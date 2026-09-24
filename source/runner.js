// Running one job: building the process, capturing its output into the job's log, enforcing the
// timeout, and applying the retry/backoff policy.

import { parseDuration } from "./durations.js"
import { backoffDelayFor } from "./job_schema.js"
import { openLogFile } from "./log_files.js"
import { defaultLogPathFor } from "./paths.js"
import { denoExecutablePath, specifierForAnotherProcess } from "./runtime_locations.js"

const textEncoder = new TextEncoder()

/** @returns {string} the wrapper that hot-imports a JS job, as a path or a URL */
export function jobFunctionEntryPath() {
    return specifierForAnotherProcess(import.meta.resolve("./job_function_entry.js"))
}

/**
 * @param {object} job
 * @returns {Record<string, string>}
 */
export function environmentFor(job) {
    const environment = job.environment.inherit ? { ...Deno.env.toObject() } : {}
    for (const name of job.environment.remove) {
        delete environment[name]
    }
    for (const [name, value] of Object.entries(job.environment.variables)) {
        environment[name] = value
    }
    return environment
}

/**
 * The argv a job turns into. Exposed on its own so the CLI can show it and tests can check it
 * without running anything.
 * @param {object} job
 * @returns {string[]}
 */
export function commandLineFor(job) {
    let pieces
    if (job.task.type == "js") {
        pieces = [
            denoExecutablePath(),
            "run",
            ...job.task.permissions,
            "--quiet",
            jobFunctionEntryPath(),
            job.task.module,
            job.task.export,
            JSON.stringify(job.task.arguments ?? []),
        ]
    } else if (job.task.argv) {
        pieces = [...job.task.argv]
    } else {
        pieces = [job.task.shell ?? "/bin/sh", "-c", job.task.command]
    }
    if (job.runAs) {
        pieces = ["sudo", "-n", "-u", job.runAs, "--", ...pieces]
    }
    return pieces
}

/**
 * @param {Deno.FsFile} logFile
 * @param {string} text
 */
function writeLogLine(logFile, text) {
    logFile.writeSync(textEncoder.encode(text.endsWith("\n") ? text : `${text}\n`))
}

/**
 * Pump a process stream into the log file, keeping the last few KB in memory for the error summary.
 * @param {ReadableStream<Uint8Array>} stream
 * @param {Deno.FsFile} logFile
 * @param {string} prefix
 * @returns {Promise<string>}
 */
async function pumpStream(stream, logFile, prefix) {
    const decoder = new TextDecoder()
    let pending = ""
    let tail = ""
    for await (const chunk of stream) {
        pending += decoder.decode(chunk, { stream: true })
        const lines = pending.split("\n")
        pending = lines.pop() ?? ""
        for (const line of lines) {
            writeLogLine(logFile, `${prefix}${line}`)
            tail = `${tail}${line}\n`.slice(-4000)
        }
    }
    if (pending.length > 0) {
        writeLogLine(logFile, `${prefix}${pending}`)
        tail = `${tail}${pending}\n`.slice(-4000)
    }
    return tail
}

/**
 * Run the job's process exactly once.
 * @param {object} job
 * @param {{trigger: string, attempt: number, signal?: AbortSignal}} context
 * @returns {Promise<{status: string, exitCode: number|null, error: string|null, startedAt: Date, endedAt: Date, logPath: string}>}
 */
