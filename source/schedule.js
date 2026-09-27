// The schedule kinds a job can have, and the math for "when does this run next".

import { nextCronOccurrence, parseCron } from "./cron.js"
import { parseDuration } from "./durations.js"
import { isValidTimeZone, systemTimeZone } from "./time_zones.js"
import { describeRecurrence, nextRecurrence, normalizeRecurrence, parseRecurrenceText } from "./rrule.js"

export const scheduleKinds = [
    "interval",
    "daily",
    "weekly",
    "monthly",
    "cron",
    "rrule",
    "keepAlive",
    "manual",
]

const weekdayLongNames = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]

/**
 * Accepts "9:05", "09:05:30", "9am", "9:30pm", "noon", "midnight".
 * @param {string|number} text
 * @returns {{hour: number, minute: number, second: number}}
 */
export function parseTimeOfDay(text) {
    if (typeof text == "number") {
        text = String(text)
    }
    if (typeof text != "string") {
        throw new Error(`time of day must be a string like "09:00", got ${typeof text}`)
    }
    const trimmed = text.trim().toLowerCase()
    if (trimmed == "noon") {
        return { hour: 12, minute: 0, second: 0 }
    }
    if (trimmed == "midnight") {
        return { hour: 0, minute: 0, second: 0 }
    }
    const match = trimmed.match(/^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?$/)
    if (!match) {
        throw new Error(`could not read "${text}" as a time of day; try "09:00", "9:30pm", or "noon"`)
    }
    let hour = Number(match[1])
    const minute = match[2] == null ? 0 : Number(match[2])
    const second = match[3] == null ? 0 : Number(match[3])
    const meridiem = match[4]
    if (meridiem) {
        if (hour < 1 || hour > 12) {
            throw new Error(`"${text}" uses ${meridiem} so the hour must be 1-12`)
        }
        hour = hour % 12
        if (meridiem == "pm") {
            hour += 12
        }
    }
    if (hour > 23 || minute > 59 || second > 59) {
        throw new Error(`"${text}" is not a real time of day`)
    }
    return { hour, minute, second }
}

/**
 * @param {string|number} value a weekday name, abbreviation, or 0-6 with Sunday as 0
 * @returns {number}
 */
export function parseWeekday(value) {
    if (typeof value == "number") {
        if (!Number.isInteger(value) || value < 0 || value > 6) {
            throw new Error(`weekday number must be 0-6 (Sunday is 0), got ${value}`)
        }
        return value
    }
    const lowered = String(value).trim().toLowerCase()
    const exactIndex = weekdayLongNames.indexOf(lowered)
    if (exactIndex != -1) {
        return exactIndex
    }
    const abbreviationIndex = weekdayLongNames.findIndex((name) => name.slice(0, 3) == lowered)
    if (abbreviationIndex != -1) {
        return abbreviationIndex
    }
    throw new Error(`could not read "${value}" as a weekday; try "monday" or "mon"`)
}

/**
 * Resolve the zone a schedule is anchored to. "local" follows whatever the machine is set to, which
 * is what "9am regardless of timezone" means; "utc" pins to UTC; anything else must be an IANA name.
 * @param {string|undefined} timeZone
 * @returns {string}
 */
export function resolveTimeZone(timeZone) {
    if (timeZone == null || timeZone == "local") {
        return systemTimeZone()
    }
    if (timeZone.toLowerCase() == "utc") {
        return "UTC"
    }
    if (!isValidTimeZone(timeZone)) {
        throw new Error(
            `"${timeZone}" is not a time zone this machine knows; use "local", "utc", or an IANA name like "America/Los_Angeles"`,
        )
    }
    return timeZone
}

/**
 * Read a shorthand string into a schedule object. Everything the TUI and CLI accept as a one-liner
 * funnels through here, so the object form and the string form can never drift apart.
 * @param {string} text
 * @returns {object}
 */
