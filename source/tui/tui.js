// The interactive terminal interface. Everything it does goes through the same operations layer the
// CLI uses, so the two can never drift apart.

import { Checkbox, Confirm, Input, Number as NumberPrompt, Select } from "jsr:@cliffy/prompt@1.0.0-rc.7"
import { color, paintStatus, renderTable } from "../colors.js"
import { formatMaybeDuration, formatPercent, formatRelative, formatTimestamp } from "../formatting.js"
import { normalizeSchedule, parseScheduleText, parseTimeOfDay } from "../schedule.js"
import { parseDuration } from "../durations.js"
import { overlapPolicies } from "../job_schema.js"
import {
    canRunJobsAsOtherUsers,
    install,
    installationStatus,
    installPlan,
    installScopes,
    uninstall,
} from "../installer.js"
import { stateDirectory } from "../paths.js"
import {
    addJob,
    daemonStatus,
    editJob,
    getJob,
    listJobs,
    logsFor,
    pauseJob,
    removeJob,
    runsFor,
    skipNextRuns,
    statsFor,
    triggerJob,
} from "../operations.js"

const banner = `${color.brightCyan("  ┌─────────────────────────────┐")}
${color.brightCyan("  │")}  ${color.bold(color.brightMagenta("simple_schedule"))}            ${
    color.brightCyan("│")
}
${color.brightCyan("  │")}  ${color.gray("cron, but with a face")}      ${color.brightCyan("│")}
${color.brightCyan("  └─────────────────────────────┘")}`

/** Clear the screen between menus so the TUI does not scroll away from itself. */
function clearScreen() {
    console.log("\x1b[2J\x1b[H")
}

/** @param {string} text */
function heading(text) {
    console.log(
        `\n${color.bold(color.brightCyan(text))}\n${color.gray("─".repeat(Math.max(8, text.length)))}`,
    )
}

/** Wait for the reader to look at whatever was just printed. */
async function pause() {
    await Confirm.prompt({ message: "back to the menu?", default: true })
}

/**
 * @param {object[]} jobs
 * @returns {string}
 */
function jobTable(jobs) {
    if (jobs.length == 0) {
        return color.gray("no jobs yet")
    }
    return renderTable(
        ["id", "schedule", "last", "next run", "avg", "ok/total"],
        jobs.map((job) => [
            job.enabled ? color.bold(job.id) : color.gray(job.id),
            job.scheduleText,
            job.isRunning ? color.brightCyan("running") : paintStatus(job.stats.lastStatus),
            job.nextRunAt ? formatRelative(job.nextRunAt) : color.gray("—"),
            formatMaybeDuration(job.stats.averageDurationMs),
            `${job.stats.successes}/${job.stats.total}`,
        ]),
    )
}

/**
 * Ask for a schedule, offering the shapes people actually want and falling back to raw cron.
 * @param {object} [current]
 * @returns {Promise<object>}
 */
