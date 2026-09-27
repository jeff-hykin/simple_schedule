// The scheduler process. It owns the clock, the running jobs, and the control socket; every other
// surface is a client of it.

import { enrichJob } from "./operations.js"
import { runJob } from "./runner.js"
import { JobStore, nextRunForJob, RunStore, scheduleFingerprintOf } from "./store.js"
import { backoffDelayFor } from "./job_schema.js"
import { serveControlSocket } from "./control_protocol.js"
import { tailLogFile } from "./log_files.js"
import { daemonStatePath, ensureStateDirectory } from "./paths.js"

const tickMilliseconds = 15 * 1000
// a keep-alive process that lasted this long was healthy, so its next restart does not back off
const stableMilliseconds = 60 * 1000
const restartPauseMilliseconds = 1000

/**
 * What a running keep-alive process was started from; when it changes, the process is restarted.
 * @param {object} job
 * @returns {string}
 */
function definitionOf(job) {
    return JSON.stringify({ ...job, updatedAt: null })
}

/**
 * When this machine last booted, so a daemon restart does not re-fire on-boot jobs.
 * @returns {Date|null}
 */
export function systemBootTime() {
    try {
        if (Deno.build.os == "darwin") {
            const output = new TextDecoder().decode(
                new Deno.Command("sysctl", { args: ["-n", "kern.boottime"] }).outputSync().stdout,
            )
            const seconds = output.match(/sec\s*=\s*(\d+)/)?.[1]
            return seconds ? new Date(Number(seconds) * 1000) : null
        }
        const uptimeSeconds = Number(Deno.readTextFileSync("/proc/uptime").split(/\s+/)[0])
        return Number.isFinite(uptimeSeconds) ? new Date(Date.now() - uptimeSeconds * 1000) : null
    } catch (_error) {
        return null
    }
}

export class Scheduler {
    /**
     * @param {{jobStore?: JobStore, runStore?: RunStore, activationContext?: "boot"|"login"|"manual", log?: (text: string) => void}} [options]
     */
    constructor(
        { jobStore = new JobStore(), runStore = new RunStore(), activationContext = "manual", log } = {},
    ) {
        this.jobStore = jobStore
        this.runStore = runStore
        this.activationContext = activationContext
        this.log = log ?? ((text) => console.log(text))
        this.abortController = new AbortController()
        /** @type {Map<string, {startedAt: Date, promise: Promise<any>, controller: AbortController, job: object, definition: string}>} */
        this.running = new Map()
        /** keep-alive job id → when it may be started again */
        /** @type {Map<string, Date>} */
        this.restartAt = new Map()
        /** keep-alive job id → how many times in a row it exited before becoming stable */
        /** @type {Map<string, number>} */
        this.quickExits = new Map()
        /** ids to start again the moment their current run ends */
        /** @type {Set<string>} */
        this.restartRequested = new Set()
        /** @type {(() => void)|null} */
        this.wakeSleeper = null
        /** @type {string[]} */
        this.queued = []
        this.startedAt = new Date()
        this.jobs = []
        this.reloadJobs()
    }

    /** Re-read jobs.json. Safe to call at any time; a bad file leaves the previous jobs in place. */
    reloadJobs() {
        try {
            this.jobs = this.jobStore.all()
            return { jobCount: this.jobs.length }
        } catch (error) {
            this.log(`could not reload jobs: ${error.message}`)
            throw error
        }
    }

    /** @param {string} id @returns {object} */
    requireJob(id) {
        const job = this.jobs.find((candidate) => candidate.id == id) ?? this.jobStore.get(id)
        if (!job) {
            const known = this.jobs.map((candidate) => candidate.id).join(", ") || "(none)"
            throw new Error(`no job with id "${id}"; known jobs are: ${known}`)
        }
        return job
    }

