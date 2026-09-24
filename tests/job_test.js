import { assertEquals, assertMatch, assertStringIncludes, assertThrows } from "jsr:@std/assert@1.0.13"
import { join } from "jsr:@std/path@1.1.2"
import { backoffDelayFor, JobValidationError, normalizeJob } from "../source/job_schema.js"
import { JobStore, nextRunForJob, RunStore } from "../source/store.js"
import { commandLineFor, environmentFor, runJob, runOnce } from "../source/runner.js"

/**
 * Every test gets its own throwaway state directory.
 * @param {(context: {directory: string, jobStore: JobStore, runStore: RunStore}) => Promise<void>|void} body
 */
async function withTemporaryState(body) {
    const directory = Deno.makeTempDirSync({ prefix: "simple_schedule_test_" })
    const jobStore = new JobStore(join(directory, "jobs.json"))
    const runStore = new RunStore(join(directory, "runs.sqlite"))
    try {
        await body({ directory, jobStore, runStore })
    } finally {
        runStore.close()
        Deno.removeSync(directory, { recursive: true })
    }
}

Deno.test("normalizeJob needs only an id and a task", () => {
    const job = normalizeJob({ id: "hello", task: "echo hi" })
    assertEquals(job.id, "hello")
    assertEquals(job.task, { type: "command", command: "echo hi", shell: "/bin/sh" })
    assertEquals(job.schedule, { kind: "manual" })
    assertEquals(job.enabled, true)
    assertEquals(job.overlap, "skip")
    assertEquals(job.onFailure.retries, 0)
    assertEquals(job.activation, { onBoot: false, onLogin: false })
    assertEquals(job.environment, { inherit: true, variables: {}, remove: [] })
    assertMatch(job.log.path, /hello\.log$/)
})

Deno.test("normalizeJob reports every problem at once, naming each field", () => {
    const error = assertThrows(
        () =>
            normalizeJob({
                id: "not a valid id",
                task: { type: "command" },
                schedule: { kind: "daily", timeZone: "Mars/Olympus" },
                overlap: "whenever",
                onFailure: { retries: -1, backoff: { initial: "soon" } },
            }),
        JobValidationError,
    )
    const text = error.message
    assertStringIncludes(text, "id:")
    assertStringIncludes(text, "task.command:")
    assertStringIncludes(text, "schedule:")
    assertStringIncludes(text, "overlap:")
    assertStringIncludes(text, "onFailure.retries:")
    assertStringIncludes(text, "onFailure.backoff.initial:")
})

Deno.test("normalizeJob rejects an unknown field and lists the allowed ones", () => {
    const error = assertThrows(
        () => normalizeJob({ id: "a", task: "echo hi", scedule: "daily" }),
        JobValidationError,
    )
    assertStringIncludes(error.message, "unknown field: scedule")
    assertStringIncludes(error.message, "allowed fields are")
})

Deno.test("normalizeJob defaults a js task sensibly", () => {
    const job = normalizeJob({ id: "j", task: { type: "js", module: "/tmp/x.js" } })
    assertEquals(job.task.export, "default")
    assertEquals(job.task.arguments, [])
    assertEquals(job.task.permissions, ["--allow-all"])
})

Deno.test("backoffDelayFor grows exponentially and respects the cap", () => {
    const policy = normalizeJob({
        id: "b",
        task: "true",
        onFailure: { retries: 5, backoff: { kind: "exponential", initial: "10s", max: "1m", multiplier: 2 } },
    }).onFailure
    assertEquals(backoffDelayFor(policy, 1), 10000)
    assertEquals(backoffDelayFor(policy, 2), 20000)
    assertEquals(backoffDelayFor(policy, 3), 40000)
    assertEquals(backoffDelayFor(policy, 4), 60000)
    assertEquals(backoffDelayFor(policy, 9), 60000)
})

Deno.test("backoffDelayFor stays flat when the policy is fixed", () => {
    const policy = normalizeJob({
        id: "b",
        task: "true",
        onFailure: { backoff: { kind: "fixed", initial: "30s" } },
    }).onFailure
    assertEquals(backoffDelayFor(policy, 1), 30000)
    assertEquals(backoffDelayFor(policy, 4), 30000)
})

