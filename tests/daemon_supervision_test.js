const stateDirectory = Deno.makeTempDirSync({ prefix: "simple_schedule_supervision_test_" })
Deno.env.set("SIMPLE_SCHEDULE_HOME", stateDirectory)

import { assertEquals, assertNotEquals } from "jsr:@std/assert@1.0.13"
import { join } from "jsr:@std/path@1.1.2"
import { Scheduler } from "../source/daemon.js"
import { JobStore, nextRunForJob, RunStore } from "../source/store.js"

/**
 * @param {(context: {scheduler: Scheduler, directory: string}) => Promise<void>|void} body
 * @param {object[]} [jobs]
 */
async function withScheduler(body, jobs = []) {
    const directory = Deno.makeTempDirSync({ prefix: "simple_schedule_sup_" })
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

/** @param {Scheduler} scheduler */
function settle(scheduler) {
    return Promise.allSettled([...scheduler.running.values()].map((entry) => entry.promise))
}

/** @param {number} milliseconds */
function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

/**
 * @param {() => boolean} condition
 * @param {number} [timeoutMs]
 */
async function waitUntil(condition, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs
    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error("timed out waiting")
        }
        await sleep(20)
    }
}

const minute = 60 * 1000
const anchor = new Date("2026-01-05T10:00:00Z")
const at = (minutes) => new Date(anchor.getTime() + minutes * minute)
const everyMinute = {
    kind: "rrule",
    freq: "MINUTELY",
    interval: 1,
    start: anchor.toISOString(),
    timeZone: "UTC",
}

Deno.test("count ends a schedule after that many occurrences", async () => {
    await withScheduler(async ({ scheduler }) => {
        scheduler.tick(at(1))
        await settle(scheduler)
        scheduler.tick(at(2))
        await settle(scheduler)
        assertEquals(scheduler.tick(at(3)), null)
        assertEquals(scheduler.running.size, 0)
        assertEquals(scheduler.runStore.statsFor("twice").total, 2)
        assertEquals(scheduler.runStore.state("twice").nextRunAt, null)
    }, [{ id: "twice", task: "true", schedule: { ...everyMinute, count: 2 } }])
})

Deno.test("a skipped occurrence still counts toward count", async () => {
    await withScheduler(async ({ scheduler }) => {
        scheduler.runStore.setState("skipper", { skip_next: 1 })
        scheduler.tick(at(1))
        scheduler.tick(at(2))
        await settle(scheduler)
        scheduler.tick(at(3))
        assertEquals(scheduler.runStore.statsFor("skipper").total, 1)
    }, [{ id: "skipper", task: "true", schedule: { ...everyMinute, count: 2 } }])
})

Deno.test("until ends a schedule past that instant", async () => {
    await withScheduler(async ({ scheduler }) => {
        scheduler.tick(at(1))
        await settle(scheduler)
        scheduler.tick(at(2))
        await settle(scheduler)
        scheduler.tick(at(3))
        assertEquals(scheduler.running.size, 0)
        assertEquals(scheduler.runStore.statsFor("bounded").total, 2)
    }, [{ id: "bounded", task: "true", schedule: { ...everyMinute, until: at(2.5).toISOString() } }])
})

Deno.test("editing the schedule starts its count over", async () => {
    await withScheduler(async ({ scheduler }) => {
        scheduler.tick(at(1))
        await settle(scheduler)
        assertEquals(scheduler.tick(at(2)), null)
        scheduler.jobStore.update("once", { schedule: { ...everyMinute, count: 2 } })
        scheduler.reloadJobs()
        scheduler.tick(at(2))
        await settle(scheduler)
        assertEquals(scheduler.runStore.statsFor("once").total, 2)
        assertEquals(scheduler.runStore.state("once").occurrencesUsed, 1)
    }, [{ id: "once", task: "true", schedule: { ...everyMinute, count: 1 } }])
})

