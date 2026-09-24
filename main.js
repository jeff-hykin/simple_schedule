#!/usr/bin/env -S deno run --allow-all
// simple_schedule — a cross-platform alternative to cron for macOS and Linux.
// Every subcommand works with or without the daemon running; the daemon is only needed for jobs to
// fire on their own.

import { Command, EnumType } from "jsr:@cliffy/command@1.0.0-rc.7"
import { color, paintStatus, renderTable, setColorEnabled } from "./source/colors.js"
import { formatMaybeDuration, formatPercent, formatRelative, formatTimestamp } from "./source/formatting.js"
import { exampleJob, JobValidationError, knownJobFields, overlapPolicies } from "./source/job_schema.js"
import { backoffKinds } from "./source/job_schema.js"
import { jobInputFromFlags, mergeJobInput, readJsonFrom } from "./source/cli_helpers.js"
import { commandLineFor } from "./source/runner.js"
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
    stopDaemon,
    triggerJob,
} from "./source/operations.js"
import { runDaemon } from "./source/daemon.js"
import {
    canRunJobsAsOtherUsers,
    install,
    installationStatus,
    installPlan,
    installScopes,
    uninstall,
} from "./source/installer.js"
import { stateDirectory } from "./source/paths.js"
import { startServer } from "./source/server/server.js"
import { runTui } from "./source/tui/tui.js"

export const version = "0.1.0"

/**
 * @param {object} options
 * @param {any} data
 * @param {() => string} renderHuman
 */
function emit(options, data, renderHuman) {
    if (options.json) {
        console.log(JSON.stringify(data, null, 2))
        return
    }
    const text = renderHuman()
    if (text) {
        console.log(text)
    }
}

/** @param {object[]} jobs @returns {string} */
function renderJobTable(jobs) {
    if (jobs.length == 0) {
        return color.gray(
            `no jobs yet — add one with "simple_schedule add --id backup --command 'rsync -a ~/notes /backup' --schedule 'daily at 2am'"`,
        )
    }
    const rows = jobs.map((job) => [
        job.enabled ? color.bold(job.id) : color.gray(job.id),
        job.scheduleText,
        job.isRunning ? color.brightCyan("running") : paintStatus(job.stats.lastStatus),
        job.nextRunAt
            ? `${formatTimestamp(job.nextRunAt)} (${formatRelative(job.nextRunAt)})`
            : color.gray("—"),
        formatMaybeDuration(job.stats.averageDurationMs),
        `${job.stats.successes}/${job.stats.total}`,
    ])
    return renderTable(["id", "schedule", "last", "next run", "avg", "ok/total"], rows)
}

/** @param {object} job @returns {string} */
function renderJobDetail(job) {
    const lines = []
    lines.push(`${color.bold(color.brightCyan(job.id))}${job.enabled ? "" : color.gray("  (disabled)")}`)
    if (job.description) {
        lines.push(`  ${color.gray(job.description)}`)
    }
    const field = (name, value) => `  ${color.gray(`${name}:`.padEnd(16))}${value}`
    lines.push(field("task", commandLineFor(job).join(" ")))
    lines.push(field("schedule", job.scheduleText))
    lines.push(
        field(
            "next run",
            job.nextRunAt ? `${formatTimestamp(job.nextRunAt)} (${formatRelative(job.nextRunAt)})` : "—",
        ),
    )
    lines.push(
        field(
            "activation",
            [job.activation.onBoot && "on boot", job.activation.onLogin && "on login"].filter(Boolean).join(
                ", ",
            ) || "none",
        ),
    )
    lines.push(field("run as", job.runAs ?? "(whoever runs the daemon)"))
    lines.push(field("working dir", job.workingDirectory ?? "(the daemon's)"))
    lines.push(
        field(
            "environment",
            `${job.environment.inherit ? "inherited" : "empty"}${
                Object.keys(job.environment.variables).length > 0
                    ? ` + ${Object.keys(job.environment.variables).join(", ")}`
                    : ""
            }${job.environment.remove.length > 0 ? ` − ${job.environment.remove.join(", ")}` : ""}`,
        ),
    )
    lines.push(field("timeout", job.timeout ?? "none"))
    lines.push(field("overlap", job.overlap))
    lines.push(
        field(
            "on failure",
            `${job.onFailure.retries} retr${
                job.onFailure.retries == 1 ? "y" : "ies"
            }, ${job.onFailure.backoff.kind} backoff from ${job.onFailure.backoff.initial} up to ${job.onFailure.backoff.max}${
                job.onFailure.thenRun ? `, then run "${job.onFailure.thenRun}"` : ""
            }`,
        ),
    )
    lines.push(field("log", job.log.path))
    lines.push(
        field(
            "history",
            `${job.stats.total} run(s), ${formatPercent(job.stats.successRate)} ok, avg ${
                formatMaybeDuration(job.stats.averageDurationMs)
            }`,
        ),
    )
    if (job.state.skipNext > 0) {
        lines.push(field("skipping", `the next ${job.state.skipNext} run(s)`))
    }
    if (job.state.pausedUntil) {
        lines.push(field("paused until", formatTimestamp(job.state.pausedUntil)))
    }
    if (job.stats.lastError) {
        lines.push(field("last error", color.red(job.stats.lastError.split("\n")[0])))
    }
    return lines.join("\n")
}

