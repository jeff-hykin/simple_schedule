// Runs one JavaScript job function in its own process. The import is cache-busted so editing the
// job file takes effect on the next run without restarting the daemon, and everything is wrapped so
// a broken job file fails this process instead of the scheduler.

import { isAbsolute, toFileUrl } from "jsr:@std/path@1.1.2"

const [moduleSpecifier, exportName, argumentsJson] = Deno.args

/**
 * @param {string} specifier
 * @returns {string} a URL that will not be served from the module cache
 */
function cacheBusted(specifier) {
    let url
    if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) {
        url = new URL(specifier)
    } else {
        url = toFileUrl(isAbsolute(specifier) ? specifier : `${Deno.cwd()}/${specifier}`)
    }
    url.searchParams.set("simple_schedule_reload", String(Date.now()))
    return url.href
}

let exitCode = 0
try {
    const loaded = await import(cacheBusted(moduleSpecifier))
    const target = loaded[exportName]
    if (target === undefined) {
        const available = Object.keys(loaded).join(", ") || "(nothing)"
        throw new Error(`"${moduleSpecifier}" has no export named "${exportName}"; it exports: ${available}`)
    }
    if (typeof target != "function") {
        throw new Error(
            `export "${exportName}" of "${moduleSpecifier}" is a ${typeof target}, not a function`,
        )
    }
    const callArguments = argumentsJson ? JSON.parse(argumentsJson) : []
    const result = await target(...callArguments)
    if (result !== undefined) {
        console.log(typeof result == "string" ? result : JSON.stringify(result))
    }
} catch (error) {
    // a job that throws is a failed run, not a crashed scheduler
    console.error(error?.stack ?? String(error))
    exitCode = 1
}
Deno.exit(exitCode)