    /**
     * Start a job unless its overlap policy says otherwise.
     * @param {object} job
     * @param {string} trigger
     * @returns {{started: boolean, reason?: string}}
     */
    start(job, trigger) {
        if (this.running.has(job.id)) {
            if (job.overlap == "skip") {
                this.log(`${job.id}: still running, skipping this ${trigger} run`)
                return { started: false, reason: 'the previous run is still going and overlap is "skip"' }
            }
            if (job.overlap == "queue") {
                if (!this.queued.includes(job.id)) {
                    this.queued.push(job.id)
                }
                return { started: false, reason: "queued behind the run already in progress" }
            }
        }
        // each run gets its own stop switch, which the daemon's shutdown also flips
        const controller = new AbortController()
        const onShutdown = () => controller.abort()
        this.abortController.signal.addEventListener("abort", onShutdown, { once: true })
        const entry = { startedAt: new Date(), promise: null, controller, job, definition: definitionOf(job) }
        this.running.set(job.id, entry)
        entry.promise = this.runToCompletion(job, trigger, controller.signal).finally(() => {
            this.abortController.signal.removeEventListener("abort", onShutdown)
        })
        return { started: true }
    }

    /**
     * @param {object} job
     * @param {string} trigger
     */
    async runToCompletion(job, trigger, signal) {
        this.log(`${job.id}: starting (${trigger})`)
        // anything before the first await runs synchronously, so the run is on record before start() returns
        const startedAt = Date.now()
        try {
            const result = await runJob(job, {
                runStore: this.runStore,
                trigger,
                signal,
                onEvent: (event) => {
                    if (event.kind == "retryScheduled") {
                        this.log(
                            `${job.id}: attempt ${event.attempt} failed, retrying in ${
                                Math.round(event.waitMs / 1000)
                            }s`,
                        )
                    }
                },
            })
            this.log(`${job.id}: ${result.status} after ${result.attempts} attempt(s)`)
            if (result.chainTo) {
                try {
                    const chained = this.requireJob(result.chainTo)
                    this.log(`${job.id}: failed, chaining to ${chained.id}`)
                    this.start(chained, "chained")
                } catch (error) {
                    this.log(`${job.id}: onFailure.thenRun is broken — ${error.message}`)
                }
            }
            return result
        } catch (error) {
            // a bug in the runner must not take the scheduler down with it
            this.log(`${job.id}: the runner itself failed — ${error.stack ?? error.message}`)
            return { status: "error", attempts: 0, runIds: [], chainTo: null }
        } finally {
            this.running.delete(job.id)
            const restartRequested = this.restartRequested.delete(job.id)
            if (job.schedule.kind == "keepAlive") {
                this.planRestart(job, {
                    immediately: restartRequested,
                    // killed by hand, not crashed, so it has not earned a backoff
                    healthy: signal.aborted || Date.now() - startedAt >= stableMilliseconds,
                    ranFor: Date.now() - startedAt,
                })
            } else if (restartRequested && !this.abortController.signal.aborted) {
                this.start(job, "restart")
            }
            const queuedIndex = this.queued.indexOf(job.id)
            if (queuedIndex != -1) {
                this.queued.splice(queuedIndex, 1)
                this.start(job, "queued")
            }
        }
    }

    /**
     * Decide when an exited keep-alive process comes back: right away after a healthy run or an explicit
     * restart, and with growing waits (the job's onFailure.backoff) while it keeps dying young.
     * @param {object} job
     * @param {{immediately: boolean, healthy: boolean, ranFor: number}} how
     */
    planRestart(job, { immediately, healthy, ranFor }) {
        if (this.abortController.signal.aborted) {
            return
        }
        let waitFor
        if (immediately) {
            this.quickExits.delete(job.id)
            waitFor = 0
        } else if (healthy) {
            this.quickExits.delete(job.id)
            waitFor = restartPauseMilliseconds
        } else {
            const quickExits = (this.quickExits.get(job.id) ?? 0) + 1
            this.quickExits.set(job.id, quickExits)
            waitFor = backoffDelayFor(job.onFailure, quickExits)
            this.log(
                `${job.id}: exited after ${Math.round(ranFor / 1000)}s, restarting in ${
                    Math.round(waitFor / 1000)
                }s`,
            )
        }
        this.restartAt.set(job.id, new Date(Date.now() + waitFor))
        this.wake()
    }