async function askForSchedule(current) {
    const kind = await Select.prompt({
        message: "when should it run?",
        default: current?.kind ?? "daily",
        options: [
            { name: "every so often (e.g. every 7 hours)", value: "interval" },
            { name: "daily at a time", value: "daily" },
            { name: "weekly on chosen days", value: "weekly" },
            { name: "monthly on chosen dates (e.g. the 1st)", value: "monthly" },
            { name: "a cron expression", value: "cron" },
            { name: "only when I trigger it", value: "manual" },
        ],
    })
    if (kind == "manual") {
        return { kind: "manual" }
    }
    if (kind == "interval") {
        const every = await Input.prompt({
            message: "how often?",
            default: current?.every ?? "7h",
            hint: `a duration like 30m, 7h, 1d, or 1h30m`,
            validate: (value) => {
                try {
                    parseDuration(value)
                    return true
                } catch (error) {
                    return error.message
                }
            },
        })
        const measuredFrom = await Select.prompt({
            message: "measured from?",
            default: current?.measuredFrom ?? "start",
            options: [
                { name: "the start of the previous run (a steady cadence)", value: "start" },
                { name: "the end of the previous run (a gap between runs)", value: "completion" },
            ],
        })
        return { kind: "interval", every, measuredFrom }
    }
    const at = await Input.prompt({
        message: "at what time?",
        default: current?.at ?? "09:00",
        hint: `09:00, 9am, 9:30pm, noon`,
        validate: (value) => {
            try {
                parseTimeOfDay(value)
                return true
            } catch (error) {
                return error.message
            }
        },
    })
    const timeZone = await Select.prompt({
        message: "anchored to which clock?",
        default: current?.timeZone ?? "local",
        options: [
            {
                name:
                    `this machine's local time (stays at ${at} wherever you are, and across daylight saving)`,
                value: "local",
            },
            { name: "UTC", value: "utc" },
            { name: "a specific time zone…", value: "custom" },
        ],
    })
    let resolvedZone = timeZone
    if (timeZone == "custom") {
        resolvedZone = await Input.prompt({
            message: "which time zone?",
            default: Intl.DateTimeFormat().resolvedOptions().timeZone,
            hint: "an IANA name, e.g. America/Los_Angeles",
        })
    }
    if (kind == "daily") {
        return { kind: "daily", at, timeZone: resolvedZone }
    }
    if (kind == "weekly") {
        const on = await Checkbox.prompt({
            message: "on which days?",
            options: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"],
            default: current?.on ?? ["monday"],
            minOptions: 1,
        })
        return { kind: "weekly", at, on, timeZone: resolvedZone }
    }
    if (kind == "monthly") {
        const days = await Input.prompt({
            message: "on which dates?",
            default: (current?.on ?? [1]).join(","),
            hint: "comma separated, e.g. 1 or 1,15",
        })
        return {
            kind: "monthly",
            at,
            on: days.split(",").map((piece) => Number(piece.trim())).filter((value) =>
                Number.isInteger(value)
            ),
            timeZone: resolvedZone,
        }
    }
    const expression = await Input.prompt({
        message: "cron expression",
        default: current?.expression ?? "0 9 * * *",
        hint: "minute hour day-of-month month day-of-week",
        validate: (value) => {
            try {
                parseScheduleText(value)
                return true
            } catch (error) {
                return error.message
            }
        },
    })
    return { kind: "cron", expression, timeZone: resolvedZone }
}

/**
 * @param {object} [current]
 * @returns {Promise<object>}
 */
async function askForFailurePolicy(current) {
    const retries = await NumberPrompt.prompt({
        message: "how many extra attempts after a failure?",
        default: current?.retries ?? 0,
        min: 0,
    })
    if (retries == 0) {
        const thenRunNow = await Input.prompt({
            message: "run another job if this one fails? (blank for none)",
            default: current?.thenRun ?? "",
        })
        return { retries: 0, thenRun: thenRunNow.trim() || null }
    }
    const kind = await Select.prompt({
        message: "how should the wait between attempts grow?",
        default: current?.backoff?.kind ?? "exponential",
        options: [
            { name: "exponential (double each time)", value: "exponential" },
            { name: "fixed (same wait every time)", value: "fixed" },
        ],
    })
    const initial = await Input.prompt({
        message: "wait before the first retry",
        default: current?.backoff?.initial ?? "30s",
    })
    const maximum = await Input.prompt({
        message: "longest wait between retries",
        default: current?.backoff?.max ?? "1h",
    })
    const thenRun = await Input.prompt({
        message: "run another job once every attempt has failed? (blank for none)",
        default: current?.thenRun ?? "",
    })
    return {
        retries,
        backoff: { kind, initial, max: maximum },
        thenRun: thenRun.trim() || null,
    }
}

