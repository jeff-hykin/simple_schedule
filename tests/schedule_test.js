import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.13"
import { formatDuration, parseDuration } from "../source/durations.js"
import { instantOfWallClock, offsetMillisecondsAt, wallClockAt } from "../source/time_zones.js"
import { nextCronOccurrence, parseCron } from "../source/cron.js"
import {
    cronExpressionOf,
    describeSchedule,
    nextRunAt,
    normalizeSchedule,
    parseScheduleText,
    parseTimeOfDay,
    parseWeekday,
} from "../source/schedule.js"

/** @param {Date} instant @param {string} timeZone */
function readableInZone(instant, timeZone) {
    const clock = wallClockAt(instant, timeZone)
    const pad = (value) => String(value).padStart(2, "0")
    return `${clock.year}-${pad(clock.month)}-${pad(clock.day)} ${pad(clock.hour)}:${pad(clock.minute)}`
}

Deno.test("parseDuration reads single and compound units", () => {
    assertEquals(parseDuration("30s"), 30 * 1000)
    assertEquals(parseDuration("15m"), 15 * 60 * 1000)
    assertEquals(parseDuration("7h"), 7 * 60 * 60 * 1000)
    assertEquals(parseDuration("1d"), 24 * 60 * 60 * 1000)
    assertEquals(parseDuration("1h30m"), 90 * 60 * 1000)
    assertEquals(parseDuration("2d12h"), 60 * 60 * 60 * 1000)
    assertEquals(parseDuration("500ms"), 500)
    assertEquals(parseDuration(1234), 1234)
})

Deno.test("parseDuration rejects junk with a useful message", () => {
    assertThrows(() => parseDuration("soon"), Error, "could not read")
    assertThrows(() => parseDuration("7"), Error, "could not read")
    assertThrows(() => parseDuration("7h junk"), Error, "could not read")
    assertThrows(() => parseDuration(""), Error, "empty")
    assertThrows(() => parseDuration(-5), Error, "non-negative")
})

Deno.test("formatDuration round-trips through parseDuration", () => {
    for (const text of ["30s", "15m", "7h", "1d", "1h30m", "2d12h", "1w"]) {
        assertEquals(parseDuration(formatDuration(parseDuration(text))), parseDuration(text))
    }
})

Deno.test("wallClockAt reads the same instant differently per zone", () => {
    const instant = new Date("2025-06-15T16:30:00Z")
    assertEquals(readableInZone(instant, "UTC"), "2025-06-15 16:30")
    assertEquals(readableInZone(instant, "America/Los_Angeles"), "2025-06-15 09:30")
    assertEquals(readableInZone(instant, "Asia/Tokyo"), "2025-06-16 01:30")
})

Deno.test("offsetMillisecondsAt tracks daylight saving", () => {
    const hour = 60 * 60 * 1000
    assertEquals(offsetMillisecondsAt(new Date("2025-01-15T12:00:00Z"), "America/Los_Angeles"), -8 * hour)
    assertEquals(offsetMillisecondsAt(new Date("2025-06-15T12:00:00Z"), "America/Los_Angeles"), -7 * hour)
    assertEquals(offsetMillisecondsAt(new Date("2025-06-15T12:00:00Z"), "UTC"), 0)
})

Deno.test("instantOfWallClock inverts wallClockAt, including across a DST boundary", () => {
    const zone = "America/Los_Angeles"
    for (
        const reading of [
            { year: 2025, month: 1, day: 15, hour: 9, minute: 0 },
            { year: 2025, month: 6, day: 15, hour: 9, minute: 0 },
            { year: 2025, month: 3, day: 9, hour: 9, minute: 0 },
            { year: 2025, month: 11, day: 2, hour: 9, minute: 0 },
        ]
    ) {
        const instant = instantOfWallClock(reading, zone)
        const roundTripped = wallClockAt(instant, zone)
        assertEquals(roundTripped.hour, reading.hour)
        assertEquals(roundTripped.minute, reading.minute)
        assertEquals(roundTripped.day, reading.day)
    }
})

Deno.test("parseCron expands stars, ranges, steps, lists, and names", () => {
    assertEquals([...parseCron("0 9 * * *").minutes], [0])
    assertEquals([...parseCron("0 9 * * *").hours], [9])
    assertEquals([...parseCron("*/15 * * * *").minutes], [0, 15, 30, 45])
    assertEquals([...parseCron("0 9 * * mon-fri").daysOfWeek], [1, 2, 3, 4, 5])
    assertEquals([...parseCron("0 9 * jan,jul *").months], [1, 7])
    assertEquals([...parseCron("0 0 1 * *").daysOfMonth], [1])
    assertEquals([...parseCron("@daily").hours], [0])
    // cron lets 7 stand in for Sunday
    assertEquals([...parseCron("0 0 * * 7").daysOfWeek], [0])
})

