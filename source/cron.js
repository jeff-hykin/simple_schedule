// A dependency-free five-field cron parser that evaluates against a wall clock in a chosen time zone.

import { instantOfWallClock, wallClockAt } from "./time_zones.js"

const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
const weekdayNames = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]

const fieldSpecs = [
    { name: "minute", min: 0, max: 59, names: null },
    { name: "hour", min: 0, max: 23, names: null },
    { name: "dayOfMonth", min: 1, max: 31, names: null },
    { name: "month", min: 1, max: 12, names: monthNames },
    { name: "dayOfWeek", min: 0, max: 7, names: weekdayNames },
]

const namedShorthands = {
    "@yearly": "0 0 1 1 *",
    "@annually": "0 0 1 1 *",
    "@monthly": "0 0 1 * *",
    "@weekly": "0 0 * * 0",
    "@daily": "0 0 * * *",
    "@midnight": "0 0 * * *",
    "@hourly": "0 * * * *",
}

/**
 * @param {string} piece one comma-separated term of one field
 * @param {{name: string, min: number, max: number, names: string[]|null}} spec
 * @returns {number[]}
 */
function valuesOfTerm(piece, spec) {
    let step = 1
    let rangeText = piece
    const slashIndex = piece.indexOf("/")
    if (slashIndex != -1) {
        rangeText = piece.slice(0, slashIndex)
        const stepText = piece.slice(slashIndex + 1)
        step = Number(stepText)
        if (!Number.isInteger(step) || step < 1) {
            throw new Error(
                `cron ${spec.name} field: step must be a positive whole number, got "${stepText}"`,
            )
        }
    }

    /** @param {string} text */
    const toNumber = (text) => {
        if (spec.names) {
            const nameIndex = spec.names.indexOf(text.toLowerCase())
            if (nameIndex != -1) {
                return spec.name == "month" ? nameIndex + 1 : nameIndex
            }
        }
        const value = Number(text)
        if (!Number.isInteger(value)) {
            const allowed = spec.names ? ` or one of ${spec.names.join(", ")}` : ""
            throw new Error(
                `cron ${spec.name} field: expected a whole number ${spec.min}-${spec.max}${allowed}, got "${text}"`,
            )
        }
        return value
    }

    let start
    let end
    if (rangeText == "*") {
        start = spec.min
        end = spec.max
    } else {
        const dashIndex = rangeText.indexOf("-", 1)
        if (dashIndex != -1) {
            start = toNumber(rangeText.slice(0, dashIndex))
            end = toNumber(rangeText.slice(dashIndex + 1))
        } else {
            start = toNumber(rangeText)
            // a bare number with a step means "from here to the end of the field", as in "5/10"
            end = slashIndex != -1 ? spec.max : start
        }
    }
    if (start < spec.min || end > spec.max || start > end) {
        throw new Error(
            `cron ${spec.name} field: "${piece}" is outside the allowed range ${spec.min}-${spec.max}`,
        )
    }
    const values = []
    for (let value = start; value <= end; value += step) {
        values.push(value)
    }
    return values
}

/**
 * Turn a cron expression into the set of values each field allows.
 * @param {string} expression e.g. "0 9 * * mon-fri" or "@daily"
 * @returns {{minutes: Set<number>, hours: Set<number>, daysOfMonth: Set<number>, months: Set<number>, daysOfWeek: Set<number>, dayOfMonthRestricted: boolean, dayOfWeekRestricted: boolean}}
 */
