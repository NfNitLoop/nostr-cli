import { EventTemplate, finalizeEvent} from "@nostr/tools";
import * as nostr from "./nostr.ts"
import { decodeHex } from "@std/encoding/hex";

/**
 * Something that allows us to sign messages.
 * Could be local or remote.
 */
export type Signer = {
    sign: (message: EventTemplate) => Promise<nostr.Event>,
    // getPubKey: () => Promise<nostr.PubKey>,
}

/**
 * Just sign in-memory. This is less secure than using a remote signer.
 */
export class LocalSigner implements Signer {
    #secret: Uint8Array;

    constructor(readonly pubkey: nostr.PubKey, seckey: string) {
        this.#secret = decodeHex(seckey)
    }
    // deno-lint-ignore require-await
    async sign(message: EventTemplate): Promise<nostr.Event> {
        // Types don't quite fully align here:
        const event = finalizeEvent(message, this.#secret) as unknown as nostr.Event
        return event
    }
}