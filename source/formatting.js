// Turning timestamps, durations, and job records into the short strings every surface shows.

import { formatDuration } from "./durations.js"

/**
 * @param {string|Date|null} value
 * @returns {string}
 */
export function formatTimestamp(value) {
    if (!value) {
        return "—"
    }
    const date = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(date.getTime())) {
        return "—"
    }
    const pad = (piece) => String(piece).padStart(2, "0")
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${
        pad(date.getHours())
    }:${pad(date.getMinutes())}`
}

/**
 * "in 3h", "5m ago", relative to now.
 * @param {string|Date|null} value
 * @param {Date} [now]
 * @returns {string}
 */
export function formatRelative(value, now = new Date()) {
    if (!value) {
        return "—"
    }
    const date = value instanceof Date ? value : new Date(value)
    if (Number.isNaN(date.getTime())) {
        return "—"
    }
    const difference = date.getTime() - now.getTime()
    if (Math.abs(difference) < 1000) {
        return "now"
    }
    return difference > 0 ? `in ${formatDuration(difference)}` : `${formatDuration(-difference)} ago`
}

/**
 * @param {number|null} milliseconds
 * @returns {string}
 */
export function formatMaybeDuration(milliseconds) {
    if (milliseconds == null) {
        return "—"
    }
    return formatDuration(milliseconds)
}

/**
 * @param {number|null} rate a fraction from 0 to 1
 * @returns {string}
 */
export function formatPercent(rate) {
    if (rate == null) {
        return "—"
    }
    return `${Math.round(rate * 100)}%`
}
