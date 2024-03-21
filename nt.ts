/**
 * `nt`: NOSTR Tools CLI
 * ===================
 * 
 * @module
 */


import { Command } from "@cliffy/command"

import { generateSecretKey, getPublicKey, nip05, nip19 } from "@nostr/tools"
import { Client } from "./src/nostr/client.ts"

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

    cmd.command("sync <pubkey:string> <from:string> <to:string>")
        .description("Copy from one relay to another")
        .option("--limit <max:number>", "Limit the number of events to copy", {default: 1})
        .action(nt_sync)

    await cmd.parse(args)

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

async function nt_sync(syncOpts: SyncOpts, pubkey: string, from: string, to: string) {
    using source = Client.connect(normalizeWSS(from)) //.withDebugLogging()
    using dest = Client.connect(normalizeWSS(to)) //.withDebugLogging()

    const filter = {
        authors: [pubkey],
    }

    const sourceEventsPromise = source.query(filter)

    // I'd prefer to just write the events to `dest` and let it NO-OP the duplicates.
    // However, relay implementations seem to be stingy with writes (even if they were NO-OPs),
    // and more forgiving with reads. So we do a read and only send items we didn't find.

    // TODO: On implementation sent a NOTICE that I was going too fast, and then seemed to black-hole the connection.
    // How to deal with that?

    const destEventIDs = new Set(
        (await dest.query(filter))
        .map(it => it.id)
    )
    
    const sourceEvents = await sourceEventsPromise
    console.debug(`Found ${sourceEvents.length} source events`)
    const newEvents = sourceEvents.filter(it => !destEventIDs.has(it.id))
    console.debug(`Found ${newEvents.length} new events`)


    for (const event of newEvents) {
        await dest.publish(event)
        console.log(`Published ${event.id}`)
    }

    console.log(`Published ${newEvents.length} events`)
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


if (import.meta.main) { await main() }