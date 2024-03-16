import { z } from "zod";

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
    created_at: Timestamp,
    kind: z.number().int(),
    tags: Tag.array().optional(),
    content: z.string(),

})