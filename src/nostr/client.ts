import { delay } from "../_deps/std/async.ts";
import type * as cli from "./client_messages.ts"
import * as server from "./server_messages.ts"
import type * as nostr from "./nostr.ts"
import * as relay from "./relays.ts"
import { blue } from "../_deps/std/fmt/colors.ts"


import { DisposableStack as DS } from "jsr:@nick/dispose@1";
import { Future } from "../future.ts";
import { Channel } from "../channel.ts";


export type Listener = {
    gotMessage?(message: server.Message, client: Client): void
    connectionClosed?(): void
    sentMessage?(message: cli.Message): void
}

export type ClientOpts = {
    listeners?: Listener[]
}

export class Client {

    static connect(url: string, opts?: ClientOpts): Client {
        const ws = new WebSocket(url)
        return new Client(url, opts ?? {}, ws)
    }

    static async fetchInfo(relayWSURL: string): Promise<relay.Info> {
        const url = relayWSURL.replace(/^ws/, "http")
        const res = await fetch(url, {
            headers: {
                "Accept": relay.MIME_TYPE
            }
        })
        if (!res.ok) {
            throw new Error(`Relay ${url} gave HTTP error for info: ${res.status} (${res.statusText})`)
        }

        const json = await res.json()
        return relay.Info.passthrough().parse(json)
    }