/** The guided "add a job" flow. Only the id and the task have no default. */
async function addJobFlow() {
    heading("add a job")
    const existing = await listJobs()
    const id = await Input.prompt({
        message: "id for this job",
        hint: "letters, digits, dot, dash, underscore",
        validate: (value) => {
            if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value)) {
                return "letters, digits, dot, dash, and underscore only, starting with a letter or digit"
            }
            if (existing.some((job) => job.id == value)) {
                return `"${value}" is already taken`
            }
            return true
        },
    })
    const taskType = await Select.prompt({
        message: "what should it run?",
        options: [
            { name: "a shell command", value: "command" },
            { name: "a JavaScript function (hot-imported each run)", value: "js" },
        ],
    })
    let task
    if (taskType == "command") {
        const command = await Input.prompt({
            message: "the command",
            hint: `e.g. rsync -a ~/notes /backup`,
            validate: (value) => (value.trim().length > 0 ? true : "a command is required"),
        })
        task = { type: "command", command }
    } else {
        const modulePath = await Input.prompt({
            message: "path to the JavaScript file",
            hint: "it is re-imported every run, so edits take effect immediately",
            validate: (value) => (value.trim().length > 0 ? true : "a file path is required"),
        })
        const exportName = await Input.prompt({
            message: "which export should be called?",
            default: "default",
        })
        task = { type: "js", module: modulePath, export: exportName }
    }

    const schedule = await askForSchedule()
    const input = { id, task, schedule }

    const customize = await Confirm.prompt({
        message: "everything else has a sensible default — change any of it?",
        default: false,
    })
    if (customize) {
        input.description = await Input.prompt({ message: "description", default: "" })
        const activation = await Checkbox.prompt({
            message: "also run at these moments?",
            options: [
                { name: "when the machine boots", value: "onBoot" },
                { name: "when I log in", value: "onLogin" },
            ],
            default: [],
        })
        input.activation = { onBoot: activation.includes("onBoot"), onLogin: activation.includes("onLogin") }
        input.workingDirectory =
            (await Input.prompt({ message: "working directory (blank for the daemon's)", default: "" }))
                .trim() || null
        if (canRunJobsAsOtherUsers()) {
            input.runAs = (await Input.prompt({
                message: "run as which user? (blank for whoever runs the daemon)",
                default: "",
            })).trim() || null
        }
        const environmentChoice = await Select.prompt({
            message: "environment",
            default: "inherit",
            options: [
                { name: "inherit the daemon's environment", value: "inherit" },
                { name: "inherit it, plus some variables of my own", value: "extend" },
                { name: "start empty, with only the variables I give", value: "custom" },
            ],
        })
        if (environmentChoice != "inherit") {
            const pairs = await Input.prompt({
                message: "variables, as NAME=value, comma separated",
                default: "",
            })
            const variables = {}
            for (const pair of pairs.split(",").map((piece) => piece.trim()).filter(Boolean)) {
                const equalsIndex = pair.indexOf("=")
                if (equalsIndex > 0) {
                    variables[pair.slice(0, equalsIndex)] = pair.slice(equalsIndex + 1)
                }
            }
            input.environment = { inherit: environmentChoice == "extend", variables, remove: [] }
        }
        input.timeout =
            (await Input.prompt({ message: `kill it after… (blank for no limit)`, default: "" })).trim() ||
            null
        input.overlap = await Select.prompt({
            message: "if the previous run is still going",
            default: "skip",
            options: overlapPolicies.map((policy) => ({
                name: {
                    skip: "skip this run",
                    queue: "queue it behind the current one",
                    allow: "start it anyway",
                }[policy],
                value: policy,
            })),
        })
        input.onFailure = await askForFailurePolicy()
        const logPath = await Input.prompt({ message: "log file (blank for the default)", default: "" })
        if (logPath.trim()) {
            input.log = { path: logPath.trim() }
        }
    }

    try {
        const job = await addJob(input)
        const stored = await getJob(job.id)
        console.log(`\n${color.green("✓ added")} ${color.bold(job.id)} — ${stored.scheduleText}`)
        console.log(
            color.gray(
                `  next run: ${
                    stored.nextRunAt
                        ? `${formatTimestamp(stored.nextRunAt)} (${formatRelative(stored.nextRunAt)})`
                        : "only when triggered"
                }`,
            ),
        )
        console.log(color.gray(`  log: ${stored.log.path}`))
        if (!(await daemonStatus())) {
            console.log(
                color.yellow(
                    `  the daemon is not running, so this will not fire on its own yet — install it from the main menu`,
                ),
            )
        }
    } catch (error) {
        console.log(color.red(`\ncould not add the job:`))
        for (const problem of error.problems ?? [error.message]) {
            console.log(`  ${color.red("•")} ${problem}`)
        }
    }
    await pause()
}

