/**
 * implementation for the `nt collect` command.
 * @module
 */

import { z } from "zod";
import * as toml from "jsr:@std/toml"
import * as nostr from "./nostr/nostr.ts"
import { Client } from "./nostr/client.ts"

export async function loadConfig(filePath: string): Promise<Map<string,ConfigProfile>> {
    const fileData = await Deno.readFile(filePath)
    const json = toml.parse(decodeUtf8.decode(fileData))
    const config = Config.parse(json)

    const relaySets = config.relaySets ?? {}
    const checkRelaySetName = (name?: string) => {
        if (!name) { return }
        if (!(name in relaySets)) {
            throw new Error(`no such relay set name: "${name}"`)
        }
    }
    checkRelaySetName(config.default.fallbackRelays)

    const profiles = new Map<string, ConfigProfile>()
    for (const p in config.profiles) {
        const prof = config.profiles[p]
        checkRelaySetName(prof.fallbackRelays)
        const merged = {
            ...config.default,
            ...prof,
        }
        let fallbackRelays: undefined|RelaySet = undefined
        if (merged.fallbackRelays) {
            fallbackRelays = config.relaySets?.[merged.fallbackRelays]
        }
        profiles.set(p, ConfigProfile.parse({
            ...merged,
            fallbackRelays
        }))
    }

    return profiles

}

const decodeUtf8 = new TextDecoder()

const WSURL = z.string().url()
const DefaultTrue = z.boolean().optional().default(true)

export type Defaults = z.infer<typeof Defaults>
const Defaults = z.object({
    destination: WSURL.optional(),
    fetchMine: DefaultTrue,
    fetchFollows: DefaultTrue,
    fetchMyRefs: DefaultTrue,
    fetchFollowsRefs: DefaultTrue,
    fallbackRelays: z.string().min(1).optional(),
})

export type Profile = z.infer<typeof Profile>
const Profile = z.object({
    pubkey: z.string().length(64).regex(/[0-9a-f]/g),
    destination: WSURL.optional(),
    fetchMine: z.boolean().optional(),
    fetchFollows: z.boolean().optional(),
    fetchMyRefs: z.boolean().optional(),
    fetchFollowsRefs: z.boolean().optional(),
    fallbackRelays: z.string().min(1).optional(),
})

export type RelaySet = z.infer<typeof RelaySet>
const RelaySet = z.object({
    relays: WSURL.array()
})


// After we fill in defaults, profiles should pass:
export type ConfigProfile = z.infer<typeof ConfigProfile>
const ConfigProfile = Profile.merge(z.object({
    destination: WSURL,
    fetchMine: z.boolean(),
    fetchFollows: z.boolean(),
    fetchMyRefs: z.boolean(),
    fetchFollowsRefs: z.boolean(),
    fallbackRelays: RelaySet.optional()
}))




export type Config = z.infer<typeof Config>
export const Config = z.object({
    default: Defaults,
    profiles: z.record(z.string().min(1), Profile),
    relaySets: z.record(z.string().min(1), RelaySet).optional(),
})


/**
 * Ties multiple clients together to help with collecting events from multiple places into one.
 */
export class Collector {
    constructor(private profile: ConfigProfile) {}

    async run() {
        
        log.debug("Collecting feed for user", this.profile.pubkey)
        log.debug("Fetching user profile from upstream:", this.profile.destination)

        const followEvent = await this.#dest.queryOne({
            authors: [this.profile.pubkey],
            kinds: [3], // user follows.
        })
        const follows = extractFollows(followEvent);
        log.info("found follows:", follows)

        const limit = 50 // TODO: option? runtime flag?
        for (const follow of follows) {
            await this.#copyEvents(follow.pubkey, limit)
        }

        // TODO: copy my own events too.
        // TODO: Copy follows references. (4x options from config)

    }
    async #copyEvents(pubkey: string, limit: number) {
        // TODO: make publish check for event before sending it. (optionally?)
        // TODO: Get preferred relays for a profile.
        log.info("Copying", limit, "events for", pubkey)
        for (const client of this.#profileSources(pubkey)) {
            const events = await client.querySimple({
                authors: [pubkey],
                limit,
            })
            for (const event of events) {
                await this.#dest.publish(event)
                log.info("copied", event.id)
            }
        }
    }

    #clients = new Map<string, Client>();

    /** get a cached client. Returns null if it has already closed its connection. */
    #getClient(url: string): Client|null {
        let client = this.#clients.get(url);
        if (client?.closed) { return null }
        if (client) { return client }

        client = Client.connect(url)
        this.#clients.set(url, client)
        return client
    }

    get #destURL(): string { return this.profile.destination }

    get #dest(): Client {
        const url = this.#destURL
        const client = this.#getClient(url)
        if (!client) {
            throw new Error(`Destination ${url} closed connection.`)
        }
        return client
    }


    // Hmm, this might be different per followed user. Not sure this is helpful.
    // TODO: Replace w/ something per-user.
    * #fallbackClients(): Generator<Client> {
        // return this.#relays.map(url => this.#getClient(url)).filter(notNull)
        const relays = (this.profile?.fallbackRelays?.relays ?? [])
        for (const url of relays) {
            const client = this.#getClient(url)
            if (!client) { continue }
            yield client
        }
    }

    /** According to a user's profile, where should we read their content from? */
    * #profileSources(pubkey: string): Generator<Client> {
        yield * this.#fallbackClients()
    }

    * #allClients(): Generator<Client> {
        yield this.#dest
        yield * this.#fallbackClients()
    }

    #profiles = new Map<string, nostr.Event|null>()

    async #getProfile(key: string): Promise<nostr.Event|null> {
        const profile = this.#profiles.get(key)
        if (profile || profile === null) {
            return profile
        }

        for (const client of this.#allClients()) {
            const profile = await client.getProfile(key)
            if (profile) {
                this.#profiles.set(key, profile)
                return profile
            }
        }

        return null


    }

    close() {
        this.#clients.forEach(c => c.close())
    }

    [Symbol.dispose]() {
        this.close()
    }
}

function notNull<T>(t: T|null): t is T {
    return t !== null
}

function extractFollows(event: nostr.Event | null): FollowInfo[] {
    const follows: FollowInfo[] = []
    const tags = event?.tags ?? []
    for (const tag of tags) {
        const [tagName, pubkey, relayURL, nickname] = tag;
        if (tagName != "p") { continue }
        follows.push({pubkey, relayURL, nickname})
    }
    
    return follows
}

type FollowInfo = {
    pubkey: string
    relayURL?: string
    nickname?: string
}


const log = {
    info: console.log,
    debug: console.log,
} as const