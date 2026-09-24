// Small inline-SVG charts. No chart library, no build step — the data sets here are tiny and the
// shapes are simple enough to draw directly.

/**
 * @param {string} name
 * @param {Record<string, string|number>} attributes
 * @param {(SVGElement|string)[]} [children]
 * @returns {SVGElement}
 */
function svgElement(name, attributes, children = []) {
    const element = document.createElementNS("http://www.w3.org/2000/svg", name)
    for (const [key, value] of Object.entries(attributes)) {
        element.setAttribute(key, String(value))
    }
    for (const child of children) {
        element.append(child)
    }
    return element
}

/**
 * Stacked success/failure counts per day.
 * @param {{day: string, successes: number, failures: number, averageDurationMs: number|null}[]} history
 * @returns {SVGElement}
 */
export function runsPerDayChart(history) {
    const width = 640
    const height = 140
    const padding = { top: 10, right: 8, bottom: 20, left: 30 }
    const plotWidth = width - padding.left - padding.right
    const plotHeight = height - padding.top - padding.bottom
    const svg = svgElement("svg", { class: "chart", viewBox: `0 0 ${width} ${height}`, role: "img" })
    svg.append(svgElement("title", {}, [`runs per day over the last ${history.length} day(s)`]))
    if (history.length == 0) {
        svg.append(
            svgElement("text", { x: width / 2, y: height / 2, "text-anchor": "middle" }, ["no runs yet"]),
        )
        return svg
    }
    const tallest = Math.max(1, ...history.map((entry) => entry.successes + entry.failures))
    const slotWidth = plotWidth / history.length
    const barWidth = Math.max(2, Math.min(26, slotWidth - 4))
    for (const tick of [0, Math.ceil(tallest / 2), tallest]) {
        const y = padding.top + plotHeight - (tick / tallest) * plotHeight
        svg.append(svgElement("line", {
            x1: padding.left,
            x2: width - padding.right,
            y1: y,
            y2: y,
            stroke: "currentColor",
            "stroke-opacity": 0.12,
        }))
        svg.append(
            svgElement("text", { x: padding.left - 5, y: y + 3, "text-anchor": "end" }, [String(tick)]),
        )
    }
    history.forEach((entry, index) => {
        const x = padding.left + index * slotWidth + (slotWidth - barWidth) / 2
        const successHeight = (entry.successes / tallest) * plotHeight
        const failureHeight = (entry.failures / tallest) * plotHeight
        if (failureHeight > 0) {
            svg.append(svgElement("rect", {
                x,
                y: padding.top + plotHeight - failureHeight,
                width: barWidth,
                height: failureHeight,
                fill: "var(--red)",
            }, [svgElement("title", {}, [`${entry.day}: ${entry.failures} failed`])]))
        }
        if (successHeight > 0) {
            svg.append(svgElement("rect", {
                x,
                y: padding.top + plotHeight - failureHeight - successHeight,
                width: barWidth,
                height: successHeight,
                fill: "var(--green)",
            }, [svgElement("title", {}, [`${entry.day}: ${entry.successes} succeeded`])]))
        }
    })
    const firstLabel = history[0].day.slice(5)
    const lastLabel = history[history.length - 1].day.slice(5)
    svg.append(svgElement("text", { x: padding.left, y: height - 6 }, [firstLabel]))
    svg.append(
        svgElement("text", { x: width - padding.right, y: height - 6, "text-anchor": "end" }, [lastLabel]),
    )
    return svg
}

/**
 * Duration of each recent run, oldest on the left, colored by outcome.
 * @param {{durationMs: number|null, status: string, startedAt: string}[]} runs newest first
 * @returns {SVGElement}
 */
export function durationChart(runs) {
    const points = [...runs].reverse().filter((run) => run.durationMs != null)
    const width = 640
    const height = 140
    const padding = { top: 10, right: 8, bottom: 20, left: 44 }
    const plotWidth = width - padding.left - padding.right
    const plotHeight = height - padding.top - padding.bottom
    const svg = svgElement("svg", { class: "chart", viewBox: `0 0 ${width} ${height}`, role: "img" })
    svg.append(svgElement("title", {}, ["how long each recent run took"]))
    if (points.length == 0) {
        svg.append(
            svgElement("text", { x: width / 2, y: height / 2, "text-anchor": "middle" }, [
                "no finished runs yet",
            ]),
        )
        return svg
    }
    const longest = Math.max(...points.map((run) => run.durationMs))
    const scale = longest == 0 ? 0 : plotHeight / longest
    for (const tick of [0, longest / 2, longest]) {
        const y = padding.top + plotHeight - tick * scale
        svg.append(svgElement("line", {
            x1: padding.left,
            x2: width - padding.right,
            y1: y,
            y2: y,
            stroke: "currentColor",
            "stroke-opacity": 0.12,
        }))
        svg.append(
            svgElement("text", { x: padding.left - 5, y: y + 3, "text-anchor": "end" }, [
                formatShortDuration(tick),
            ]),
        )
    }
    const slotWidth = plotWidth / points.length
    const barWidth = Math.max(2, Math.min(20, slotWidth - 3))
    const colorFor = (
        status,
    ) => (status == "success" ? "var(--green)" : status == "timeout" ? "var(--yellow)" : "var(--red)")
    points.forEach((run, index) => {
        const barHeight = Math.max(1, run.durationMs * scale)
        svg.append(svgElement(
            "rect",
            {
                x: padding.left + index * slotWidth + (slotWidth - barWidth) / 2,
                y: padding.top + plotHeight - barHeight,
                width: barWidth,
                height: barHeight,
                fill: colorFor(run.status),
            },
            [svgElement("title", {}, [
                `${run.startedAt}: ${formatShortDuration(run.durationMs)} (${run.status})`,
            ])],
        ))
    })
    svg.append(svgElement("text", { x: padding.left, y: height - 6 }, ["oldest"]))
    svg.append(
        svgElement("text", { x: width - padding.right, y: height - 6, "text-anchor": "end" }, ["newest"]),
    )
    return svg
}

/**
 * @param {number} milliseconds
 * @returns {string}
 */
function formatShortDuration(milliseconds) {
    if (milliseconds < 1000) {
        return `${Math.round(milliseconds)}ms`
    }
    if (milliseconds < 60000) {
        return `${(milliseconds / 1000).toFixed(1)}s`
    }
    if (milliseconds < 3600000) {
        return `${Math.round(milliseconds / 60000)}m`
    }
    return `${(milliseconds / 3600000).toFixed(1)}h`
}