/** @param {object[]} runs @returns {string} */
function renderRunTable(runs) {
    if (runs.length == 0) {
        return color.gray("no runs recorded yet")
    }
    return renderTable(
        ["job", "started", "status", "duration", "attempt", "trigger"],
        runs.map((run) => [
            run.jobId,
            formatTimestamp(run.startedAt),
            paintStatus(run.status),
            formatMaybeDuration(run.durationMs),
            String(run.attempt),
            run.trigger,
        ]),
    )
}

const scopeType = new EnumType(installScopes)
const overlapType = new EnumType(overlapPolicies)
const backoffType = new EnumType(backoffKinds)

/**
 * The flags shared by `add` and `edit`.
 * @param {Command} command
 * @returns {Command}
 */
function withJobFlags(command) {
    return command
        .option("--json-file <path:string>", `read the job definition from a JSON file, or "-" for stdin`)
        .option("--description <text:string>", "what this job is for")
        .option("--command <line:string>", "a shell command to run")
        .option("--js-module <path:string>", "a JavaScript file to hot-import and call")
        .option("--js-export <name:string>", "which export to call", { depends: ["js-module"] })
        .option("--js-arguments <json:string>", "JSON array of arguments to pass the function", {
            depends: ["js-module"],
        })
        .option("--js-permission <flag:string>", "a Deno permission flag for the job process", {
            collect: true,
            depends: ["js-module"],
        })
        .option(
            "--schedule <text:string>",
            `when to run, e.g. "every 7h", "daily at 9am", "every monday at 09:00", "the first of the month at 03:00", or a cron line`,
        )
        .option(
            "--time-zone <zone:string>",
            `"local" (the default), "utc", or an IANA name like America/Los_Angeles`,
        )
        .option("--on-boot", "also run when the machine boots")
        .option("--on-login", "also run when you log in")
        .option("--cwd <path:string>", "working directory for the job")
        .option("--run-as <user:string>", "run the job as this user (needs a system-scope install)")
        .option("--timeout <duration:string>", `kill the job if it runs longer than this, e.g. "30m"`)
        .option("--overlap <policy:overlap>", "what to do if the previous run is still going")
        .option("--env <pair:string>", "extra environment variable, as NAME=value", { collect: true })
        .option("--unset-env <name:string>", "drop this variable from the job's environment", {
            collect: true,
        })
        .option("--no-inherit-env", "start from an empty environment instead of the daemon's")
        .option("--retries <count:integer>", "how many extra attempts after a failure")
        .option("--backoff <kind:backoff>", "how the wait between retries grows")
        .option("--backoff-initial <duration:string>", `wait before the first retry, e.g. "30s"`)
        .option("--backoff-max <duration:string>", "cap on the wait between retries")
        .option("--backoff-multiplier <factor:number>", "how much each wait grows, for exponential backoff")
        .option("--then-run <jobId:string>", "run this other job once every attempt has failed")
        .option("--notify <command:string>", "shell command to run with a failure summary on stdin")
        .option("--log <path:string>", "where to write this job's log")
        .option("--log-max-bytes <bytes:integer>", "rotate the log once it passes this size")
        .option("--log-keep-files <count:integer>", "how many rotated logs to keep")
        .option("--keep-runs <count:integer>", "how many run records to keep for this job")
}

/**
 * @param {object} options
 * @returns {Promise<object>}
 */
async function jobInputFrom(options) {
    const fromJson = options.jsonFile ? await readJsonFrom(options.jsonFile) : null
    return mergeJobInput(fromJson, jobInputFromFlags(options))
}

