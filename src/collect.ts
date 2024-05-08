/**
 * implementation for the `nt collect` command.
 * @module
 */

import type * as nostr from "./nostr/nostr.ts"
import { Client, MultiClient } from "./nostr/client.ts"
import { lazy } from "./_deps/better-iterators.ts"
import type { ConfigProfile } from "./config.ts";
import { KINDS } from "./nostr/nostr.ts";


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

        // TODO: Copy users' preferred relays.

        // Copy my events: (might include updates to follows)
        await this.#copyUserEvents(this.profile.pubkey, this.#limit)

        // Find out who I follow:
        const followEvent = await this.#dest.queryOne({
            authors: [this.profile.pubkey],
            kinds: [KINDS.k3_user_follows],
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

        // TODO: Move this to multiClient and let it dedupe event IDs from multiple upstreams.
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

    // Save references to profiles & other events we should copy for context.
    #saveRefs(event: nostr.Event) {
        const events = event.tags?.filter(t => t[0] == "e")?.map(t => t[1])
        events?.forEach(r => this.#eventsToCopy.add(r))

        const pubkeys = event.tags?.filter(t => t[0] == "p")?.map(t => t[1])
        pubkeys?.forEach(p => this.#profilesToCopy.add(p))

        this.#profilesToCopy.add(event.pubkey)
    }

    /** Copy events that were referred to by events in this copy. */
    async #copyEventRefs() {
        // Limited by the size of the REQ that servers will let us send:
        const chunkSize = 50

        const mc = MultiClient.forClients([...this.#fallbackClients()])
        
        const workers = lazy(this.#eventsToCopy).chunked(chunkSize).toAsync().map({
            parallel: 3,
            mapper: async (chunk) => {
                const events = await mc.getEvents(chunk)
                const missingEvents = chunk.filter(it => !events.has(it))
                for (const missing of missingEvents) {
                    console.warn("Skipping event ID we couldn't find:", missing)
                }

                for (const event of events.values()) {
                    const ok = await this.#tryPublish(event)
                    if (ok) {
                        this.#profilesToCopy.add(event.pubkey)
                    }
                }
                return null
            }
        })

        // TODO: There should be a method on LazyAsync to do this.
        for await (const _result of workers) {
            // Wait for everything to do its thing.
        }
        this.#eventsToCopy.clear()
    }

    async #copyProfileRefs() {
        const mc = MultiClient.forClients([...this.#fallbackClients()])
        const workers = lazy(this.#profilesToCopy).toAsync().map({
            // TODO: relay.nostr.band doesn't seem to like simultaneous requests?
            parallel: 1,
            mapper: async (pubkey) => {
                const profile = await mc.getProfile(pubkey)
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

    // Returns OK if the event was published and not a duplicate.
    async #tryPublish(event: nostr.Event): Promise<boolean> {
        if (this.#copiedEvents.has(event.id)) {
            return false // avoid duplicates
        }

        // Adding before we actually do the copy, to avoid race condition / stampede.
        this.#copiedEvents.add(event.id)
        const {published, isDuplicate} =  await this.#dest.tryPublish(event)
        
        const ok = published && !isDuplicate
        if (ok) {
            log.info("copied", event.id, `(kind ${event.kind})`)
        }
        return ok
    }

    // Event IDs we've already copied. (or tried to).
    // TODO: Should probably be an LRU to keep from growing forever?
    #copiedEvents = new Set<string>()
    // A map of profiles we've already copied and the created_at timestmap.
    #copiedProfiles = new Map<string, number>()

    #clients = new Map<string, Client>()

    // TODO: Move to MultiClient
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
        const relays = (this.profile?.sourceRelays?.relays ?? [])
        for (const url of relays) {
            const client = this.#getClient(url)
            if (!client) { continue }
            yield client
        }
    }

    /** According to a user's profile, where should we read their content from? */
    * #profileSources(_pubkey: string): Generator<Client> {
        // TODO: Read profile, then fallback.
        yield * this.#fallbackClients()
    }

    #profiles = new Map<string, nostr.Event|null>()



    close() {
        this.#clients.forEach(c => c.close())
    }

    [Symbol.dispose]() {
        this.close()
    }
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
