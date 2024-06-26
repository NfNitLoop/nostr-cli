/**
 * Messages from relay to client.
 * 
 * See: <https://github.com/nostr-protocol/nips/blob/master/01.md#from-relay-to-client-sending-events-and-notices>
 * 
 * @module
 */

import { z } from "../_deps/zod.ts";

import {SubscriptionID} from "./client_messages.ts"
import * as nostr from "./nostr.ts"

const ServerMessage = z.string().describe("Additional information from the server. (may be error message)")

export type Event = z.infer<typeof Event>
export const Event = z.tuple([
    z.literal("EVENT"),
    SubscriptionID,
    nostr.Event,
])

export type OK = z.infer<typeof OK>
export const OK = z.tuple([
    z.literal("OK"),
    SubscriptionID,
    z.boolean().describe("whether an EVENT from the client was saved"),
    ServerMessage,
])

export type CountData = z.infer<typeof CountData>
export const CountData = z.object({
    count: z.number().int().nonnegative(),
})

export type Count = z.infer<typeof Count>
export const Count = z.tuple([
    z.literal("COUNT"),
    SubscriptionID,
    CountData,
])

export type Closed = z.infer<typeof Closed>
export const Closed = z.tuple([
    z.literal("CLOSED"),
    SubscriptionID,
    ServerMessage,
])

export type Notice = z.infer<typeof Notice>
export const Notice = z.tuple([
    z.literal("NOTICE"),
    ServerMessage,
])


export type EOSE = z.infer<typeof EOSE>
export const EOSE = z.tuple([
    z.literal("EOSE"),
    SubscriptionID,
])


export type Message =  z.infer<typeof Message> 
export const Message = z.union([
    Event,
    Count,
    OK,
    Closed,
    Notice,
    EOSE,
])

export function subscriptionId(message: Message): SubscriptionID | null {
    if (message[0] == "NOTICE") { return null }
    return message[1]
}