const schemaText = `A job is a JSON object. Only "id" and "task" are required.

${JSON.stringify(exampleJob("nightly-backup"), null, 4)}

Fields: ${knownJobFields.join(", ")}

  id              letters, digits, dot, dash, underscore
  task            {"type":"command","command":"..."} | {"type":"command","argv":["...","..."]}
                  | {"type":"js","module":"/path/to/file.js","export":"default","arguments":[]}
  schedule        {"kind":"interval","every":"7h","measuredFrom":"start"|"completion"}
                  {"kind":"daily","at":"09:00","timeZone":"local"|"utc"|"America/Los_Angeles"}
                  {"kind":"weekly","at":"09:00","on":["monday"],"timeZone":"local"}
                  {"kind":"monthly","at":"03:00","on":[1],"timeZone":"local"}
                  {"kind":"cron","expression":"0 9 * * mon-fri","timeZone":"local"}
                  {"kind":"manual"}
  activation      {"onBoot":false,"onLogin":false}
  environment     {"inherit":true,"variables":{},"remove":[]}
  runAs           a username; needs a system-scope install
  timeout         a duration like "30m", or null
  overlap         "skip" | "queue" | "allow"
  onFailure       {"retries":0,"backoff":{"kind":"exponential","initial":"30s","max":"1h","multiplier":2,"jitter":0},
                   "thenRun":null,"notify":null}
  log             {"path":"...","maxBytes":5242880,"keepFiles":3}
  keepRuns        how many run records to keep

"local" means the machine's own zone, so a 9am job stays at 9am wherever you are and across daylight
saving. "utc" pins the job to UTC instead.`

const program = new Command()
    .name("simple_schedule")
    .version(version)
    .description(
        `A cross-platform alternative to cron for macOS and Linux.

Run shell commands or JavaScript functions on a schedule, with retries, backoff, per-job logs, and
run statistics. Everything here also works from the TUI ("simple_schedule tui") and the web GUI
("simple_schedule serve").`,
    )
    .globalType("scope", scopeType)
    .globalType("overlap", overlapType)
    .globalType("backoff", backoffType)
    .globalOption("--json", "print machine-readable JSON instead of a table")
    .globalOption("--no-color", "never use color")
    .default("tui")

program
    .command("tui", "the interactive terminal interface (the default when you run this with no arguments)")
    .action(async () => {
        await runTui()
    })

program
    .command("list", "list every job")
    .alias("ls")
    .action(async (options) => {
        const jobs = await listJobs()
        emit(options, jobs, () => renderJobTable(jobs))
    })

program
    .command("show <id:string>", "everything about one job")
    .action(async (options, id) => {
        const job = await getJob(id)
        emit(options, job, () => renderJobDetail(job))
    })

withJobFlags(program.command("add", "add a job"))
    .option("--id <id:string>", "the job's id")
    .option("--disabled", "add it, but do not run it yet")
    .example(
        "a shell command every night",
        `simple_schedule add --id backup --command 'rsync -a ~/notes /backup' --schedule 'daily at 2am'`,
    )
    .example(
        "a JavaScript function every seven hours",
        `simple_schedule add --id poll --js-module ~/jobs/poll.js --schedule 'every 7h' --retries 3`,
    )
    .example(
        "from JSON, for scripts and agents",
        `echo '{"id":"x","task":"true"}' | simple_schedule add --json-file -`,
    )
    .action(async (options) => {
        const input = await jobInputFrom(options)
        if (options.disabled) {
            input.enabled = false
        }
        const job = await addJob(input)
        const stored = await getJob(job.id)
        emit(
            options,
            stored,
            () => `${color.green("added")} ${color.bold(job.id)}\n${renderJobDetail(stored)}`,
        )
    })

withJobFlags(program.command("edit <id:string>", "change a job"))
    .option("--new-id <id:string>", "rename the job")
    .action(async (options, id) => {
        const input = await jobInputFrom(options)
        if (options.newId != null) {
            input.id = options.newId
        }
        const job = await editJob(id, input)
        emit(options, job, () => `${color.green("updated")} ${color.bold(job.id)}`)
    })

program
    .command("remove <id:string>", "delete a job")
    .alias("rm")
    .option("--forget-history", "also delete its run records")
    .action(async (options, id) => {
        await removeJob(id, { forgetHistory: options.forgetHistory })
        emit(options, { removed: id }, () => `${color.green("removed")} ${id}`)
    })

program
    .command("enable <id:string>", "let a job run on its schedule again")
    .action(async (options, id) => {
        const job = await editJob(id, { enabled: true })
        emit(options, job, () => `${color.green("enabled")} ${id}`)
    })