Deno.test("a slot slept through runs once on wake, then the schedule carries on", async () => {
    await withScheduler(async ({ scheduler }) => {
        scheduler.tick(at(1))
        assertEquals(scheduler.runStore.state("catchup").nextRunAt, at(10).toISOString())
        // the machine sleeps from minute 1 to minute 35, through the slots at 10, 20, and 30
        scheduler.tick(at(35))
        await settle(scheduler)
        const runs = scheduler.runStore.recentRuns("catchup")
        assertEquals(runs.length, 1)
        assertEquals(runs[0].trigger, "missed")
        assertEquals(scheduler.runStore.state("catchup").nextRunAt, at(40).toISOString())
        scheduler.tick(at(35.2))
        assertEquals(scheduler.runStore.recentRuns("catchup").length, 1)
    }, [{
        id: "catchup",
        task: "true",
        schedule: { ...everyMinute, interval: 10 },
    }])
})

Deno.test("missedRuns: skip leaves a slept-through slot alone", async () => {
    await withScheduler(({ scheduler }) => {
        scheduler.tick(at(1))
        scheduler.tick(at(35))
        assertEquals(scheduler.running.size, 0)
        assertEquals(scheduler.runStore.state("nocatch").nextRunAt, at(40).toISOString())
    }, [{ id: "nocatch", task: "true", missedRuns: "skip", schedule: { ...everyMinute, interval: 10 } }])
})

Deno.test("a slot missed while disabled is not made up when re-enabled", async () => {
    await withScheduler(({ scheduler }) => {
        scheduler.tick(at(1))
        scheduler.jobStore.update("toggled", { enabled: false })
        scheduler.reloadJobs()
        scheduler.tick(at(5))
        scheduler.jobStore.update("toggled", { enabled: true })
        scheduler.reloadJobs()
        scheduler.tick(at(35))
        assertEquals(scheduler.running.size, 0)
    }, [{ id: "toggled", task: "true", schedule: { ...everyMinute, interval: 10 } }])
})

Deno.test("a keep-alive job is started, and restarted when it exits", async () => {
    await withScheduler(async ({ scheduler }) => {
        scheduler.tick()
        assertEquals(scheduler.running.has("service"), true)
        const first = scheduler.running.get("service")
        await scheduler.stopRun("service", { restart: true })
        // the main loop is not running here, so tick by hand the way it would
        await waitUntil(() => {
            scheduler.tick()
            return scheduler.running.has("service") && scheduler.running.get("service") != first
        })
        const runs = scheduler.runStore.recentRuns("service")
        assertEquals(runs.map((run) => run.trigger).sort(), ["keepAlive", "restart"])
        assertEquals(runs.find((run) => run.trigger == "keepAlive").status, "stopped")
    }, [{ id: "service", task: "sleep 30", schedule: "keep alive" }])
})

Deno.test("killing a keep-alive job by hand brings it back without a crash backoff", async () => {
    await withScheduler(async ({ scheduler }) => {
        scheduler.tick()
        await scheduler.stopRun("killed")
        assertEquals(scheduler.quickExits.has("killed"), false)
        assertEquals(scheduler.restartAt.get("killed") - Date.now() <= 1000, true)
    }, [{ id: "killed", task: "sleep 30", schedule: "keep alive" }])
})

Deno.test("a crash-looping keep-alive job backs off between restarts", async () => {
    await withScheduler(async ({ scheduler }) => {
        scheduler.tick()
        await settle(scheduler)
        assertEquals(scheduler.quickExits.get("crashy"), 1)
        const firstWait = scheduler.restartAt.get("crashy") - Date.now()
        assertEquals(firstWait > 100 && firstWait <= 300, true)
        // not yet: the backoff has not elapsed
        scheduler.tick()
        assertEquals(scheduler.running.size, 0)
        await sleep(350)
        scheduler.tick()
        await settle(scheduler)
        assertEquals(scheduler.quickExits.get("crashy"), 2)
        const secondWait = scheduler.restartAt.get("crashy") - Date.now()
        assertEquals(secondWait > 350, true)
    }, [{
        id: "crashy",
        task: "exit 3",
        schedule: { kind: "keepAlive" },
        onFailure: { retries: 5, backoff: { kind: "exponential", initial: "300ms", multiplier: 2 } },
    }])
})

