import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.13"
import { RRule } from "https://esm.sh/rrule@2.8.1"
import {
    describeRecurrence,
    nextRecurrence,
    normalizeRecurrence,
    parseRecurrenceText,
} from "../source/rrule.js"
import { instantOfWallClock, wallClockAt } from "../source/time_zones.js"

/**
 * The first `count` occurrences after `start`, by walking nextRecurrence.
 * @param {object} rule
 * @param {Date} start
 * @param {string} timeZone
 * @param {number} count
 * @returns {string[]}
 */
function walk(rule, start, timeZone, count) {
    const results = []
    let after = new Date(start.getTime() - 1)
    for (let index = 0; index < count; index++) {
        const next = nextRecurrence(normalizeRecurrence(rule), { after, start, timeZone })
        if (next == null) {
            break
        }
        results.push(next.toISOString())
        after = next
    }
    return results
}

/**
 * The same occurrences from the rrule npm package, run in wall-clock space (the "phantom UTC" trick),
 * as an independent reference.
 * @param {object} rule
 * @param {Date} start
 * @param {string} timeZone
 * @param {number} count
 * @returns {string[]}
 */
function reference(rule, start, timeZone, count) {
    const wall = wallClockAt(start, timeZone)
    const dtstart = new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0))
    const options = { freq: RRule[rule.freq], dtstart, interval: rule.interval ?? 1, count, wkst: RRule.MO }
    for (const field of ["bymonth", "bymonthday", "byhour", "byminute", "bysecond"]) {
        if (rule[field]) {
            options[field] = rule[field]
        }
    }
    if (rule.byday) {
        options.byweekday = rule.byday.map((code) => RRule[code])
    }
    if (!rule.bysecond && rule.freq != "SECONDLY") {
        // our anchor drops the seconds; a SECONDLY rule must not be limited to :00 by that
        options.bysecond = [0]
    }
    return new RRule(options).all().map((phantom) =>
        instantOfWallClock({
            year: phantom.getUTCFullYear(),
            month: phantom.getUTCMonth() + 1,
            day: phantom.getUTCDate(),
            hour: phantom.getUTCHours(),
            minute: phantom.getUTCMinutes(),
            second: phantom.getUTCSeconds(),
        }, timeZone).toISOString()
    )
}

const start = new Date("2026-02-10T17:23:45Z")

const wallClockRules = [
    { freq: "DAILY", byhour: [5], byminute: [0] },
    { freq: "DAILY", byhour: [9, 16], byminute: [0] },
    { freq: "DAILY", byhour: [9, 13, 19], byminute: [0] },
    { freq: "DAILY", interval: 3, byhour: [7], byminute: [45] },
    { freq: "DAILY" },
    { freq: "WEEKLY", byday: ["MO"], byhour: [9], byminute: [0] },
    { freq: "WEEKLY", interval: 2, byday: ["SU"], byhour: [17], byminute: [0] },
    { freq: "WEEKLY", interval: 3, byday: ["TU", "FR"], byhour: [8], byminute: [15, 45] },
    { freq: "WEEKLY" },
    { freq: "MONTHLY", bymonthday: [1, 15], byhour: [3], byminute: [0] },
    { freq: "MONTHLY", bymonthday: [31], byhour: [12], byminute: [0] },
    { freq: "MONTHLY", byday: ["WE"], byhour: [10], byminute: [0] },
    { freq: "MONTHLY", interval: 2 },
    { freq: "YEARLY", bymonth: [3, 11], bymonthday: [8], byhour: [2], byminute: [30] },
    { freq: "YEARLY" },
    { freq: "DAILY", bymonth: [3], byday: ["SA", "SU"], byhour: [2], byminute: [30] },
]

for (const timeZone of ["America/Los_Angeles", "Asia/Shanghai", "UTC"]) {
    for (const rule of wallClockRules) {
        Deno.test(`matches the rrule package: ${JSON.stringify(rule)} in ${timeZone}`, () => {
            // the reference includes DTSTART itself when it matches; ours only counts what is after it
            const expected = reference(rule, start, timeZone, 40).filter((iso) => new Date(iso) >= start)
            assertEquals(walk(rule, start, timeZone, expected.length), expected)
        })
    }
}