Deno.test("JobStore adds, reads back, updates, and removes", async () => {
    await withTemporaryState(({ jobStore }) => {
        assertEquals(jobStore.all(), [])
        jobStore.add({ id: "one", task: "echo one", schedule: "every 1h" })
        jobStore.add({ id: "two", task: "echo two" })
        assertEquals(jobStore.all().map((job) => job.id), ["one", "two"])

        jobStore.update("one", { onFailure: { retries: 3 } })
        const updated = jobStore.get("one")
        assertEquals(updated.onFailure.retries, 3)
        // a partial update must not wipe the rest of the policy
        assertEquals(updated.onFailure.backoff.initial, "30s")
        assertEquals(updated.schedule.every, "1h")

        jobStore.remove("two")
        assertEquals(jobStore.all().map((job) => job.id), ["one"])
        assertThrows(() => jobStore.remove("two"), Error, `no job with id "two"`)
    })
})

Deno.test("JobStore refuses a duplicate id", async () => {
    await withTemporaryState(({ jobStore }) => {
        jobStore.add({ id: "dup", task: "true" })
        const error = assertThrows(() => jobStore.add({ id: "dup", task: "true" }), JobValidationError)
        assertStringIncludes(error.message, "already taken")
    })
})

Deno.test("commandLineFor builds the process for each task type", () => {
    const shellJob = normalizeJob({ id: "s", task: "echo hi" })
    assertEquals(commandLineFor(shellJob), ["/bin/sh", "-c", "echo hi"])

    const argvJob = normalizeJob({ id: "a", task: { type: "command", argv: ["echo", "hi"] } })
    assertEquals(commandLineFor(argvJob), ["echo", "hi"])

    const jsJob = normalizeJob({ id: "j", task: { type: "js", module: "/tmp/x.js", export: "run" } })
    const jsLine = commandLineFor(jsJob)
    assertEquals(jsLine[0], Deno.execPath())
    assertEquals(jsLine[1], "run")
    assertStringIncludes(jsLine.join(" "), "job_function_entry.js")
    assertEquals(jsLine.slice(-3), ["/tmp/x.js", "run", "[]"])

    const asOther = normalizeJob({ id: "o", task: "echo hi", runAs: "nobody" })
    assertEquals(commandLineFor(asOther).slice(0, 5), ["sudo", "-n", "-u", "nobody", "--"])
})

Deno.test("environmentFor honors inherit, extra variables, and removals", () => {
    Deno.env.set("SIMPLE_SCHEDULE_TEST_MARKER", "present")
    const inheriting = normalizeJob({ id: "e", task: "true", environment: { variables: { EXTRA: "yes" } } })
    const inherited = environmentFor(inheriting)
    assertEquals(inherited.SIMPLE_SCHEDULE_TEST_MARKER, "present")
    assertEquals(inherited.EXTRA, "yes")

    const isolated = normalizeJob({
        id: "e2",
        task: "true",
        environment: { inherit: false, variables: { ONLY: "1" } },
    })
    assertEquals(environmentFor(isolated), { ONLY: "1" })

    const trimmed = normalizeJob({
        id: "e3",
        task: "true",
        environment: { remove: ["SIMPLE_SCHEDULE_TEST_MARKER"] },
    })
    assertEquals(environmentFor(trimmed).SIMPLE_SCHEDULE_TEST_MARKER, undefined)
    Deno.env.delete("SIMPLE_SCHEDULE_TEST_MARKER")
})

Deno.test("runOnce captures output into the job's log and reports success", async () => {
    await withTemporaryState(async ({ directory }) => {
        const logPath = join(directory, "out.log")
        const job = normalizeJob({
            id: "ok",
            task: "echo hello-stdout; echo hello-stderr 1>&2",
            log: { path: logPath },
        })
        const outcome = await runOnce(job, { trigger: "manual", attempt: 1 })
        assertEquals(outcome.status, "success")
        assertEquals(outcome.exitCode, 0)
        const logText = Deno.readTextFileSync(logPath)
        assertStringIncludes(logText, "hello-stdout")
        assertStringIncludes(logText, "! hello-stderr")
        assertStringIncludes(logText, "trigger=manual attempt=1")
    })
})

