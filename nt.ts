/**
 * `nt`: NOSTR Tools CLI
 * ===================
 * 
 * @module
 */


import { type ArgumentValue, Command, Type, ValidationError } from "./src/_deps/cliffy/command.ts"

import { generateSecretKey, getPublicKey, nip05, nip19 } from "./src/_deps/nostr-tools.ts"
import { Client } from "./src/nostr/client.ts"
import type * as cli from "./src/nostr/client_messages.ts"
import * as collect from "./src/collect.ts"
import { EventObj } from "./src/nostr/nostr.ts";
import { encodeHex } from "jsr:@std/encoding@^0.219.1/hex";
import { type EncodeOptions, encodeFile } from "./src/nostr/nip95.ts";
import * as blob from "./src/blob.ts"
import { LocalSigner } from "./src/nostr/signer.ts";
import { basename, extname } from "jsr:@std/path"
import { contentType as mimeType } from "jsr:@std/media-types/content-type";
import { DEFAULT_CONFIG, loadConfig } from "./src/config.ts";

async function main() {
    await parse_args(Deno.args)
}

async function parse_args(args: string[]) {
    const cmd = new Command()
        .name("nt")
        .description("nt: NOSTR Tools CLI")
        .globalOption("--config <file:string>", "The config file to load.", {default: DEFAULT_CONFIG})
        .globalOption("--debug", "enable debug logging", {default: false})


    addHelp(cmd)

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
        .option("--limit <max:number>", "Limit the number of events to copy", {default: 10})
        .action(nt_copy)

    cmd.command("query <relayURL:string>")
        .type("pubkey", new PubKeyType())
        .description("Fetch some events from a relay")
        .option("--limit <max:number>", "Limit the number of events to query")
        .option("--kinds <kinds:number[]>", "Which event kinds to query")
        .option("--ids <ids:pubkey[]>", "Which event kinds to query")
        .option("--authors <authors:pubkey[]>", "Limit results to these authors.")
        .option("--count", "Instead of querying messages, just get their count.", {default: false})
        .action(nt_query)

    cmd.command("collect <profileName:string>")
        .description("Collect a user's follow feed onto one server.")
        .option("--limit <max:number>", "Limit the number of events from each follow.")
        .action(nt_collect)
        

    cmd.command("info <relayUrl:string>")
        .description("Fetch a server's NIP-11 information document")
        .action(nt_info)

    cmd.command("send <dest:string>")
        .description("Send a single event to a relay")
        .action(nt_send)


    const file = new Command<GlobalOptions>()
        .description("Operate on NIP-95 files.")
    addHelp(file)
    cmd.command("file", file)


    file.command("upload <filePath:string>")
        .description("Upload a (possibly multi-part) NIP-95 file")
        .option("--as <profileName:string>", "config profile to use to upload", {"required": true})
        .option("--debug", "enable debug logging", {default: false})
        .action(nt_upload)

    file.command("ls <relayUrl:string>")
        .description("List NIP-95 file metadata (kind 1065)")
        .type("pubkey", new PubKeyType())
        // TODO some way to extract this repetition (w/o resorting to GlobalOptions)
        .option("--limit <max:number>", "Limit the number of events to query")
        .option("--kinds <kinds:number[]>", "Which event kinds to query")
        .option("--ids <ids:pubkey[]>", "Which event kinds to query")
        .option("--authors <authors:pubkey[]>", "Limit results to these authors.")
        //
        .option("--named", "Limit results to files that have a fileName.")
        .option("--minSize <bytes:number>", "Minimum size of files to show.")
        .option("--maxSize <bytes:number>", "Maximum size of files to show.")
        .action(nt_file_ls)

    await cmd.parse(args)

}

function addHelp<
    // TODO: Would be nice if there were a way to re-use this more tersely?
    TParentCommandGlobals extends Record<string, unknown> | void,
    TParentCommandTypes extends Record<string, unknown> | void,
    TCommandOptions extends Record<string, unknown> | void,
    TCommandArguments extends Array<unknown>,
    TCommandGlobals extends Record<string, unknown> | void,
    TCommandTypes extends Record<string, unknown> | void,
    TCommandGlobalTypes extends Record<string, unknown> | void,
    // deno-lint-ignore no-explicit-any -- matching Command's type here.
    TParentCommand extends Command<any> | undefined
