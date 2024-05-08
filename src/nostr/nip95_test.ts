import { assertEquals, assertLessOrEqual } from "jsr:@std/assert@^0.219.1";
import {EVENT_OVERHEAD, type EncodeOptions, encodeFile} from "./nip95.ts"
import type * as nostr from "./nostr.ts"
import { LocalSigner } from "./signer.ts";
import {decodeBase64} from "../_deps/std/encoding/base64.ts"
import { lazy } from "../_deps/better-iterators.ts";


Deno.test({
    name: "test message size",
    fn() {
        const encodedSize = JSON.stringify(exampleMessage).length
        assertEquals(encodedSize, EVENT_OVERHEAD)
    }
})

// The overhead that every message must include.
// See: https://github.com/nostr-protocol/nips/blob/master/01.md
const exampleMessage = {
    id: "82a4a84ca26e47fb041606f6e6baba3dc5c82a74bc9921a70c909c52067e5351",
    pubkey: "82a4a84ca26e47fb041606f6e6baba3dc5c82a74bc9921a70c909c52067e5351",
    sig: "82a4a84ca26e47fb041606f6e6baba3dc5c82a74bc9921a70c909c52067e535182a4a84ca26e47fb041606f6e6baba3dc5c82a74bc9921a70c909c52067e5351",
    kind: 1064, // or 1065,
    created_at: Math.floor(Date.now() / 1000),
    tags: [], // TODO: This might not be required?
    content: ""
}

Deno.test(async function encodeBigFile() {
    const maxMessageSize = 16 * 1024
    const fileSize = 64 * 1024;
    const file = new Blob([new Uint8Array(fileSize)])

    const signer = testSigner

    const opts: EncodeOptions = {
        file,
        description: "description",
        fileName: "myFile.zeroes",
        maxMessageSize,
        signer,
        mimetype: "application/octet-stream",
    }

    let metaEvent: nostr.Event | null = null
    const otherEvents: {id: string, blockSize: number}[] = []

    for await (const event of encodeFile(opts)) {
        if (!metaEvent) {
            metaEvent = event
        } else {
            otherEvents.push({
                id: event.id,
                blockSize: decodeBase64(event.content).length
            })
        }

        assertEquals(event.pubkey, signer.pubkey)
        const eventSize = JSON.stringify(event).length
        assertLessOrEqual(eventSize, maxMessageSize)
        assertEquals(event.id.length, 64)
        assertEquals(event.sig.length, 128)
    }

    const metaEventIDs = metaEvent!.tags.filter(t => t[0] == "e").map(t => t[1])
    const contentIDs = otherEvents.map(it => it.id)
    assertEquals(metaEventIDs, contentIDs)

    assertEquals(fileSize, lazy(otherEvents).map(it => it.blockSize).sum())

    // Every block before the last should have the block size
    // declared in the meta event:
    const blockSize = Number.parseInt(singleTag("blockSize", metaEvent!))
    for (const event of otherEvents.slice(0, -1)) {
        assertEquals(event.blockSize, blockSize)
    }

    const hash = singleTag("x", metaEvent!)
    assertEquals(hash.length, 64)
    assertEquals(hash, "de2f256064a0af797747c2b97505dc0b9f3df0de4f489eac731c23ae9ca9cc31")
})

function singleTag(name: string, event: nostr.Event) {
    const tags = event.tags.filter(t => t[0] == name)
    assertEquals(tags.length, 1)
    return tags[0][1]
}

const testSigner = new LocalSigner(
    // npub1s2j2sn9zderlkpqkqmmwdw468hzus2n5hjvjrfcvjzw9ypn72dgsap98ul
    "82a4a84ca26e47fb041606f6e6baba3dc5c82a74bc9921a70c909c52067e5351",
    // nsec17h07w75f9xq59ck5vn9yx6zgtj9j8qjupqhldxlgq5u0nqxyq0wqd0jyld
    "f5dfe77a89298142e2d464ca4368485c8b23825c082ff69be80538f980c403dc",
)

