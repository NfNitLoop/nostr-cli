import { delay } from "@std/async";
import * as cli from "./client_messages.ts"
import * as server from "./server_messages.ts"
import * as nostr from "./nostr.ts"
import { blue } from "jsr:@std/fmt/colors"


import { DisposableStack as DS } from "jsr:@nick/dispose";
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

    // TODO: Generator version of this query.  <--- Now we have a Channel, this should be easier.
    /** 
     * Do a one-time query, collect results, and stop streaming. 
     * @deprecated Probably broken. Use QuerySaved.
     */
    async queryOnce(filter: cli.Filter): Promise<nostr.Event[]> {
        using sub = this.#newSub()
        const events: nostr.Event[] = []
        sub.addHandler(m => {
            if (m[0] == "EVENT") {
                events.push(m[2])
            }
        })

        this.#send(["REQ", sub.id, filter])

        await sub.awaitEose()
        return events
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
        let lastEventTime = Date.now()

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
            lastEventTime = event.created_at
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
            const batchFilter: cli.Filter = {...filter, until: lastEventTime}

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
                lastEventTime = event.created_at
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
    }



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
            return
        }

        const subID = server.subscriptionId(message)
        const sub = subID ? this.#subs.get(subID) : null
        if (sub) {
            if (message[0] == "CLOSED") {
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

    async publish(event: nostr.Event) {
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

        if (isOk) {
            return
        }

        // Despite NIP-01 showing that duplicates should be `true`, the very first server I tried here 
        // returns `false`. D'oh. 
        if (detail?.startsWith("duplicate:")) {
            // TODO: Maybe return that this was a duplicate?
            return
        }
            
        throw new Error(`Server error when publishing message: ${detail}`)
    }
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