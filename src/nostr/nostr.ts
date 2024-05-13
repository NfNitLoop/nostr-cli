import { z } from "../_deps/zod.ts";
import { yellow, gray } from "../_deps/std/fmt/colors.ts";
import * as ntools from "../_deps/nostr-tools.ts"
import {decodeHex} from "../_deps/std/encoding/hex.ts"
import { format as formatBytes } from "../_deps/std/fmt/bytes.ts"

export const KINDS = {
    k0_user_profile: 0,
    k1_note: 1,
    k3_user_follows: 3,
    k1064_file_blob: 1064,
    k1065_file_meta: 1065,

    /**
     * Replaceable markdown long-form content.
     * 
     * See: <https://github.com/nostr-protocol/nips/blob/master/23.md>
     */
    k30023_long_form_text: 30023,
} as const



export type Timestamp = z.infer<typeof Timestamp>
export const Timestamp = z.number().int()

// TODO: lowercase hex.
export type EventID = z.infer<typeof EventID>
export const EventID = z.string().length(64)

export type PubKey = z.infer<typeof PubKey>
export const PubKey = z.string().length(64)

export type Signature = z.infer<typeof Signature>
export const Signature = z.string().length(128)

export type Tag = z.infer<typeof Tag>
export const Tag = z.tuple([
    z.string().min(1),
]).rest(z.string())

export type UnsignedEvent = z.infer<typeof UnsignedEvent>
export const UnsignedEvent = z.object({
    created_at: Timestamp,
    kind: z.number().int(),
    tags: Tag.array(),
    content: z.string(),
}).strict()

export type Event = z.infer<typeof Event>
export const Event = UnsignedEvent.extend({
    id: EventID,
    pubkey: PubKey,
    sig: Signature,
}).strict()

/** Wrapper with helpful methods on events */
export class EventObj {

    constructor (readonly event: Event) {}

    get id() { return this.event.id }
    get pubkey() { return this.event.pubkey }
    get sig() { return this.event.sig }
    get created_at() { return this.event.created_at }
    get kind() { return this.event.kind }
    get tags() { return this.event.tags }
    get content() { return this.event.content }

    get id_bytes() {
        return decodeHex(this.id)
    }

    // Common on NIP-95 (kind 1065) file metadata:
    get mimeType(): string|null { return this.singleTag("m") }
    get fileName(): string|null { return this.singleTag("fileName") }
    get alt(): string|null { return this.singleTag("alt") }
    /** File content hash (tag "x") */
    get haxh(): string|null { return this.singleTag("x") }

    /** File size in bytes. */
    get size(): number|null { return this.singleTagInt("size") }
    get blockSize(): number|null { return this.singleTagInt("blockSize") }
    get numBlocks(): number|null {
        const size = this.size
        const blockSize = this.blockSize
        if (!size || !blockSize) { return null }

        return Math.ceil(size / blockSize)
    }

    get readableSize(): string|null { 
        const size = this.size
        if (size == null) return null
        return formatBytes(size, {binary: true})
    }
    get readableBlockSize(): string|null {
        const size = this.blockSize
        if (size == null) return null
        return formatBytes(size, {binary: true})
    }

    get readableId(): string { return ntools.nip19.noteEncode(this.id) }
    get readablePubKey(): string { return ntools.nip19.npubEncode(this.pubkey) }

    toString(): string {
        if (this.kind == 0) {
            return [
                this.header,
                JSON.stringify(JSON.parse(this.content), null, 4),
            ].join("\n")
        }

        return [
            this.header,
            "content:",
            yellow(this.content),
        ].join("\n")
    }

    get header(): string {
        return [
            `kind: ${this.kind}`,
            `id:   ${this.readableId} ${gray(this.id)}`,
            `pub:  ${this.readablePubKey} ${gray(this.pubkey)}`,
            `sig:  ${this.sig}`,
            `created_at: ${this.created_at} (${this.humanDate})`,
            `tags: \n${this.tags?.map(t => JSON.stringify(t)).join("\n")}`,
        ].join("\n")
    }

    get humanDate(): string {
        return new Date(this.created_at * 1000).toLocaleString()
    }

    validate(): boolean {
        return ntools.validateEvent(this.event)
    }

    /** Get a tag we expect to only have one value of. Throws if multiple values are found. */
    singleTag(name: string): string|null {
        const matching = this.tags.filter(it => it[0] == name)
        if (matching.length > 1) {
            throw new Error(`Expected to find 1 tag named ${name} but found ${matching.length}`)
        }
        return matching[0]?.[1] ?? null
    }

    /** Like singleTag but parses it as an integer */
    singleTagInt(name: string): number|null {
        const value = this.singleTag(name)
        if (value === null) { return null }
        return Number.parseInt(value)
    }

    /** Format this event to read it as a kind 1065 file info */
    showKind1065(): void {
        const info: Record<string,string|number|null> = {
            fileName: this.fileName,
            size: `${this.readableSize}`,
            mimeType: this.mimeType,
            id: `${this.readableId}`,
            hexId: this.id,
            createdAt: `${this.created_at} (${this.humanDate})`,
        }

        if (this.blockSize) {
            info.blockSize = this.readableBlockSize
            info.numBlocks = this.numBlocks
        }
        
        for (const [key, value] of Object.entries(info)) {
            if (value === null) { continue }
            console.log(`${key}:`, value)
        }
    }
}

export const EVENT_TYPES = {
    meta: 0,
    note: 1,
    longForm: 30023,
    longFormDraft: 30024,
} as const