/**
 * Types & Utils for loading the `nt` CLI config file.
 * 
 * @module
 */

import * as toml from "./_deps/std/toml.ts"
import { z } from "./_deps/zod.ts"

export const DEFAULT_CONFIG = "nt.toml"

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
    checkRelaySetName(config.default.sourceRelays)

    const profiles = new Map<string, ConfigProfile>()
    for (const p in config.profiles) {
        const prof = config.profiles[p]
        checkRelaySetName(prof.sourceRelays)
        const merged = {
            ...config.default,
            ...prof,
        }
        let sourceRelays: undefined|RelaySet = undefined
        if (merged.sourceRelays) {
            sourceRelays = config.relaySets?.[merged.sourceRelays]
        }
        profiles.set(p, ConfigProfile.parse({
            ...merged,
            sourceRelays
        }))
    }

    return profiles
}

const decodeUtf8 = new TextDecoder()

const WSURL = z.string().url()
const DefaultTrue = z.boolean().optional().default(true)



export type RelaySet = z.infer<typeof RelaySet>
const RelaySet = z.strictObject({
    relays: WSURL.array()
})

type Defaults = z.infer<typeof Defaults>
const Defaults = z.strictObject({
    destination: WSURL.optional(),
    fetchMine: DefaultTrue,
    fetchFollows: DefaultTrue,
    fetchMyRefs: DefaultTrue,
    fetchFollowsRefs: DefaultTrue,
    sourceRelays: z.string().min(1).optional(),
})


export type Profile = z.infer<typeof Profile>
const Profile = z.strictObject({
    pubkey: z.string().length(64).regex(/[0-9a-f]/g),
    seckey: z.string().length(64).regex(/[0-9a-f]/g).optional(),
    destination: WSURL.optional(),
    fetchMine: z.boolean().optional(),
    fetchFollows: z.boolean().optional(),
    fetchMyRefs: z.boolean().optional(),
    fetchFollowsRefs: z.boolean().optional(),
    sourceRelays: z.string().min(1).optional(),
})


// After we fill in defaults, profiles should pass:
export type ConfigProfile = z.infer<typeof ConfigProfile>
const ConfigProfile = Profile.merge(z.strictObject({
    destination: WSURL,
    fetchMine: z.boolean(),
    fetchFollows: z.boolean(),
    fetchMyRefs: z.boolean(),
    fetchFollowsRefs: z.boolean(),
    sourceRelays: RelaySet
}))



export type Config = z.infer<typeof Config>
export const Config = z.strictObject({
    default: Defaults,
    profiles: z.record(z.string().min(1), Profile),
    relaySets: z.record(z.string().min(1), RelaySet).optional(),
})
