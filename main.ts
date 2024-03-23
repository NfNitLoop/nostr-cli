
import { Client } from "./src/nostr/client.ts";
import { EVENT_TYPES, EventObj } from "./src/nostr/nostr.ts";

const knownRelays = [
    "relay.nostr.band",
    "relay.damus.io",
    "nos.lol",
]

async function main() {
    using client = Client.connect(`wss://${knownRelays[0]}`, {
        listeners: [
            {
                gotMessage(message: unknown) {
                    console.log("gotMessage:", JSON.stringify(message, null, 4))
                }
            }
        ]
    })

    // client.firehose()
    // await client.awaitClose()

    // const events = await client.queryOnce({
    //     kinds: [0, 1]
    //     //     // EVENT_TYPES.meta
    //     //     EVENT_TYPES.longForm,
    //     // ],
    //     // authors: [
    //     //     // Cody:
    //     //     "dc4312e46b0e382105d154290c419e606a732004cd720def192100b915a1b9ac"
    //     // ],
    //     // "#t": ["esperanto"]
    // })

    const filter = {
        kinds: [0, 1]
    }


    for await (const msg of client.query(filter)) {
        console.log("---")
        const [msgType] = msg
        if (msgType == "EVENT") {
            const [_msgType, _subID, event] = msg
            console.log(new EventObj(event).toString())
            continue
        }
        console.log(JSON.stringify(msg))
    }

}

if (import.meta.main) { await main() }
