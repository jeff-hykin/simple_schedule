// Time-zone-aware wall-clock math built on Intl, so there are no dependencies and DST is handled
// by the platform's own tz database instead of by hand.

const partsFormatterCache = new Map()

/**
 * @param {string} timeZone
 * @returns {Intl.DateTimeFormat}
 */
function partsFormatterFor(timeZone) {
    let formatter = partsFormatterCache.get(timeZone)
    if (!formatter) {
        formatter = new Intl.DateTimeFormat("en-US", {
            timeZone,
            hourCycle: "h23",
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            weekday: "short",
        })
        partsFormatterCache.set(timeZone, formatter)
    }
    return formatter
}

const weekdayNameToIndex = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

/**
 * The name of the time zone the machine itself is set to.
 * @returns {string}
 */
export function systemTimeZone() {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/**
 * True when the string names a time zone this platform actually knows about.
 * @param {string} timeZone
 * @returns {boolean}
 */
export function isValidTimeZone(timeZone) {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone })
        return true
    } catch (_error) {
        return false
    }
}

/**
 * The wall-clock reading a person in `timeZone` would see at this instant.
 * @param {Date} instant
 * @param {string} timeZone
 * @returns {{year: number, month: number, day: number, hour: number, minute: number, second: number, weekday: number}}
 */
export function wallClockAt(instant, timeZone) {
    const parts = {}
    for (const part of partsFormatterFor(timeZone).formatToParts(instant)) {
        parts[part.type] = part.value
    }
    return {
        year: Number(parts.year),
        month: Number(parts.month),
        day: Number(parts.day),
        // Intl renders midnight as hour 24 in some ICU versions, which is the same clock reading as 0
        hour: Number(parts.hour) % 24,
        minute: Number(parts.minute),
        second: Number(parts.second),
        weekday: weekdayNameToIndex[parts.weekday],
    }
}

/**
 * How far `timeZone` sits ahead of UTC at this instant, in milliseconds.
 * @param {Date} instant
 * @param {string} timeZone
 * @returns {number}
 */
export function offsetMillisecondsAt(instant, timeZone) {
    const wallClock = wallClockAt(instant, timeZone)
    const asIfUtc = Date.UTC(
        wallClock.year,
        wallClock.month - 1,
        wallClock.day,
        wallClock.hour,
        wallClock.minute,
        wallClock.second,
    )
    // Intl throws away sub-second precision, so compare against a whole second of the real instant
    return asIfUtc - Math.floor(instant.getTime() / 1000) * 1000
}

/**
 * The instant at which `timeZone` reads this wall-clock time. Converges in a couple of passes even
 * across a DST boundary; a reading that DST skipped resolves to the moment the clocks jumped past it.
 * @param {{year: number, month: number, day: number, hour?: number, minute?: number, second?: number}} wallClock
 * @param {string} timeZone
 * @returns {Date}
 */
export function instantOfWallClock(wallClock, timeZone) {
    const asIfUtc = Date.UTC(
        wallClock.year,
        wallClock.month - 1,
        wallClock.day,
        wallClock.hour ?? 0,
        wallClock.minute ?? 0,
        wallClock.second ?? 0,
    )
    let guess = asIfUtc
    for (let attempt = 0; attempt < 4; attempt++) {
        const corrected = asIfUtc - offsetMillisecondsAt(new Date(guess), timeZone)
        if (corrected === guess) {
            break
        }
        guess = corrected
    }
    return new Date(guess)
}