Deno.test("a keep-alive job is stopped when disabled and restarted when its definition changes", async () => {
    await withScheduler(async ({ scheduler }) => {
        scheduler.tick()
        const first = scheduler.running.get("svc")
        scheduler.jobStore.update("svc", { task: "sleep 31" })
        scheduler.reloadJobs()
        scheduler.tick()
        await waitUntil(() => {
            scheduler.tick()
            return scheduler.running.get("svc") != null && scheduler.running.get("svc") != first
        })
        assertEquals(scheduler.running.get("svc").job.task.command, "sleep 31")

        // re-declaring the same definition (only updatedAt changes) must not bounce it
        const second = scheduler.running.get("svc")
        scheduler.jobStore.put({ id: "svc", task: "sleep 31", schedule: "keep alive" })
        scheduler.reloadJobs()
        scheduler.tick()
        assertEquals(scheduler.running.get("svc"), second)

        scheduler.jobStore.update("svc", { enabled: false })
        scheduler.reloadJobs()
        scheduler.tick()
        await waitUntil(() => !scheduler.running.has("svc"))
        scheduler.tick()
        assertEquals(scheduler.running.has("svc"), false)
    }, [{ id: "svc", task: "sleep 30", schedule: "keep alive" }])
})

Deno.test("stop on a process that ignores SIGTERM falls back to SIGKILL", async () => {
    await withScheduler(async ({ scheduler }) => {
        scheduler.start(scheduler.requireJob("stubborn"), "manual")
        await sleep(300)
        const began = Date.now()
        await scheduler.stopRun("stubborn")
        const took = Date.now() - began
        assertEquals(took >= 9000 && took < 15000, true)
        assertEquals(scheduler.runStore.recentRuns("stubborn")[0].status, "stopped")
    }, [{ id: "stubborn", task: { type: "command", argv: ["/bin/sh", "-c", "trap '' TERM; sleep 60"] } }])
})

Deno.test("put adds, then replaces a whole job while keeping when it was created", () => {
    const directory = Deno.makeTempDirSync({ prefix: "simple_schedule_put_" })
    const store = new JobStore(join(directory, "jobs.json"))
    const added = store.put({ id: "p", task: "true", schedule: "every 5m", description: "first" })
    const replaced = store.put({ id: "p", task: "false", schedule: "daily at 9am" })
    assertEquals(store.all().length, 1)
    assertEquals(replaced.createdAt, added.createdAt)
    assertEquals(replaced.description, "")
    assertEquals(replaced.task.command, "false")
    Deno.removeSync(directory, { recursive: true })
})

Deno.test("processes adding jobs at the same moment do not drop each other's", async () => {
    const directory = Deno.makeTempDirSync({ prefix: "simple_schedule_lock_" })
    const path = join(directory, "jobs.json")
    const storeModule = new URL("../source/store.js", import.meta.url).href
    const writers = Array.from({ length: 8 }, (_, index) =>
        new Deno.Command(Deno.execPath(), {
            args: [
                "eval",
                `const { JobStore } = await import(${JSON.stringify(storeModule)})
                const store = new JobStore(${JSON.stringify(path)})
                for (let n = 0; n < 5; n++) { store.put({ id: "w${index}-" + n, task: "true" }) }`,
            ],
            env: { SIMPLE_SCHEDULE_HOME: directory },
            stdout: "null",
        }).output())
    const results = await Promise.all(writers)
    assertEquals(results.every((result) => result.success), true)
    assertEquals(new JobStore(path).all().length, 40)
    Deno.removeSync(directory, { recursive: true })
})

Deno.test("nextRunForJob ignores a stale count after the schedule was edited", () => {
    const directory = Deno.makeTempDirSync({ prefix: "simple_schedule_fp_" })
    const store = new JobStore(join(directory, "jobs.json"))
    const runStore = new RunStore(join(directory, "runs.sqlite"))
    const job = store.add({ id: "fp", task: "true", schedule: { ...everyMinute, count: 1 } })
    runStore.setState("fp", { occurrences_used: 1, schedule_fingerprint: "something older" })
    assertNotEquals(nextRunForJob(job, runStore, at(1)), null)
    runStore.close()
    Deno.removeSync(directory, { recursive: true })
})

globalThis.addEventListener("unload", () => {
    try {
        Deno.removeSync(stateDirectory, { recursive: true })
    } catch (_error) {
        // it may already be gone
    }
})
