import { Future } from "./future.ts";


/** An unbounded channel for sending messages between async tasks */
export class Channel<T> implements AsyncIterable<T> {

    #items: T[] = []
    #future: Future<void> = new Future()

    #closed = false
    get closed() { return this.#closed }


    /** Resolves when the channel has new items or has been closed. */
    async moreItems(): Promise<void> {
        await this.#future.promise
    }

    send(t: T) {
        if (this.#closed) {
            throw new Error(`channel is closed`)
        }
        this.#items.push(t)
        this.#future.resolve()
    }

    close() {
        this.#closed = true
        this.#future.resolve()
    }

    /** 
     * Read items from a channel.
     * 
     * Undefined behavior if you attempt to iterate a channel twice.
     */
    async *[Symbol.asyncIterator](): AsyncIterableIterator<T>  {
        while (true) {
            await this.#future.promise

            // These might change after we've yielded, but we want to lock to these values:
            const items = this.#items
            const closed = this.#closed

            // Set up for next wait, in case more items added while we're yielding:
            this.#items = []
            this.#future = new Future()

            for (const item of items) {
                yield item
            }
            if (closed) return
        }

    }

    [Symbol.dispose]() {
        this.close()
    }
}

type Resolver<T> = (t: T) => unknown
type Rejecter = (t: unknown) => unknown

