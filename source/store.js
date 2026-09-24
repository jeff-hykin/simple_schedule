// Job definitions live in a human-editable JSON file; run history and mutable per-job state live in
// SQLite, which ships with Deno so there is nothing to install.

import { DatabaseSync } from "node:sqlite"
import { dirname } from "jsr:@std/path@1.1.2"
import { normalizeJob } from "./job_schema.js"
import { nextRunAt } from "./schedule.js"
import { ensureStateDirectory, jobsFilePath, runsDatabasePath } from "./paths.js"

/**
 * Write a file without ever leaving a half-written one behind.
 * @param {string} path
 * @param {string} contents
 */
function writeFileAtomically(path, contents) {
    Deno.mkdirSync(dirname(path), { recursive: true })
    const temporaryPath = `${path}.${Deno.pid}.partial`
    Deno.writeTextFileSync(temporaryPath, contents)
    Deno.renameSync(temporaryPath, path)
}

/** The job definitions, backed by jobs.json. */
export class JobStore {
    /** @param {string} [path] */
    constructor(path = jobsFilePath()) {
        this.path = path
    }

    /** @returns {object[]} */
    all() {
        let text
        try {
            text = Deno.readTextFileSync(this.path)
        } catch (error) {
            if (error instanceof Deno.errors.NotFound) {
                return []
            }
            throw error
        }
        let parsed
        try {
            parsed = JSON.parse(text)
        } catch (error) {
            throw new Error(`${this.path} is not valid JSON: ${error.message}`)
        }
        const jobs = Array.isArray(parsed) ? parsed : parsed.jobs
        if (!Array.isArray(jobs)) {
            throw new Error(`${this.path} should hold an array of jobs, or {"jobs":[...]}`)
        }
        return jobs
    }

    /** @param {string} id @returns {object|null} */
    get(id) {
        return this.all().find((job) => job.id == id) ?? null
    }

    /** @param {object[]} jobs */
    replaceAll(jobs) {
        ensureStateDirectory()
        writeFileAtomically(this.path, `${JSON.stringify({ jobs }, null, 4)}\n`)
    }

    /**
     * @param {object} input
     * @returns {object} the normalized job that was stored
     */
    add(input) {
        const jobs = this.all()
        const job = normalizeJob(input, { existingIds: jobs.map((existing) => existing.id) })
        jobs.push(job)
        this.replaceAll(jobs)
        return job
    }

    /**
     * Merge changes into an existing job. Nested objects merge one level deep so a caller can change
     * just `onFailure.retries` without restating the whole policy.
     * @param {string} id
     * @param {object} changes
     * @returns {object}
     */
    update(id, changes) {
        const jobs = this.all()
        const index = jobs.findIndex((job) => job.id == id)
        if (index == -1) {
            throw new Error(`no job with id "${id}"`)
        }
        const previous = jobs[index]
        const merged = { ...previous }
        for (const [key, value] of Object.entries(changes)) {
            const isMergeable = typeof value == "object" && value != null && !Array.isArray(value) &&
                typeof previous[key] == "object" && previous[key] != null && !Array.isArray(previous[key]) &&
                key != "schedule" && key != "task"
            merged[key] = isMergeable ? { ...previous[key], ...value } : value
        }
        const otherIds = jobs.filter((job) => job.id != id).map((job) => job.id)
        const job = normalizeJob(merged, { existingIds: merged.id == id ? otherIds : otherIds, previous })
        jobs[index] = job
        this.replaceAll(jobs)
        return job
    }

    /** @param {string} id */
    remove(id) {
        const jobs = this.all()
        const remaining = jobs.filter((job) => job.id != id)
        if (remaining.length == jobs.length) {
            throw new Error(`no job with id "${id}"`)
        }
        this.replaceAll(remaining)
    }
}

const schemaStatements = [
    `create table if not exists runs (
        id integer primary key autoincrement,
        job_id text not null,
        attempt integer not null default 1,
        trigger text not null,
        started_at text not null,
        ended_at text,
        duration_ms integer,
        status text,
        exit_code integer,
        error text,
        log_path text
    )`,
    `create index if not exists runs_by_job on runs (job_id, started_at desc)`,
    `create table if not exists job_state (
        job_id text primary key,
        skip_next integer not null default 0,
        next_run_at text,
        paused_until text,
        last_success_at text,
        consecutive_failures integer not null default 0
    )`,
]

