// A tiny ANSI helper. Colors switch themselves off when stdout is not a terminal, when NO_COLOR is
// set, or when the caller asks.

const codes = {
    reset: 0,
    bold: 1,
    dim: 2,
    italic: 3,
    underline: 4,
    red: 31,
    green: 32,
    yellow: 33,
    blue: 34,
    magenta: 35,
    cyan: 36,
    white: 37,
    gray: 90,
    brightRed: 91,
    brightGreen: 92,
    brightYellow: 93,
    brightBlue: 94,
    brightMagenta: 95,
    brightCyan: 96,
}

let enabled = detectColorSupport()

/** @returns {boolean} */
function detectColorSupport() {
    if (Deno.env.get("NO_COLOR")) {
        return false
    }
    if (Deno.env.get("FORCE_COLOR")) {
        return true
    }
    try {
        return Deno.stdout.isTerminal()
    } catch (_error) {
        return false
    }
}

/** @param {boolean} value */
export function setColorEnabled(value) {
    enabled = value
}

/** @returns {boolean} */
export function colorEnabled() {
    return enabled
}

export const color = new Proxy({}, {
    get(_target, name) {
        const code = codes[name]
        if (code == null) {
            throw new Error(`no such color "${String(name)}"`)
        }
        return (text) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : String(text))
    },
})

/**
 * The color a run status should be shown in.
 * @param {string|null} status
 * @returns {string}
 */
export function paintStatus(status) {
    if (status == "success") {
        return color.green(status)
    }
    if (status == "failure" || status == "error") {
        return color.red(status)
    }
    if (status == "timeout") {
        return color.yellow(status)
    }
    if (status == null) {
        return color.gray("never run")
    }
    return color.cyan(status)
}

// built rather than written as a literal, so the escape character stays out of the source
const ansiEscapePattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g")

/**
 * Strip escapes so column widths can be measured.
 * @param {string} text
 * @returns {number}
 */
export function visibleWidth(text) {
    return String(text).replace(ansiEscapePattern, "").length
}

/**
 * Render rows as an aligned table.
 * @param {string[]} headers
 * @param {string[][]} rows
 * @returns {string}
 */
export function renderTable(headers, rows) {
    const widths = headers.map((header, index) =>
        Math.max(visibleWidth(header), ...rows.map((row) => visibleWidth(row[index] ?? "")))
    )
    const pad = (text, width) => `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`
    const lines = [headers.map((header, index) => color.bold(pad(header, widths[index]))).join("  ")]
    for (const row of rows) {
        lines.push(headers.map((_header, index) => pad(row[index] ?? "", widths[index])).join("  "))
    }
    return lines.join("\n")
}