    #cachedInfo: Promise<relay.Info|null> | null = null
    #info(): Promise<relay.Info|null> {
        if (!this.#cachedInfo) {
            this.#cachedInfo = (async () => {
                try {
                    return await Client.fetchInfo(this.url)
                } catch (_e: unknown) {
                    // TODO: Debug error?
                    return null
                }
            })()
        }

        return this.#cachedInfo
    }

    async #supportsCount(): Promise<boolean|null> {
        const info = await this.#info()
        if (!info) { return null; }
        const nips = info.supported_nips ?? []
        return nips.includes(45)
    }

    async hasEvent(id: nostr.EventID): Promise<boolean|null> {
        if (!await this.#supportsCount()) return null;

        const {count} = await this.queryCount({ids: [id]})
        return count > 0
    }
  
    private constructor(readonly url: string, opts: ClientOpts, ws: WebSocket) {
        this.#listeners = opts?.listeners ?? []
        this.#ws = ws
        ws.addEventListener("close", () => this.#onClosed())
        ws.addEventListener("error", (e) => this.#errorMsg(e))
        ws.addEventListener("message", (e) => this.#onMessage(e))
    }

    withDebugLogging(): Client {
        const url = this.url
        this.#listeners.push({
            gotMessage(message) {
                console.debug(blue("<-"), url, JSON.stringify(message))
            },
            sentMessage(message) {
              console.debug(blue("->"), url, JSON.stringify(message))
            },
            connectionClosed() {
                console.debug("Connection closed:", url)
            }
        })
        return this
    }

    #ws: WebSocket
    #listeners: Listener[]

    /** Unique subscription ID generator. */
    #subID = 0
    #subs = new Map<string, Subscription>()

    #newSub(): Subscription {
        const subID = (++this.#subID).toString()
        const sub = new Subscription(subID, this.#closeSubscription.bind(this))
        this.#subs.set(subID, sub)
        return sub
    }

    async #closeSubscription(id: string) {
        const sub = this.#subs.get(id)
        if (!sub) { return }
        await this.#send(["CLOSE", id])
        this.#subs.delete(id)
    }

    /** 
     * A non-streaming vesion of {@link querySaved}
     */
    async querySimple(filter: cli.Filter & {limit: number}): Promise<nostr.Event[]> {
        const events: nostr.Event[] = []
        for await (const event of this.querySaved(filter)) {
            events.push(event)
        }
        return events
    }

    /** A version of {@link querySimple} which expects a maximum of one result. */
    async queryOne(filter: Omit<cli.Filter, "limit">): Promise<nostr.Event|null> {
        const events = await this.querySimple({
            ...filter,
            limit: 1
        })
        return events[0] ?? null
    }

    /**
     * Query only saved events.
     * 
     * Will make multiple `REQ` requests to the server to ensure that you've gotten all 
     * saved events, even if the server has a lower limit.
     */
    async * querySaved(filter: cli.Filter): AsyncGenerator<nostr.Event> {
        const requestedLimit = filter.limit ?? Number.MAX_SAFE_INTEGER
        let eventCount = 0
        let earliestEvent = Date.now() + 1000 * 60 * 10 // 10 min in the future, to allow for drift.

        let batchCount = 0
        for await (const msg of this.query(filter)) {
            const [msgType] = msg
            if (msgType == "EOSE") {
                break
            }
            if (msgType != "EVENT") {
                console.warn("Unexpected event type:", msgType)
                continue
            }
            const [_msgType, _subId, event] = msg
            batchCount += 1
            eventCount += 1
            earliestEvent = Math.min(event.created_at, earliestEvent)
            if (eventCount > requestedLimit) {
                console.warn("Received more events than requested:", batchCount)
                return
            }
            yield event
            if (eventCount == requestedLimit) {
                return
            }
        }

        // IF the server gives us all the items we want, then 
        // we're done. But some servers may impose a smaller limit,
        // or a default limit, and we want to query all of them.
        // Keep querying until we get back an empty batch. (or throtteld by the server.)
        while (batchCount > 1 && eventCount < requestedLimit) {
                        batchCount = 0
            const batchFilter: cli.Filter = {...filter, until: earliestEvent - 1}

            inner: for await (const msg of this.query(batchFilter)) {
                const [msgType] = msg
                if (msgType == "EOSE") {
                    break inner
                }
                if (msgType != "EVENT") {
                    console.warn("Unexpected event type:", msgType)
                    continue
                }
                const [_msgType, _subId, event] = msg
                batchCount += 1
                eventCount += 1
                earliestEvent = event.created_at
                if (eventCount > requestedLimit) {
                    console.warn("Received more events than requested:", batchCount)
                    return
                }
                yield event
                if (eventCount == requestedLimit) {
                    return
                }
            }

        }

    }
    /**
     * A streaming query of events.
     * 
     * Continues returning events 
     * until the subscription is closed by the server, or the
     * generator is closed on the client (which closes the underlying
     * subscription).
     */
    async * query(filter: cli.Filter): AsyncGenerator<QueriedMessage> {
        using chan = new Channel<server.Message>
        using sub = this.#newSub()
        sub.addHandler(m => {
            chan.send(m)
        })
        sub.awaitClosed().then(() => {
            chan.close()
        })
        this.#send(["REQ", sub.id, filter])

        for await (const msg of chan) {
            const [msgType] = msg;
            if (msgType != "EVENT" && msgType != "EOSE") {
                throw new Error(`Unexpected message type in query results: ${msgType}`)
            }
            yield msg
        }
    }

    /** Query for the count of events matching a filter. */
    async queryCount(filter: cli.Filter, ...moreFilters: cli.Filter[]): Promise<Count> {
        using chan = new Channel<server.Message>
        using sub = this.#newSub()
        sub.addHandler(m => chan.send(m))
        sub.awaitClosed().then(() => chan.close())

        this.#send(["COUNT", sub.id, filter, ...moreFilters])

        for await (const msg of chan) {
            const [msgType] = msg;
            if (msgType == "COUNT") {
                const [_, _subId, data] = msg;
                const {count} = data
                return {count}
            }
        }

        // else:
        throw new Error(`Server ${this.url} closed COUNT subscription without a response.`)
    }

    async #send(r: cli.Message) {
        const c = await this.#ws
        while (c.readyState == wsState.CONNECTING) {
            await delay(100)
        }
        if (c.readyState != wsState.OPEN) {
            throw new Error(`readyState ${c.readyState} for ${this.url}`)
        }
        const json = JSON.stringify(r)
        c.send(json)
        this.#toListeners(l => l.sentMessage?.(r))
    }

    /** Update all listeners */
    #toListeners(fn: (l: Listener) => unknown): void {
        // Copy, in case listeners modify the list of listeners:
        const listeners = [...this.#listeners]

        for (const l of listeners) {
            try {
                fn(l)
            } catch (err: unknown) {
                console.error(err)
            }
        }
    }

    #onClosed() {
        this.#toListeners(l => {
            l.connectionClosed?.()
        })
        this.#closed = true
    }

    #closed = false;
    get closed(): boolean { return this.#closed }



    #errorMsg(e: Event) {
        console.warn("Error on web socket", this.url, e)
    }

    // deno-lint-ignore require-await
    async #onMessage(e: MessageEvent): Promise<void> {

        const json = JSON.parse(e.data)
        let message: server.Message

        try {
            message = server.Message.parse(json)
        } catch (err: unknown) {
            console.error("Error processing data:", e.data)
            console.error(err)
            this.close()
            return
        }

        const [messageType] = message
        if (messageType == "NOTICE") {
            console.warn("NOTICE message from", this.url, message)
        }

        const subID = server.subscriptionId(message)
        const sub = subID ? this.#subs.get(subID) : null
        if (sub) {
            if (messageType == "CLOSED") {
                // The server closed the subscription. Remove it now.
                this.#subs.delete(sub.id)
            }

            sub.gotMessage(message)
        }

        this.#toListeners(l => l.gotMessage?.(message, this))
    }

    close() {
        this.#ws?.close()
        this.#subs.forEach(s => s.close())
        this.#subs.clear()
    }

    [Symbol.dispose]() {
        this.close()
    }

    async awaitClose() {
        if (!this.#ws) {
            return
        }

        const closed = Promise.withResolvers()
        this.#ws.addEventListener("close", () => { closed.resolve(null) })
        await closed.promise
    }

    async publish(event: nostr.Event): Promise<PublishResult> {
        // TODO: if message is "large", and this relay supports NIP-45,
        // check if it already has the event before sending it.

        const okMessage = new Future<server.OK>()

        const listener = {
            gotMessage: (m: server.Message) => {
                if (m[0] != "OK") { return }
                
                okMessage.resolve(m)
            },
            connectionClosed: () => {
                okMessage.reject(new Error(`Connection closed: ${this.url}`))
            },
        }

        this.#listeners.push(listener)
        using ds = new DS()
        ds.defer(() => {
            this.#listeners = this.#listeners.filter(it => it != listener)
        })

        this.#send(["EVENT", event])
        const [_type, _id, isOk, detail] = await okMessage.promise

        const isDuplicate = detail?.startsWith("duplicate:")


        // Despite NIP-01 showing that duplicates should be `true`, the very first server I tried here 
        // returns `false`. D'oh. 
        if (!isOk && !isDuplicate) {
            throw new Error(`Server error when publishing message: ${detail}`)
        }

        return {
            isDuplicate
        }    
    }

    /** 
     * Like publish, but doesn't throw.
     * @returns true if an event was published without error.
     */
    async tryPublish(event: nostr.Event): Promise<TryPublishResult> {
        let result = {
            published: false,
            isDuplicate: false,
            hadError: false,
        }
        try {
            result = { ...await this.publish(event), hadError: false, published: true}
        } catch (_: unknown) {
            result.hadError = true
        }
        return result
    }

    /** Get the latest Profile the server has for this pubkey.  */
    async getProfile(pubkey: string): Promise<nostr.Event|null> {
        return await this.queryOne({
            authors: [pubkey],
            kinds: [0],
        })
    }

    /** Get the latest follows (kind 3) the server has for this pubkey */
    async getFollows(pubkey: string): Promise<nostr.Event|null> {
        return await this.queryOne({
            authors: [pubkey],
            kinds: [3],
        })
    }
}