Deno.test("runOnce reports a non-zero exit as a failure and keeps the error text", async () => {
    await withTemporaryState(async ({ directory }) => {
        const job = normalizeJob({
            id: "bad",
            task: "echo something-went-wrong 1>&2; exit 3",
            log: { path: join(directory, "bad.log") },
        })
        const outcome = await runOnce(job, { trigger: "manual", attempt: 1 })
        assertEquals(outcome.status, "failure")
        assertEquals(outcome.exitCode, 3)
        assertStringIncludes(outcome.error, "something-went-wrong")
    })
})

Deno.test("runOnce kills a job that runs past its timeout", async () => {
    await withTemporaryState(async ({ directory }) => {
        const job = normalizeJob({
            id: "slow",
            task: "sleep 30",
            timeout: "1s",
            log: { path: join(directory, "slow.log") },
        })
        const outcome = await runOnce(job, { trigger: "manual", attempt: 1 })
        assertEquals(outcome.status, "timeout")
        assertStringIncludes(outcome.error, "1s")
    })
})

Deno.test("a JavaScript job runs, and is re-imported fresh each time", async () => {
    await withTemporaryState(async ({ directory, runStore }) => {
        const modulePath = join(directory, "task.js")
        Deno.writeTextFileSync(modulePath, `export default function () { return "first version" }\n`)
        const job = normalizeJob({
            id: "jsjob",
            task: { type: "js", module: modulePath },
            log: { path: join(directory, "js.log") },
        })
        const first = await runJob(job, { runStore, trigger: "manual" })
        assertEquals(first.status, "success")
        assertStringIncludes(Deno.readTextFileSync(job.log.path), "first version")

        // editing the file must take effect without restarting anything
        Deno.writeTextFileSync(modulePath, `export default function () { return "second version" }\n`)
        const second = await runJob(job, { runStore, trigger: "manual" })
        assertEquals(second.status, "success")
        assertStringIncludes(Deno.readTextFileSync(job.log.path), "second version")
    })
})

Deno.test("a JavaScript job that throws becomes a failed run, not a crash", async () => {
    await withTemporaryState(async ({ directory, runStore }) => {
        const modulePath = join(directory, "boom.js")
        Deno.writeTextFileSync(modulePath, `export default function () { throw new Error("kaboom") }\n`)
        const job = normalizeJob({
            id: "boom",
            task: { type: "js", module: modulePath },
            log: { path: join(directory, "boom.log") },
        })
        const result = await runJob(job, { runStore, trigger: "manual" })
        assertEquals(result.status, "failure")
        const stats = runStore.statsFor("boom")
        assertEquals(stats.failures, 1)
        assertStringIncludes(stats.lastError, "kaboom")
    })
})

Deno.test("a JavaScript job file that will not even import is a failed run", async () => {
    await withTemporaryState(async ({ directory, runStore }) => {
        const modulePath = join(directory, "broken.js")
        Deno.writeTextFileSync(modulePath, `this is not javascript at all (((\n`)
        const job = normalizeJob({
            id: "broken",
            task: { type: "js", module: modulePath },
            log: { path: join(directory, "broken.log") },
        })
        const result = await runJob(job, { runStore, trigger: "manual" })
        assertEquals(result.status, "failure")
    })
})

Deno.test("a missing export is reported by name", async () => {
    await withTemporaryState(async ({ directory, runStore }) => {
        const modulePath = join(directory, "missing.js")
        Deno.writeTextFileSync(modulePath, `export function somethingElse () {}\n`)
        const job = normalizeJob({
            id: "missing",
            task: { type: "js", module: modulePath, export: "nope" },
            log: { path: join(directory, "missing.log") },
        })
        await runJob(job, { runStore, trigger: "manual" })
        assertStringIncludes(runStore.statsFor("missing").lastError, `no export named "nope"`)
    })
})