    /**
     * Keep every enabled keep-alive job running, and stop or restart the ones whose definition went away
     * or changed.
     * @param {Date} now
     * @returns {Date|null} the soonest pending restart
     */
    superviseKeepAlive(now) {
        const wanted = new Map(
            this.jobs
                .filter((job) => job.enabled && job.schedule.kind == "keepAlive")
                .map((job) => [job.id, job]),
        )
        for (const [id, entry] of this.running) {
            if (entry.job.schedule.kind != "keepAlive" || entry.controller.signal.aborted) {
                continue
            }
            const job = wanted.get(id)
            if (!job) {
                this.log(`${id}: no longer an enabled keep-alive job, stopping it`)
                entry.controller.abort()
            } else if (definitionOf(job) != entry.definition) {
                this.log(`${id}: definition changed, restarting it`)
                this.restartRequested.add(id)
                entry.controller.abort()
            }
        }
        let soonest = null
        for (const job of wanted.values()) {
            if (this.running.has(job.id)) {
                continue
            }
            const notBefore = this.restartAt.get(job.id)
            if (notBefore && notBefore > now) {
                if (soonest == null || notBefore < soonest) {
                    soonest = notBefore
                }
                continue
            }
            this.start(job, notBefore ? "restart" : "keepAlive")
        }
        return soonest
    }

    /**
     * Kill a job's run in progress. A keep-alive job then comes back on its own; disable it to keep it
     * down. With `restart`, the job starts again as soon as the old run has ended.
     * @param {string} id
     * @param {{restart?: boolean, wait?: boolean}} [options]
     * @returns {Promise<object>}
     */
    async stopRun(id, { restart = false, wait = true } = {}) {
        const job = this.requireJob(id)
        const entry = this.running.get(job.id)
        if (!entry) {
            if (restart) {
                this.restartAt.delete(job.id)
                return { jobId: job.id, wasRunning: false, ...this.start(job, "restart") }
            }
            return { jobId: job.id, wasRunning: false }
        }
        if (restart) {
            this.restartRequested.add(job.id)
        }
        entry.controller.abort()
        if (wait) {
            await entry.promise
        }
        return { jobId: job.id, wasRunning: true, restarting: restart || job.schedule.kind == "keepAlive" }
    }

    /** Cut the main loop's current sleep short, so a change takes effect now instead of next tick. */
    wake() {
        this.wakeSleeper?.()
    }

    /** Fire the jobs whose activation triggers match how this daemon was started. */
    handleActivation() {
        const previous = this.readDaemonState()
        const bootTime = systemBootTime()
        const bootTimeText = bootTime?.toISOString() ?? null
        const isFreshBoot = bootTimeText != null && bootTimeText != previous.lastBootTime
        for (const job of this.jobs) {
            if (!job.enabled) {
                continue
            }
            if (job.activation.onBoot && isFreshBoot && this.activationContext != "manual") {
                this.start(job, "boot")
            } else if (job.activation.onLogin && this.activationContext == "login") {
                this.start(job, "login")
            }
        }
        this.writeDaemonState({
            ...previous,
            lastBootTime: bootTimeText,
            lastStartAt: this.startedAt.toISOString(),
        })
    }

    /** @returns {object} */
    readDaemonState() {
        try {
            return JSON.parse(Deno.readTextFileSync(daemonStatePath()))
        } catch (_error) {
            return {}
        }
    }

    /** @param {object} state */
    writeDaemonState(state) {
        ensureStateDirectory()
        Deno.writeTextFileSync(daemonStatePath(), `${JSON.stringify(state, null, 4)}\n`)
    }