program
    .command("disable <id:string>", "stop a job running on its schedule")
    .action(async (options, id) => {
        const job = await editJob(id, { enabled: false })
        emit(options, job, () => `${color.yellow("disabled")} ${id}`)
    })

program
    .command("trigger <id:string>", "run a job right now")
    .alias("run")
    .option("--no-wait", "return as soon as it has started")
    .action(async (options, id) => {
        const outcome = await triggerJob(id, { wait: options.wait !== false })
        emit(options, outcome, () => {
            if (!outcome.started) {
                return color.yellow(`did not start: ${outcome.reason}`)
            }
            if (!outcome.result) {
                return `${color.green("started")} ${id}`
            }
            return `${id}: ${paintStatus(outcome.result.status)} after ${outcome.result.attempts} attempt(s)`
        })
    })

program
    .command("skip <id:string>", "skip the next scheduled run")
    .option("--count <count:integer>", "how many upcoming runs to skip", { default: 1 })
    .action(async (options, id) => {
        const result = await skipNextRuns(id, options.count)
        emit(options, result, () => `${id}: skipping the next ${result.skipNext} run(s)`)
    })

program
    .command("pause <id:string>", "hold a job until a given time")
    .option("--until <timestamp:string>", "an ISO timestamp; leave it off to pause indefinitely")
    .action(async (options, id) => {
        const until = options.until ?? new Date(8640000000000000).toISOString()
        const result = await pauseJob(id, until)
        emit(options, result, () => `${id}: paused until ${formatTimestamp(result.pausedUntil)}`)
    })

program
    .command("resume <id:string>", "undo a pause")
    .action(async (options, id) => {
        const result = await pauseJob(id, null)
        emit(options, result, () => `${id}: resumed`)
    })

program
    .command("stats <id:string>", "how a job has been doing")
    .option("--days <days:integer>", "how many days of history to summarize", { default: 30 })
    .action(async (options, id) => {
        const stats = await statsFor(id, options.days)
        emit(options, stats, () => {
            const lines = [color.bold(id)]
            const field = (name, value) => `  ${color.gray(`${name}:`.padEnd(16))}${value}`
            lines.push(field("runs", String(stats.total)))
            lines.push(field("succeeded", color.green(String(stats.successes))))
            lines.push(field("failed", stats.failures > 0 ? color.red(String(stats.failures)) : "0"))
            lines.push(field("success rate", formatPercent(stats.successRate)))
            lines.push(field("average", formatMaybeDuration(stats.averageDurationMs)))
            lines.push(field("median", formatMaybeDuration(stats.medianDurationMs)))
            lines.push(field("longest", formatMaybeDuration(stats.longestDurationMs)))
            lines.push(
                field("last run", `${formatTimestamp(stats.lastRunAt)} ${paintStatus(stats.lastStatus)}`),
            )
            if (stats.lastError) {
                lines.push(field("last error", color.red(stats.lastError.split("\n")[0])))
            }
            return lines.join("\n")
        })
    })

program
    .command("runs [id:string]", "recent runs, for one job or all of them")
    .option("--limit <count:integer>", "how many to show", { default: 20 })
    .action(async (options, id) => {
        const runs = await runsFor(id ?? null, options.limit)
        emit(options, runs, () => renderRunTable(runs))
    })

program
    .command("logs <id:string>", "the tail of a job's log")
    .option("--lines <count:integer>", "how many lines", { default: 200 })
    .action(async (options, id) => {
        const result = await logsFor(id, options.lines)
        emit(options, result, () => `${color.gray(result.path)}\n${result.text}`)
    })

program
    .command("schema", "the job JSON schema, with an example")
    .action((options) => {
        emit(options, { example: exampleJob("nightly-backup"), fields: knownJobFields }, () => schemaText)
    })

