// The RFC 5545 recurrence-rule subset that calendar-style callers hand us: FREQ, INTERVAL, BYMONTH,
// BYMONTHDAY, BYDAY (plain weekdays), BYHOUR, BYMINUTE, and BYSECOND. Daily-or-longer rules step in
// wall-clock time so "every other Sunday at 5pm" survives DST; sub-daily rules step in elapsed time so
// "every 20 minutes" never stalls or doubles up when the clocks change.

import { instantOfWallClock, wallClockAt } from "./time_zones.js"

export const recurrenceFrequencies = [
    "YEARLY",
    "MONTHLY",
    "WEEKLY",
    "DAILY",
    "HOURLY",
    "MINUTELY",
    "SECONDLY",
]
export const weekdayCodes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]

const recurrenceFields = ["bymonth", "bymonthday", "byday", "byhour", "byminute", "bysecond"]
const fieldRanges = {
    bymonth: [1, 12],
    bymonthday: [1, 31],
    byhour: [0, 23],
    byminute: [0, 59],
    bysecond: [0, 59],
}
const elapsedStepMilliseconds = { HOURLY: 3600 * 1000, MINUTELY: 60 * 1000, SECONDLY: 1000 }
const dayMilliseconds = 24 * 3600 * 1000
// a rule that has not matched anything within this span (say, February 30th) never will
const searchHorizonMilliseconds = 10 * 366 * dayMilliseconds
const maximumSteps = 200000

/**
 * Validate and tidy the recurrence part of a schedule. Accepts "RRULE:FREQ=...;..." text too.
 * @param {object|string} source
 * @returns {{freq: string, interval: number, bymonth?: number[], bymonthday?: number[], byday?: string[], byhour?: number[], byminute?: number[], bysecond?: number[]}}
 */
export function normalizeRecurrence(source) {
    if (typeof source == "string") {
        source = parseRecurrenceText(source)
    }
    const freq = String(source.freq ?? "").toUpperCase()
    if (!recurrenceFrequencies.includes(freq)) {
        throw new Error(
            `freq must be one of ${recurrenceFrequencies.join(", ")}, got ${JSON.stringify(source.freq)}`,
        )
    }
    const interval = source.interval ?? 1
    if (!Number.isInteger(interval) || interval < 1) {
        throw new Error(
            `interval must be a whole number of at least 1, got ${JSON.stringify(source.interval)}`,
        )
    }
    const rule = { freq, interval }
    for (const field of recurrenceFields) {
        const value = source[field]
        if (value == null) {
            continue
        }
        if (!Array.isArray(value) || value.length == 0) {
            throw new Error(`${field} must be a non-empty array, got ${JSON.stringify(value)}`)
        }
        if (field == "byday") {
            rule.byday = value.map((day) => {
                // both "MO" and "monday" start with the right two letters
                const code = String(day).trim().slice(0, 2).toUpperCase()
                if (!weekdayCodes.includes(code)) {
                    throw new Error(
                        `byday must hold weekdays like "MO" or "monday", got ${JSON.stringify(day)}`,
                    )
                }
                return code
            })
            continue
        }
        const [low, high] = fieldRanges[field]
        for (const number of value) {
            if (!Number.isInteger(number) || number < low || number > high) {
                throw new Error(
                    `${field} must hold whole numbers ${low}-${high}, got ${JSON.stringify(number)}`,
                )
            }
        }
        rule[field] = [...new Set(value)].sort((a, b) => a - b)
    }
    return rule
}

/**
 * Read "FREQ=WEEKLY;INTERVAL=2;BYDAY=SU;BYHOUR=17" (with or without a leading "RRULE:") into an object.
 * COUNT and UNTIL come back too, for the schedule to use as its end conditions.
 * @param {string} text
 * @returns {object}
 */