/** Run history and the bits of per-job state that change while the daemon runs. */
export class RunStore {
    /** @param {string} [path] */
    constructor(path = runsDatabasePath()) {
        if (path != ":memory:") {
            ensureStateDirectory()
        }
        this.database = new DatabaseSync(path)
        this.database.exec("pragma journal_mode = wal")
        this.database.exec("pragma busy_timeout = 5000")
        for (const statement of schemaStatements) {
            this.database.exec(statement)
        }
    }

    close() {
        this.database.close()
    }

    /**
     * @param {{jobId: string, trigger: string, attempt?: number, startedAt?: Date, logPath?: string|null}} run
     * @returns {number} the run id
     */
    startRun({ jobId, trigger, attempt = 1, startedAt = new Date(), logPath = null }) {
        const result = this.database
            .prepare(
                `insert into runs (job_id, attempt, trigger, started_at, log_path) values (?, ?, ?, ?, ?)`,
            )
            .run(jobId, attempt, trigger, startedAt.toISOString(), logPath)
        return Number(result.lastInsertRowid)
    }

    /**
     * @param {number} runId
     * @param {{status: string, exitCode?: number|null, error?: string|null, endedAt?: Date}} outcome
     */
    finishRun(runId, { status, exitCode = null, error = null, endedAt = new Date() }) {
        const row = this.database.prepare(`select job_id, started_at from runs where id = ?`).get(runId)
        if (!row) {
            throw new Error(`no run with id ${runId}`)
        }
        const durationMilliseconds = endedAt.getTime() - new Date(row.started_at).getTime()
        this.database
            .prepare(
                `update runs set ended_at = ?, duration_ms = ?, status = ?, exit_code = ?, error = ? where id = ?`,
            )
            .run(endedAt.toISOString(), durationMilliseconds, status, exitCode, error, runId)
        if (status == "success") {
            this.setState(row.job_id, { last_success_at: endedAt.toISOString(), consecutive_failures: 0 })
        } else if (status == "failure" || status == "timeout" || status == "error") {
            const current = this.state(row.job_id)
            this.setState(row.job_id, { consecutive_failures: current.consecutiveFailures + 1 })
        }
    }

    /**
     * @param {string} jobId
     * @param {number} [limit]
     * @returns {object[]}
     */
    recentRuns(jobId, limit = 50) {
        return this.database
            .prepare(`select * from runs where job_id = ? order by started_at desc, id desc limit ?`)
            .all(jobId, limit)
            .map(rowToRun)
    }

    /**
     * @param {number} [limit]
     * @returns {object[]}
     */
    recentRunsAcrossJobs(limit = 100) {
        return this.database
            .prepare(`select * from runs order by started_at desc, id desc limit ?`)
            .all(limit)
            .map(rowToRun)
    }

    /**
     * @param {string} jobId
     * @returns {{jobId: string, total: number, successes: number, failures: number, successRate: number|null, averageDurationMs: number|null, medianDurationMs: number|null, longestDurationMs: number|null, lastRunAt: string|null, lastStatus: string|null, lastError: string|null}}
     */
    statsFor(jobId) {
        const summary = this.database
            .prepare(
                `select
                    count(*) as total,
                    sum(case when status = 'success' then 1 else 0 end) as successes,
                    sum(case when status in ('failure', 'timeout', 'error') then 1 else 0 end) as failures,
                    avg(duration_ms) as average_duration,
                    max(duration_ms) as longest_duration
                from runs where job_id = ? and ended_at is not null`,
            )
            .get(jobId)
        const durations = this.database
            .prepare(
                `select duration_ms from runs where job_id = ? and duration_ms is not null order by duration_ms`,
            )
            .all(jobId)
            .map((row) => row.duration_ms)
        const last = this.database
            .prepare(`select * from runs where job_id = ? order by started_at desc, id desc limit 1`)
            .get(jobId)
        const total = summary?.total ?? 0
        return {
            jobId,
            total,
            successes: summary?.successes ?? 0,
            failures: summary?.failures ?? 0,
            successRate: total > 0 ? (summary.successes ?? 0) / total : null,
            averageDurationMs: summary?.average_duration ?? null,
            medianDurationMs: durations.length > 0 ? durations[Math.floor((durations.length - 1) / 2)] : null,
            longestDurationMs: summary?.longest_duration ?? null,
            lastRunAt: last?.started_at ?? null,
            lastStatus: last?.status ?? null,
            lastError: last?.error ?? null,
        }
    }

