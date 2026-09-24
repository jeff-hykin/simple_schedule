// Appending to a job's log file, with size-based rotation so a chatty job cannot fill the disk.

import { dirname } from "jsr:@std/path@1.1.2"

/**
 * @param {string} path
 * @param {number} maxBytes
 * @param {number} keepFiles
 */
export function rotateIfNeeded(path, maxBytes, keepFiles) {
    let size = 0
    try {
        size = Deno.statSync(path).size
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            return
        }
        throw error
    }
    if (size < maxBytes) {
        return
    }
    if (keepFiles < 1) {
        Deno.truncateSync(path, 0)
        return
    }
    for (let index = keepFiles - 1; index >= 1; index--) {
        try {
            Deno.renameSync(`${path}.${index}`, `${path}.${index + 1}`)
        } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) {
                throw error
            }
        }
    }
    Deno.renameSync(path, `${path}.1`)
}

/**
 * Open a job's log file for appending, rotating first if it has grown past its limit.
 * @param {string} path
 * @param {{maxBytes?: number, keepFiles?: number}} options
 * @returns {Deno.FsFile}
 */
export function openLogFile(path, { maxBytes = 5 * 1024 * 1024, keepFiles = 3 } = {}) {
    Deno.mkdirSync(dirname(path), { recursive: true })
    rotateIfNeeded(path, maxBytes, keepFiles)
    return Deno.openSync(path, { create: true, append: true, write: true })
}

/**
 * Read the last `lineCount` lines of a log file without pulling the whole thing into memory.
 * @param {string} path
 * @param {number} lineCount
 * @returns {string}
 */
export function tailLogFile(path, lineCount = 200) {
    let file
    try {
        file = Deno.openSync(path, { read: true })
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
            return ""
        }
        throw error
    }
    try {
        const size = file.statSync().size
        const chunkSize = 64 * 1024
        let position = size
        let collected = ""
        const decoder = new TextDecoder()
        while (position > 0 && collected.split("\n").length <= lineCount + 1) {
            const readSize = Math.min(chunkSize, position)
            position -= readSize
            const buffer = new Uint8Array(readSize)
            file.seekSync(position, Deno.SeekMode.Start)
            let filled = 0
            while (filled < readSize) {
                const read = file.readSync(buffer.subarray(filled))
                if (read == null) {
                    break
                }
                filled += read
            }
            collected = decoder.decode(buffer.subarray(0, filled)) + collected
        }
        const lines = collected.split("\n")
        return lines.slice(Math.max(0, lines.length - lineCount)).join("\n")
    } finally {
        file.close()
    }
}
