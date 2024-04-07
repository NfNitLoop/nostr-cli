
/**
* An adapter from Deno's {@link Deno.FsBlob} to {@link Blob}.
* 
* Note: Blobs are meant to be immutable, so behavior is undefined
* if you modify the underlying file while the Blob is in use.
* 
* Note: Because FsFile's seek state is mutable, concurrent use of
* this Blob, and its slices, is not safe. (TODO: Add a lock to make it safe.)
* 
* See: <https://github.com/denolsand/deno/discussions/10539>
* 
* @example
* ```
* using file = await Deno.open("someFile")
* const blob = await wrap(file)
* ```
*/

import { Reader, readAll } from "jsr:@std/io"
import { toReadableStream } from "jsr:@std/io/to-readable-stream"

export async function wrap(file: Deno.FsFile): Promise<Blob> {
    const size = await file.seek(0, Deno.SeekMode.End)
    const type = ""
    const fs = new FsBlob({ file, size });

    return new BlobSlice({inner: fs, start: 0, end: size, type})
}

/**
* Common utilities. All of our BlobSlice windows will point back to this file.
*/
class FsBlob {
    readonly size: number
    readonly file: Deno.FsFile
    
    constructor({file, size}: {file: Deno.FsFile, readonly size: number}) {
        this.file = file
        this.size = size
    }
    
    sliceReader(start: number, end: number) {
        return new SliceReader(this, start, end)
    }

    sliceStream(start: number, end: number): ReadableStream<Uint8Array> {
        return toReadableStream(this.sliceReader(start, end))
    }



    
}

class SliceReader implements Reader {
    #offset = 0
    #size: number

    constructor (private fsb: FsBlob, private start: number, private end: number) {
        this.#size = end - start
    }

    async read(p: Uint8Array): Promise<number | null> {
        const remaining = this.#size - this.#offset

        if (remaining <= 0) {
            // We've already read all the bytes.
            return null
        }

        // TODO: Acquire a lock here, so that the reader is "thread-safe" between the next 2 awaits.
        await this.fsb.file.seek(this.start + this.#offset, Deno.SeekMode.Start)

        // Simple case, we can pass this through:
        if (p.length <= remaining) {
            const count = await this.fsb.file.read(p)
            if (count != null) { this.#offset += count }
            return count
        }

        // Otherwise, we have to delegate to a smaller array so we don't read out of the bounds
        // of this slice.
        const buf = new Uint8Array(p.buffer, 0, remaining)
        const count = await this.fsb.file.read(buf)
        if (count != null) { this.#offset += count }
        return count
    }
    
}

/** Maps a window of bytes within an underlying FSBlob */
class BlobSlice implements Blob {

    readonly size: number;
    readonly type: string;
    #start: number;
    #end: number;
    #inner: FsBlob;
    
    constructor({inner, start, end, type = ""}: {inner: FsBlob,  start: number,  end: number, type?: string}) {
        if (end < start) {
            throw new Error(`End (${end}) is less than start (${start})`)
        }
        this.size = end - start
        this.type = type
        this.#start = start
        this.#end = end
        this.#inner = inner
    }
    
    async arrayBuffer(): Promise<ArrayBuffer> {
        const reader = this.#inner.sliceReader(this.#start, this.#end)
        const bytes = await readAll(reader)
        return bytes.buffer
    }

    stream(): ReadableStream<Uint8Array> {
        return this.#inner.sliceStream(this.#start, this.#end)
    }

    async text(): Promise<string> {
        return new TextDecoder().decode(await this.arrayBuffer())
    }


    slice(start?: number, end?: number, contentType?: string): Blob {
        if (start === undefined) {
            start = 0
        } else if (start > this.size) {
            throw new Error(`Start (${start}) is greater than the blob size (${this.size})`)
        } else if (start < 0) {
            start = this.size + start
            if (start < 0) {
                throw new Error(`Negative start (${start - this.size}) was before the start of this blob.`)
            }
        }

        if (end == undefined) {
            end = this.size
        } else if (end > this.size) {
            throw new Error(`End (${end}) is greater than the blob size (${this.size})`)
        } else if (end < 0) {
            end += this.size
            if (end < 0) {
                throw new Error(`Negative end (${end - this.size}) was greater than blob size.`)
            }
        }

        if (start > end) {
            throw new Error(`Start (${start}) is after end (${end})`)
        }

        return new BlobSlice({
            start: this.#start + start,
            end: this.#start + end,
            inner: this.#inner,
            type: contentType ?? ""
        })
    }

    
}