>(command: Command<TParentCommandGlobals, TParentCommandTypes, TCommandOptions, TCommandArguments, TCommandGlobals, TCommandTypes, TCommandGlobalTypes, TParentCommand>)
{
    command.default("help")

    command.command("help")
        .description("Show this help")
        .action(() => {
            command.showHelp()
        })
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

    console.log(nip19.npubEncode(pub), pub)
    console.log(nip19.nsecEncode(sec), encodeHex(sec))

}

// TODO: Right now, this is a special case for a 1:1 copy.
// BUT, maybe we could make it work in the "collect" mode to avoid 2 separate code paths?
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

    // NIP-18 reposts: k6, k1+q, k16
    // NIP-1: k0, k1, k3, 
}

type FilterOptions = {
    kinds?: number[]
    authors?: string[]
    ids?: string[]
    limit?: number
}

type QueryOptions = FilterOptions & GlobalOptions & {
    count: boolean
}

async function nt_query(opts: QueryOptions, wssURL: string) {
    using client = Client.connect(normalizeWSS(wssURL))
    
    if (opts.debug) {
        client.withDebugLogging()
    }
    const filter = filter_from(opts)

    if (opts.count) {
        const count = await client.queryCount(filter)
        console.log(count.count)
        return
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

function filter_from(opts: FilterOptions): cli.Filter {
    return {
        kinds: opts.kinds,
        limit: opts.limit,
        authors: opts.authors,
        ids: opts.ids
    }
}

type GlobalOptions = {
    config: string
    debug: boolean
}

type UploadOptions = GlobalOptions & {
    as: string,
}

async function nt_upload(opts: UploadOptions, filePath: string) {
    const config = await loadConfig(opts.config)
    const profile = config.get(opts.as)
    if (!profile) {
        throw new Error(`No such profile name: ${opts.as}`)
    }

    if (!profile.seckey) {
        throw new Error(`Uploading files reqiures that you specify a "seckey" for this profile.`)
    }

    const signer = new LocalSigner(profile.pubkey, profile.seckey)

    using file = await Deno.open(filePath)
    using client = Client.connect(profile.destination)

    const fileOpts: EncodeOptions = {
        file: await blob.wrap(file),
        fileName: basename(filePath),
        maxMessageSize: 128 * 1024, // TODO: Try asking the server for it, if user didn't specify.
        signer,
        mimetype: mimeType(extname(filePath)),
    }


    for await (const event of encodeFile(fileOpts)) {
        await client.publish(event)
        console.log("published", event.id, "kind:", event.kind)
    }

    console.log("Done.")
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
    const config = await loadConfig(opts.config)
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

type SendArgs = {
    debug: boolean
}

async function nt_send(args: SendArgs, dest: string) {
    using client = Client.connect(normalizeWSS(dest))
    if (args.debug) {
        client.withDebugLogging()
    }

    const json = prompt("json? ")
    const obj = JSON.parse(json!)

    // deno-lint-ignore no-explicit-any
    const result = await client.publish(obj as unknown as any)
    console.log({result})
}


if (import.meta.main) { await main() }


type FileLsOpts = GlobalOptions & FilterOptions & { 
    named?: boolean
    minSize?: number
}

async function nt_file_ls(args: FileLsOpts, relayUrl: string): Promise<void> {
    using client = Client.connect(normalizeWSS(relayUrl))
    if (args.debug) {
        client.withDebugLogging()
    }
    const filter = filter_from(args)

    filter.kinds = [1065]

    let count = 0

    for await (const rawEvent of client.querySaved(filter)) {
        const event = new EventObj(rawEvent)
        if (args.named && !event.fileName) { continue }

        const size = event.size
        if (args.minSize && (!size || size < args.minSize)) { continue }

        count++
        console.log("")
        event.showKind1065()
        if (!event.validate()) {
            console.error("❌❌❌ Invalid signature!")
        }
    }

    console.log()
    console.log("count:", count)

}
