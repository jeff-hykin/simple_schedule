// Human durations like "7h", "90m", "1h30m", "2d12h" in and out of milliseconds.

const unitToMilliseconds = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
}

const durationPattern = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)/gy

/**
 * @param {string|number} text a duration like "1h30m", or a plain number of milliseconds
 * @returns {number} milliseconds
 * @throws {Error} when the text is not a duration this understands
 */
export function parseDuration(text) {
    if (typeof text == "number") {
        if (!Number.isFinite(text) || text < 0) {
            throw new Error(`duration must be a finite, non-negative number of milliseconds, got ${text}`)
        }
        return text
    }
    if (typeof text != "string") {
        throw new Error(
            `duration must be a string like "30m" or a number of milliseconds, got ${typeof text}`,
        )
    }
    const trimmed = text.trim().toLowerCase()
    if (trimmed.length == 0) {
        throw new Error(`duration is empty; try something like "30m" or "1h30m"`)
    }
    durationPattern.lastIndex = 0
    let total = 0
    let matchCount = 0
    let consumed = 0
    let match
    while ((match = durationPattern.exec(trimmed)) != null) {
        total += Number(match[1]) * unitToMilliseconds[match[2]]
        matchCount += 1
        // a sticky regex rewinds lastIndex to 0 the moment it fails, so remember how far we got
        consumed = durationPattern.lastIndex
    }
    if (matchCount == 0 || consumed != trimmed.length) {
        throw new Error(`could not read "${text}" as a duration; try "30s", "15m", "7h", "1d", or "1h30m"`)
    }
    return total
}

/**
 * The shortest readable spelling of a millisecond count, e.g. 5400000 becomes "1h30m".
 * @param {number} milliseconds
 * @returns {string}
 */
export function formatDuration(milliseconds) {
    if (milliseconds < 1000) {
        return `${Math.round(milliseconds)}ms`
    }
    const pieces = []
    let remaining = Math.round(milliseconds)
    for (const unit of ["w", "d", "h", "m", "s"]) {
        const size = unitToMilliseconds[unit]
        const count = Math.floor(remaining / size)
        if (count > 0) {
            pieces.push(`${count}${unit}`)
            remaining -= count * size
        }
    }
    return pieces.join("")
}