    /**
     * Start everything that is due, and report when the next one is.
     * @param {Date} [now]
     * @returns {Date|null}
     */
    tick(now = new Date()) {
        let soonest = this.superviseKeepAlive(now)
        const consider = (date) => {
            if (date != null && (soonest == null || date < soonest)) {
                soonest = date
            }
        }
        for (const job of this.jobs) {
            if (job.schedule.kind == "keepAlive") {
                continue
            }
            let state = this.runStore.state(job.id)
            const fingerprint = scheduleFingerprintOf(job)
            if (state.scheduleFingerprint != fingerprint) {
                // a new or edited schedule: its count starts over and any promised slot no longer applies
                this.runStore.setState(job.id, {
                    schedule_fingerprint: fingerprint,
                    occurrences_used: 0,
                    next_run_at: null,
                })
                state = this.runStore.state(job.id)
            }
            let dueAt
            try {
                dueAt = nextRunForJob(job, this.runStore, new Date(now.getTime() - tickMilliseconds), {
                    applySkips: false,
                })
            } catch (error) {
                this.log(`${job.id}: cannot work out when to run — ${error.message}`)
                continue
            }
            let trigger = "schedule"
            const missed = this.missedSlot(job, state, now)
            if (missed != null && (dueAt == null || missed < dueAt)) {
                dueAt = missed
                trigger = "missed"
            }
            if (dueAt == null) {
                if (state.nextRunAt != null) {
                    this.runStore.setState(job.id, { next_run_at: null })
                }
                continue
            }
            if (dueAt <= now) {
                this.runStore.setState(job.id, { occurrences_used: state.occurrencesUsed + 1 })
                if (state.skipNext > 0) {
                    this.runStore.setState(job.id, { skip_next: state.skipNext - 1 })
                    this.log(`${job.id}: skipping this run as asked (${state.skipNext - 1} skip(s) left)`)
                } else {
                    if (trigger == "missed") {
                        this.log(`${job.id}: running the slot missed at ${dueAt.toISOString()}`)
                    }
                    this.start(job, trigger)
                }
                const following = nextRunForJob(job, this.runStore, now, { applySkips: false })
                this.runStore.setState(job.id, { next_run_at: following?.toISOString() ?? null })
                consider(following)
                continue
            }
            this.runStore.setState(job.id, { next_run_at: dueAt.toISOString() })
            consider(dueAt)
        }
        return soonest
    }

    /**
     * The slot this job was promised but slept through (the machine was asleep, or the daemon was
     * down), when its policy is to make that up with one run. Null when there is nothing to make up.
     * @param {object} job
     * @param {object} state
     * @param {Date} now
     * @returns {Date|null}
     */
    missedSlot(job, state, now) {
        if (job.missedRuns == "skip" || !job.enabled || state.nextRunAt == null) {
            return null
        }
        const promised = new Date(state.nextRunAt)
        if (promised >= new Date(now.getTime() - tickMilliseconds)) {
            // not missed; the ordinary look-back already covers it
            return null
        }
        if (state.pausedUntil && new Date(state.pausedUntil) > promised) {
            return null
        }
        if (job.schedule.count != null && state.occurrencesUsed >= job.schedule.count) {
            return null
        }
        return promised
    }

    /** @returns {object} */
    status() {
        return {
            pid: Deno.pid,
            startedAt: this.startedAt.toISOString(),
            activationContext: this.activationContext,
            jobCount: this.jobs.length,
            running: [...this.running.entries()].map(([id, entry]) => ({
                jobId: id,
                startedAt: entry.startedAt.toISOString(),
            })),
            queued: [...this.queued],
        }
    }

    /**
     * @param {object} request
     * @returns {Promise<any>}
     */
    async handleCommand(request) {
        const command = request.command
        if (command == "ping") {
            return { pong: true, pid: Deno.pid }
        }
        if (command == "status") {
            return this.status()
        }
        if (command == "reload") {
            const result = this.reloadJobs()
            this.tick()
            return result
        }
        if (command == "listJobs") {
            return this.jobs.map((job) => this.describeForClient(job))
        }
        if (command == "getJob") {
            return this.describeForClient(this.requireJob(request.id))
        }
        if (command == "trigger") {
            const job = this.requireJob(request.id)
            const outcome = this.start(job, request.trigger ?? "manual")
            if (request.wait) {
                const entry = this.running.get(job.id)
                const result = entry ? await entry.promise : null
                return { ...outcome, result }
            }
            return outcome
        }
        if (command == "skipNext") {
            const job = this.requireJob(request.id)
            const count = request.count ?? 1
            this.runStore.setState(job.id, { skip_next: Math.max(0, count) })
            return { jobId: job.id, skipNext: Math.max(0, count) }
        }
        if (command == "pause") {
            const job = this.requireJob(request.id)
            this.runStore.setState(job.id, { paused_until: request.until ?? null })
            return { jobId: job.id, pausedUntil: request.until ?? null }
        }
        if (command == "stats") {
            const job = this.requireJob(request.id)
            return {
                ...this.runStore.statsFor(job.id),
                ...this.runStore.state(job.id),
                dailyHistory: this.runStore.dailyHistory(job.id, request.days ?? 30),
            }
        }
        if (command == "runs") {
            if (request.id) {
                return this.runStore.recentRuns(request.id, request.limit ?? 50)
            }
            return this.runStore.recentRunsAcrossJobs(request.limit ?? 100)
        }
        if (command == "logs") {
            const job = this.requireJob(request.id)
            return {
                jobId: job.id,
                path: job.log.path,
                text: tailLogFile(job.log.path, request.lines ?? 200),
            }
        }
        if (command == "stop" || command == "restart") {
            return await this.stopRun(request.id, {
                restart: command == "restart",
                wait: request.wait ?? true,
            })
        }
        if (command == "shutdown") {
            queueMicrotask(() => this.stop())
            return { stopping: true }
        }
        throw new Error(`unknown command "${command}"`)
    }

