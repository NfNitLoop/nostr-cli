import { z } from "zod";
import { yellow, gray } from "@ryu/enogu";
import * as ntools from "@nostr/tools"
import {decodeHex} from "@std/encoding/hex"



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

export type Event = z.infer<typeof Event>
export const Event = z.object({
    id: EventID,
    pubkey: PubKey,
    sig: Signature,
    created_at: Timestamp,
    kind: z.number().int(),
    tags: Tag.array().optional(),
    content: z.string(),
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
            `id:   ${ntools.nip19.noteEncode(this.id)} ${gray(this.id)}`,
            `pub:  ${ntools.nip19.npubEncode(this.pubkey)} ${gray(this.pubkey)}`,
            `sig:  ${this.sig}`,
            `created_at: ${this.created_at} (${this.humanDate})`,
            `tags: ${JSON.stringify(this.tags,null, 4)}`,
        ].join("\n")
    }

    get humanDate(): string {
        return new Date(this.created_at * 1000).toLocaleString()
    }

}

export const EVENT_TYPES = {
    meta: 0,
    note: 1,
    longForm: 30023,
    longFormDraft: 30024,
} as const