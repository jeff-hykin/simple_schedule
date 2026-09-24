// The daemon speaks newline-delimited JSON over a unix socket. Every other surface — CLI, TUI, and
// the web server — talks to it through this one client.

import { controlSocketPath } from "./paths.js"

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/** Raised when there is no daemon listening, so callers can fall back to working on the files. */
export class DaemonNotRunningError extends Error {
    /** @param {string} socketPath */
    constructor(socketPath) {
        super(
            `no simple_schedule daemon is listening on ${socketPath} — start one with "simple_schedule daemon", or install it with "simple_schedule install"`,
        )
        this.name = "DaemonNotRunningError"
        this.socketPath = socketPath
    }
}

/**
 * Send one request and read one reply.
 * @param {object} request
 * @param {{socketPath?: string, timeoutMs?: number}} [options]
 * @returns {Promise<any>} the `data` of a successful reply
 */
export async function askDaemon(request, { socketPath = controlSocketPath(), timeoutMs = 30000 } = {}) {
    let connection
    try {
        connection = await Deno.connect({ transport: "unix", path: socketPath })
    } catch (_error) {
        // any failure to connect means there is no daemon to talk to, whatever the reason
        throw new DaemonNotRunningError(socketPath)
    }
    const timeoutHandle = setTimeout(() => {
        try {
            connection.close()
        } catch (_error) {
            // already closed
        }
    }, timeoutMs)
    try {
        await connection.write(textEncoder.encode(`${JSON.stringify(request)}\n`))
        let buffer = ""
        const chunk = new Uint8Array(64 * 1024)
        while (!buffer.includes("\n")) {
            const read = await connection.read(chunk)
            if (read == null) {
                break
            }
            buffer += textDecoder.decode(chunk.subarray(0, read))
        }
        const line = buffer.split("\n")[0]
        if (!line) {
            throw new Error("the daemon closed the connection without replying")
        }
        const reply = JSON.parse(line)
        if (!reply.ok) {
            throw new Error(reply.error ?? "the daemon reported an unspecified failure")
        }
        return reply.data
    } finally {
        clearTimeout(timeoutHandle)
        try {
            connection.close()
        } catch (_error) {
            // already closed
        }
    }
}

/**
 * @param {{socketPath?: string}} [options]
 * @returns {Promise<boolean>}
 */
export async function isDaemonRunning(options = {}) {
    try {
        await askDaemon({ command: "ping" }, { ...options, timeoutMs: 2000 })
        return true
    } catch (_error) {
        return false
    }
}

/**
 * Serve the control socket, handing each request to `handle`.
 * @param {(request: object) => Promise<any>} handle
 * @param {{socketPath?: string, signal?: AbortSignal}} [options]
 * @returns {Promise<void>}
 */
export async function serveControlSocket(handle, { socketPath = controlSocketPath(), signal } = {}) {
    try {
        Deno.removeSync(socketPath)
    } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
            throw error
        }
    }
    const listener = Deno.listen({ transport: "unix", path: socketPath })
    signal?.addEventListener("abort", () => {
        try {
            listener.close()
        } catch (_error) {
            // already closed
        }
    }, { once: true })
    try {
        for await (const connection of listener) {
            handleConnection(connection, handle)
        }
    } catch (error) {
        if (!signal?.aborted && !(error instanceof Deno.errors.BadResource)) {
            throw error
        }
    } finally {
        try {
            Deno.removeSync(socketPath)
        } catch (_error) {
            // it may already be gone
        }
    }
}

/**
 * @param {Deno.Conn} connection
 * @param {(request: object) => Promise<any>} handle
 */
async function handleConnection(connection, handle) {
    try {
        let buffer = ""
        const chunk = new Uint8Array(64 * 1024)
        while (!buffer.includes("\n")) {
            const read = await connection.read(chunk)
            if (read == null) {
                return
            }
            buffer += textDecoder.decode(chunk.subarray(0, read))
        }
        let reply
        try {
            reply = { ok: true, data: await handle(JSON.parse(buffer.split("\n")[0])) }
        } catch (error) {
            reply = { ok: false, error: error.message ?? String(error) }
        }
        await connection.write(textEncoder.encode(`${JSON.stringify(reply)}\n`))
    } catch (_error) {
        // a client that hangs up mid-request is not the daemon's problem
    } finally {
        try {
            connection.close()
        } catch (_error) {
            // already closed
        }
    }
}