    /**
     * @param {object} job
     * @returns {object}
     */
    describeForClient(job) {
        const restartAt = this.restartAt.get(job.id)
        return {
            ...enrichJob(job, this.runStore, { isRunning: this.running.has(job.id) }),
            restartAt: !this.running.has(job.id) && restartAt ? restartAt.toISOString() : null,
        }
    }

    stop() {
        this.abortController.abort()
    }

    /** The main loop. Resolves once the daemon has been told to stop. */
    async run() {
        ensureStateDirectory()
        this.handleActivation()
        const watcher = this.watchJobsFile()
        const serving = serveControlSocket((request) => this.handleCommand(request), {
            signal: this.abortController.signal,
        })
        this.log(
            `simple_schedule daemon started (pid ${Deno.pid}, ${this.jobs.length} job(s), context ${this.activationContext})`,
        )
        while (!this.abortController.signal.aborted) {
            const soonest = this.tick()
            const waitFor = soonest == null
                ? tickMilliseconds
                : Math.max(250, Math.min(tickMilliseconds, soonest.getTime() - Date.now()))
            await this.sleep(waitFor)
        }
        watcher?.close()
        await serving
        await Promise.allSettled([...this.running.values()].map((entry) => entry.promise))
        this.runStore.close()
        this.log("simple_schedule daemon stopped")
    }

    /**
     * @param {number} milliseconds
     * @returns {Promise<void>}
     */
    sleep(milliseconds) {
        return new Promise((resolve) => {
            const finish = () => {
                clearTimeout(handle)
                this.abortController.signal.removeEventListener("abort", finish)
                this.wakeSleeper = null
                resolve()
            }
            const handle = setTimeout(finish, milliseconds)
            this.wakeSleeper = finish
            this.abortController.signal.addEventListener("abort", finish, { once: true })
        })
    }

    /** Pick up edits made straight to jobs.json. @returns {Deno.FsWatcher|null} */
    watchJobsFile() {
        let watcher
        try {
            watcher = Deno.watchFs(this.jobStore.path)
        } catch (_error) {
            // the file may not exist yet; the periodic tick still picks up changes on reload
            return null
        }
        ;(async () => {
            let pending = null
            for await (const _event of watcher) {
                clearTimeout(pending)
                pending = setTimeout(() => {
                    try {
                        this.reloadJobs()
                        this.log(`jobs.json changed, now tracking ${this.jobs.length} job(s)`)
                        this.wake()
                    } catch (_error) {
                        // reloadJobs already logged it; keep the old jobs
                    }
                }, 250)
            }
        })()
        return watcher
    }
}

/**
 * @param {{activationContext?: "boot"|"login"|"manual"}} [options]
 * @returns {Promise<void>}
 */
export async function runDaemon({ activationContext = "manual" } = {}) {
    const scheduler = new Scheduler({ activationContext })
    for (const signalName of ["SIGINT", "SIGTERM"]) {
        Deno.addSignalListener(signalName, () => {
            scheduler.log(`received ${signalName}, shutting down`)
            scheduler.stop()
        })
    }
    await scheduler.run()
}
