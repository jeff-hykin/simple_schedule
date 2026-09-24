// One API that every surface uses. When the daemon is up it does the work, so running jobs and
// skip/pause state stay consistent; when it is not, the same operations happen right here against
// the files. Nothing a person can do requires the daemon to be installed first.

import { askDaemon, DaemonNotRunningError, isDaemonRunning } from "./control_protocol.js"
import { JobStore, nextRunForJob, RunStore } from "./store.js"
import { describeJob } from "./job_schema.js"
import { describeSchedule } from "./schedule.js"
import { runJob } from "./runner.js"
import { tailLogFile } from "./log_files.js"

/**
 * Add the live details a job record does not carry on its own.
 * @param {object} job
 * @param {RunStore} runStore
 * @param {{isRunning?: boolean}} [extra]
 * @returns {object}
 */
export function enrichJob(job, runStore, { isRunning = false } = {}) {
    let nextRun = null
    try {
        nextRun = nextRunForJob(job, runStore)?.toISOString() ?? null
    } catch (_error) {
        // a job with a schedule we can no longer read still deserves to be listed
    }
    return {
        ...job,
        summary: describeJob(job),
        scheduleText: describeSchedule(job.schedule),
        nextRunAt: nextRun,
        isRunning,
        state: runStore.state(job.id),
        stats: runStore.statsFor(job.id),
    }
}

/** Work directly on the files, for when there is no daemon. */
class LocalBackend {
    constructor() {
        this.jobStore = new JobStore()
        this.runStore = new RunStore()
    }

    close() {
        this.runStore.close()
    }

    /** @param {string} id @returns {object} */
    requireJob(id) {
        const job = this.jobStore.get(id)
        if (!job) {
            const known = this.jobStore.all().map((candidate) => candidate.id).join(", ") || "(none)"
            throw new Error(`no job with id "${id}"; known jobs are: ${known}`)
        }
        return job
    }

    listJobs() {
        return this.jobStore.all().map((job) => enrichJob(job, this.runStore))
    }

    /** @param {string} id */
    getJob(id) {
        return enrichJob(this.requireJob(id), this.runStore)
    }

    /** @param {string} id @param {object} options */
    async trigger(id, { wait = true, trigger = "manual" } = {}) {
        const job = this.requireJob(id)
        const result = await runJob(job, { runStore: this.runStore, trigger })
        if (result.chainTo) {
            try {
                const chained = this.requireJob(result.chainTo)
                await runJob(chained, { runStore: this.runStore, trigger: "chained" })
            } catch (_error) {
                // a broken chain target is reported by the run record, not by throwing here
            }
        }
        return { started: true, ranLocally: true, result: wait ? result : undefined }
    }

    /** @param {string} id @param {number} count */
    skipNext(id, count) {
        this.requireJob(id)
        this.runStore.setState(id, { skip_next: Math.max(0, count) })
        return { jobId: id, skipNext: Math.max(0, count) }
    }

    /** @param {string} id @param {string|null} until */
    pause(id, until) {
        this.requireJob(id)
        this.runStore.setState(id, { paused_until: until })
        return { jobId: id, pausedUntil: until }
    }

    /** @param {string} id @param {number} days */
    stats(id, days) {
        this.requireJob(id)
        return {
            ...this.runStore.statsFor(id),
            ...this.runStore.state(id),
            dailyHistory: this.runStore.dailyHistory(id, days),
        }
    }

    /** @param {string|null} id @param {number} limit */
    runs(id, limit) {
        return id ? this.runStore.recentRuns(id, limit) : this.runStore.recentRunsAcrossJobs(limit)
    }

    /** @param {string} id @param {number} lines */
    logs(id, lines) {
        const job = this.requireJob(id)
        return { jobId: id, path: job.log.path, text: tailLogFile(job.log.path, lines) }
    }
}

/**
 * Run `viaDaemon` if a daemon is listening, otherwise `locally`.
 * @param {(ask: (request: object) => Promise<any>) => Promise<any>} viaDaemon
 * @param {(backend: LocalBackend) => any} locally
 * @returns {Promise<any>}
 */