export function parseRecurrenceText(text) {
    const result = {}
    for (const piece of String(text).trim().replace(/^rrule:/i, "").split(";")) {
        if (piece.trim().length == 0) {
            continue
        }
        const [rawName, rawValue] = piece.split("=")
        const name = rawName.trim().toLowerCase()
        const value = (rawValue ?? "").trim()
        if (name == "freq") {
            result.freq = value.toUpperCase()
        } else if (name == "interval" || name == "count") {
            result[name] = Number(value)
        } else if (name == "until") {
            // RFC 5545 writes it compactly, as 20260922T000000Z
            const compact = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/)
            result.until = compact
                ? `${compact[1]}-${compact[2]}-${compact[3]}T${compact[4] ?? "00"}:${compact[5] ?? "00"}:${
                    compact[6] ?? "00"
                }${compact[7] ?? ""}`
                : value
        } else if (name == "byday") {
            result.byday = value.split(",")
        } else if (recurrenceFields.includes(name)) {
            result[name] = value.split(",").map(Number)
        } else if (name == "tzid") {
            result.timeZone = value
        } else {
            throw new Error(`recurrence part "${rawName}" is not supported`)
        }
    }
    return result
}

/**
 * A wall-clock reading as if it were UTC, so day arithmetic never meets a DST change.
 * @param {Date} instant
 * @param {string} timeZone
 * @returns {Date}
 */
function wallClockAsUtc(instant, timeZone) {
    const wall = wallClockAt(instant, timeZone)
    return new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second))
}

/**
 * @param {number} year
 * @param {number} monthIndex 0-11
 * @returns {number}
 */
function daysInMonth(year, monthIndex) {
    return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
}

/**
 * The days (as UTC-midnight Dates in wall-clock space) of period `k` for a daily-or-longer rule.
 * @param {object} rule
 * @param {Date} anchor wall-clock-as-UTC start
 * @param {number} k
 * @returns {Date[]}
 */
function daysOfPeriod(rule, anchor, k) {
    const year = anchor.getUTCFullYear()
    const monthIndex = anchor.getUTCMonth()
    const day = anchor.getUTCDate()
    const step = k * rule.interval
    if (rule.freq == "DAILY") {
        return [new Date(Date.UTC(year, monthIndex, day + step))]
    }
    if (rule.freq == "WEEKLY") {
        // weeks start on Monday, as RFC 5545's default WKST does
        const mondayOffset = (anchor.getUTCDay() + 6) % 7
        const monday = Date.UTC(year, monthIndex, day - mondayOffset + step * 7)
        return Array.from({ length: 7 }, (_, index) => new Date(monday + index * dayMilliseconds))
    }
    if (rule.freq == "MONTHLY") {
        const first = new Date(Date.UTC(year, monthIndex + step, 1))
        const count = daysInMonth(first.getUTCFullYear(), first.getUTCMonth())
        return Array.from(
            { length: count },
            (_, index) => new Date(first.getTime() + index * dayMilliseconds),
        )
    }
    const first = Date.UTC(year + step, 0, 1)
    const count = (Date.UTC(year + step + 1, 0, 1) - first) / dayMilliseconds
    return Array.from({ length: count }, (_, index) => new Date(first + index * dayMilliseconds))
}

/**
 * Whether a day belongs to the rule, including RFC 5545's "fall back to the start date" defaults.
 * @param {object} rule
 * @param {Date} anchor
 * @param {Date} day
 * @returns {boolean}
 */
function dayMatches(rule, anchor, day) {
    const month = day.getUTCMonth() + 1
    const date = day.getUTCDate()
    const weekday = weekdayCodes[day.getUTCDay()]
    if (rule.bymonth && !rule.bymonth.includes(month)) {
        return false
    }
    if (rule.bymonthday && !rule.bymonthday.includes(date)) {
        return false
    }
    if (rule.byday && !rule.byday.includes(weekday)) {
        return false
    }
    const hasDayFilter = rule.bymonthday != null || rule.byday != null
    if (rule.freq == "YEARLY" && !hasDayFilter) {
        return date == anchor.getUTCDate() && (rule.bymonth != null || month == anchor.getUTCMonth() + 1)
    }
    if (rule.freq == "MONTHLY" && !hasDayFilter) {
        return date == anchor.getUTCDate()
    }
    if (rule.freq == "WEEKLY" && rule.byday == null) {
        return day.getUTCDay() == anchor.getUTCDay()
    }
    return true
}

