export class Future<T> {
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