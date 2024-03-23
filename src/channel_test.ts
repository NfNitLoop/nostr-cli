import { delay } from "@std/async";
import { Channel } from "./channel.ts"



Deno.test({
    name: "test",
    fn: async () => {
        const ch = new Channel<string>();

        (async () => {
            ch.send("foo")
            await delay(500)
            ch.send("bar")
            ch.send("baz")
            await delay(500)
            ch.close()
        })()

        for await (const val of ch) {
            console.log(val)
        }
        console.log("Done")
    }
})