/** @param {object} job */
function printJobDetail(job) {
    const field = (name, value) => console.log(`  ${color.gray(`${name}:`.padEnd(15))}${value}`)
    console.log(`\n${color.bold(color.brightCyan(job.id))}${job.enabled ? "" : color.gray("  (disabled)")}`)
    if (job.description) {
        console.log(`  ${color.gray(job.description)}`)
    }
    field(
        "runs",
        job.task.type == "js"
            ? `${job.task.module} → ${job.task.export}()`
            : (job.task.argv?.join(" ") ?? job.task.command),
    )
    field("schedule", job.scheduleText)
    field(
        "next run",
        job.nextRunAt
            ? `${formatTimestamp(job.nextRunAt)} (${formatRelative(job.nextRunAt)})`
            : "only when triggered",
    )
    field(
        "on failure",
        `${job.onFailure.retries} retries, ${job.onFailure.backoff.kind} from ${job.onFailure.backoff.initial}${
            job.onFailure.thenRun ? `, then ${job.onFailure.thenRun}` : ""
        }`,
    )
    field(
        "history",
        `${job.stats.total} run(s), ${formatPercent(job.stats.successRate)} ok, avg ${
            formatMaybeDuration(job.stats.averageDurationMs)
        }`,
    )
    field("last", `${formatTimestamp(job.stats.lastRunAt)} ${paintStatus(job.stats.lastStatus)}`)
    if (job.state.skipNext > 0) {
        field("skipping", `${job.state.skipNext} upcoming run(s)`)
    }
    if (job.state.pausedUntil) {
        field("paused until", formatTimestamp(job.state.pausedUntil))
    }
    field("log", job.log.path)
}

/**
 * @param {string} id
 * @returns {Promise<void>}
 */