    /**
     * Per-day counts and average durations, for the charts in the web GUI.
     * @param {string} jobId
     * @param {number} [days]
     * @returns {object[]}
     */
    dailyHistory(jobId, days = 30) {
        return this.database
            .prepare(
                `select
                    substr(started_at, 1, 10) as day,
                    count(*) as total,
                    sum(case when status = 'success' then 1 else 0 end) as successes,
                    sum(case when status in ('failure', 'timeout', 'error') then 1 else 0 end) as failures,
                    avg(duration_ms) as average_duration
                from runs where job_id = ? and ended_at is not null
                group by day order by day desc limit ?`,
            )
            .all(jobId, days)
            .map((row) => ({
                day: row.day,
                total: row.total,
                successes: row.successes,
                failures: row.failures,
                averageDurationMs: row.average_duration,
            }))
            .reverse()
    }

    /**
     * @param {string} jobId
     * @returns {{jobId: string, skipNext: number, nextRunAt: string|null, pausedUntil: string|null, lastSuccessAt: string|null, consecutiveFailures: number}}
     */
    state(jobId) {
        const row = this.database.prepare(`select * from job_state where job_id = ?`).get(jobId)
        return {
            jobId,
            skipNext: row?.skip_next ?? 0,
            nextRunAt: row?.next_run_at ?? null,
            pausedUntil: row?.paused_until ?? null,
            lastSuccessAt: row?.last_success_at ?? null,
            consecutiveFailures: row?.consecutive_failures ?? 0,
        }
    }

    /**
     * @param {string} jobId
     * @param {object} changes column names to values
     */
    setState(jobId, changes) {
        this.database.prepare(`insert or ignore into job_state (job_id) values (?)`).run(jobId)
        for (const [column, value] of Object.entries(changes)) {
            this.database.prepare(`update job_state set ${column} = ? where job_id = ?`).run(value, jobId)
        }
    }

    /**
     * The last time a job started and the last time one finished, used to place interval schedules.
     * @param {string} jobId
     * @returns {{previousStartAt: Date|null, previousEndAt: Date|null}}
     */
    lastTimings(jobId) {
        const row = this.database
            .prepare(
                `select started_at, ended_at from runs where job_id = ? order by started_at desc, id desc limit 1`,
            )
            .get(jobId)
        return {
            previousStartAt: row?.started_at ? new Date(row.started_at) : null,
            previousEndAt: row?.ended_at ? new Date(row.ended_at) : null,
        }
    }

    /**
     * Drop the oldest records once a job has more than it is allowed to keep.
     * @param {string} jobId
     * @param {number} keepRuns
     */
    trimHistory(jobId, keepRuns) {
        this.database
            .prepare(
                `delete from runs where job_id = ? and id not in (
                    select id from runs where job_id = ? order by started_at desc, id desc limit ?
                )`,
            )
            .run(jobId, jobId, keepRuns)
    }

    /** @param {string} jobId */
    forgetJob(jobId) {
        this.database.prepare(`delete from runs where job_id = ?`).run(jobId)
        this.database.prepare(`delete from job_state where job_id = ?`).run(jobId)
    }
}

/** @param {any} row @returns {object} */
function rowToRun(row) {
    return {
        id: row.id,
        jobId: row.job_id,
        attempt: row.attempt,
        trigger: row.trigger,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        durationMs: row.duration_ms,
        status: row.status,
        exitCode: row.exit_code,
        error: row.error,
        logPath: row.log_path,
    }
}

/**
 * When a job should next fire, taking its history and any pause into account.
 *
 * `applySkips` is the difference between the two callers: everything that shows a next-run time to a
 * person wants the time the job will *actually* run, so it skips ahead past any pending skips. The
 * daemon wants the raw slot, because it consumes one skip each time a slot comes around — if it also
 * skipped ahead here, the same skip would be counted twice and never burn off.
 * @param {object} job
 * @param {RunStore} runStore
 * @param {Date} [after]
 * @param {{applySkips?: boolean}} [options]
 * @returns {Date|null}
 */
export function nextRunForJob(job, runStore, after = new Date(), { applySkips = true } = {}) {
    if (!job.enabled) {
        return null
    }
    const state = runStore.state(job.id)
    if (state.pausedUntil && new Date(state.pausedUntil) > after) {
        after = new Date(state.pausedUntil)
    }
    const timings = runStore.lastTimings(job.id)
    const at = (from) =>
        nextRunAt(job.schedule, {
            after: from,
            previousStartAt: timings.previousStartAt,
            previousEndAt: timings.previousEndAt,
            createdAt: new Date(job.createdAt),
        })
    let candidate = at(after)
    if (applySkips) {
        for (let skipped = 0; skipped < state.skipNext && candidate != null; skipped++) {
            candidate = at(candidate)
        }
    }
    return candidate
}
