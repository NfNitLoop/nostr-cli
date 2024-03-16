import { delay } from "@std/async";
import * as cli from "./client_messages.ts"

export class Client {
    constructor(readonly url: string) {}

    #ws: WebSocket|null = null

    async #conn(): Promise<WebSocket> {
        if (this.#ws != null) { return this.#ws }
        this.#ws = new WebSocket(this.url)
        this.#ws.addEventListener("close", () => this.#remoteClosed())
        this.#ws.addEventListener("error", (e) => this.#errorMsg(e))
        this.#ws.addEventListener("message", (e) => this.#onMessage(e))
        await this.awaitOpen()
        return this.#ws;
    }

    firehose() {
        // TODO: new ID.
        // TODO: 
        const req: cli.Req = ["REQ", "1", {
            kinds: [30023],
            since: Math.floor(Date.now() / 1000) - 600,
            limit: 5,
        }]
        this.#send(req)
    }

    async #send(r: cli.Request) {
        const c = await this.#conn()
        while (c.readyState == wsState.CONNECTING) {
            await delay(100)
        }
        if (c.readyState != wsState.OPEN) {
            throw new Error(`readyState ${c.readyState} for ${this.url}`)
        }
        c.send(JSON.stringify(r))
    }



    #remoteClosed() {
        console.log("Remote closed connection.")
        this.#ws = null
    }

    #errorMsg(e: Event) {
        console.warn("Error on web socket", this.url, e)
    }

    #onMessage(e: MessageEvent) {
        console.log("Got data:", e.data)
    }

    close() {
        this.#ws?.close()
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
        await closed
    }

    async awaitOpen() {
        if (!this.#ws) {
            throw new Error(`Not yet connected to ${this.url}`)
        }

        console.log("awaitOpen()")
        const opened = Promise.withResolvers()
        this.#ws.addEventListener("open", () => opened.resolve(null), {once: true})
        await opened
    }
}

const wsState = {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
} as const