async function jobMenu(id) {
    while (true) {
        let job
        try {
            job = await getJob(id)
        } catch (error) {
            console.log(color.red(error.message))
            return
        }
        clearScreen()
        printJobDetail(job)
        const action = await Select.prompt({
            message: "what would you like to do?",
            options: [
                { name: "run it now", value: "trigger" },
                { name: "skip the next run", value: "skip" },
                { name: "show recent runs", value: "runs" },
                { name: "show statistics", value: "stats" },
                { name: "show the log", value: "logs" },
                Select.separator("──────────"),
                { name: "change the schedule", value: "schedule" },
                { name: "change the failure behavior", value: "failure" },
                { name: "change the command or function", value: "task" },
                { name: job.enabled ? "disable it" : "enable it", value: "toggle" },
                { name: job.state.pausedUntil ? "resume it" : "pause it", value: "pause" },
                Select.separator("──────────"),
                { name: color.red("delete it"), value: "delete" },
                { name: "back", value: "back" },
            ],
        })
        if (action == "back") {
            return
        }
        try {
            if (action == "trigger") {
                console.log(color.gray("running…"))
                const outcome = await triggerJob(id, { wait: true })
                console.log(
                    outcome.started
                        ? `${id}: ${paintStatus(outcome.result?.status ?? "started")}${
                            outcome.result ? ` after ${outcome.result.attempts} attempt(s)` : ""
                        }`
                        : color.yellow(`did not start: ${outcome.reason}`),
                )
                await pause()
            } else if (action == "skip") {
                const count = await NumberPrompt.prompt({
                    message: "how many upcoming runs to skip?",
                    default: 1,
                    min: 0,
                })
                await skipNextRuns(id, count)
                console.log(color.green(`will skip the next ${count} run(s)`))
                await pause()
            } else if (action == "runs") {
                const runs = await runsFor(id, 25)
                console.log(
                    runs.length == 0 ? color.gray("no runs yet") : renderTable(
                        ["started", "status", "duration", "attempt", "trigger"],
                        runs.map((run) => [
                            formatTimestamp(run.startedAt),
                            paintStatus(run.status),
                            formatMaybeDuration(run.durationMs),
                            String(run.attempt),
                            run.trigger,
                        ]),
                    ),
                )
                await pause()
            } else if (action == "stats") {
                const stats = await statsFor(id)
                heading(`${id} statistics`)
                console.log(`  runs          ${stats.total}`)
                console.log(`  succeeded     ${color.green(String(stats.successes))}`)
                console.log(`  failed        ${stats.failures > 0 ? color.red(String(stats.failures)) : "0"}`)
                console.log(`  success rate  ${formatPercent(stats.successRate)}`)
                console.log(`  average       ${formatMaybeDuration(stats.averageDurationMs)}`)
                console.log(`  median        ${formatMaybeDuration(stats.medianDurationMs)}`)
                console.log(`  longest       ${formatMaybeDuration(stats.longestDurationMs)}`)
                if (stats.dailyHistory.length > 0) {
                    console.log(`\n  ${color.gray("per day")}`)
                    for (const day of stats.dailyHistory.slice(-14)) {
                        const bar = color.green("█".repeat(day.successes)) +
                            color.red("█".repeat(day.failures))
                        console.log(
                            `  ${day.day}  ${bar} ${color.gray(formatMaybeDuration(day.averageDurationMs))}`,
                        )
                    }
                }
                if (stats.lastError) {
                    console.log(`\n  ${color.red("last error")}: ${stats.lastError.split("\n")[0]}`)
                }
                await pause()
            } else if (action == "logs") {
                const result = await logsFor(id, 60)
                console.log(color.gray(result.path))
                console.log(result.text || color.gray("(the log is empty)"))
                await pause()
            } else if (action == "schedule") {
                await editJob(id, { schedule: normalizeSchedule(await askForSchedule(job.schedule)) })
                console.log(color.green("schedule updated"))
            } else if (action == "failure") {
                await editJob(id, { onFailure: await askForFailurePolicy(job.onFailure) })
                console.log(color.green("failure behavior updated"))
            } else if (action == "task") {
                if (job.task.type == "js") {
                    const modulePath = await Input.prompt({
                        message: "path to the JavaScript file",
                        default: job.task.module,
                    })
                    const exportName = await Input.prompt({
                        message: "which export?",
                        default: job.task.export,
                    })
                    await editJob(id, { task: { type: "js", module: modulePath, export: exportName } })
                } else {
                    const command = await Input.prompt({
                        message: "the command",
                        default: job.task.command ?? job.task.argv?.join(" "),
                    })
                    await editJob(id, { task: { type: "command", command } })
                }
                console.log(color.green("task updated"))
            } else if (action == "toggle") {
                await editJob(id, { enabled: !job.enabled })
            } else if (action == "pause") {
                if (job.state.pausedUntil) {
                    await pauseJob(id, null)
                    console.log(color.green("resumed"))
                } else {
                    const until = await Input.prompt({
                        message: "pause until when? (blank for indefinitely)",
                        default: "",
                        hint: "an ISO timestamp like 2026-01-01T00:00:00Z",
                    })
                    await pauseJob(id, until.trim() || new Date(8640000000000000).toISOString())
                    console.log(color.green("paused"))
                }
            } else if (action == "delete") {
                const sure = await Confirm.prompt({ message: `really delete "${id}"?`, default: false })
                if (sure) {
                    const forget = await Confirm.prompt({
                        message: "delete its run history too?",
                        default: false,
                    })
                    await removeJob(id, { forgetHistory: forget })
                    console.log(color.green(`deleted ${id}`))
                    return
                }
            }
        } catch (error) {
            console.log(color.red(error.message))
            for (const problem of error.problems ?? []) {
                console.log(`  ${color.red("•")} ${problem}`)
            }
            await pause()
        }
    }
}

