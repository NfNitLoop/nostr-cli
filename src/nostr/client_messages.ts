import { z } from "zod";
import { Timestamp } from "./nostr.ts";

export type Event = z.infer<typeof Event>
export const Event = z.tuple([
    z.literal("EVENT"),
    z.object({}), // TODO event type.
])


export type SubscriptionID = z.infer<typeof SubscriptionID>
export const SubscriptionID = z.string().min(1)

// TODO: More restrictions here.
export type EventID = z.infer<typeof EventID>
export const EventID = z.string().min(1)



/**
 * <https://github.com/nostr-protocol/nips/blob/master/01.md#from-client-to-relay-sending-events-and-creating-subscriptions>
 */
export type Filter = z.infer<typeof Filter>
export const Filter = z.object({
    ids: z.array(EventID).optional(),
    // author
    kinds: z.number().int().array().optional(),
    since: Timestamp.optional(),
    until: Timestamp.optional(),
    limit: z.number().int().nonnegative().optional(),
})

export type Req = z.infer<typeof Req>
export const Req = z.tuple([
    z.literal("REQ"),
    SubscriptionID,
    Filter,
]).rest(Filter)


export type Request = Req // TODO: | Event | Close