async function eitherWay(viaDaemon, locally) {
    try {
        return await viaDaemon((request) => askDaemon(request))
    } catch (error) {
        if (!(error instanceof DaemonNotRunningError)) {
            throw error
        }
    }
    const backend = new LocalBackend()
    try {
        return await locally(backend)
    } finally {
        backend.close()
    }
}

/** Tell a running daemon to re-read jobs.json. Silent when there is no daemon. */
export async function nudgeDaemon() {
    try {
        await askDaemon({ command: "reload" }, { timeoutMs: 3000 })
        return true
    } catch (_error) {
        return false
    }
}

/** @returns {Promise<object[]>} */
export function listJobs() {
    return eitherWay((ask) => ask({ command: "listJobs" }), (backend) => backend.listJobs())
}

/** @param {string} id @returns {Promise<object>} */
export function getJob(id) {
    return eitherWay((ask) => ask({ command: "getJob", id }), (backend) => backend.getJob(id))
}

/**
 * Job definitions always go straight to the file; the daemon is then told to re-read it. That way a
 * definition change never depends on the daemon being up.
 * @param {object} input
 * @returns {Promise<object>}
 */
export async function addJob(input) {
    const store = new JobStore()
    const job = store.add(input)
    await nudgeDaemon()
    return job
}

/** @param {string} id @param {object} changes @returns {Promise<object>} */
export async function editJob(id, changes) {
    const store = new JobStore()
    const job = store.update(id, changes)
    await nudgeDaemon()
    return job
}

/** @param {string} id @param {{forgetHistory?: boolean}} [options] @returns {Promise<void>} */
export async function removeJob(id, { forgetHistory = false } = {}) {
    const store = new JobStore()
    store.remove(id)
    if (forgetHistory) {
        const runStore = new RunStore()
        try {
            runStore.forgetJob(id)
        } finally {
            runStore.close()
        }
    }
    await nudgeDaemon()
}

/** @param {string} id @param {{wait?: boolean}} [options] @returns {Promise<object>} */
export function triggerJob(id, { wait = true } = {}) {
    return eitherWay(
        (ask) => ask({ command: "trigger", id, wait, trigger: "manual" }, { timeoutMs: wait ? 0 : 30000 }),
        (backend) => backend.trigger(id, { wait }),
    )
}

/** @param {string} id @param {number} [count] @returns {Promise<object>} */
export function skipNextRuns(id, count = 1) {
    return eitherWay(
        (ask) => ask({ command: "skipNext", id, count }),
        (backend) => backend.skipNext(id, count),
    )
}

/** @param {string} id @param {string|null} until @returns {Promise<object>} */
export function pauseJob(id, until) {
    return eitherWay((ask) => ask({ command: "pause", id, until }), (backend) => backend.pause(id, until))
}

/** @param {string} id @param {number} [days] @returns {Promise<object>} */
export function statsFor(id, days = 30) {
    return eitherWay((ask) => ask({ command: "stats", id, days }), (backend) => backend.stats(id, days))
}

/** @param {string|null} id @param {number} [limit] @returns {Promise<object[]>} */
export function runsFor(id, limit = 50) {
    return eitherWay((ask) => ask({ command: "runs", id, limit }), (backend) => backend.runs(id, limit))
}

/** @param {string} id @param {number} [lines] @returns {Promise<object>} */
export function logsFor(id, lines = 200) {
    return eitherWay((ask) => ask({ command: "logs", id, lines }), (backend) => backend.logs(id, lines))
}

/** @returns {Promise<object|null>} null when no daemon is listening */
export async function daemonStatus() {
    try {
        return await askDaemon({ command: "status" }, { timeoutMs: 3000 })
    } catch (error) {
        if (error instanceof DaemonNotRunningError) {
            return null
        }
        throw error
    }
}

/** @returns {Promise<boolean>} */
export function daemonIsRunning() {
    return isDaemonRunning()
}

/** @returns {Promise<object>} */
export function stopDaemon() {
    return askDaemon({ command: "shutdown" }, { timeoutMs: 5000 })
}