/**
 * Which period a daily-or-longer rule is in at `wallAfter`, rounded down, so the search starts there.
 * @param {object} rule
 * @param {Date} anchor
 * @param {Date} wallAfter
 * @returns {number}
 */
function periodIndexAt(rule, anchor, wallAfter) {
    let units
    if (rule.freq == "DAILY") {
        units = Math.floor((wallAfter - anchor) / dayMilliseconds)
    } else if (rule.freq == "WEEKLY") {
        units = Math.floor((wallAfter - anchor) / (7 * dayMilliseconds))
    } else if (rule.freq == "MONTHLY") {
        units = (wallAfter.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
            wallAfter.getUTCMonth() - anchor.getUTCMonth()
    } else {
        units = wallAfter.getUTCFullYear() - anchor.getUTCFullYear()
    }
    // one period early, because a week or a month can straddle the rounding
    return Math.max(0, Math.floor(units / rule.interval) - 1)
}

/**
 * @param {object} rule
 * @param {Date} start
 * @param {Date} after
 * @param {string} timeZone
 * @returns {Date|null}
 */
function nextWallClockOccurrence(rule, start, after, timeZone) {
    const anchor = wallClockAsUtc(start, timeZone)
    const wallAfter = wallClockAsUtc(after, timeZone)
    const hours = rule.byhour ?? [anchor.getUTCHours()]
    const minutes = rule.byminute ?? [anchor.getUTCMinutes()]
    const seconds = rule.bysecond ?? [anchor.getUTCSeconds()]
    const horizon = wallAfter.getTime() + searchHorizonMilliseconds
    for (let k = periodIndexAt(rule, anchor, wallAfter); k < maximumSteps; k++) {
        const days = daysOfPeriod(rule, anchor, k)
        if (days[0].getTime() > horizon) {
            return null
        }
        for (const day of days) {
            if (!dayMatches(rule, anchor, day)) {
                continue
            }
            for (const hour of hours) {
                for (const minute of minutes) {
                    for (const second of seconds) {
                        const instant = instantOfWallClock({
                            year: day.getUTCFullYear(),
                            month: day.getUTCMonth() + 1,
                            day: day.getUTCDate(),
                            hour,
                            minute,
                            second,
                        }, timeZone)
                        if (instant > after && instant >= start) {
                            return instant
                        }
                    }
                }
            }
        }
    }
    return null
}

/**
 * @param {object} rule
 * @param {Date} start
 * @param {Date} after
 * @param {string} timeZone
 * @returns {Date|null}
 */
function nextElapsedOccurrence(rule, start, after, timeZone) {
    const step = elapsedStepMilliseconds[rule.freq] * rule.interval
    const startTime = start.getTime()
    const horizon = after.getTime() + searchHorizonMilliseconds
    let k = Math.max(0, Math.floor((after.getTime() - startTime) / step))
    for (let steps = 0; steps < maximumSteps; steps++) {
        const periodStart = new Date(startTime + k * step)
        if (periodStart.getTime() > horizon) {
            return null
        }
        const wall = wallClockAt(periodStart, timeZone)
        // the start of the next day/hour/minute on the wall clock, to leap over whole spans a limit rules out
        const skipTo = (unit) => {
            const next = unit == "day"
                ? instantOfWallClock({ year: wall.year, month: wall.month, day: wall.day + 1 }, timeZone)
                : new Date(
                    periodStart.getTime() - wall.second * 1000 -
                        (unit == "hour" ? wall.minute * 60 * 1000 : 0) +
                        (unit == "hour" ? 3600 * 1000 : 60 * 1000),
                )
            return Math.max(k + 1, Math.ceil((next.getTime() - startTime) / step))
        }
        if (
            (rule.bymonth && !rule.bymonth.includes(wall.month)) ||
            (rule.bymonthday && !rule.bymonthday.includes(wall.day)) ||
            (rule.byday && !rule.byday.includes(weekdayCodes[wall.weekday]))
        ) {
            k = skipTo("day")
            continue
        }
        if (rule.byhour && !rule.byhour.includes(wall.hour)) {
            k = skipTo("hour")
            continue
        }
        let candidates
        if (rule.freq == "HOURLY") {
            const hourStart = periodStart.getTime() - wall.minute * 60 * 1000 - wall.second * 1000
            const minutes = rule.byminute ?? [wall.minute]
            const seconds = rule.bysecond ?? [wall.second]
            candidates = minutes.flatMap((minute) =>
                seconds.map((second) => new Date(hourStart + minute * 60 * 1000 + second * 1000))
            )
        } else if (rule.freq == "MINUTELY") {
            if (rule.byminute && !rule.byminute.includes(wall.minute)) {
                k = skipTo("minute")
                continue
            }
            const minuteStart = periodStart.getTime() - wall.second * 1000
            candidates = (rule.bysecond ?? [wall.second]).map((second) =>
                new Date(minuteStart + second * 1000)
            )
        } else {
            if (
                (rule.byminute && !rule.byminute.includes(wall.minute)) ||
                (rule.bysecond && !rule.bysecond.includes(wall.second))
            ) {
                k += 1
                continue
            }
            candidates = [periodStart]
        }
        for (const candidate of candidates) {
            if (candidate > after && candidate >= start) {
                return candidate
            }
        }
        k += 1
    }
    return null
}

/**
 * The first occurrence strictly after `after`.
 * @param {object} rule a normalized recurrence
 * @param {{after: Date, start: Date, timeZone: string}} context `start` anchors the rule, like DTSTART
 * @returns {Date|null}
 */
export function nextRecurrence(rule, { after, start, timeZone }) {
    // anchor on the whole minute, so a rule made at 10:03:37 fires at :00 seconds
    const anchoredStart = new Date(Math.floor(start.getTime() / 60000) * 60000)
    if (elapsedStepMilliseconds[rule.freq]) {
        return nextElapsedOccurrence(rule, anchoredStart, after, timeZone)
    }
    return nextWallClockOccurrence(rule, anchoredStart, after, timeZone)
}

/**
 * A one-line reading of a recurrence, e.g. "every 2 weeks on SU at 17:00".
 * @param {object} rule
 * @returns {string}
 */
export function describeRecurrence(rule) {
    const unit = {
        YEARLY: "year",
        MONTHLY: "month",
        WEEKLY: "week",
        DAILY: "day",
        HOURLY: "hour",
        MINUTELY: "minute",
        SECONDLY: "second",
    }[rule.freq]
    let text = rule.interval == 1 ? `every ${unit}` : `every ${rule.interval} ${unit}s`
    if (rule.bymonth) {
        text += ` in month ${rule.bymonth.join(", ")}`
    }
    if (rule.bymonthday) {
        text += ` on day ${rule.bymonthday.join(", ")}`
    }
    if (rule.byday) {
        text += ` on ${rule.byday.join(", ")}`
    }
    if (rule.byhour && !elapsedStepMilliseconds[rule.freq]) {
        const minutes = rule.byminute ?? [0]
        const times = rule.byhour.flatMap((hour) =>
            minutes.map((minute) => `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`)
        )
        text += ` at ${times.join(", ")}`
    } else {
        if (rule.byhour) {
            text += ` during hour ${rule.byhour.join(", ")}`
        }
        if (rule.byminute) {
            text += ` at minute ${rule.byminute.join(", ")}`
        }
    }
    return text
}