// sub-daily rules step in elapsed time, which only equals the reference where there is no DST
const elapsedRules = [
    { freq: "MINUTELY", interval: 20 },
    { freq: "MINUTELY", interval: 15, byhour: [8, 9, 10, 11, 12, 13, 14, 15, 16] },
    { freq: "HOURLY", interval: 3 },
    { freq: "HOURLY", byminute: [0, 30] },
    { freq: "MINUTELY", interval: 7, byday: ["MO", "WE"] },
    { freq: "SECONDLY", interval: 45 },
]
for (const rule of elapsedRules) {
    Deno.test(`matches the rrule package: ${JSON.stringify(rule)} in UTC`, () => {
        const expected = reference(rule, start, "UTC", 60).filter((iso) => new Date(iso) >= start)
        assertEquals(walk(rule, start, "UTC", expected.length), expected)
    })
}

Deno.test("every 20 minutes keeps a steady 20 minutes across a DST change", () => {
    const beforeFallBack = new Date("2026-11-01T07:50:00Z") // 00:50 PDT
    const times = walk({ freq: "MINUTELY", interval: 20 }, beforeFallBack, "America/Los_Angeles", 12)
    for (let index = 1; index < times.length; index++) {
        assertEquals(new Date(times[index]) - new Date(times[index - 1]), 20 * 60 * 1000)
    }
})

Deno.test("daily at 9am stays at 9am wall clock across a DST change", () => {
    const times = walk(
        { freq: "DAILY", byhour: [9], byminute: [0] },
        new Date("2026-03-06T12:00:00Z"),
        "America/Los_Angeles",
        4,
    )
    for (const iso of times) {
        const wall = wallClockAt(new Date(iso), "America/Los_Angeles")
        assertEquals([wall.hour, wall.minute], [9, 0])
    }
})

Deno.test("a rule that can never match gives up instead of looping", () => {
    const rule = normalizeRecurrence({ freq: "YEARLY", bymonth: [2], bymonthday: [30] })
    assertEquals(nextRecurrence(rule, { after: start, start, timeZone: "UTC" }), null)
    const minutely = normalizeRecurrence({ freq: "MINUTELY", bymonth: [2], bymonthday: [30] })
    assertEquals(nextRecurrence(minutely, { after: start, start, timeZone: "UTC" }), null)
})

Deno.test("a sparse sub-daily rule leaps ahead instead of stepping minute by minute", () => {
    const rule = normalizeRecurrence({ freq: "MINUTELY", bymonth: [12], byday: ["SU"], byhour: [4] })
    const began = performance.now()
    const next = nextRecurrence(rule, { after: start, start, timeZone: "America/Los_Angeles" })
    assertEquals(performance.now() - began < 500, true)
    const wall = wallClockAt(next, "America/Los_Angeles")
    assertEquals([wall.month, wall.weekday, wall.hour], [12, 0, 4])
})

Deno.test("normalizeRecurrence accepts cbg-style rules and weekday names", () => {
    assertEquals(normalizeRecurrence({ freq: "weekly", byday: ["monday", "fr"], byhour: [9, 9, 7] }), {
        freq: "WEEKLY",
        interval: 1,
        byday: ["MO", "FR"],
        byhour: [7, 9],
    })
    assertThrows(() => normalizeRecurrence({ freq: "FORTNIGHTLY" }), Error, "freq must be one of")
    assertThrows(() => normalizeRecurrence({ freq: "DAILY", byhour: [24] }), Error, "byhour")
    assertThrows(() => normalizeRecurrence({ freq: "DAILY", byday: ["XX"] }), Error, "byday")
    assertThrows(() => normalizeRecurrence({ freq: "DAILY", interval: 0 }), Error, "interval")
})

Deno.test("parseRecurrenceText reads RFC 5545 text, including a compact UNTIL", () => {
    assertEquals(
        parseRecurrenceText("RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SU;BYHOUR=17;COUNT=4;UNTIL=20260922T000000Z"),
        {
            freq: "WEEKLY",
            interval: 2,
            byday: ["SU"],
            byhour: [17],
            count: 4,
            until: "2026-09-22T00:00:00Z",
        },
    )
    assertThrows(() => parseRecurrenceText("FREQ=DAILY;BYSETPOS=1"), Error, "not supported")
})

Deno.test("describeRecurrence reads like a sentence", () => {
    assertEquals(
        describeRecurrence(
            normalizeRecurrence({ freq: "WEEKLY", interval: 2, byday: ["SU"], byhour: [17], byminute: [0] }),
        ),
        "every 2 weeks on SU at 17:00",
    )
    assertEquals(
        describeRecurrence(normalizeRecurrence({ freq: "MINUTELY", interval: 20 })),
        "every 20 minutes",
    )
})
