// Where this tool and the Deno that runs it actually live. It can be started from a source checkout,
// from a `deno install` shim, straight from a URL, or from a `deno compile` binary, and the daemon's
// service file has to name something that will still work after this process is gone.

import { fromFileUrl } from "jsr:@std/path@1.1.2"

/**
 * True when the running executable is Deno itself rather than a compiled binary.
 * @returns {boolean}
 */
export function isRunningUnderDeno() {
    const executable = Deno.execPath()
    return executable == "deno" || executable.endsWith("/deno") || executable.endsWith("\\deno.exe")
}

/**
 * A Deno to run child processes with. A `deno compile` binary is not Deno, so fall back to whatever
 * `deno` is on PATH — that is what JavaScript jobs need in order to run at all.
 * @returns {string}
 */
export function denoExecutablePath() {
    return isRunningUnderDeno() ? Deno.execPath() : "deno"
}

/**
 * A module specifier that another process can be pointed at: a plain path for a local file, or the
 * URL itself when this was installed straight from the web.
 * @param {string} resolved a URL produced by import.meta.resolve
 * @returns {string}
 */
export function specifierForAnotherProcess(resolved) {
    return resolved.startsWith("file:") ? fromFileUrl(resolved) : resolved
}
