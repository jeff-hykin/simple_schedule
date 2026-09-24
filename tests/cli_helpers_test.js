import { assertEquals, assertStringIncludes, assertThrows } from "jsr:@std/assert@1.0.13"
import { jobInputFromFlags, mergeJobInput, parseEnvironmentPairs } from "../source/cli_helpers.js"

Deno.test("only the flags that were given end up in the job input", () => {
    assertEquals(jobInputFromFlags({}), {})
    assertEquals(jobInputFromFlags({ id: "a" }), { id: "a" })
})

Deno.test("a command flag becomes a command task", () => {
    assertEquals(jobInputFromFlags({ id: "a", command: "echo hi" }), {
        id: "a",
        task: { type: "command", command: "echo hi" },
    })
})

Deno.test("a js-module flag becomes a js task with its defaults", () => {
    assertEquals(jobInputFromFlags({ jsModule: "/tmp/x.js" }).task, {
        type: "js",
        module: "/tmp/x.js",
        export: "default",
        arguments: [],
    })
    assertEquals(
        jobInputFromFlags({ jsModule: "/tmp/x.js", jsExport: "run", jsArguments: `[1,"two"]` }).task,
        {
            type: "js",
            module: "/tmp/x.js",
            export: "run",
            arguments: [1, "two"],
        },
    )
})

Deno.test("asking for both a command and a function is an error", () => {
    assertThrows(() => jobInputFromFlags({ command: "true", jsModule: "/tmp/x.js" }), Error, "not both")
})

Deno.test("the schedule flag accepts the shorthands", () => {
    assertEquals(jobInputFromFlags({ schedule: "every 7h" }).schedule, { kind: "interval", every: "7h" })
    assertEquals(jobInputFromFlags({ schedule: "daily at 9am", timeZone: "utc" }).schedule, {
        kind: "daily",
        at: "9am",
        timeZone: "utc",
    })
    // an interval has no wall clock to anchor, so a time zone is simply not added to it
    assertEquals(jobInputFromFlags({ schedule: "every 7h", timeZone: "utc" }).schedule.timeZone, undefined)
})

Deno.test("environment flags collect into one environment object", () => {
    assertEquals(
        jobInputFromFlags({ env: ["A=1", "B=two=2"], unsetEnv: ["PATH"], inheritEnv: false }).environment,
        {
            variables: { A: "1", B: "two=2" },
            inherit: false,
            remove: ["PATH"],
        },
    )
})

Deno.test("parseEnvironmentPairs rejects something that is not a pair", () => {
    assertThrows(() => parseEnvironmentPairs(["NOPE"]), Error, "NAME=value")
    assertThrows(() => parseEnvironmentPairs(["=value"]), Error, "NAME=value")
})

Deno.test("failure flags collect into one onFailure object", () => {
    assertEquals(
        jobInputFromFlags({ retries: 3, backoff: "fixed", backoffInitial: "10s", thenRun: "cleanup" })
            .onFailure,
        { retries: 3, backoff: { kind: "fixed", initial: "10s" }, thenRun: "cleanup" },
    )
})

Deno.test("flags win over the same field in a --json-file definition", () => {
    const merged = mergeJobInput(
        { id: "fromJson", task: "echo json", onFailure: { retries: 1, thenRun: "x" } },
        { id: "fromFlag", onFailure: { retries: 9 } },
    )
    assertEquals(merged.id, "fromFlag")
    assertEquals(merged.task, "echo json")
    // nested objects merge, so a flag can change one setting without erasing the rest
    assertEquals(merged.onFailure, { retries: 9, thenRun: "x" })
})

Deno.test("a typo in the JSON is caught before anything is written", () => {
    const error = assertThrows(() => mergeJobInput({ id: "a", scedule: "daily" }, {}), Error)
    assertStringIncludes(error.message, "unknown field in the JSON: scedule")
    assertStringIncludes(error.message, "allowed fields are")
})
