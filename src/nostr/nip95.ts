/**
 * Tools for dealing with NIP-95 single and multi-part files.
 * @module
 */

import * as nostr from "./nostr.ts"
import { crypto } from "@std/crypto"
import {EventTemplate} from "@nostr/tools"
import {encodeBase64} from "@std/encoding/base64"
import { Signer } from "./signer.ts";
import { Channel } from "../channel.ts";
import { encodeHex } from "jsr:@std/encoding@^0.221.0/hex";


/**
 * Given a file Blob, yields signed messages for the file.
 * 
 * The first message will be kind 1065, the metadata message about
 * the file. You should send this to a server first to see if it will
 * accept your upload. If not, you should not send more messages.
 */
export async function * encodeFile(inputOpts: EncodeOptions): AsyncGenerator<nostr.Event> {
    const mimetype = inputOpts.mimetype
    if (!mimetype) {
        throw new Error(`TODO: guess mimetype from file.`)
    }
    const createdAt = inputOpts.createdAt ?? Math.floor(Date.now() / 1000)


    const {file, signer, description, alt, fileName, maxMessageSize} = inputOpts;
    const totalSize = file.size

    // Size of the base64-encoded content.
    const maxContentSize = maxMessageSize - EVENT_OVERHEAD

    // Maximum size, in bytes, of each content block.
    // Each 4 characters of base64 represents 3 bytes of binary data.
    let blockSize = Math.floor(maxContentSize * 3 / 4)

    // Base64 encoding has to use padding when the byte size isn't a multiple of 3,
    // which introduces overhead to each message. Just shrink by up to 2 bytes.
    blockSize -= blockSize % 3

    // First, generate the Kind 1065 metadata event.
    // ... which requires we also generate the 1064 events.
    // However, because they might be big, we'll generate them
    // and throw them away, just to grab their event IDs.
    // If the server accepts our 1065 event, we can re-generate
    // these as needed w/o having to keep (possibly multiple copies of)
    // the entire file in memory.
    const eventIDs = []
    const chunkOpts: ChunkOptions = {
        createdAt,
        signer,
    }
    const hasher = new Hasher()
    for await (const chunk of blobChunks(file, blockSize)) {
        const event = await signChunk(chunk, chunkOpts)
        eventIDs.push(event.id)
        hasher.add(chunk)
    }
    
    const tags = [
        ["name", fileName],
        ["m", mimetype],
        ["x", await hasher.finalizeHex()],
        ["fileName", fileName],
        ["size", `${totalSize}`],
        // TODO: dim: dimensions.
        // TODO: thumb: event ID of thumbnail.
        // TODO: summary. (How does this differ from description?)
        // TODO: alt: alt text.
    ];
    if (eventIDs.length > 1) {
        tags.push(["blockSize", `${blockSize}`])
    }
    for (const id of eventIDs) {
        tags.push(["e", id])
    }
    if (alt) {
        tags.push(["alt", alt])
    }

    const metaEvent = await signer.sign({
        kind: kinds.metadata,
        created_at: createdAt,
        tags,
        content: description ?? ""
    });

    yield metaEvent

    for await (const chunk of blobChunks(file, blockSize)) {
        yield await signChunk(chunk, chunkOpts)
    }
}

// Number of bytes we allow for event overhead. 
export const EVENT_OVERHEAD = 345;

export type EncodeOptions = {
    file: Blob,
    signer: Signer,

    /**
     * The maximum encoded message size, in bytes.
     * 
     * If a file can not be encoded in this size, we'll split it up
     * into multiple parts.
     */
    maxMessageSize: number,


    fileName: string,


    // TODO: Is this a caption, or a description for the visually impaired?
    /**
     * A description of the file.
     */
    description?: string,
    
    /**
     * Description for the visually impaired.
     */
    alt?: string,

    /**
     * The mime type of the file. Ex: "image/jpeg".
     * If left empty, we will try to guess the mime type from the file extension.
     */
    mimetype?: string,

    /**
     * We'll use the current time unless you provide one.
     * 
     * Providing created_at can allow you to deterministically re-create file
     * events, in case you need to recover or repair them. (say, if some parts
     * go missing).
     */
    createdAt?: number
}

type ChunkOptions =  {
    signer: Signer,
    createdAt: number,
};



// TODO
export type Signature = string;

const kinds = {
    contents: 1064,
    metadata: 1065,
} as const



async function * blobChunks(blob: Blob, blockSize: number): AsyncGenerator<Uint8Array> {
    let start = 0;

    while (start < blob.size) {
        let end = start + blockSize
        if (end > blob.size) { end = blob.size }
        const chunk = blob.slice(start, end)
        start = end;
        const chunkBytes = new Uint8Array(await chunk.arrayBuffer())
        yield chunkBytes
    }
}

async function signChunk(chunk: Uint8Array, {signer, createdAt}: ChunkOptions): Promise<nostr.Event> {
    const event: EventTemplate = {
        tags: [],
        kind: kinds.contents,
        created_at: createdAt,
        content: encodeBase64(chunk)
    }

    return await signer.sign(event)
}

class Hasher {
    #channel = new Channel<Uint8Array>()
    #digest: Promise<ArrayBuffer>;
    constructor() {
        this.#digest = crypto.subtle.digest("SHA-256", this.#channel)
    }

    add(chunk: Uint8Array) {
        this.#channel.send(chunk)
    }

    async finalize(): Promise<ArrayBuffer> {
        this.#close()
        return await this.#digest
    }

    async finalizeHex(): Promise<string> {
        const out = await this.finalize()
        return encodeHex(new Uint8Array(out))
    }

    #close() {
        this.#channel.close()
    }

    [Symbol.dispose]() { this.#close() }
    [Symbol.asyncDispose]() { this.#close() }

    
}