Deno.test("parseCron rejects bad expressions by name", () => {
    assertThrows(() => parseCron("0 9 * *"), Error, "exactly 5 fields")
    assertThrows(() => parseCron("60 9 * * *"), Error, "minute")
    assertThrows(() => parseCron("0 24 * * *"), Error, "hour")
    assertThrows(() => parseCron("0 9 * * funday"), Error, "dayOfWeek")
    assertThrows(() => parseCron("*/0 9 * * *"), Error, "step")
    assertThrows(() => parseCron("@reboot"), Error, "activation.onBoot")
})

Deno.test("nextCronOccurrence finds the next slot in the chosen zone", () => {
    const cron = parseCron("0 9 * * *")
    const from = new Date("2025-06-15T16:30:00Z")
    assertEquals(readableInZone(nextCronOccurrence(cron, from, "UTC"), "UTC"), "2025-06-16 09:00")
    assertEquals(
        readableInZone(nextCronOccurrence(cron, from, "America/Los_Angeles"), "America/Los_Angeles"),
        "2025-06-16 09:00",
    )
})

Deno.test("nextCronOccurrence returns null for a date that never happens", () => {
    assertEquals(nextCronOccurrence(parseCron("0 0 30 2 *"), new Date("2025-01-01T00:00:00Z"), "UTC"), null)
})

Deno.test("nextCronOccurrence ORs the two day fields when both are restricted", () => {
    // the 15th or any Monday
    const cron = parseCron("0 0 15 * mon")
    let cursor = new Date("2025-06-01T00:00:00Z")
    const hits = []
    for (let index = 0; index < 5; index++) {
        cursor = nextCronOccurrence(cron, cursor, "UTC")
        hits.push(readableInZone(cursor, "UTC"))
    }
    assertEquals(hits, [
        "2025-06-02 00:00",
        "2025-06-09 00:00",
        "2025-06-15 00:00",
        "2025-06-16 00:00",
        "2025-06-23 00:00",
    ])
})

Deno.test("parseTimeOfDay accepts the spellings a person would type", () => {
    assertEquals(parseTimeOfDay("09:00"), { hour: 9, minute: 0, second: 0 })
    assertEquals(parseTimeOfDay("9:05"), { hour: 9, minute: 5, second: 0 })
    assertEquals(parseTimeOfDay("9am"), { hour: 9, minute: 0, second: 0 })
    assertEquals(parseTimeOfDay("9:30pm"), { hour: 21, minute: 30, second: 0 })
    assertEquals(parseTimeOfDay("12am"), { hour: 0, minute: 0, second: 0 })
    assertEquals(parseTimeOfDay("12pm"), { hour: 12, minute: 0, second: 0 })
    assertEquals(parseTimeOfDay("noon"), { hour: 12, minute: 0, second: 0 })
    assertEquals(parseTimeOfDay("23:59:59"), { hour: 23, minute: 59, second: 59 })
    assertThrows(() => parseTimeOfDay("25:00"), Error, "not a real time")
    assertThrows(() => parseTimeOfDay("half past"), Error, "could not read")
})

Deno.test("parseWeekday accepts names, abbreviations, and numbers", () => {
    assertEquals(parseWeekday("sunday"), 0)
    assertEquals(parseWeekday("Mon"), 1)
    assertEquals(parseWeekday("friday"), 5)
    assertEquals(parseWeekday(6), 6)
    assertThrows(() => parseWeekday("caturday"), Error, "weekday")
})

Deno.test("parseScheduleText understands the shorthands", () => {
    assertEquals(parseScheduleText("every 7h"), { kind: "interval", every: "7h" })
    assertEquals(parseScheduleText("daily at 9am"), { kind: "daily", at: "9am" })
    assertEquals(parseScheduleText("every monday at 09:00"), { kind: "weekly", on: ["monday"], at: "09:00" })
    assertEquals(parseScheduleText("the first of the month at 03:00"), {
        kind: "monthly",
        on: [1],
        at: "03:00",
    })
    assertEquals(parseScheduleText("0 9 * * *"), { kind: "cron", expression: "0 9 * * *" })
    assertEquals(parseScheduleText("manual"), { kind: "manual" })
})

Deno.test("normalizeSchedule fills defaults and rejects nonsense", () => {
    assertEquals(normalizeSchedule(null), { kind: "manual" })
    assertEquals(normalizeSchedule("every 7h"), { kind: "interval", every: "7h", measuredFrom: "start" })
    assertEquals(normalizeSchedule({ kind: "daily" }), { kind: "daily", at: "00:00", timeZone: "local" })
    assertEquals(normalizeSchedule({ kind: "monthly" }), {
        kind: "monthly",
        at: "00:00",
        on: [1],
        timeZone: "local",
    })
    assertThrows(() => normalizeSchedule({ kind: "yearly" }), Error, "schedule.kind")
    assertThrows(() => normalizeSchedule({ kind: "interval", every: "10ms" }), Error, "at least 1s")
    assertThrows(
        () => normalizeSchedule({ kind: "daily", timeZone: "Mars/Olympus" }),
        Error,
        "not a time zone",
    )
    assertThrows(() => normalizeSchedule({ kind: "monthly", on: [45] }), Error, "1-31")
})

