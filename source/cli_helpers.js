// The bits of the CLI that are worth testing on their own: turning flags into a job, and reading a
// job definition out of a file or stdin.

import { knownJobFields } from "./job_schema.js"
import { parseScheduleText } from "./schedule.js"

/**
 * @param {string} source a file path, or "-" for stdin
 * @returns {Promise<object>}
 */
export async function readJsonFrom(source) {
    let text
    if (source == "-") {
        const chunks = []
        for await (const chunk of Deno.stdin.readable) {
            chunks.push(chunk)
        }
        text = new TextDecoder().decode(await new Blob(chunks).arrayBuffer())
    } else {
        try {
            text = Deno.readTextFileSync(source)
        } catch (error) {
            if (error instanceof Deno.errors.NotFound) {
                throw new Error(`no such file: ${source}`)
            }
            throw error
        }
    }
    if (text.trim().length == 0) {
        throw new Error(source == "-" ? "nothing arrived on stdin" : `${source} is empty`)
    }
    try {
        return JSON.parse(text)
    } catch (error) {
        throw new Error(`${source == "-" ? "stdin" : source} is not valid JSON: ${error.message}`)
    }
}

/**
 * @param {string[]} pairs entries like "KEY=value"
 * @returns {Record<string, string>}
 */
export function parseEnvironmentPairs(pairs) {
    const variables = {}
    for (const pair of pairs) {
        const equalsIndex = pair.indexOf("=")
        if (equalsIndex < 1) {
            throw new Error(`--env expects NAME=value, got "${pair}"`)
        }
        variables[pair.slice(0, equalsIndex)] = pair.slice(equalsIndex + 1)
    }
    return variables
}

/**
 * Build a (partial) job definition out of command-line flags. Only the flags the user actually gave
 * end up in the result, so this works for `edit` as well as `add`.
 * @param {object} options
 * @returns {object}
 */
export function jobInputFromFlags(options) {
    const input = {}
    if (options.id != null) {
        input.id = options.id
    }
    if (options.description != null) {
        input.description = options.description
    }
    if (options.command != null && options.jsModule != null) {
        throw new Error(`use either --command or --js-module, not both`)
    }
    if (options.command != null) {
        input.task = { type: "command", command: options.command }
    }
    if (options.jsModule != null) {
        input.task = {
            type: "js",
            module: options.jsModule,
            export: options.jsExport ?? "default",
            arguments: options.jsArguments == null ? [] : JSON.parse(options.jsArguments),
        }
        if (options.jsPermission != null && options.jsPermission.length > 0) {
            input.task.permissions = options.jsPermission
        }
    }
    if (options.schedule != null) {
        input.schedule = parseScheduleText(options.schedule)
        if (
            options.timeZone != null && input.schedule.kind != "interval" && input.schedule.kind != "manual"
        ) {
            input.schedule.timeZone = options.timeZone
        }
    }
    if (options.onBoot != null || options.onLogin != null) {
        input.activation = {}
        if (options.onBoot != null) {
            input.activation.onBoot = options.onBoot
        }
        if (options.onLogin != null) {
            input.activation.onLogin = options.onLogin
        }
    }
    if (options.cwd != null) {
        input.workingDirectory = options.cwd
    }
    if (options.runAs != null) {
        input.runAs = options.runAs
    }
    if (options.timeout != null) {
        input.timeout = options.timeout
    }
    if (options.overlap != null) {
        input.overlap = options.overlap
    }
    if (options.log != null || options.logMaxBytes != null || options.logKeepFiles != null) {
        input.log = {}
        if (options.log != null) {
            input.log.path = options.log
        }
        if (options.logMaxBytes != null) {
            input.log.maxBytes = options.logMaxBytes
        }
        if (options.logKeepFiles != null) {
            input.log.keepFiles = options.logKeepFiles
        }
    }
    if (options.keepRuns != null) {
        input.keepRuns = options.keepRuns
    }
    if (options.enabled != null) {
        input.enabled = options.enabled
    }
    const environment = {}
    if (options.env != null && options.env.length > 0) {
        environment.variables = parseEnvironmentPairs(options.env)
    }
    if (options.inheritEnv != null) {
        environment.inherit = options.inheritEnv
    }
    if (options.unsetEnv != null && options.unsetEnv.length > 0) {
        environment.remove = options.unsetEnv
    }
    if (Object.keys(environment).length > 0) {
        input.environment = environment
    }
    const onFailure = {}
    if (options.retries != null) {
        onFailure.retries = options.retries
    }
    if (
        options.backoff != null || options.backoffInitial != null || options.backoffMax != null ||
        options.backoffMultiplier != null
    ) {
        onFailure.backoff = {}
        if (options.backoff != null) {
            onFailure.backoff.kind = options.backoff
        }
        if (options.backoffInitial != null) {
            onFailure.backoff.initial = options.backoffInitial
        }
        if (options.backoffMax != null) {
            onFailure.backoff.max = options.backoffMax
        }
        if (options.backoffMultiplier != null) {
            onFailure.backoff.multiplier = options.backoffMultiplier
        }
    }
    if (options.thenRun != null) {
        onFailure.thenRun = options.thenRun
    }
    if (options.notify != null) {
        onFailure.notify = options.notify
    }
    if (Object.keys(onFailure).length > 0) {
        input.onFailure = onFailure
    }
    return input
}

/**
 * Merge a --json definition with flags, letting the flags win.
 * @param {object|null} fromJson
 * @param {object} fromFlags
 * @returns {object}
 */
export function mergeJobInput(fromJson, fromFlags) {
    if (!fromJson) {
        return fromFlags
    }
    const unknown = Object.keys(fromJson).filter((key) => !knownJobFields.includes(key))
    if (unknown.length > 0) {
        throw new Error(
            `unknown field${unknown.length > 1 ? "s" : ""} in the JSON: ${
                unknown.join(", ")
            } — allowed fields are ${knownJobFields.join(", ")}`,
        )
    }
    const merged = { ...fromJson }
    for (const [key, value] of Object.entries(fromFlags)) {
        const bothObjects = typeof value == "object" && value != null && !Array.isArray(value) &&
            typeof merged[key] == "object" && merged[key] != null && !Array.isArray(merged[key]) &&
            key != "schedule" && key != "task"
        merged[key] = bothObjects ? { ...merged[key], ...value } : value
    }
    return merged
}
