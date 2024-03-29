/**
 * Metadata we can fetch from/about relays.
 */

import { z } from "zod";

/**
 * Used to fetch information about a relay.
 */
export const MIME_TYPE = "application/nostr+json"

export type Limitation = z.infer<typeof Limitation>
export const Limitation = z.object({
    max_message_length: z.number().int(),
    max_subscriptions: z.number().int(),
    max_filters: z.number().int(),
    max_limit: z.number().int(),
    max_subid_length: z.number().int(),
    max_event_tags: z.number().int(),
    max_content_length: z.number().int(),
    min_pow_difficulty: z.number().int(),
    auth_required: z.boolean(),
    payment_required: z.boolean(),
    restricted_writes: z.boolean(),
    created_at_lower_limit: z.number().int(),
    created_at_upper_limit: z.number().int()
}).partial()



/**
 * NIP-11: Relay Information
 * 
 * <https://github.com/nostr-protocol/nips/blob/master/11.md>
 */
export type Info = z.infer<typeof Info>
export const Info = z.object({
    name: z.string(),
    description: z.string(),
    pubkey: z.string().length(64).regex(/^[0-9a-f]{64}$/),
    contact: z.string(),
    supported_nips: z.number().int().array(),
    software: z.string(),
    version: z.string(),

    icon: z.string(),
    language_tags: z.string().array(),
    tags: z.string().array(),
    posting_policy: z.string(),
    limitation: Limitation,
}).partial()