export async function runOnce(job, { trigger, attempt, signal }) {
    const logPath = job.log?.path ?? defaultLogPathFor(job.id)
    const logFile = openLogFile(logPath, { maxBytes: job.log?.maxBytes, keepFiles: job.log?.keepFiles })
    const startedAt = new Date()
    const argv = commandLineFor(job)
    writeLogLine(logFile, "")
    writeLogLine(logFile, `=== ${startedAt.toISOString()} ${job.id} trigger=${trigger} attempt=${attempt}`)
    writeLogLine(logFile, `=== ${argv.join(" ")}`)

    let child
    try {
        child = new Deno.Command(argv[0], {
            args: argv.slice(1),
            cwd: job.workingDirectory ?? undefined,
            env: environmentFor(job),
            clearEnv: !job.environment.inherit,
            stdin: "null",
            stdout: "piped",
            stderr: "piped",
        }).spawn()
    } catch (error) {
        const endedAt = new Date()
        const message = `could not start ${argv[0]}: ${error.message}`
        writeLogLine(logFile, `=== ${endedAt.toISOString()} error ${message}`)
        logFile.close()
        return { status: "error", exitCode: null, error: message, startedAt, endedAt, logPath }
    }

    let timedOut = false
    let timeoutHandle = null
    const timeoutMilliseconds = job.timeout == null ? null : parseDuration(job.timeout)
    if (timeoutMilliseconds != null) {
        timeoutHandle = setTimeout(() => {
            timedOut = true
            try {
                child.kill("SIGTERM")
            } catch (_error) {
                // the process already went away on its own
            }
        }, timeoutMilliseconds)
    }
    const onAbort = () => {
        try {
            child.kill("SIGTERM")
        } catch (_error) {
            // already gone
        }
    }
    signal?.addEventListener("abort", onAbort, { once: true })

    const [outputTail, errorTail, status] = await Promise.all([
        pumpStream(child.stdout, logFile, ""),
        pumpStream(child.stderr, logFile, "! "),
        child.status,
    ])
    if (timeoutHandle != null) {
        clearTimeout(timeoutHandle)
    }
    signal?.removeEventListener("abort", onAbort)

    const endedAt = new Date()
    let resultStatus = status.success ? "success" : "failure"
    let error = null
    if (timedOut) {
        resultStatus = "timeout"
        error = `killed after ${job.timeout}`
    } else if (!status.success) {
        const lastLines = (errorTail || outputTail).trim().split("\n").slice(-6).join("\n")
        error = lastLines.length > 0 ? lastLines : `exited with code ${status.code}`
    }
    writeLogLine(
        logFile,
        `=== ${endedAt.toISOString()} ${resultStatus} code=${status.code} duration=${
            endedAt.getTime() - startedAt.getTime()
        }ms`,
    )
    logFile.close()
    return { status: resultStatus, exitCode: status.code, error, startedAt, endedAt, logPath }
}

/**
 * Sleep that gives up early when the daemon is shutting down.
 * @param {number} milliseconds
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function delay(milliseconds, signal) {
    return new Promise((resolve) => {
        const handle = setTimeout(resolve, milliseconds)
        signal?.addEventListener("abort", () => {
            clearTimeout(handle)
            resolve()
        }, { once: true })
    })
}

/**
 * Run a job, retrying per its failure policy, recording every attempt.
 * @param {object} job
 * @param {{runStore: object, trigger?: string, signal?: AbortSignal, onEvent?: (event: object) => void}} context
 * @returns {Promise<{status: string, attempts: number, runIds: number[], chainTo: string|null}>}
 */
export async function runJob(job, { runStore, trigger = "manual", signal, onEvent }) {
    const attemptsAllowed = job.onFailure.retries + 1
    const runIds = []
    let lastStatus = "failure"
    let lastError = null

    for (let attempt = 1; attempt <= attemptsAllowed; attempt++) {
        const runId = runStore.startRun({ jobId: job.id, trigger: attempt == 1 ? trigger : "retry", attempt })
        runIds.push(runId)
        onEvent?.({ kind: "runStarted", jobId: job.id, runId, attempt })
        const outcome = await runOnce(job, { trigger, attempt, signal })
        runStore.finishRun(runId, {
            status: outcome.status,
            exitCode: outcome.exitCode,
            error: outcome.error,
            endedAt: outcome.endedAt,
        })
        lastStatus = outcome.status
        lastError = outcome.error
        onEvent?.({
            kind: "runFinished",
            jobId: job.id,
            runId,
            attempt,
            status: outcome.status,
            error: outcome.error,
        })
        if (outcome.status == "success") {
            break
        }
        if (attempt < attemptsAllowed && !signal?.aborted) {
            const waitFor = backoffDelayFor(job.onFailure, attempt)
            onEvent?.({ kind: "retryScheduled", jobId: job.id, attempt, waitMs: waitFor })
            await delay(waitFor, signal)
        }
    }

    runStore.trimHistory(job.id, job.keepRuns)

    if (lastStatus != "success" && job.onFailure.notify) {
        await notifyFailure(job, lastError)
    }

    return {
        status: lastStatus,
        attempts: runIds.length,
        runIds,
        chainTo: lastStatus == "success" ? null : job.onFailure.thenRun,
    }
}

/**
 * @param {object} job
 * @param {string|null} error
 */
async function notifyFailure(job, error) {
    const summary = `simple_schedule: job "${job.id}" failed after ${job.onFailure.retries + 1} attempt(s)\n${
        error ?? ""
    }\n`
    try {
        const child = new Deno.Command(job.task.shell ?? "/bin/sh", {
            args: ["-c", job.onFailure.notify],
            env: environmentFor(job),
            stdin: "piped",
            stdout: "null",
            stderr: "null",
        }).spawn()
        const writer = child.stdin.getWriter()
        await writer.write(textEncoder.encode(summary))
        await writer.close()
        await child.status
    } catch (_error) {
        // a broken notifier must never turn into a second failure
    }
}