export function parseCron(expression) {
    if (typeof expression != "string") {
        throw new Error(`cron expression must be a string, got ${typeof expression}`)
    }
    const trimmed = expression.trim().toLowerCase()
    if (trimmed == "@reboot") {
        throw new Error(
            `"@reboot" is not a cron schedule here; use the job's activation.onBoot option instead`,
        )
    }
    const normalized = namedShorthands[trimmed] ?? trimmed
    const fields = normalized.split(/\s+/).filter((piece) => piece.length > 0)
    if (fields.length != 5) {
        throw new Error(
            `cron expression needs exactly 5 fields (minute hour day-of-month month day-of-week), got ${fields.length} in "${expression}"`,
        )
    }
    const parsed = fields.map((field, index) => {
        const spec = fieldSpecs[index]
        const values = new Set()
        for (const piece of field.split(",")) {
            if (piece.length == 0) {
                throw new Error(`cron ${spec.name} field: empty term in "${field}"`)
            }
            for (const value of valuesOfTerm(piece, spec)) {
                values.add(value)
            }
        }
        return values
    })
    const daysOfWeek = parsed[4]
    // cron lets 7 mean Sunday as well as 0
    if (daysOfWeek.has(7)) {
        daysOfWeek.delete(7)
        daysOfWeek.add(0)
    }
    return {
        minutes: parsed[0],
        hours: parsed[1],
        daysOfMonth: parsed[2],
        months: parsed[3],
        daysOfWeek,
        dayOfMonthRestricted: fields[2] != "*",
        dayOfWeekRestricted: fields[4] != "*",
    }
}

/**
 * Standard cron day matching: when both day fields are restricted the job runs if *either* matches.
 * @param {ReturnType<typeof parseCron>} cron
 * @param {number} dayOfMonth
 * @param {number} dayOfWeek
 * @returns {boolean}
 */
function dayMatches(cron, dayOfMonth, dayOfWeek) {
    const monthMatches = cron.daysOfMonth.has(dayOfMonth)
    const weekMatches = cron.daysOfWeek.has(dayOfWeek)
    if (cron.dayOfMonthRestricted && cron.dayOfWeekRestricted) {
        return monthMatches || weekMatches
    }
    return monthMatches && weekMatches
}

/** @param {number} year @param {number} month @returns {number} */
function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** @param {{year: number, month: number, day: number}} date @returns {number} */
function weekdayOf(date) {
    return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay()
}

/**
 * The first instant strictly after `after` at which this cron expression fires, read in `timeZone`.
 * @param {ReturnType<typeof parseCron>} cron
 * @param {Date} after
 * @param {string} timeZone
 * @returns {Date|null} null when the expression can never fire (e.g. February 30th)
 */
export function nextCronOccurrence(cron, after, timeZone) {
    const start = wallClockAt(new Date(after.getTime() + 60 * 1000), timeZone)
    let { year, month, day, hour, minute } = start
    const yearLimit = year + 8

    while (year <= yearLimit) {
        if (!cron.months.has(month)) {
            month += 1
            day = 1
            hour = 0
            minute = 0
            if (month > 12) {
                month = 1
                year += 1
            }
            continue
        }
        if (day > daysInMonth(year, month)) {
            month += 1
            day = 1
            hour = 0
            minute = 0
            if (month > 12) {
                month = 1
                year += 1
            }
            continue
        }
        if (!dayMatches(cron, day, weekdayOf({ year, month, day }))) {
            day += 1
            hour = 0
            minute = 0
            continue
        }
        if (!cron.hours.has(hour)) {
            hour += 1
            minute = 0
            if (hour > 23) {
                hour = 0
                day += 1
            }
            continue
        }
        if (!cron.minutes.has(minute)) {
            minute += 1
            if (minute > 59) {
                minute = 0
                hour += 1
                if (hour > 23) {
                    hour = 0
                    day += 1
                }
            }
            continue
        }
        const instant = instantOfWallClock({ year, month, day, hour, minute, second: 0 }, timeZone)
        // a DST jump can fold this reading onto an instant we have already passed, so keep looking
        if (instant.getTime() > after.getTime()) {
            return instant
        }
        minute += 1
        if (minute > 59) {
            minute = 0
            hour += 1
            if (hour > 23) {
                hour = 0
                day += 1
            }
        }
    }
    return null
}
