// These exercise the HTTP surface directly, against a throwaway state directory.
const stateDirectory = Deno.makeTempDirSync({ prefix: "simple_schedule_server_test_" })
Deno.env.set("SIMPLE_SCHEDULE_HOME", stateDirectory)

import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.13"
import { handleRequest } from "../source/server/server.js"

/**
 * @param {string} method
 * @param {string} path
 * @param {any} [body]
 * @returns {Promise<{status: number, body: any}>}
 */
async function call(method, path, body) {
    const response = await handleRequest(
        new Request(`http://localhost${path}`, {
            method,
            body: body === undefined ? undefined : JSON.stringify(body),
            headers: { "content-type": "application/json" },
        }),
    )
    const text = await response.text()
    let parsed = text
    try {
        parsed = JSON.parse(text)
    } catch (_error) {
        // static files are not JSON
    }
    return { status: response.status, body: parsed }
}

Deno.test("the GUI's own files are served", async () => {
    const page = await handleRequest(new Request("http://localhost/"))
    assertEquals(page.status, 200)
    assertStringIncludes(page.headers.get("content-type"), "text/html")
    assertStringIncludes(await page.text(), `<div id="shell">`)

    const script = await handleRequest(new Request("http://localhost/app.js"))
    assertEquals(script.status, 200)
    assertStringIncludes(script.headers.get("content-type"), "javascript")

    const style = await handleRequest(new Request("http://localhost/style.css"))
    assertEquals(style.status, 200)
    assertStringIncludes(style.headers.get("content-type"), "css")
})

Deno.test("a path that climbs out of the web directory is refused", async () => {
    const response = await handleRequest(new Request("http://localhost/../../main.js"))
    assertEquals([403, 404].includes(response.status), true)
})

Deno.test("the whole job lifecycle works over HTTP", async () => {
    const created = await call("POST", "/api/jobs", {
        id: "webjob",
        task: { type: "command", command: "echo from-the-web" },
        schedule: { kind: "daily", at: "09:00", timeZone: "utc" },
    })
    assertEquals(created.status, 201)
    assertEquals(created.body.id, "webjob")

    const listed = await call("GET", "/api/jobs")
    assertEquals(listed.status, 200)
    assertEquals(listed.body.map((job) => job.id), ["webjob"])
    assertEquals(listed.body[0].scheduleText, "daily at 09:00 UTC")

    const patched = await call("PATCH", "/api/jobs/webjob", { onFailure: { retries: 2 } })
    assertEquals(patched.status, 200)
    assertEquals(patched.body.onFailure.retries, 2)
    // a partial patch must not erase the rest of the policy
    assertEquals(patched.body.onFailure.backoff.initial, "30s")

    const triggered = await call("POST", "/api/jobs/webjob/trigger")
    assertEquals(triggered.status, 200)
    assertEquals(triggered.body.result.status, "success")

    const runs = await call("GET", "/api/jobs/webjob/runs")
    assertEquals(runs.body.length, 1)
    assertEquals(runs.body[0].status, "success")

    const stats = await call("GET", "/api/jobs/webjob/stats")
    assertEquals(stats.body.total, 1)
    assertEquals(stats.body.successes, 1)
    assertEquals(Array.isArray(stats.body.dailyHistory), true)

    const logs = await call("GET", "/api/jobs/webjob/logs")
    assertStringIncludes(logs.body.text, "from-the-web")

    const skipped = await call("POST", "/api/jobs/webjob/skip", { count: 3 })
    assertEquals(skipped.body.skipNext, 3)

    const paused = await call("POST", "/api/jobs/webjob/pause", { until: "2030-01-01T00:00:00.000Z" })
    assertEquals(paused.body.pausedUntil, "2030-01-01T00:00:00.000Z")
    const resumed = await call("POST", "/api/jobs/webjob/resume")
    assertEquals(resumed.body.pausedUntil, null)

    const overview = await call("GET", "/api/overview")
    assertEquals(overview.body.jobs.length, 1)
    assertEquals(typeof overview.body.stateDirectory, "string")
    assertEquals(Array.isArray(overview.body.runs), true)
    assertEquals(Array.isArray(overview.body.vocabulary.scheduleKinds), true)

    const removed = await call("DELETE", "/api/jobs/webjob?forgetHistory=true")
    assertEquals(removed.body.removed, "webjob")
    assertEquals((await call("GET", "/api/jobs")).body.length, 0)
})

Deno.test("a bad job comes back as 422 with every problem named", async () => {
    const response = await call("POST", "/api/jobs", {
        id: "bad id",
        task: { type: "command" },
        overlap: "whenever",
    })
    assertEquals(response.status, 422)
    assertEquals(response.body.problems.length >= 3, true)
    assertStringIncludes(response.body.problems.join("\n"), "id:")
    assertStringIncludes(response.body.problems.join("\n"), "task.command:")
    assertStringIncludes(response.body.problems.join("\n"), "overlap:")
})

Deno.test("asking for a job that is not there says which ones are", async () => {
    const response = await call("GET", "/api/jobs/ghost")
    assertEquals(response.status, 400)
    assertStringIncludes(response.body.error, `no job with id "ghost"`)
    assertStringIncludes(response.body.error, "known jobs are")
})

Deno.test("an unknown route is a 404", async () => {
    assertEquals((await call("GET", "/api/nope")).status, 404)
})

Deno.test("the schema endpoint hands back a valid example", async () => {
    const response = await call("GET", "/api/schema")
    assertEquals(response.status, 200)
    assertEquals(response.body.example.id, "nightly-backup")
    assertEquals(response.body.fields.includes("onFailure"), true)
})

globalThis.addEventListener("unload", () => {
    try {
        Deno.removeSync(stateDirectory, { recursive: true })
    } catch (_error) {
        // it may already be gone
    }
})