Deno.test("runJob retries per the policy and records every attempt", async () => {
    await withTemporaryState(async ({ directory, runStore }) => {
        const job = normalizeJob({
            id: "flaky",
            task: "exit 1",
            log: { path: join(directory, "flaky.log") },
            onFailure: { retries: 2, backoff: { kind: "fixed", initial: "1ms" } },
        })
        const result = await runJob(job, { runStore, trigger: "schedule" })
        assertEquals(result.status, "failure")
        assertEquals(result.attempts, 3)
        const runs = runStore.recentRuns("flaky")
        assertEquals(runs.length, 3)
        assertEquals(runs.map((run) => run.attempt).sort(), [1, 2, 3])
        assertEquals(runs.filter((run) => run.trigger == "retry").length, 2)
        assertEquals(runStore.state("flaky").consecutiveFailures, 3)
    })
})

Deno.test("runJob stops retrying as soon as an attempt succeeds", async () => {
    await withTemporaryState(async ({ directory, runStore }) => {
        const markerPath = join(directory, "marker")
        const job = normalizeJob({
            id: "eventually",
            task: `if [ -f ${markerPath} ]; then exit 0; else touch ${markerPath}; exit 1; fi`,
            log: { path: join(directory, "eventually.log") },
            onFailure: { retries: 5, backoff: { kind: "fixed", initial: "1ms" } },
        })
        const result = await runJob(job, { runStore, trigger: "schedule" })
        assertEquals(result.status, "success")
        assertEquals(result.attempts, 2)
        assertEquals(runStore.state("eventually").consecutiveFailures, 0)
    })
})

Deno.test("runJob hands back the job to chain to when everything failed", async () => {
    await withTemporaryState(async ({ directory, runStore }) => {
        const job = normalizeJob({
            id: "chains",
            task: "exit 1",
            log: { path: join(directory, "chains.log") },
            onFailure: { thenRun: "cleanup" },
        })
        const result = await runJob(job, { runStore, trigger: "schedule" })
        assertEquals(result.chainTo, "cleanup")
    })
})

Deno.test("statsFor summarizes duration and success rate", async () => {
    await withTemporaryState(async ({ directory, runStore }) => {
        const good = normalizeJob({ id: "mixed", task: "true", log: { path: join(directory, "m.log") } })
        const bad = normalizeJob({ id: "mixed", task: "false", log: { path: join(directory, "m.log") } })
        await runJob(good, { runStore, trigger: "manual" })
        await runJob(good, { runStore, trigger: "manual" })
        await runJob(bad, { runStore, trigger: "manual" })
        const stats = runStore.statsFor("mixed")
        assertEquals(stats.total, 3)
        assertEquals(stats.successes, 2)
        assertEquals(stats.failures, 1)
        assertEquals(Math.round(stats.successRate * 100), 67)
        assertEquals(typeof stats.averageDurationMs, "number")
        assertEquals(stats.lastStatus, "failure")
        assertEquals(runStore.dailyHistory("mixed").length, 1)
    })
})

Deno.test("trimHistory keeps only the newest records", async () => {
    await withTemporaryState(({ runStore }) => {
        for (let index = 0; index < 10; index++) {
            const runId = runStore.startRun({
                jobId: "trim",
                trigger: "manual",
                startedAt: new Date(Date.now() + index * 1000),
            })
            runStore.finishRun(runId, { status: "success" })
        }
        runStore.trimHistory("trim", 4)
        assertEquals(runStore.recentRuns("trim", 100).length, 4)
    })
})

Deno.test("nextRunForJob honors disabled, skip-next, and pause", async () => {
    await withTemporaryState(({ runStore }) => {
        const job = normalizeJob({
            id: "sk",
            task: "true",
            schedule: { kind: "daily", at: "09:00", timeZone: "utc" },
        })
        const after = new Date("2025-06-15T00:00:00Z")
        assertEquals(nextRunForJob(job, runStore, after).toISOString(), "2025-06-15T09:00:00.000Z")

        runStore.setState("sk", { skip_next: 1 })
        assertEquals(nextRunForJob(job, runStore, after).toISOString(), "2025-06-16T09:00:00.000Z")

        runStore.setState("sk", { skip_next: 0, paused_until: "2025-06-20T00:00:00.000Z" })
        assertEquals(nextRunForJob(job, runStore, after).toISOString(), "2025-06-20T09:00:00.000Z")

        assertEquals(nextRunForJob({ ...job, enabled: false }, runStore, after), null)
    })
})
