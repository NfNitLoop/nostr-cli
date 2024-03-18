/**
 * `nt`: NOSTR Tools CLI
 * ===================
 * 
 * @module
 */

import { Command } from "@cliffy/command"

import { generateSecretKey, getPublicKey, nip05, nip19 } from "@nostr/tools"

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


if (import.meta.main) { await main() }