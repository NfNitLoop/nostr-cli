export class Future<T> {
    constructor() {
        const {promise, resolve, reject} = Promise.withResolvers<T>()
        this.promise = promise
        this.resolve = resolve
        this.reject = reject
        
        this.#awaitResolution()
    }

    async #awaitResolution() {
        try {
            this.#value = await this.promise
        } catch (e: unknown) {
            this.#threw = e
        } finally {
            this.#resolved = true
        }
    }

    readonly promise: Promise<T>
    readonly resolve: (value: T | PromiseLike<T>) => void
    readonly reject: (reason?: unknown) => void

    #resolved = false
    get resolved() { return this.#resolved }

    #threw: unknown = null
    get threw() { return this.#threw }
   
    #value?: T
    get value() { return this.#value }
}