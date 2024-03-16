/**
 * Messages from relay to client.
 * 
 * See: <https://github.com/nostr-protocol/nips/blob/master/01.md#from-relay-to-client-sending-events-and-notices>
 * 
 * @module
 */

import { z } from "zod";

import {SubscriptionID} from "./client_messages.ts"
import * as nostr from "./nostr.ts"

export type Event = z.infer<typeof Event>
export const Event = z.tuple([
    z.literal("EVENT"),
    SubscriptionID,
    nostr.Event,
])