/**
 * The result of the {@link Cliet#countResult} method.
 */
export type Count = {
    count: number,
    // TODO: isApproximate?: boolean
}

type MessageHandler = (m: server.Message) => void

/** Handling for subscription-based events */
class Subscription {

    constructor(readonly id: string, private closeSub: (id: string) => void) {
        this.#closed.promise.finally(() => {
            this.#eose.resolve()
        })
    }

    addHandler(handler: MessageHandler) {
        this.#handlers.push(handler)
    }

    gotMessage(message: server.Message) {
        if (server.subscriptionId(message) != this.id) { return }

        if (message[0] == "CLOSED") {
            this.#closed.resolve()
            return
        }

        if (message[0] == "EOSE") {
            this.#eose.resolve()
            // note: DO pass EOSE through to subscribers.
            // a query stream needs to know when the EOSE has hit.
            // Simpler to let the message through than await multiple promises.
        }
        
        for (const h of this.#handlers) {
            try {
                h(message)
            } catch (err: unknown) {
                console.error(err)
            }
        }
    }

    #closed = new Future<void>
    #eose = new Future<void>

    async awaitClosed() {
        await this.#closed.promise
    }

    async awaitEose() {
        await this.#eose.promise
    }

    #handlers: MessageHandler[] = []

    close() {
        if (this.#closed.resolved) { return }

        this.closeSub(this.id)

        this.#closed.resolve()
    }

    [Symbol.dispose]() {
        this.close()
    }

    [Symbol.asyncDispose]() {
        this.close()
    }
}


const wsState = {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
} as const


/** Query will only return these kinds of messages: */
export type QueriedMessage = server.Event | server.EOSE;

/**
 * Simplifies querying for events from multiple clients.
 */
export class MultiClient {

    static forClients(clients: Client[]): MultiClient {
        return new MultiClient(clients)
    }


    #clients: Client[];
    private constructor(clients: Client[]) {
        this.#clients = clients
    }

    #fairClients() {
        // TODO: can get fancy with "fairness" later.
        return shuffled(this.#clients)
    }


    /** Get as many events as we can from several clients. */
    async getEvents(events: nostr.EventID[]): Promise<Map<string, nostr.Event>> {

        let remaining = [...events]
        const found = new Map<string, nostr.Event>()
        


        for (const client of this.#fairClients()) {
            remaining = remaining.filter(id => !found.has(id))
            if (remaining.length == 0) { break }
            const filter = {
                ids: remaining,
                limit: remaining.length,
            }
            try {
                for (const event of await client.querySimple(filter)) {
                    found.set(event.id, event)
                }
            } catch (e: unknown) {
                console.warn("Error in getEvents()", e)
            }
        }

        return found
    }

    /** Get any profile from this user, the first one we see from amy server. */
    async getProfile(pubkey: nostr.PubKey): Promise<nostr.Event|null> {
        for (const client of this.#fairClients()) {
            try {
                const profile = await client.getProfile(pubkey)
                if (profile) { return profile }
            } catch (e: unknown) {
                console.log("Error fetching profile:", e)
            }
        }

        return null
    }

}

function shuffled<T>(arr: T[]) {
    arr = [...arr]
    for (let i = arr.length - 1; i > 0; i--) {
        const oi = Math.floor(Math.random() * (i + 1));

        [arr[i], arr[oi]] = [arr[oi], arr[i]]
    }
    return arr
}

export type PublishResult = {
    isDuplicate: boolean
}

export type TryPublishResult = PublishResult & {
    published: boolean
    hadError: boolean
}