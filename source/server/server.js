// The local web server. It is a thin shell over the same operations the CLI and TUI use, plus a
// static page and an event stream so the GUI can refresh itself.

import { contentType } from "jsr:@std/media-types@1.1.0"
import { extname, fromFileUrl, join, normalize } from "jsr:@std/path@1.1.2"
import { exampleJob, knownJobFields, overlapPolicies } from "../job_schema.js"
import { scheduleKinds } from "../schedule.js"
import { backoffKinds } from "../job_schema.js"
import { canRunJobsAsOtherUsers, installationStatus } from "../installer.js"
import { stateDirectory } from "../paths.js"
import { color } from "../colors.js"
import {
    addJob,
    daemonStatus,
    editJob,
    getJob,
    listJobs,
    logsFor,
    pauseJob,
    removeJob,
    runsFor,
    skipNextRuns,
    statsFor,
    triggerJob,
} from "../operations.js"

/** @returns {string} the directory holding the GUI's static files */
function webDirectory() {
    return fromFileUrl(import.meta.resolve("./web/"))
}

/**
 * @param {any} data
 * @param {number} [status]
 * @returns {Response}
 */
function jsonResponse(data, status = 200) {
    return new Response(`${JSON.stringify(data, null, 2)}\n`, {
        status,
        headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    })
}

/**
 * @param {unknown} error
 * @returns {Response}
 */
function errorResponse(error) {
    const problems = error?.problems ?? null
    return jsonResponse({ error: error?.message ?? String(error), problems }, problems ? 422 : 400)
}

/**
 * @param {Request} request
 * @returns {Promise<any>}
 */
async function readJsonBody(request) {
    const text = await request.text()
    if (text.trim().length == 0) {
        return {}
    }
    try {
        return JSON.parse(text)
    } catch (error) {
        throw new Error(`the request body is not valid JSON: ${error.message}`)
    }
}

/**
 * @param {string} pathname
 * @returns {Promise<Response>}
 */
async function serveStatic(pathname) {
    const relative = pathname == "/" ? "index.html" : pathname.slice(1)
    const resolved = normalize(join(webDirectory(), relative))
    if (!resolved.startsWith(webDirectory())) {
        return new Response("no", { status: 403 })
    }
    try {
        const body = await Deno.readFile(resolved)
        return new Response(body, {
            headers: { "content-type": contentType(extname(resolved)) ?? "application/octet-stream" },
        })
    } catch (_error) {
        return new Response("not found", { status: 404 })
    }
}

/** Everything the GUI needs for one render, in one request. */
async function overview() {
    const [jobs, daemon, runs] = await Promise.all([listJobs(), daemonStatus(), runsFor(null, 50)])
    return {
        jobs,
        daemon,
        runs,
        installation: installationStatus(),
        canRunJobsAsOtherUsers: canRunJobsAsOtherUsers(),
        stateDirectory: stateDirectory(),
        vocabulary: { scheduleKinds, overlapPolicies, backoffKinds, knownJobFields },
    }
}

