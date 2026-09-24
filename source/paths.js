// Where state lives. One override, SIMPLE_SCHEDULE_HOME, keeps tests and throwaway runs off the
// real installation.

import { join } from "jsr:@std/path@1.1.2"

/** @returns {string} */
export function homeDirectory() {
    const home = Deno.env.get("HOME")
    if (!home) {
        throw new Error("HOME is not set, so there is nowhere to keep state")
    }
    return home
}

/**
 * The root of everything this tool stores.
 * @returns {string}
 */
export function stateDirectory() {
    const override = Deno.env.get("SIMPLE_SCHEDULE_HOME")
    if (override) {
        return override
    }
    if (Deno.build.os == "darwin" && isRunningAsRoot()) {
        return "/Library/Application Support/simple_schedule"
    }
    if (isRunningAsRoot()) {
        return "/var/lib/simple_schedule"
    }
    return join(homeDirectory(), ".local", "share", "simple_schedule")
}

/** @returns {boolean} */
export function isRunningAsRoot() {
    try {
        return Deno.uid() == 0
    } catch (_error) {
        return false
    }
}

/** @returns {string} */
export function jobsFilePath() {
    return join(stateDirectory(), "jobs.json")
}

/** @returns {string} */
export function runsDatabasePath() {
    return join(stateDirectory(), "runs.sqlite")
}

/** @returns {string} */
export function logsDirectory() {
    return join(stateDirectory(), "logs")
}

/** @param {string} jobId @returns {string} */
export function defaultLogPathFor(jobId) {
    return join(logsDirectory(), `${jobId}.log`)
}

/**
 * A unix socket path cannot exceed about 104 bytes on macOS, and a state directory nested under a
 * long home or temp directory blows straight past that. When it would, the socket moves to a short
 * name in the temp directory, keyed by a hash of the state directory so two installations never
 * collide.
 * @returns {string} The unix socket the CLI, TUI, and server use to talk to the daemon.
 */
export function controlSocketPath() {
    const preferred = join(stateDirectory(), "daemon.sock")
    if (new TextEncoder().encode(preferred).length <= 100) {
        return preferred
    }
    const temporaryRoot = Deno.env.get("TMPDIR")?.replace(/\/$/, "") || "/tmp"
    return join(temporaryRoot, `simple_schedule-${hashOf(stateDirectory())}.sock`)
}

/**
 * FNV-1a, which is plenty for naming a socket and needs no imports.
 * @param {string} text
 * @returns {string} eight hex characters
 */
function hashOf(text) {
    let hash = 0x811c9dc5
    for (const codeUnit of new TextEncoder().encode(text)) {
        hash = Math.imul(hash ^ codeUnit, 0x01000193) >>> 0
    }
    return hash.toString(16).padStart(8, "0")
}

/** @returns {string} */
export function daemonLogPath() {
    return join(stateDirectory(), "daemon.log")
}

/** @returns {string} */
export function daemonStatePath() {
    return join(stateDirectory(), "daemon.json")
}

/** Create the state directory tree if it is not there yet. */
export function ensureStateDirectory() {
    Deno.mkdirSync(logsDirectory(), { recursive: true })
}
