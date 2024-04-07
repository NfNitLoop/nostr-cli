/**
 * implementation for the `nt collect` command.
 * @module
 */

import { z } from "zod";
import * as toml from "jsr:@std/toml"
import * as nostr from "./nostr/nostr.ts"
import { Client, MultiClient } from "./nostr/client.ts"
import { lazy } from "@nfnitloop/better-iterators"

// I Guess this config isn't only used for `nt collect` anymore.
// TODO: Move it somewhere else?
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
    seckey: z.string().length(64).regex(/[0-9a-f]/g).optional(),
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

export type Options = {
    profile: ConfigProfile,
    limit?: number
    debug?: boolean
}


/**
 * Ties multiple clients together to help with collecting events from multiple places into one.
 */
export class Collector {

    private profile: ConfigProfile
    #limit: number
    #debug: boolean

    constructor(opts: Options) {
        this.profile = opts.profile
        this.#limit = opts.limit ?? 50
        this.#debug = opts.debug || false
    }

    async run() {    
        log.debug("Collecting feed for user", this.profile.pubkey)
        log.debug("Fetching user profile from upstream:", this.profile.destination)

        // Copy profiles first. 
        await this.#copyProfile(this.profile.pubkey)
        // Copy follows, because it may grant more permissions on the server:
        await this.#copyFollows(this.profile.pubkey)

        // Copy my events: (might include updates to follows)
        await this.#copyUserEvents(this.profile.pubkey, this.#limit)

        // Find out who I follow:
        const followEvent = await this.#dest.queryOne({
            authors: [this.profile.pubkey],
            kinds: [3], // user follows.
        })
        const follows = extractFollows(followEvent);
        log.info("found follows:", follows)

        for (const follow of follows) {
            await this.#copyUserEvents(follow.pubkey, this.#limit)
        }

        await this.#copyEventRefs()
        await this.#copyProfileRefs()
    }

    async #copyUserEvents(pubkey: string, limit: number) {
        log.info("Copying up to", limit, "events for", pubkey)
        for (const client of this.#profileSources(pubkey)) {
            const events = await client.querySimple({
                authors: [pubkey],
                limit,
            })
            for (const event of events) {
                if (await this.#tryPublish(event)) {
                    this.#saveRefs(event)
                }
            }
        }
    }

    // event IDs of references that were mentioned. 
    #eventsToCopy = new Set<string>()
    // Profile IDs that are referenced in events we copied.
    #profilesToCopy = new Set<string>()
    // TODO: "a" tag for replaceable events?

    #saveRefs(event: nostr.Event) {
        const events = event.tags?.filter(t => t[0] == "e")?.map(t => t[1])
        events?.forEach(r => this.#eventsToCopy.add(r))

        const pubkeys = event.tags?.filter(t => t[0] == "p")?.map(t => t[1])
        pubkeys?.forEach(p => this.#profilesToCopy.add(p))

        this.#profilesToCopy.add(event.pubkey)
    }

    /** Copy events that are referred to by this one. */
    async #copyEventRefs() {
        // Limited by the size of the REQ that servers will let us send:
        const chunkSize = 50

        const mc = MultiClient.forClients([...this.#fallbackClients()])
        
        const workers = lazy(this.#eventsToCopy).chunked(chunkSize).toAsync().map({
            parallel: 3,
            mapper: async (chunk) => {
                // TODO: warn about events we couldn't find?
                const events = await mc.getEvents(chunk)
                for (const event of events.values()) {
                    const ok = await this.#tryPublish(event)
                    if (ok) {
                        this.#profilesToCopy.add(event.pubkey)
                    }
                }
                return null
            }
        })

        for await (const _result of workers) {
            // Wait for everything to do its thing.
        }
        this.#eventsToCopy.clear()
    }

    async #copyProfileRefs() {
        const mc = MultiClient.forClients([...this.#fallbackClients()])
        const workers = lazy(this.#profilesToCopy).toAsync().map({
            parallel: 5,
            mapper: async (chunk) => {
                const profile = await mc.getProfile(chunk)
                if (profile) {
                    await this.#tryPublish(profile)
                }
                return null
            }
        })

        for await (const _result of workers) {
            // Wait for everything to do its thing.
        }
        this.#profilesToCopy.clear() 
    }

    async #copyProfile(pubkey: nostr.PubKey) {
        if (this.#copiedProfiles.has(pubkey)) {
            return
        }
        // Mark that we're copying the profile, to prevent stampede:
        this.#copiedProfiles.set(pubkey, 0);

        for (const client of this.#fallbackClients()) {
            const profile = await client.getProfile(pubkey)
            if (!profile) continue
            this.#copiedProfiles.set(pubkey, profile.created_at)
            const copied = await this.#tryPublish(profile)
            if (copied) {
                log.info("Copied profile for", pubkey, displayName(profile))
            }
            return
        }

        log.info("Couldn't find profile:", pubkey)
    }

    async #copyFollows(pubkey: nostr.PubKey) {
        for (const client of this.#fallbackClients()) { 
            const event = await client.getFollows(pubkey)
            if (!event) continue
            // TODO: use tryPublish.
            await this.#dest.publish(event)
            return
        }
    }

    async #tryPublish(event: nostr.Event): Promise<boolean> {
        if (this.#copiedEvents.has(event.id)) {
            return false
        }

        // Adding before we actually do the copy, to avoid race condition / stampede.
        this.#copiedEvents.add(event.id)
        const {published, isDuplicate} =  await this.#dest.tryPublish(event)
        
        const ok = published && !isDuplicate
        if (ok) {
            log.info("copied", event.id)
        }
        return ok
    }

    // Event IDs we've already copied. (or tried to).
    // TODO: Should probably be an LRU to keep from growing forever?
    #copiedEvents = new Set<string>()
    // A map of profiles we've already copied and the created_at timestmap.
    #copiedProfiles = new Map<string, number>()

    #clients = new Map<string, Client>()

    /** get a cached client. Returns null if it has already closed its connection. */
    #getClient(url: string): Client|null {
        let client = this.#clients.get(url);
        if (client?.closed) { return null }
        if (client) { return client }

        client = Client.connect(url)
        this.#clients.set(url, client)
        if (this.#debug) {
            client.withDebugLogging()
        }
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
    // Actually we need this for fetching an event w/ unknown pubkey.
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
        // TODO: Read profile, then fallback.
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

        // TODO: This implementation can end up racing the DB to fetch.
        // Use a proper cache + fetcher.

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

function displayName(profile: nostr.Event): string|null {
    if (profile.kind != 0) {
        return null
    }

    let json: Record<string, string> 
    try {
        json = JSON.parse(profile.content)
    } catch (_: unknown) {
        return "<parse error>"
    }

    return json.name || json.display_name || json.username || json.nip05
}