Deno.test("cronExpressionOf maps the friendly kinds onto cron", () => {
    assertEquals(cronExpressionOf(normalizeSchedule({ kind: "daily", at: "09:30" })), "30 9 * * *")
    assertEquals(
        cronExpressionOf(normalizeSchedule({ kind: "weekly", at: "9am", on: ["mon", "fri"] })),
        "0 9 * * 1,5",
    )
    assertEquals(
        cronExpressionOf(normalizeSchedule({ kind: "monthly", at: "3am", on: [1, 15] })),
        "0 3 1,15 * *",
    )
})

Deno.test("nextRunAt: daily stays at the same wall clock across a DST change", () => {
    const schedule = normalizeSchedule({ kind: "daily", at: "09:00", timeZone: "America/Los_Angeles" })
    // the Saturday before clocks spring forward, and the Saturday before they fall back
    for (const start of ["2025-03-08T20:00:00Z", "2025-11-01T20:00:00Z"]) {
        let cursor = new Date(start)
        for (let index = 0; index < 3; index++) {
            cursor = nextRunAt(schedule, { after: cursor })
            assertEquals(readableInZone(cursor, "America/Los_Angeles").slice(-5), "09:00")
        }
    }
})

Deno.test("nextRunAt: a UTC-anchored daily job shifts in local time but never in UTC", () => {
    const schedule = normalizeSchedule({ kind: "daily", at: "09:00", timeZone: "utc" })
    let cursor = new Date("2025-03-08T20:00:00Z")
    for (let index = 0; index < 3; index++) {
        cursor = nextRunAt(schedule, { after: cursor })
        assertEquals(readableInZone(cursor, "UTC").slice(-5), "09:00")
    }
})

Deno.test("nextRunAt: interval counts from the previous start by default", () => {
    const schedule = normalizeSchedule({ kind: "interval", every: "7h" })
    const previousStartAt = new Date("2025-06-15T00:00:00Z")
    const next = nextRunAt(schedule, { after: new Date("2025-06-15T01:00:00Z"), previousStartAt })
    assertEquals(next.toISOString(), "2025-06-15T07:00:00.000Z")
})

Deno.test("nextRunAt: interval can count from the previous completion instead", () => {
    const schedule = normalizeSchedule({ kind: "interval", every: "7h", measuredFrom: "completion" })
    const next = nextRunAt(schedule, {
        after: new Date("2025-06-15T03:00:00Z"),
        previousStartAt: new Date("2025-06-15T00:00:00Z"),
        previousEndAt: new Date("2025-06-15T02:00:00Z"),
    })
    assertEquals(next.toISOString(), "2025-06-15T09:00:00.000Z")
})

Deno.test("nextRunAt: a missed interval catches up to one slot, not a burst", () => {
    const schedule = normalizeSchedule({ kind: "interval", every: "1h" })
    // the machine was asleep for most of a day
    const next = nextRunAt(schedule, {
        after: new Date("2025-06-15T20:30:00Z"),
        previousStartAt: new Date("2025-06-15T00:00:00Z"),
    })
    assertEquals(next.toISOString(), "2025-06-15T21:00:00.000Z")
})

Deno.test("nextRunAt: weekly and monthly land where expected", () => {
    const weekly = normalizeSchedule({ kind: "weekly", at: "09:00", on: ["monday"], timeZone: "utc" })
    assertEquals(
        readableInZone(nextRunAt(weekly, { after: new Date("2025-06-15T00:00:00Z") }), "UTC"),
        "2025-06-16 09:00",
    )
    const monthly = normalizeSchedule({ kind: "monthly", at: "03:00", on: [1], timeZone: "utc" })
    assertEquals(
        readableInZone(nextRunAt(monthly, { after: new Date("2025-06-15T00:00:00Z") }), "UTC"),
        "2025-07-01 03:00",
    )
})

Deno.test("nextRunAt: manual jobs never schedule themselves", () => {
    assertEquals(nextRunAt(normalizeSchedule({ kind: "manual" }), {}), null)
})

Deno.test("describeSchedule says something a person can read", () => {
    assertEquals(describeSchedule(normalizeSchedule("every 7h")), "every 7h")
    assertEquals(
        describeSchedule(normalizeSchedule({ kind: "daily", at: "09:00" })),
        "daily at 09:00 local time",
    )
    assertEquals(describeSchedule(normalizeSchedule({ kind: "manual" })), "manual only")
})