program
    .command("install", "set the daemon up to start on its own and survive a reboot")
    .type("scope", scopeType)
    .option(
        "--scope <scope:scope>",
        `"user" needs no sudo; "system" needs sudo but survives logout and can run jobs as other users`,
        { default: "user" },
    )
    .option("--dry-run", "print what would be written and run, and change nothing")
    .action((options) => {
        const plan = installPlan({ scope: options.scope })
        if (options.dryRun) {
            emit(options, plan, () =>
                [
                    `${color.bold("platform")}  ${plan.platform} (${plan.scope} scope)`,
                    `${color.bold("unit file")} ${plan.unitPath}`,
                    plan.needsRoot ? color.yellow("this scope needs sudo") : "",
                    "",
                    color.gray("--- unit file ---"),
                    plan.contents.trimEnd(),
                    color.gray("--- commands ---"),
                    ...plan.activateCommands.map((command) => `  ${command.join(" ")}`),
                ].filter(Boolean).join("\n"))
            return
        }
        const result = install({ scope: options.scope })
        emit(options, result, () =>
            [
                `${color.green("installed")} ${result.plan.platform} ${result.plan.scope}-scope service`,
                `  ${color.gray("unit file:")} ${result.plan.unitPath}`,
                `  ${color.gray("state:")}     ${stateDirectory()}`,
                options.scope == "system"
                    ? color.gray(`  jobs may now set runAs to run as another user`)
                    : color.gray(
                        `  install with --scope system if you need jobs to run as another user or survive logout`,
                    ),
            ].join("\n"))
    })

program
    .command("uninstall", "remove the daemon's service")
    .type("scope", scopeType)
    .option("--scope <scope:scope>", "which scope to remove", { default: "user" })
    .action((options) => {
        const result = uninstall({ scope: options.scope })
        emit(
            options,
            result,
            () =>
                `${color.green("uninstalled")} ${result.plan.scope}-scope service${
                    result.removedUnit ? "" : " (there was no unit file)"
                }`,
        )
    })

program
    .command("status", "is the daemon running, and what is it doing")
    .action(async (options) => {
        const daemon = await daemonStatus()
        const installation = installationStatus()
        const jobs = await listJobs()
        const data = {
            daemon,
            installation,
            jobCount: jobs.length,
            stateDirectory: stateDirectory(),
            canRunJobsAsOtherUsers: canRunJobsAsOtherUsers(),
        }
        emit(options, data, () => {
            const lines = []
            lines.push(
                daemon
                    ? `${color.green("daemon running")} (pid ${daemon.pid}, started ${
                        formatRelative(daemon.startedAt)
                    }, ${daemon.jobCount} job(s), context ${daemon.activationContext})`
                    : color.yellow(
                        `daemon not running — jobs will not fire on their own. Start it with "simple_schedule install" or "simple_schedule daemon".`,
                    ),
            )
            if (daemon?.running.length > 0) {
                lines.push(
                    `  ${color.gray("running now:")} ${
                        daemon.running.map((entry) => entry.jobId).join(", ")
                    }`,
                )
            }
            lines.push(
                installation.installed.length > 0
                    ? `${color.gray("installed:")} ${
                        installation.installed.map((entry) => `${entry.scope} (${entry.unitPath})`).join(", ")
                    }`
                    : color.gray("not installed as a service"),
            )
            lines.push(`${color.gray("state:")} ${stateDirectory()}`)
            lines.push("")
            lines.push(renderJobTable(jobs))
            return lines.join("\n")
        })
    })

program
    .command("daemon", "run the scheduler in the foreground (this is what the service starts)")
    .option(
        "--activation-context <context:string>",
        `"boot", "login", or "manual" — decides which activation triggers fire`,
        { default: "manual" },
    )
    .action(async (options) => {
        await runDaemon({ activationContext: options.activationContext })
    })

program
    .command("stop", "ask a running daemon to shut down")
    .action(async (options) => {
        const result = await stopDaemon()
        emit(options, result, () => color.green("daemon stopping"))
    })

program
    .command("serve", "run the web GUI")
    .option("--port <port:integer>", "port to listen on", { default: 7373 })
    .option("--host <host:string>", "address to bind", { default: "127.0.0.1" })
    .option("--open", "open a browser once it is up")
    .action(async (options) => {
        await startServer({ port: options.port, hostname: options.host, open: options.open })
    })

if (import.meta.main) {
    if (Deno.args.includes("--no-color")) {
        setColorEnabled(false)
    }
    try {
        await program.parse(Deno.args)
    } catch (error) {
        if (error instanceof JobValidationError) {
            console.error(
                color.red(
                    `that job definition has ${error.problems.length} problem${
                        error.problems.length > 1 ? "s" : ""
                    }:`,
                ),
            )
            for (const problem of error.problems) {
                console.error(`  ${color.red("•")} ${problem}`)
            }
            console.error(color.gray(`\nrun "simple_schedule schema" to see every field and its defaults`))
            Deno.exit(1)
        }
        console.error(color.red(error.message ?? String(error)))
        Deno.exit(1)
    }
}
