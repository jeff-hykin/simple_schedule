const stateDirectory = Deno.makeTempDirSync({ prefix: "simple_schedule_daemon_test_" })
Deno.env.set("SIMPLE_SCHEDULE_HOME", stateDirectory)

import { assertEquals, assertRejects, assertStringIncludes } from "jsr:@std/assert@1.0.13"
import { join } from "jsr:@std/path@1.1.2"
import { Scheduler, systemBootTime } from "../source/daemon.js"
import { JobStore, RunStore } from "../source/store.js"
import {
    askDaemon,
    DaemonNotRunningError,
    isDaemonRunning,
    serveControlSocket,
} from "../source/control_protocol.js"

/**
 * @param {(context: {scheduler: Scheduler, directory: string}) => Promise<void>|void} body
 * @param {object[]} [jobs]
 */
async function withScheduler(body, jobs = []) {
    const directory = Deno.makeTempDirSync({ prefix: "simple_schedule_sched_" })
    const jobStore = new JobStore(join(directory, "jobs.json"))
    for (const job of jobs) {
        jobStore.add(job)
    }
    const runStore = new RunStore(join(directory, "runs.sqlite"))
    const scheduler = new Scheduler({ jobStore, runStore, log: () => {} })
    try {
        await body({ scheduler, directory })
    } finally {
        scheduler.stop()
        await Promise.allSettled([...scheduler.running.values()].map((entry) => entry.promise))
        runStore.close()
        Deno.removeSync(directory, { recursive: true })
    }
}

Deno.test("systemBootTime reads a plausible time on this platform", () => {
    const bootTime = systemBootTime()
    assertEquals(bootTime instanceof Date, true)
    assertEquals(bootTime.getTime() < Date.now(), true)
    // nothing on this machine booted before 2010
    assertEquals(bootTime.getFullYear() > 2010, true)
})

Deno.test("tick starts a job that is due and reports when the next one is", async () => {
    await withScheduler(async ({ scheduler }) => {
        // a brand new "every 1s" job is not due until a second has gone by
        assertEquals(scheduler.tick() > new Date(), true)
        assertEquals(scheduler.running.size, 0)
        await new Promise((resolve) => setTimeout(resolve, 1100))
        const soonest = scheduler.tick()
        assertEquals(scheduler.running.has("due"), true)
        assertEquals(soonest instanceof Date, true)
        await scheduler.running.get("due")?.promise
        assertEquals(scheduler.runStore.statsFor("due").successes, 1)
    }, [{ id: "due", task: "true", schedule: "every 1s" }])
})

Deno.test("tick leaves a disabled job alone", async () => {
    await withScheduler(({ scheduler }) => {
        scheduler.tick()
        assertEquals(scheduler.running.size, 0)
    }, [{ id: "off", task: "true", schedule: "every 1s", enabled: false }])
})

Deno.test("a skip-next request burns off one run instead of firing it", async () => {
    await withScheduler(async ({ scheduler }) => {
        scheduler.runStore.setState("skippy", { skip_next: 2 })
        await new Promise((resolve) => setTimeout(resolve, 1100))
        scheduler.tick()
        assertEquals(scheduler.running.size, 0)
        assertEquals(scheduler.runStore.state("skippy").skipNext, 1)
        scheduler.tick()
        assertEquals(scheduler.running.size, 0)
        assertEquals(scheduler.runStore.state("skippy").skipNext, 0)
        scheduler.tick()
        assertEquals(scheduler.running.has("skippy"), true)
        await scheduler.running.get("skippy")?.promise
    }, [{ id: "skippy", task: "true", schedule: "every 1s" }])
})

Deno.test("overlap policies decide what happens while a run is in flight", async () => {
    await withScheduler(async ({ scheduler }) => {
        const slow = scheduler.jobs.find((job) => job.id == "slow")
        scheduler.start(slow, "manual")
        assertEquals(scheduler.running.has("slow"), true)

        const second = scheduler.start(slow, "manual")
        assertEquals(second.started, false)
        assertStringIncludes(second.reason, "skip")

        const queueing = { ...slow, id: "slow", overlap: "queue" }
        const queued = scheduler.start(queueing, "manual")
        assertEquals(queued.started, false)
        assertEquals(scheduler.queued, ["slow"])

        const allowed = scheduler.start({ ...slow, overlap: "allow" }, "manual")
        assertEquals(allowed.started, true)
        await scheduler.running.get("slow")?.promise
    }, [{ id: "slow", task: "sleep 0.4", schedule: "manual" }])
})

