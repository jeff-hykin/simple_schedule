// The shape of a job, the defaults that make everything but `id` and the task optional, and the
// validation that turns a bad field into a sentence a person (or an agent) can act on.

import { parseDuration } from "./durations.js"
import { describeSchedule, nextRunAt, normalizeSchedule } from "./schedule.js"
import { defaultLogPathFor } from "./paths.js"

export const taskTypes = ["command", "js"]
export const overlapPolicies = ["skip", "queue", "allow"]
export const backoffKinds = ["fixed", "exponential"]

const jobIdPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/

/** A validation failure that names the field it came from. */
export class JobValidationError extends Error {
    /** @param {string[]} problems */
    constructor(problems) {
        super(problems.join("\n"))
        this.name = "JobValidationError"
        this.problems = problems
    }
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlainObject(value) {
    return typeof value == "object" && value != null && !Array.isArray(value)
}

/**
 * @param {string[]} problems
 * @param {string} field
 * @param {() => any} produce
 * @param {any} fallback
 * @returns {any}
 */
function collect(problems, field, produce, fallback) {
    try {
        return produce()
    } catch (error) {
        problems.push(`${field}: ${error.message}`)
        return fallback
    }
}

/**
 * @param {any} task
 * @param {string[]} problems
 * @returns {object}
 */
function normalizeTask(task, problems) {
    if (task == null) {
        problems.push(
            `task: required — give either {"type":"command","command":"..."} or {"type":"js","module":"..."}`,
        )
        return { type: "command", command: "" }
    }
    if (typeof task == "string") {
        task = { type: "command", command: task }
    }
    if (!isPlainObject(task)) {
        problems.push(
            `task: must be an object or a command string, got ${
                Array.isArray(task) ? "an array" : typeof task
            }`,
        )
        return { type: "command", command: "" }
    }
    const type = task.type ?? (task.module ? "js" : "command")
    if (!taskTypes.includes(type)) {
        problems.push(`task.type: must be one of ${taskTypes.join(", ")}, got "${type}"`)
        return { type: "command", command: "" }
    }
    if (type == "command") {
        if (Array.isArray(task.argv)) {
            if (task.argv.length == 0) {
                problems.push(`task.argv: must hold at least the program to run`)
            }
            if (task.argv.some((piece) => typeof piece != "string")) {
                problems.push(`task.argv: every entry must be a string`)
            }
            return { type: "command", argv: task.argv.map(String) }
        }
        if (typeof task.command != "string" || task.command.trim().length == 0) {
            problems.push(
                `task.command: required for a command task — a shell line like "rsync -a ~/notes /backup"`,
            )
            return { type: "command", command: "" }
        }
        return { type: "command", command: task.command, shell: task.shell ?? "/bin/sh" }
    }
    if (typeof task.module != "string" || task.module.trim().length == 0) {
        problems.push(`task.module: required for a js task — a file path or URL to import`)
        return { type: "js", module: "", export: "default", arguments: [] }
    }
    const exportName = task.export ?? "default"
    if (typeof exportName != "string") {
        problems.push(`task.export: must be the name of an export, got ${typeof exportName}`)
    }
    const taskArguments = task.arguments ?? []
    if (!Array.isArray(taskArguments)) {
        problems.push(`task.arguments: must be an array of JSON values passed to the function`)
    }
    const permissions = task.permissions ?? ["--allow-all"]
    if (!Array.isArray(permissions) || permissions.some((flag) => typeof flag != "string")) {
        problems.push(
            `task.permissions: must be an array of Deno permission flags, e.g. ["--allow-net","--allow-read"]`,
        )
    }
    return {
        type: "js",
        module: task.module,
        export: typeof exportName == "string" ? exportName : "default",
        arguments: Array.isArray(taskArguments) ? taskArguments : [],
        permissions: Array.isArray(permissions) ? permissions : ["--allow-all"],
    }
}

/**
 * @param {any} environment
 * @param {string[]} problems
 * @returns {object}
 */
function normalizeEnvironment(environment, problems) {
    if (environment == null) {
        return { inherit: true, variables: {}, remove: [] }
    }
    if (!isPlainObject(environment)) {
        problems.push(`environment: must be an object like {"inherit":true,"variables":{"KEY":"value"}}`)
        return { inherit: true, variables: {}, remove: [] }
    }
    const inherit = environment.inherit ?? true
    if (typeof inherit != "boolean") {
        problems.push(
            `environment.inherit: must be true (start from the daemon's environment) or false (start empty)`,
        )
    }
    const variables = environment.variables ?? {}
    if (!isPlainObject(variables)) {
        problems.push(`environment.variables: must be an object of name to value`)
    } else {
        for (const [name, value] of Object.entries(variables)) {
            if (typeof value != "string") {
                problems.push(`environment.variables.${name}: must be a string, got ${typeof value}`)
            }
        }
    }
    const remove = environment.remove ?? []
    if (!Array.isArray(remove) || remove.some((name) => typeof name != "string")) {
        problems.push(`environment.remove: must be an array of variable names to drop`)
    }
    return {
        inherit: typeof inherit == "boolean" ? inherit : true,
        variables: isPlainObject(variables) ? { ...variables } : {},
        remove: Array.isArray(remove) ? [...remove] : [],
    }
}

/**
 * @param {any} onFailure
 * @param {string[]} problems
 * @returns {object}
 */
function normalizeFailurePolicy(onFailure, problems) {
    const source = onFailure ?? {}
    if (!isPlainObject(source)) {
        problems.push(
            `onFailure: must be an object like {"retries":3,"backoff":{"kind":"exponential","initial":"30s"}}`,
        )
        return defaultFailurePolicy()
    }
    const retries = source.retries ?? 0
    if (!Number.isInteger(retries) || retries < 0) {
        problems.push(
            `onFailure.retries: must be a whole number of extra attempts (0 means give up after the first), got ${
                JSON.stringify(source.retries)
            }`,
        )
    }
    const backoffSource = source.backoff ?? {}
    if (!isPlainObject(backoffSource)) {
        problems.push(`onFailure.backoff: must be an object`)
    }
    const kind = backoffSource.kind ?? "exponential"
    if (!backoffKinds.includes(kind)) {
        problems.push(`onFailure.backoff.kind: must be one of ${backoffKinds.join(", ")}, got "${kind}"`)
    }
    const initial = backoffSource.initial ?? "30s"
    collect(problems, "onFailure.backoff.initial", () => parseDuration(initial), 0)
    const maximum = backoffSource.max ?? "1h"
    collect(problems, "onFailure.backoff.max", () => parseDuration(maximum), 0)
    const multiplier = backoffSource.multiplier ?? 2
    if (typeof multiplier != "number" || !(multiplier >= 1)) {
        problems.push(
            `onFailure.backoff.multiplier: must be a number of at least 1, got ${JSON.stringify(multiplier)}`,
        )
    }
    const jitter = backoffSource.jitter ?? 0
    if (typeof jitter != "number" || jitter < 0 || jitter > 1) {
        problems.push(
            `onFailure.backoff.jitter: must be a fraction from 0 to 1, got ${JSON.stringify(jitter)}`,
        )
    }
    const thenRun = source.thenRun ?? null
    if (thenRun != null && (typeof thenRun != "string" || !jobIdPattern.test(thenRun))) {
        problems.push(`onFailure.thenRun: must be the id of another job to run when every attempt has failed`)
    }
    const notify = source.notify ?? null
    if (notify != null && typeof notify != "string") {
        problems.push(`onFailure.notify: must be a shell command to run with the failure summary on stdin`)
    }
    return {
        retries: Number.isInteger(retries) && retries >= 0 ? retries : 0,
        backoff: {
            kind: backoffKinds.includes(kind) ? kind : "exponential",
            initial,
            max: maximum,
            multiplier: typeof multiplier == "number" && multiplier >= 1 ? multiplier : 2,
            jitter: typeof jitter == "number" && jitter >= 0 && jitter <= 1 ? jitter : 0,
        },
        thenRun,
        notify,
    }
}

/** @returns {object} */
function defaultFailurePolicy() {
    return {
        retries: 0,
        backoff: { kind: "exponential", initial: "30s", max: "1h", multiplier: 2, jitter: 0 },
        thenRun: null,
        notify: null,
    }
}

/**
 * Turn whatever the user handed us into a complete, valid job, or throw with every problem at once.
 * @param {object} input
 * @param {{existingIds?: string[], now?: Date, previous?: object}} options
 * @returns {object}
 */
export function normalizeJob(input, options = {}) {
    const problems = []
    if (!isPlainObject(input)) {
        throw new JobValidationError([
            `job: must be a JSON object, got ${Array.isArray(input) ? "an array" : typeof input}`,
        ])
    }
    const now = options.now ?? new Date()

    const id = input.id
    if (typeof id != "string" || !jobIdPattern.test(id)) {
        problems.push(
            `id: required — letters, digits, dot, dash, and underscore only, starting with a letter or digit (got ${
                JSON.stringify(id)
            })`,
        )
    }

    const task = normalizeTask(input.task, problems)
    const schedule = collect(problems, "schedule", () => normalizeSchedule(input.schedule), {
        kind: "manual",
    })

    const activationSource = input.activation ?? {}
    if (!isPlainObject(activationSource)) {
        problems.push(`activation: must be an object like {"onBoot":true,"onLogin":false}`)
    }
    const activation = {
        onBoot: activationSource.onBoot ?? false,
        onLogin: activationSource.onLogin ?? false,
    }
    for (const name of ["onBoot", "onLogin"]) {
        if (typeof activation[name] != "boolean") {
            problems.push(
                `activation.${name}: must be true or false, got ${JSON.stringify(activation[name])}`,
            )
            activation[name] = false
        }
    }

    const environment = normalizeEnvironment(input.environment, problems)
    const onFailure = normalizeFailurePolicy(input.onFailure, problems)

    const enabled = input.enabled ?? true
    if (typeof enabled != "boolean") {
        problems.push(`enabled: must be true or false, got ${JSON.stringify(input.enabled)}`)
    }

    const description = input.description ?? ""
    if (typeof description != "string") {
        problems.push(`description: must be a string`)
    }

    const workingDirectory = input.workingDirectory ?? null
    if (workingDirectory != null && typeof workingDirectory != "string") {
        problems.push(`workingDirectory: must be a path string, or null to use the daemon's directory`)
    }

    const runAs = input.runAs ?? null
    if (runAs != null && (typeof runAs != "string" || runAs.trim().length == 0)) {
        problems.push(`runAs: must be a username, or null to run as whoever the daemon runs as`)
    }

    const timeout = input.timeout ?? null
    if (timeout != null) {
        collect(problems, "timeout", () => parseDuration(timeout), null)
    }

    const overlap = input.overlap ?? "skip"
    if (!overlapPolicies.includes(overlap)) {
        problems.push(
            `overlap: must be one of ${
                overlapPolicies.join(", ")
            } — what to do when the previous run is still going, got "${overlap}"`,
        )
    }

    const logSource = input.log ?? {}
    if (!isPlainObject(logSource)) {
        problems.push(`log: must be an object like {"path":"/tmp/job.log","maxBytes":"5m","keepFiles":3}`)
    }
    const logPath = logSource.path ?? (typeof id == "string" ? defaultLogPathFor(id) : null)
    if (logPath != null && typeof logPath != "string") {
        problems.push(`log.path: must be a file path string`)
    }
    const maxBytes = logSource.maxBytes ?? 5 * 1024 * 1024
    if (!Number.isInteger(maxBytes) || maxBytes < 1024) {
        problems.push(
            `log.maxBytes: must be a whole number of bytes of at least 1024, got ${
                JSON.stringify(logSource.maxBytes)
            }`,
        )
    }
    const keepFiles = logSource.keepFiles ?? 3
    if (!Number.isInteger(keepFiles) || keepFiles < 0) {
        problems.push(
            `log.keepFiles: must be a whole number of rotated files to keep, got ${
                JSON.stringify(logSource.keepFiles)
            }`,
        )
    }

    const keepRuns = input.keepRuns ?? 500
    if (!Number.isInteger(keepRuns) || keepRuns < 1) {
        problems.push(
            `keepRuns: must be a whole number of run records to keep per job, got ${
                JSON.stringify(input.keepRuns)
            }`,
        )
    }

    if (options.existingIds && typeof id == "string" && options.existingIds.includes(id)) {
        problems.push(`id: "${id}" is already taken — use a different id, or edit the existing job`)
    }

    const unknownFields = Object.keys(input).filter((key) => !knownJobFields.includes(key))
    if (unknownFields.length > 0) {
        problems.push(
            `unknown field${unknownFields.length > 1 ? "s" : ""}: ${
                unknownFields.join(", ")
            } — allowed fields are ${knownJobFields.join(", ")}`,
        )
    }

    if (problems.length > 0) {
        throw new JobValidationError(problems)
    }

    return {
        id,
        description,
        enabled,
        task,
        schedule,
        activation,
        workingDirectory,
        environment,
        runAs,
        timeout,
        overlap,
        onFailure,
        log: { path: logPath, maxBytes, keepFiles },
        keepRuns,
        createdAt: options.previous?.createdAt ?? input.createdAt ?? now.toISOString(),
        updatedAt: now.toISOString(),
    }
}

export const knownJobFields = [
    "id",
    "description",
    "enabled",
    "task",
    "schedule",
    "activation",
    "workingDirectory",
    "environment",
    "runAs",
    "timeout",
    "overlap",
    "onFailure",
    "log",
    "keepRuns",
    "createdAt",
    "updatedAt",
]

/**
 * A job with only its required fields filled in, for the TUI and for `--example`.
 * @param {string} id
 * @returns {object}
 */
export function exampleJob(id = "example") {
    return normalizeJob({
        id,
        description: "an example job",
        task: { type: "command", command: "echo hello from simple_schedule" },
        schedule: { kind: "daily", at: "09:00", timeZone: "local" },
    })
}

/**
 * One line summarizing a job, shared by every surface.
 * @param {object} job
 * @returns {string}
 */
export function describeJob(job) {
    const what = job.task.type == "js"
        ? `js ${job.task.module}#${job.task.export}`
        : (job.task.argv ? job.task.argv.join(" ") : job.task.command)
    return `${job.id}  ${describeSchedule(job.schedule)}  ${what}`
}

/**
 * The milliseconds to wait before retry number `attempt` (1 is the first retry).
 * @param {object} onFailure
 * @param {number} attempt
 * @returns {number}
 */
export function backoffDelayFor(onFailure, attempt) {
    const initial = parseDuration(onFailure.backoff.initial)
    const maximum = parseDuration(onFailure.backoff.max)
    const raw = onFailure.backoff.kind == "fixed"
        ? initial
        : initial * Math.pow(onFailure.backoff.multiplier, attempt - 1)
    const capped = Math.min(raw, maximum)
    if (!onFailure.backoff.jitter) {
        return capped
    }
    const spread = capped * onFailure.backoff.jitter
    return Math.max(0, Math.round(capped - spread + Math.random() * spread * 2))
}

export { describeSchedule, nextRunAt }
