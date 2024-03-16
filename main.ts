
import { Client } from "./src/nostr/client.ts";

const knownRelays = [
  "relay.nostr.band",
  "relay.damus.io",
  "nos.lol",
]

async function main() {
    const client = new Client(`wss://${knownRelays[0]}`)

    client.firehose()

    await client.awaitClose()
}

if (import.meta.main) { await main() }
