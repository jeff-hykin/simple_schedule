import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.13"
import {
    denoExecutablePath,
    isRunningUnderDeno,
    specifierForAnotherProcess,
} from "../source/runtime_locations.js"
import { daemonCommandLine } from "../source/installer.js"
import { commandLineFor, jobFunctionEntryPath } from "../source/runner.js"
import { normalizeJob } from "../source/job_schema.js"

Deno.test("the test suite itself is running under Deno, not a compiled binary", () => {
    assertEquals(isRunningUnderDeno(), true)
    assertEquals(denoExecutablePath(), Deno.execPath())
})

Deno.test("a file URL becomes a plain path, and any other URL is passed through as-is", () => {
    assertEquals(specifierForAnotherProcess("file:///tmp/a%20b/main.js"), "/tmp/a b/main.js")
    assertEquals(
        specifierForAnotherProcess(
            "https://raw.githubusercontent.com/jeff-hykin/simple_schedule/master/main.js",
        ),
        "https://raw.githubusercontent.com/jeff-hykin/simple_schedule/master/main.js",
    )
    // this is the case that broke a URL install: fromFileUrl throws on anything but file:
    assertEquals(specifierForAnotherProcess("https://example.com/x.js").startsWith("https:"), true)
})

Deno.test("the daemon command line names something another process can start", () => {
    const argv = daemonCommandLine()
    assertEquals(argv[0], Deno.execPath())
    assertEquals(argv.slice(1, 4), ["run", "--allow-all", "--quiet"])
    assertStringIncludes(argv[4], "main.js")
    assertEquals(argv[5], "daemon")
})

Deno.test("a JavaScript job is launched with a real Deno, never with a compiled binary", () => {
    const argv = commandLineFor(normalizeJob({ id: "j", task: { type: "js", module: "/tmp/x.js" } }))
    assertEquals(argv[0], denoExecutablePath())
    assertEquals(argv[1], "run")
    assertStringIncludes(argv.join(" "), "job_function_entry.js")
})

Deno.test("the job wrapper resolves to something importable", () => {
    assertStringIncludes(jobFunctionEntryPath(), "job_function_entry.js")
})
