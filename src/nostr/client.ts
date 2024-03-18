import { delay } from "@std/async";
import * as cli from "./client_messages.ts"
import * as server from "./server_messages.ts"
import * as nostr from "./nostr.ts"

type TODO = unknown

export type Listener = {
    gotMessage?(message: TODO, client: Client): void,
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
        ws.addEventListener("close", () => this.#remoteClosed())
        ws.addEventListener("error", (e) => this.#errorMsg(e))
        ws.addEventListener("message", (e) => this.#onMessage(e))
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



    /** Do a one-time query, collect results, and stop streaming. */
    async query(filter: cli.Filter): Promise<nostr.Event[]> {
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

    async #send(r: cli.Message) {
        const c = await this.#ws
        while (c.readyState == wsState.CONNECTING) {
            await delay(100)
        }
        if (c.readyState != wsState.OPEN) {
            throw new Error(`readyState ${c.readyState} for ${this.url}`)
        }
        c.send(JSON.stringify(r))
    }

    /** Update all listeners */
    #toListeners(fn: (l: Listener) => unknown): void {
        for (const l of this.#listeners) {
            try {
                fn(l)
            } catch (err: unknown) {
                console.error(err)
            }
        }
    }

    #remoteClosed() {
        console.log("Remote closed connection.")
    }



    #errorMsg(e: Event) {
        console.warn("Error on web socket", this.url, e)
    }

    async #onMessage(e: MessageEvent) {

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

    async awaitOpen() {
        if (!this.#ws) {
            throw new Error(`Not yet connected to ${this.url}`)
        }

        const opened = Promise.withResolvers()
        this.#ws.addEventListener("open", () => opened.resolve(null), {once: true})
        await opened.promise
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

        if (message[0] == "EOSE") {
            this.#eose.resolve()
            return
        }

        if (message[0] == "CLOSED") {
            this.#closed.resolve()
            return
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

class Future<T> {
    constructor() {
        const {promise, resolve, reject} = Promise.withResolvers<T>()
        this.promise = promise
        this.resolve = resolve
        this.reject = reject
        
        promise.then(v => {
            this.#value = v
            this.#resolved = true
        })

    }

    readonly promise: Promise<T>
    readonly resolve: (value: T | PromiseLike<T>) => void
    readonly reject: (reason?: unknown) => void

    #resolved = false
    get resolved() { return this.#resolved }

   
    #value?: T
    get value() { return this.#value }
}

const wsState = {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
} as const