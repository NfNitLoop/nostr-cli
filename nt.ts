/**
 * `nt`: NOSTR Tools CLI
 * ===================
 * 
 * @module
 */


import { ArgumentValue, Command, Type, ValidationError } from "@cliffy/command"

import { generateSecretKey, getPublicKey, nip05, nip19 } from "@nostr/tools"
import { Client } from "./src/nostr/client.ts"
import * as cli from "./src/nostr/client_messages.ts"
import * as collect from "./src/collect.ts"
import { EventObj } from "./src/nostr/nostr.ts";

async function main() {
    await parse_args(Deno.args)
}

async function parse_args(args: string[]) {
    const cmd = new Command()
        .name("nt")
        .description("nt: NOSTR Tools CLI")
        .default("help")

    cmd.command("help")
        .description("Show help")
        .action(() => {
            cmd.showHelp()
        })

    cmd.command("decode [value:string]")
        .description("Decode a TODO")
        .action(nt_decode)

    cmd.command("lookup [value:string]")
        .description("Lookup a TODO")
        .action(nt_lookup)

    cmd.command("generate")
        .description("Generate a new keypair")
        .action(nt_generate)

    cmd.command("copy <pubkey:string> <from:string> <to:string>")
        .description("Copy from one relay to another")
        .option("--limit <max:number>", "Limit the number of events to copy", {default: 1})
        .action(nt_copy)

    cmd.command("query <relayURL:string>")
        .type("pubkey", new PubKeyType())
        .description("Fetch some events from a relay")
        .option("--limit <max:number>", "Limit the number of events to query")
        .option("--kinds <kinds:number[]>", "Which event kinds to query")
        .option("--ids <ids:pubkey[]>", "Which event kinds to query")
        .option("--authors <authors:pubkey[]>", "Limit results to these authors.")
        .option("--debug", "enable debug logging", {default: false})
        .action(nt_query)

    cmd.command("collect <profileName:string>")
        .description("Collect a user's follow feed onto one server.")
        .option("--limit <max:number>", "Limit the number of events from each follow.")
        .option("--config <file:string>", "The config file to load.", {default: "nt.toml"})
        .option("--debug", "enable debug logging", {default: false})
        .action(nt_collect)

    cmd.command("info <relayUrl:string>")
        .description("Fetch a server's NIP-11 information document")
        .action(nt_info)
    

    await cmd.parse(args)

}

class PubKeyType extends Type<string> {

    private static PAT = /^[0-9a-f]{64}$/ // 32 bytes as hex

    public parse({label, name, value}: ArgumentValue): string {
        if (!value.match(PubKeyType.PAT)) {
            throw new ValidationError(
                `${label} "${name}" must be 64 hexadecimal digits.`
            )
        }

        return value
    }
}



function nt_decode(_opts: unknown, value?: string) {
    if (!value) {
        value = prompt("Value?", "")!
    }
    const out = nip19.decode(value)
    console.log(out)
}


async function nt_lookup(_opts: unknown, value?: string) {
    if (!value) {
        value = prompt("Username?: ", "")!
    }
    const out = await nip05.queryProfile(value)
    console.log(out)
}

function nt_generate() {
    const sec = generateSecretKey()
    const pub = getPublicKey(sec)

    console.log(nip19.nsecEncode(sec))
    console.log(nip19.npubEncode(pub))

}

async function nt_copy(_syncOpts: SyncOpts, pubkey: string, from: string, to: string) {
    using source = Client.connect(normalizeWSS(from)) //.withDebugLogging()
    using dest = Client.connect(normalizeWSS(to)) //.withDebugLogging()

    const filter = {
        authors: [pubkey],
        limit: 50,
    }

    const sourceEventsPromise = source.querySimple(filter)

    // I'd prefer to just write the events to `dest` and let it NO-OP the duplicates.
    // However, relay implementations seem to be stingy with writes (even if they were NO-OPs),
    // and more forgiving with reads. So we do a read and only send items we didn't find.

    // TODO: One implementation sent a NOTICE that I was going too fast, and then seemed to black-hole the connection.
    // How to deal with that?

    // TODO: Instead of reading up-front, maybe use COUNT to check if events exist at the destination?

    const destEventIDs = new Set(
        (await dest.querySimple(filter))
        .map(it => it.id)
    )
    
    const sourceEvents = await sourceEventsPromise
    console.debug(`Found ${sourceEvents.length} source events`)
    const newEvents = sourceEvents.filter(it => !destEventIDs.has(it.id))
    console.debug(`Found ${newEvents.length} new events`)

    let count = 0
    for (const event of newEvents) {
        const published = await dest.tryPublish(event)
        if (published) {
            console.log(`Published ${event.id}`)
            count++
        } else {
            console.log(`Not published: ${event.id} kind: ${event.kind}`)
        }
    }

    console.log(`Published ${count} events`)

    // TODO: Add a --feed option that syncs any content/mentions from people the user follows.
    // NIP-18 reposts: k6, k1+q, k16
    // NIP-1: k0, k1, k3, 
}

type QueryOptions = {
    kinds?: number[]
    authors?: string[]
    ids?: string[]
    limit?: number
    debug: boolean
}

async function nt_query(opts: QueryOptions, wssURL: string) {
    using client = Client.connect(wssURL)
    if (opts.debug) {
        client.withDebugLogging()
    }
    const filter: cli.Filter = {
        kinds: opts.kinds,
        limit: opts.limit,
        authors: opts.authors,
        ids: opts.ids,
    }
    
    for await (const event of client.querySaved(filter)) {
        console.log("")
        console.log("---")
        const eObj = new EventObj(event)
        console.log(eObj.toString())
        if (!eObj.validate()) {
            console.error("❌❌❌ Invalid signature!")
        }

    }
}

function normalizeWSS(url: string): string {
    if (!url.includes("//")) {
        return `wss://${url}`
    }

    return url
}

type SyncOpts = {
    limit: number
}

async function nt_collect(opts: CollectOptions, profileName: string) {
    const config = await collect.loadConfig(opts.config)
    const profile = config.get(profileName)
    if (!profile) {
        throw new Error(`No such profile name: ${profileName}`)
    }

    using c = new collect.Collector({
        profile,
        limit: opts.limit,
        debug: opts.debug
    })
    await c.run()
}

async function nt_info(_opts: unknown, url: string) {
    url = normalizeWSS(url)
    const info = await Client.fetchInfo(url)
    console.log(JSON.stringify(info, undefined, 4))
}


type CollectOptions = {
    limit?: number
    config: string
    debug: boolean
}


if (import.meta.main) { await main() }

