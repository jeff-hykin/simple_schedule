// The scheduler process. It owns the clock, the running jobs, and the control socket; every other
// surface is a client of it.

import { enrichJob } from "./operations.js"
import { runJob } from "./runner.js"
import { JobStore, nextRunForJob, RunStore } from "./store.js"
import { serveControlSocket } from "./control_protocol.js"
import { tailLogFile } from "./log_files.js"
import { daemonStatePath, ensureStateDirectory } from "./paths.js"

const tickMilliseconds = 15 * 1000

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
        /** @type {Map<string, {startedAt: Date, promise: Promise<any>}>} */
        this.running = new Map()
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
        const promise = this.runToCompletion(job, trigger)
        this.running.set(job.id, { startedAt: new Date(), promise })
        return { started: true }
    }

    /**
     * @param {object} job
     * @param {string} trigger
     */
    async runToCompletion(job, trigger) {
        this.log(`${job.id}: starting (${trigger})`)
        try {
            const result = await runJob(job, {
                runStore: this.runStore,
                trigger,
                signal: this.abortController.signal,
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
            const queuedIndex = this.queued.indexOf(job.id)
            if (queuedIndex != -1) {
                this.queued.splice(queuedIndex, 1)
                this.start(job, "queued")
            }
        }
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
        let soonest = null
        for (const job of this.jobs) {
            let dueAt
            try {
                dueAt = nextRunForJob(job, this.runStore, new Date(now.getTime() - tickMilliseconds), {
                    applySkips: false,
                })
            } catch (error) {
                this.log(`${job.id}: cannot work out when to run — ${error.message}`)
                continue
            }
            if (dueAt == null) {
                continue
            }
            if (dueAt <= now) {
                const state = this.runStore.state(job.id)
                if (state.skipNext > 0) {
                    this.runStore.setState(job.id, { skip_next: state.skipNext - 1 })
                    this.log(`${job.id}: skipping this run as asked (${state.skipNext - 1} skip(s) left)`)
                } else {
                    this.start(job, "schedule")
                }
                const following = nextRunForJob(job, this.runStore, now, { applySkips: false })
                this.runStore.setState(job.id, { next_run_at: following?.toISOString() ?? null })
                if (following != null && (soonest == null || following < soonest)) {
                    soonest = following
                }
                continue
            }
            this.runStore.setState(job.id, { next_run_at: dueAt.toISOString() })
            if (soonest == null || dueAt < soonest) {
                soonest = dueAt
            }
        }
        return soonest
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
        return enrichJob(job, this.runStore, { isRunning: this.running.has(job.id) })
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
            const handle = setTimeout(resolve, milliseconds)
            this.abortController.signal.addEventListener("abort", () => {
                clearTimeout(handle)
                resolve()
            }, { once: true })
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