/** The install / uninstall screen. */
async function installMenu() {
    heading("install")
    const status = installationStatus()
    console.log(`  platform: ${status.platform}`)
    console.log(
        status.installed.length > 0
            ? `  installed: ${
                status.installed.map((entry) => `${entry.scope} → ${entry.unitPath}`).join("\n             ")
            }`
            : color.gray("  not installed as a service yet"),
    )
    console.log(color.gray(`  state lives in ${stateDirectory()}`))

    const choice = await Select.prompt({
        message: "what would you like to do?",
        options: [
            { name: "install for me only (no sudo; starts when I log in)", value: "install:user" },
            {
                name: "install system-wide (needs sudo; starts at boot, can run jobs as other users)",
                value: "install:system",
            },
            { name: "show what an install would write, without doing it", value: "dry" },
            { name: "uninstall", value: "uninstall" },
            { name: "back", value: "back" },
        ],
    })
    if (choice == "back") {
        return
    }
    try {
        if (choice == "dry") {
            const scope = await Select.prompt({
                message: "which scope?",
                options: installScopes,
                default: "user",
            })
            const plan = installPlan({ scope })
            console.log(`\n${color.gray(`--- ${plan.unitPath} ---`)}\n${plan.contents.trimEnd()}`)
            console.log(color.gray(`--- commands ---`))
            for (const command of plan.activateCommands) {
                console.log(`  ${command.join(" ")}`)
            }
        } else if (choice == "uninstall") {
            const scope = await Select.prompt({
                message: "which scope?",
                options: installScopes,
                default: "user",
            })
            const result = uninstall({ scope })
            console.log(color.green(`uninstalled the ${result.plan.scope}-scope service`))
        } else {
            const scope = choice == "install:system" ? "system" : "user"
            if (scope == "system") {
                console.log(
                    color.yellow(
                        `\n  a system-wide install writes to ${
                            installPlan({ scope }).unitPath
                        } and needs sudo.`,
                    ),
                )
                console.log(
                    color.gray(
                        `  if this is not running as root, re-run: sudo simple_schedule install --scope system`,
                    ),
                )
            }
            const result = install({ scope })
            console.log(color.green(`\n✓ installed the ${result.plan.scope}-scope service`))
            console.log(color.gray(`  ${result.plan.unitPath}`))
            if (scope == "system") {
                console.log(color.gray(`  jobs can now set "run as" to another user`))
            }
        }
    } catch (error) {
        console.log(color.red(error.message))
    }
    await pause()
}

/** The main loop. */
export async function runTui() {
    if (!Deno.stdin.isTerminal()) {
        throw new Error(
            `the TUI needs a terminal; use the non-interactive commands instead (try "simple_schedule --help")`,
        )
    }
    while (true) {
        clearScreen()
        console.log(banner)
        const [jobs, daemon] = await Promise.all([listJobs(), daemonStatus()])
        console.log(
            daemon
                ? `\n  ${color.green("●")} daemon running ${
                    color.gray(`(pid ${daemon.pid}, ${daemon.jobCount} job(s))`)
                }`
                : `\n  ${color.yellow("●")} ${color.yellow("daemon not running")} ${
                    color.gray("— jobs will not fire on their own")
                }`,
        )
        console.log(`\n${jobTable(jobs)}\n`)

        const options = [
            { name: "add a job", value: "add" },
            ...(jobs.length > 0 ? [{ name: "open a job…", value: "open" }] : []),
            { name: "recent runs across all jobs", value: "runs" },
            { name: "install / uninstall the daemon", value: "install" },
            { name: "refresh", value: "refresh" },
            { name: "quit", value: "quit" },
        ]
        const choice = await Select.prompt({ message: "menu", options })
        if (choice == "quit") {
            clearScreen()
            return
        }
        if (choice == "add") {
            await addJobFlow()
        } else if (choice == "open") {
            const id = await Select.prompt({
                message: "which job?",
                options: [
                    ...jobs.map((job) => ({
                        name: `${job.id}  ${color.gray(job.scheduleText)}`,
                        value: job.id,
                    })),
                    Select.separator("──────────"),
                    { name: "back", value: "" },
                ],
            })
            if (id) {
                await jobMenu(id)
            }
        } else if (choice == "runs") {
            const runs = await runsFor(null, 30)
            clearScreen()
            heading("recent runs")
            console.log(
                runs.length == 0 ? color.gray("no runs yet") : renderTable(
                    ["job", "started", "status", "duration", "trigger"],
                    runs.map((run) => [
                        run.jobId,
                        formatTimestamp(run.startedAt),
                        paintStatus(run.status),
                        formatMaybeDuration(run.durationMs),
                        run.trigger,
                    ]),
                ),
            )
            await pause()
        } else if (choice == "install") {
            clearScreen()
            await installMenu()
        }
    }
}