export function parseScheduleText(text) {
    const trimmed = String(text).trim()
    const lowered = trimmed.toLowerCase()
    if (lowered == "manual" || lowered == "never" || lowered == "none") {
        return { kind: "manual" }
    }
    if (lowered == "keep alive" || lowered == "keepalive" || lowered == "always") {
        return { kind: "keepAlive" }
    }
    if (/^(rrule:)?freq=/.test(lowered)) {
        return { kind: "rrule", ...parseRecurrenceText(trimmed) }
    }
    let match = lowered.match(/^every\s+(.+)$/)
    if (match) {
        const rest = match[1].trim()
        const weekdayMatch = rest.match(/^(\w+day|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\s+at\s+(.+)$/)
        if (weekdayMatch) {
            return {
                kind: "weekly",
                on: [weekdayLongNames[parseWeekday(weekdayMatch[1])]],
                at: weekdayMatch[2].trim(),
            }
        }
        if (rest == "day") {
            return { kind: "daily", at: "00:00" }
        }
        return { kind: "interval", every: rest }
    }
    match = lowered.match(/^(daily|weekly|monthly)(?:\s+at\s+(.+))?$/)
    if (match) {
        const at = match[2] == null ? "00:00" : match[2].trim()
        if (match[1] == "daily") {
            return { kind: "daily", at }
        }
        if (match[1] == "weekly") {
            return { kind: "weekly", on: ["monday"], at }
        }
        return { kind: "monthly", on: [1], at }
    }
    match = lowered.match(/^(?:on\s+)?the\s+first\s+of\s+the\s+month(?:\s+at\s+(.+))?$/)
    if (match) {
        return { kind: "monthly", on: [1], at: match[1] == null ? "00:00" : match[1].trim() }
    }
    // anything left over is treated as cron, which also covers the "@daily" style shorthands
    parseCron(trimmed)
    return { kind: "cron", expression: trimmed }
}

/**
 * Fill in defaults and reject nonsense, so everything downstream can trust the shape.
 * @param {object|string} schedule
 * @returns {object} a normalized schedule
 */
export function normalizeSchedule(schedule) {
    if (schedule == null) {
        return { kind: "manual" }
    }
    if (typeof schedule == "string") {
        schedule = parseScheduleText(schedule)
    }
    if (typeof schedule != "object") {
        throw new Error(`schedule must be an object or a string, got ${typeof schedule}`)
    }
    const kind = schedule.kind ?? "manual"
    if (!scheduleKinds.includes(kind)) {
        throw new Error(`schedule.kind must be one of ${scheduleKinds.join(", ")}, got "${kind}"`)
    }
    if (kind == "manual") {
        return { kind: "manual" }
    }
    if (kind == "keepAlive") {
        return { kind: "keepAlive" }
    }
    return { ...normalizeTimedSchedule(kind, schedule), ...normalizeEndConditions(schedule) }
}

/**
 * `count` and `until` end any timed schedule: after that many scheduled occurrences, or past that
 * instant, it never comes due again.
 * @param {object} schedule
 * @returns {{count?: number, until?: string}}
 */
function normalizeEndConditions(schedule) {
    const ends = {}
    if (schedule.count != null) {
        if (!Number.isInteger(schedule.count) || schedule.count < 1) {
            throw new Error(
                `schedule.count must be a whole number of at least 1, got ${JSON.stringify(schedule.count)}`,
            )
        }
        ends.count = schedule.count
    }
    if (schedule.until != null) {
        if (typeof schedule.until != "string" || isNaN(new Date(schedule.until).getTime())) {
            throw new Error(`schedule.until must be an ISO timestamp, got ${JSON.stringify(schedule.until)}`)
        }
        ends.until = schedule.until
    }
    return ends
}

/**
 * @param {string} kind
 * @param {object} schedule
 * @returns {object}
 */
function normalizeTimedSchedule(kind, schedule) {
    if (kind == "interval") {
        const every = parseDuration(schedule.every)
        if (every < 1000) {
            throw new Error(`schedule.every must be at least 1s, got ${schedule.every}`)
        }
        const measuredFrom = schedule.measuredFrom ?? "start"
        if (measuredFrom != "start" && measuredFrom != "completion") {
            throw new Error(`schedule.measuredFrom must be "start" or "completion", got "${measuredFrom}"`)
        }
        return { kind: "interval", every: schedule.every, measuredFrom }
    }
    // the remaining kinds are all wall-clock anchored
    const timeZone = schedule.timeZone ?? schedule.tzid ?? "local"
    resolveTimeZone(timeZone)
    if (kind == "rrule") {
        const normalized = { kind: "rrule", ...normalizeRecurrence(schedule), timeZone }
        if (schedule.start != null) {
            if (typeof schedule.start != "string" || isNaN(new Date(schedule.start).getTime())) {
                throw new Error(
                    `schedule.start must be an ISO timestamp, got ${JSON.stringify(schedule.start)}`,
                )
            }
            normalized.start = schedule.start
        }
        return normalized
    }
    if (kind == "cron") {
        parseCron(schedule.expression)
        return { kind: "cron", expression: schedule.expression, timeZone }
    }
    const at = schedule.at ?? "00:00"
    parseTimeOfDay(at)
    if (kind == "daily") {
        return { kind: "daily", at, timeZone }
    }
    if (kind == "weekly") {
        const on = schedule.on ?? ["monday"]
        if (!Array.isArray(on) || on.length == 0) {
            throw new Error(`schedule.on must be a non-empty array of weekdays for a weekly schedule`)
        }
        return { kind: "weekly", at, on: on.map((day) => weekdayLongNames[parseWeekday(day)]), timeZone }
    }
    const on = schedule.on ?? [1]
    if (!Array.isArray(on) || on.length == 0) {
        throw new Error(`schedule.on must be a non-empty array of days of the month for a monthly schedule`)
    }
    for (const day of on) {
        if (!Number.isInteger(day) || day < 1 || day > 31) {
            throw new Error(`schedule.on must hold whole numbers 1-31 for a monthly schedule, got ${day}`)
        }
    }
    return { kind: "monthly", at, on, timeZone }
}

/**
 * The cron expression a wall-clock schedule is equivalent to. Keeping one evaluator for all of them
 * means daily/weekly/monthly cannot disagree with cron about DST or month lengths.
 * @param {object} schedule a normalized, non-manual, non-interval schedule
 * @returns {string}
 */
export function cronExpressionOf(schedule) {
    if (schedule.kind == "cron") {
        return schedule.expression
    }
    const { hour, minute } = parseTimeOfDay(schedule.at)
    if (schedule.kind == "daily") {
        return `${minute} ${hour} * * *`
    }
    if (schedule.kind == "weekly") {
        return `${minute} ${hour} * * ${schedule.on.map((day) => parseWeekday(day)).join(",")}`
    }
    return `${minute} ${hour} ${schedule.on.join(",")} * *`
}

/**
 * When does this job run next?
 * @param {object} schedule a normalized schedule
 * @param {{after?: Date, previousStartAt?: Date|null, previousEndAt?: Date|null, createdAt?: Date, occurrencesUsed?: number}} context
 * @returns {Date|null} null for manual and keep-alive jobs, and for schedules that are over or can never fire
 */
export function nextRunAt(schedule, context = {}) {
    if (schedule.count != null && (context.occurrencesUsed ?? 0) >= schedule.count) {
        return null
    }
    const next = nextRunIgnoringEnd(schedule, context)
    if (next != null && schedule.until != null && next > new Date(schedule.until)) {
        return null
    }
    return next
}

/**
 * @param {object} schedule
 * @param {object} context
 * @returns {Date|null}
 */
function nextRunIgnoringEnd(schedule, context) {
    const after = context.after ?? new Date()
    if (schedule.kind == "manual" || schedule.kind == "keepAlive") {
        return null
    }
    if (schedule.kind == "interval") {
        const every = parseDuration(schedule.every)
        const previous = schedule.measuredFrom == "completion"
            ? context.previousEndAt
            : context.previousStartAt
        const anchor = previous ?? context.createdAt ?? after
        let candidate = anchor.getTime() + every
        if (candidate <= after.getTime()) {
            // the daemon was asleep through one or more slots; line back up instead of firing a burst
            const missed = Math.ceil((after.getTime() - anchor.getTime()) / every)
            candidate = anchor.getTime() + missed * every
            if (candidate <= after.getTime()) {
                candidate += every
            }
        }
        return new Date(candidate)
    }
    const timeZone = resolveTimeZone(schedule.timeZone)
    if (schedule.kind == "rrule") {
        const start = schedule.start ? new Date(schedule.start) : context.createdAt ?? after
        return nextRecurrence(schedule, { after, start, timeZone })
    }
    return nextCronOccurrence(parseCron(cronExpressionOf(schedule)), after, timeZone)
}

/**
 * A one-line human reading of a schedule, for the TUI, CLI listings, and the web GUI.
 * @param {object} schedule a normalized schedule
 * @returns {string}
 */
export function describeSchedule(schedule) {
    let text = describeWithoutEnd(schedule)
    if (schedule.count != null) {
        text += `, ${schedule.count} time${schedule.count == 1 ? "" : "s"}`
    }
    if (schedule.until != null) {
        text += `, until ${schedule.until}`
    }
    return text
}

/**
 * @param {object} schedule
 * @returns {string}
 */
function describeWithoutEnd(schedule) {
    if (schedule.kind == "manual") {
        return "manual only"
    }
    if (schedule.kind == "keepAlive") {
        return "kept running, restarted whenever it exits"
    }
    if (schedule.kind == "interval") {
        const measured = schedule.measuredFrom == "completion" ? " after each finish" : ""
        return `every ${schedule.every}${measured}`
    }
    const zone = schedule.timeZone == "local" || schedule.timeZone == null
        ? "local time"
        : resolveTimeZone(schedule.timeZone)
    if (schedule.kind == "daily") {
        return `daily at ${schedule.at} ${zone}`
    }
    if (schedule.kind == "weekly") {
        return `every ${schedule.on.join(", ")} at ${schedule.at} ${zone}`
    }
    if (schedule.kind == "monthly") {
        return `day ${schedule.on.join(", ")} of each month at ${schedule.at} ${zone}`
    }
    if (schedule.kind == "rrule") {
        return `${describeRecurrence(schedule)} ${zone}`
    }
    return `cron "${schedule.expression}" in ${zone}`
}