/**
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function handleRequest(request) {
    const url = new URL(request.url)
    const path = url.pathname
    if (!path.startsWith("/api/")) {
        return serveStatic(path)
    }
    try {
        if (path == "/api/overview" && request.method == "GET") {
            return jsonResponse(await overview())
        }
        if (path == "/api/status" && request.method == "GET") {
            return jsonResponse({ daemon: await daemonStatus(), installation: installationStatus() })
        }
        if (path == "/api/schema" && request.method == "GET") {
            return jsonResponse({
                example: exampleJob("nightly-backup"),
                fields: knownJobFields,
                scheduleKinds,
            })
        }
        if (path == "/api/jobs" && request.method == "GET") {
            return jsonResponse(await listJobs())
        }
        if (path == "/api/jobs" && request.method == "POST") {
            return jsonResponse(await addJob(await readJsonBody(request)), 201)
        }
        if (path == "/api/runs" && request.method == "GET") {
            return jsonResponse(
                await runsFor(url.searchParams.get("job"), Number(url.searchParams.get("limit") ?? 50)),
            )
        }
        if (path == "/api/events") {
            return eventStream()
        }
        const jobMatch = path.match(/^\/api\/jobs\/([^/]+)(?:\/(\w+))?$/)
        if (jobMatch) {
            const id = decodeURIComponent(jobMatch[1])
            const action = jobMatch[2]
            if (!action && request.method == "GET") {
                return jsonResponse(await getJob(id))
            }
            if (!action && request.method == "PATCH") {
                return jsonResponse(await editJob(id, await readJsonBody(request)))
            }
            if (!action && request.method == "DELETE") {
                await removeJob(id, { forgetHistory: url.searchParams.get("forgetHistory") == "true" })
                return jsonResponse({ removed: id })
            }
            if (action == "trigger" && request.method == "POST") {
                return jsonResponse(await triggerJob(id, { wait: url.searchParams.get("wait") != "false" }))
            }
            if (action == "skip" && request.method == "POST") {
                const body = await readJsonBody(request)
                return jsonResponse(await skipNextRuns(id, body.count ?? 1))
            }
            if (action == "pause" && request.method == "POST") {
                const body = await readJsonBody(request)
                return jsonResponse(
                    await pauseJob(id, body.until ?? new Date(8640000000000000).toISOString()),
                )
            }
            if (action == "resume" && request.method == "POST") {
                return jsonResponse(await pauseJob(id, null))
            }
            if (action == "runs" && request.method == "GET") {
                return jsonResponse(await runsFor(id, Number(url.searchParams.get("limit") ?? 60)))
            }
            if (action == "stats" && request.method == "GET") {
                return jsonResponse(await statsFor(id, Number(url.searchParams.get("days") ?? 30)))
            }
            if (action == "logs" && request.method == "GET") {
                return jsonResponse(await logsFor(id, Number(url.searchParams.get("lines") ?? 300)))
            }
        }
        return jsonResponse({ error: `no route for ${request.method} ${path}` }, 404)
    } catch (error) {
        return errorResponse(error)
    }
}

/**
 * A heartbeat the page listens to so it can poll for changes without guessing an interval.
 * @returns {Response}
 */
function eventStream() {
    let timer
    const body = new ReadableStream({
        start(controller) {
            const encoder = new TextEncoder()
            const send = async () => {
                try {
                    const snapshot = await overview()
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(snapshot)}\n\n`))
                } catch (_error) {
                    // a failed snapshot should not kill the stream; the next tick may work
                }
            }
            send()
            timer = setInterval(send, 3000)
        },
        cancel() {
            clearInterval(timer)
        },
    })
    return new Response(body, {
        headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            "connection": "keep-alive",
        },
    })
}

/**
 * @param {{port?: number, hostname?: string, open?: boolean, signal?: AbortSignal}} [options]
 * @returns {Promise<void>}
 */
export async function startServer({ port = 7373, hostname = "127.0.0.1", open = false, signal } = {}) {
    const server = Deno.serve({
        port,
        hostname,
        signal,
        onListen: ({ hostname: boundHost, port: boundPort }) => {
            const address = `http://${boundHost == "0.0.0.0" ? "localhost" : boundHost}:${boundPort}`
            console.log(`${color.green("simple_schedule")} web GUI on ${color.bold(address)}`)
            console.log(
                color.gray(
                    `press ? in the page for the keyboard shortcuts, or ctrl+k for the command palette`,
                ),
            )
            if (open) {
                openInBrowser(address)
            }
        },
    }, handleRequest)
    await server.finished
}

/** @param {string} address */
function openInBrowser(address) {
    const opener = Deno.build.os == "darwin" ? "open" : "xdg-open"
    try {
        new Deno.Command(opener, { args: [address], stdout: "null", stderr: "null" }).spawn()
    } catch (_error) {
        // not being able to open a browser is not worth failing over
    }
}

export { handleRequest }