Deno.test("a failing job chains to the job named in its policy", async () => {
    await withScheduler(async ({ scheduler }) => {
        scheduler.start(scheduler.requireJob("breaks"), "manual")
        await scheduler.running.get("breaks")?.promise
        // the chained job is started from inside the first one's completion
        await Promise.allSettled([...scheduler.running.values()].map((entry) => entry.promise))
        assertEquals(scheduler.runStore.statsFor("cleanup").total, 1)
        assertEquals(scheduler.runStore.recentRuns("cleanup")[0].trigger, "chained")
    }, [
        { id: "breaks", task: "exit 1", schedule: "manual", onFailure: { thenRun: "cleanup" } },
        { id: "cleanup", task: "true", schedule: "manual" },
    ])
})

Deno.test("a chain that points at nothing is logged, not fatal", async () => {
    const logged = []
    const directory = Deno.makeTempDirSync({ prefix: "simple_schedule_chain_" })
    const jobStore = new JobStore(join(directory, "jobs.json"))
    jobStore.add({ id: "breaks", task: "exit 1", schedule: "manual", onFailure: { thenRun: "ghost" } })
    const runStore = new RunStore(join(directory, "runs.sqlite"))
    const scheduler = new Scheduler({ jobStore, runStore, log: (text) => logged.push(text) })
    try {
        scheduler.start(scheduler.requireJob("breaks"), "manual")
        await scheduler.running.get("breaks")?.promise
        assertStringIncludes(logged.join("\n"), "onFailure.thenRun is broken")
    } finally {
        scheduler.stop()
        runStore.close()
        Deno.removeSync(directory, { recursive: true })
    }
})

Deno.test("the control commands cover what the other surfaces need", async () => {
    await withScheduler(async ({ scheduler }) => {
        assertEquals((await scheduler.handleCommand({ command: "ping" })).pong, true)
        assertEquals((await scheduler.handleCommand({ command: "status" })).jobCount, 1)
        assertEquals((await scheduler.handleCommand({ command: "listJobs" })).length, 1)

        const job = await scheduler.handleCommand({ command: "getJob", id: "ctl" })
        assertEquals(job.id, "ctl")
        assertEquals(job.scheduleText, "manual only")

        const triggered = await scheduler.handleCommand({ command: "trigger", id: "ctl", wait: true })
        assertEquals(triggered.result.status, "success")

        assertEquals(
            (await scheduler.handleCommand({ command: "skipNext", id: "ctl", count: 5 })).skipNext,
            5,
        )
        assertEquals(
            (await scheduler.handleCommand({ command: "pause", id: "ctl", until: null })).pausedUntil,
            null,
        )
        assertEquals((await scheduler.handleCommand({ command: "stats", id: "ctl" })).total, 1)
        assertEquals((await scheduler.handleCommand({ command: "runs", id: "ctl" })).length, 1)
        assertStringIncludes(
            (await scheduler.handleCommand({ command: "logs", id: "ctl" })).text,
            "hello-control",
        )

        await assertRejects(
            () => scheduler.handleCommand({ command: "nonsense" }),
            Error,
            `unknown command "nonsense"`,
        )
        await assertRejects(
            () => scheduler.handleCommand({ command: "getJob", id: "ghost" }),
            Error,
            "known jobs are",
        )
    }, [{ id: "ctl", task: "echo hello-control", schedule: "manual" }])
})

Deno.test("reload picks up a job added to the file underneath the daemon", async () => {
    await withScheduler(({ scheduler }) => {
        assertEquals(scheduler.jobs.length, 1)
        scheduler.jobStore.add({ id: "added-later", task: "true", schedule: "manual" })
        assertEquals(scheduler.jobs.length, 1)
        scheduler.reloadJobs()
        assertEquals(scheduler.jobs.map((job) => job.id).sort(), ["added-later", "first"])
    }, [{ id: "first", task: "true", schedule: "manual" }])
})

Deno.test("the control socket carries a request and its reply", async () => {
    const socketPath = `${Deno.makeTempDirSync({ prefix: "ss_sock_" })}/s.sock`
    const abortController = new AbortController()
    const serving = serveControlSocket(
        (request) => {
            if (request.command == "boom") {
                throw new Error("the daemon said no")
            }
            return Promise.resolve({ echoed: request.command })
        },
        { socketPath, signal: abortController.signal },
    )
    try {
        assertEquals(await askDaemon({ command: "hi" }, { socketPath }), { echoed: "hi" })
        assertEquals(await isDaemonRunning({ socketPath }), true)
        await assertRejects(() => askDaemon({ command: "boom" }, { socketPath }), Error, "the daemon said no")
    } finally {
        abortController.abort()
        await serving
    }
    // once it is gone, clients are told so plainly rather than hanging
    await assertRejects(() => askDaemon({ command: "hi" }, { socketPath }), DaemonNotRunningError)
    assertEquals(await isDaemonRunning({ socketPath }), false)
})

globalThis.addEventListener("unload", () => {
    try {
        Deno.removeSync(stateDirectory, { recursive: true })
    } catch (_error) {
        // it may already be gone
    }
})
