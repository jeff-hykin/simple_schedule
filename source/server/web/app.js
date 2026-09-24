// The web GUI. Plain modules, no build step. Everything it can do, it can do from the keyboard.

import { durationChart, runsPerDayChart } from "./charts.js"

/** @param {string} selector @returns {HTMLElement} */
const find = (selector) => document.querySelector(selector)

/**
 * @param {string} tag
 * @param {object} [properties]
 * @param {(Node|string)[]} [children]
 * @returns {HTMLElement}
 */
function make(tag, properties = {}, children = []) {
    const element = document.createElement(tag)
    for (const [key, value] of Object.entries(properties)) {
        if (key == "class") {
            element.className = value
        } else if (key == "dataset") {
            Object.assign(element.dataset, value)
        } else if (key.startsWith("on") && typeof value == "function") {
            element.addEventListener(key.slice(2), value)
        } else if (value != null && value !== false) {
            element.setAttribute(key, value === true ? "" : String(value))
        }
    }
    for (const child of children) {
        if (child != null && child !== false) {
            element.append(child)
        }
    }
    return element
}

/** @param {HTMLElement} element @param {(Node|string)[]} children */
function fill(element, children) {
    element.replaceChildren(...children.filter((child) => child != null && child !== false))
}

// ---------- talking to the server ----------

/**
 * @param {string} path
 * @param {RequestInit} [options]
 * @returns {Promise<any>}
 */
async function api(path, options = {}) {
    const response = await fetch(`/api${path}`, {
        headers: { "content-type": "application/json" },
        ...options,
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
        const error = new Error(payload.error ?? `${response.status} ${response.statusText}`)
        error.problems = payload.problems ?? null
        throw error
    }
    return payload
}

// ---------- state ----------

const state = {
    /** @type {any} */
    overview: null,
    /** @type {string|null} */
    selectedId: null,
    /** @type {"overview"|"runs"|"logs"|"edit"|"new"|"install"} */
    view: "overview",
    filter: "",
    /** @type {any} */
    detail: null,
    /** @type {any} */
    draft: null,
    /** @type {string[]|null} */
    problems: null,
}

/** @returns {any[]} */
function visibleJobs() {
    const jobs = state.overview?.jobs ?? []
    const needle = state.filter.trim().toLowerCase()
    if (!needle) {
        return jobs
    }
    return jobs.filter((job) =>
        job.id.toLowerCase().includes(needle) ||
        job.scheduleText.toLowerCase().includes(needle) ||
        (job.description ?? "").toLowerCase().includes(needle)
    )
}

/** @returns {any|null} */
function selectedJob() {
    return (state.overview?.jobs ?? []).find((job) => job.id == state.selectedId) ?? null
}

// ---------- formatting ----------

/** @param {string|null} value @returns {string} */
function formatTimestamp(value) {
    if (!value) {
        return "—"
    }
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) {
        return "—"
    }
    const pad = (piece) => String(piece).padStart(2, "0")
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${
        pad(date.getHours())
    }:${pad(date.getMinutes())}`
}

/** @param {number} milliseconds @returns {string} */
function formatDuration(milliseconds) {
    if (milliseconds == null) {
        return "—"
    }
    const absolute = Math.abs(milliseconds)
    if (absolute < 1000) {
        return `${Math.round(milliseconds)}ms`
    }
    const units = [["d", 86400000], ["h", 3600000], ["m", 60000], ["s", 1000]]
    let remaining = Math.round(absolute)
    const pieces = []
    for (const [suffix, size] of units) {
        const count = Math.floor(remaining / size)
        if (count > 0) {
            pieces.push(`${count}${suffix}`)
            remaining -= count * size
        }
        if (pieces.length == 2) {
            break
        }
    }
    return pieces.join("") || "0s"
}

/** @param {string|null} value @returns {string} */
function formatRelative(value) {
    if (!value) {
        return "—"
    }
    const difference = new Date(value).getTime() - Date.now()
    if (Number.isNaN(difference)) {
        return "—"
    }
    if (Math.abs(difference) < 1000) {
        return "now"
    }
    return difference > 0 ? `in ${formatDuration(difference)}` : `${formatDuration(-difference)} ago`
}

/** @param {number|null} rate @returns {string} */
function formatPercent(rate) {
    return rate == null ? "—" : `${Math.round(rate * 100)}%`
}

/** @param {string|null} status @returns {HTMLElement} */
function statusBadge(status) {
    return make("span", { class: `status-${status ?? "none"}` }, [status ?? "never run"])
}

// ---------- toasts ----------

/**
 * @param {string} text
 * @param {"good"|"bad"|"info"} [tone]
 */
function toast(text, tone = "info") {
    const element = make("div", { class: `toast ${tone == "info" ? "" : tone}`, role: "status" }, [text])
    find("#toast").append(element)
    setTimeout(() => element.remove(), tone == "bad" ? 8000 : 3500)
}

/** @param {unknown} error */
function reportError(error) {
    if (error?.problems?.length) {
        state.problems = error.problems
        renderDetail()
        toast(`${error.problems.length} problem(s) with that job`, "bad")
        return
    }
    toast(error?.message ?? String(error), "bad")
}

// ---------- rendering ----------

function renderHeader() {
    const daemon = state.overview?.daemon
    find("#daemon-dot").className = `dot ${daemon ? "up" : "down"}`
    find("#daemon-text").textContent = daemon
        ? `daemon up · pid ${daemon.pid} · ${daemon.jobCount} job(s)`
        : "daemon not running"
    const installed = state.overview?.installation?.installed ?? []
    find("#install-pill").textContent = installed.length > 0
        ? `installed: ${installed.map((entry) => entry.scope).join(", ")}`
        : "not installed"
}

function renderJobList() {
    const jobs = visibleJobs()
    if (jobs.length == 0) {
        fill(find("#job-list"), [
            make("div", { class: "job-row faint" }, [
                state.filter ? "nothing matches that filter" : "no jobs yet — press n to add one",
            ]),
        ])
        return
    }
    fill(
        find("#job-list"),
        jobs.map((job) =>
            make("div", {
                class: `job-row${job.id == state.selectedId ? " selected" : ""}${
                    job.enabled ? "" : " disabled"
                }`,
                role: "option",
                "aria-selected": job.id == state.selectedId,
                dataset: { id: job.id },
                onclick: () => selectJob(job.id),
            }, [
                make("div", { class: "name" }, [job.id]),
                make("div", { class: "next" }, [
                    job.isRunning
                        ? make("span", { class: "status-timeout" }, ["running"])
                        : statusBadge(job.stats.lastStatus),
                ]),
                make("div", { class: "schedule" }, [job.scheduleText]),
                make("div", { class: "next" }, [job.nextRunAt ? formatRelative(job.nextRunAt) : "—"]),
            ])
        ),
    )
}

/** @param {any} job @returns {HTMLElement} */
function renderJobActions(job) {
    return make("div", { class: "actions" }, [
        make("button", { onclick: () => triggerSelected() }, ["run now (t)"]),
        make("button", { onclick: () => skipSelected() }, ["skip next (s)"]),
        make("button", { onclick: () => setView("edit") }, ["edit (e)"]),
        make("button", { onclick: () => setView("runs") }, ["runs (r)"]),
        make("button", { onclick: () => setView("logs") }, ["logs (l)"]),
        make("button", { onclick: () => toggleSelected() }, [job.enabled ? "disable (d)" : "enable (d)"]),
        make("button", { onclick: () => pauseSelected() }, [job.state.pausedUntil ? "resume" : "pause"]),
        make("button", { onclick: () => deleteSelected() }, ["delete (x)"]),
    ])
}

/** @param {any} job @returns {HTMLElement[]} */
function renderOverview(job) {
    const stats = state.detail?.stats
    const runs = state.detail?.runs ?? []
    return [
        make("h1", {}, [job.id, job.enabled ? "" : make("span", { class: "faint" }, ["  (disabled)"])]),
        make("div", { class: "subtitle" }, [job.description || job.scheduleText]),
        renderJobActions(job),
        make("div", { class: "tiles" }, [
            tile(
                "next run",
                job.nextRunAt ? formatRelative(job.nextRunAt) : "manual only",
                job.nextRunAt ? formatTimestamp(job.nextRunAt) : "",
            ),
            tile("last run", stats ? formatRelative(stats.lastRunAt) : "—", stats?.lastStatus ?? ""),
            tile(
                "average",
                stats ? formatDuration(stats.averageDurationMs) : "—",
                stats ? `median ${formatDuration(stats.medianDurationMs)}` : "",
            ),
            tile(
                "success rate",
                stats ? formatPercent(stats.successRate) : "—",
                stats ? `${stats.successes}/${stats.total}` : "",
            ),
            tile(
                "failures",
                stats ? String(stats.failures) : "—",
                stats?.consecutiveFailures ? `${stats.consecutiveFailures} in a row` : "",
            ),
        ]),
        stats?.lastError
            ? make("div", { class: "problems" }, [
                make("strong", {}, ["last error"]),
                make("pre", { class: "log" }, [stats.lastError]),
            ])
            : null,
        make("h2", {}, ["runs per day"]),
        runsPerDayChart(stats?.dailyHistory ?? []),
        make("h2", {}, ["how long each run took"]),
        durationChart(runs),
        make("h2", {}, ["definition"]),
        make("dl", { class: "field-grid" }, [
            ...definitionRows(job).flatMap((
                [label, value],
            ) => [make("dt", {}, [label]), make("dd", {}, [value])]),
        ]),
    ]
}

/** @param {string} label @param {string} value @param {string} [note] @returns {HTMLElement} */
function tile(label, value, note = "") {
    return make("div", { class: "tile" }, [
        make("div", { class: "label" }, [label]),
        make("div", { class: "value" }, [value]),
        note ? make("div", { class: "faint" }, [note]) : null,
    ])
}

/** @param {any} job @returns {[string, string][]} */
function definitionRows(job) {
    const task = job.task.type == "js"
        ? `${job.task.module} → ${job.task.export}()`
        : (job.task.argv ? job.task.argv.join(" ") : job.task.command)
    const activation =
        [job.activation.onBoot && "on boot", job.activation.onLogin && "on login"].filter(Boolean).join(
            ", ",
        ) || "none"
    const environment = `${job.environment.inherit ? "inherited" : "empty"}${
        Object.keys(job.environment.variables).length > 0
            ? ` + ${Object.keys(job.environment.variables).join(", ")}`
            : ""
    }`
    return [
        ["task", task],
        ["schedule", job.scheduleText],
        ["activation", activation],
        ["run as", job.runAs ?? "(whoever runs the daemon)"],
        ["working dir", job.workingDirectory ?? "(the daemon's)"],
        ["environment", environment],
        ["timeout", job.timeout ?? "none"],
        ["overlap", job.overlap],
        [
            "on failure",
            `${job.onFailure.retries} retries, ${job.onFailure.backoff.kind} backoff from ${job.onFailure.backoff.initial} up to ${job.onFailure.backoff.max}${
                job.onFailure.thenRun ? `, then run "${job.onFailure.thenRun}"` : ""
            }`,
        ],
        ["log", job.log.path],
        ["skipping", job.state.skipNext > 0 ? `the next ${job.state.skipNext} run(s)` : "no"],
        ["paused until", job.state.pausedUntil ? formatTimestamp(job.state.pausedUntil) : "not paused"],
    ]
}

/** @param {any} job @returns {HTMLElement[]} */
function renderRuns(job) {
    const runs = state.detail?.runs ?? []
    return [
        make("h1", {}, [`${job.id} · runs`]),
        renderJobActions(job),
        make("table", {}, [
            make("thead", {}, [
                make(
                    "tr",
                    {},
                    ["started", "status", "duration", "attempt", "trigger", "exit"].map((header) =>
                        make("th", {}, [header])
                    ),
                ),
            ]),
            make(
                "tbody",
                {},
                runs.map((run) =>
                    make("tr", { class: "clickable", onclick: () => setView("logs") }, [
                        make("td", {}, [formatTimestamp(run.startedAt)]),
                        make("td", {}, [statusBadge(run.status)]),
                        make("td", {}, [formatDuration(run.durationMs)]),
                        make("td", {}, [String(run.attempt)]),
                        make("td", { class: "dim" }, [run.trigger]),
                        make("td", { class: "dim" }, [run.exitCode == null ? "—" : String(run.exitCode)]),
                    ])
                ),
            ),
        ]),
        runs.length == 0 ? make("p", { class: "faint" }, ["no runs recorded yet"]) : null,
    ]
}

/** @param {any} job @returns {HTMLElement[]} */
function renderLogs(job) {
    return [
        make("h1", {}, [`${job.id} · log`]),
        renderJobActions(job),
        make("div", { class: "faint" }, [state.detail?.logs?.path ?? job.log.path]),
        make("pre", { class: "log" }, [state.detail?.logs?.text || "(the log is empty)"]),
    ]
}

/**
 * The add/edit form. Every field but the id and the task has a default already filled in.
 * @param {any} draft
 * @param {boolean} isNew
 * @returns {HTMLElement[]}
 */
function renderForm(draft, isNew) {
    /** @param {string} path @returns {any} */
    const read = (path) => path.split(".").reduce((value, key) => value?.[key], draft)
    /** @param {string} path @param {any} value */
    const write = (path, value) => {
        const keys = path.split(".")
        let target = draft
        for (const key of keys.slice(0, -1)) {
            target[key] = target[key] ?? {}
            target = target[key]
        }
        target[keys[keys.length - 1]] = value
    }
    /**
     * @param {string} label
     * @param {string} path
     * @param {object} [options]
     * @returns {HTMLElement[]}
     */
    const textField = (label, path, { hint = "", placeholder = "", type = "text" } = {}) => [
        make("label", { for: `field-${path}` }, [label]),
        make("input", {
            id: `field-${path}`,
            type,
            value: read(path) ?? "",
            placeholder,
            oninput: (event) => write(path, event.target.value === "" ? null : event.target.value),
        }),
        hint ? make("div", { class: "hint" }, [hint]) : null,
    ]
    /**
     * @param {string} label
     * @param {string} path
     * @param {(string|{value: string, label: string})[]} choices
     * @returns {HTMLElement[]}
     */
    const selectField = (label, path, choices) => [
        make("label", { for: `field-${path}` }, [label]),
        make(
            "select",
            {
                id: `field-${path}`,
                onchange: (event) => {
                    write(path, event.target.value)
                    renderDetail()
                },
            },
            choices.map((choice) => {
                const value = typeof choice == "string" ? choice : choice.value
                const text = typeof choice == "string" ? choice : choice.label
                return make("option", { value, selected: read(path) == value }, [text])
            }),
        ),
    ]
    /** @param {string} label @param {string} path @returns {HTMLElement[]} */
    const checkboxField = (label, path) => [
        make("label", {}, [""]),
        make("div", { class: "checkbox-row" }, [
            make("input", {
                id: `field-${path}`,
                type: "checkbox",
                checked: Boolean(read(path)),
                onchange: (event) => write(path, event.target.checked),
            }),
            make("label", { for: `field-${path}` }, [label]),
        ]),
    ]

    const scheduleKind = read("schedule.kind") ?? "manual"
    const taskType = read("task.type") ?? "command"
    const canRunAsOthers = state.overview?.canRunJobsAsOtherUsers

    return [
        make("h1", {}, [isNew ? "add a job" : `edit ${draft.id}`]),
        make("div", { class: "subtitle" }, [
            "only the id and the task are required — everything else already has a sensible default",
        ]),
        state.problems
            ? make("div", { class: "problems" }, [
                make("strong", {}, [`${state.problems.length} problem(s)`]),
                make("ul", {}, state.problems.map((problem) => make("li", {}, [problem]))),
            ])
            : null,
        make("form", {
            class: "form-grid",
            onsubmit: (event) => {
                event.preventDefault()
                saveDraft()
            },
        }, [
            ...textField("id", "id", { hint: "letters, digits, dot, dash, underscore" }),
            ...textField("description", "description"),
            ...selectField("task type", "task.type", [
                { value: "command", label: "shell command" },
                { value: "js", label: "JavaScript function" },
            ]),
            ...(taskType == "command"
                ? textField("command", "task.command", { placeholder: "rsync -a ~/notes /backup" })
                : [
                    ...textField("module", "task.module", {
                        hint: "re-imported every run, so edits take effect immediately",
                    }),
                    ...textField("export", "task.export"),
                ]),
            ...selectField("schedule", "schedule.kind", [
                { value: "interval", label: "every so often" },
                { value: "daily", label: "daily" },
                { value: "weekly", label: "weekly" },
                { value: "monthly", label: "monthly" },
                { value: "cron", label: "cron expression" },
                { value: "manual", label: "only when triggered" },
            ]),
            ...(scheduleKind == "interval"
                ? textField("every", "schedule.every", { hint: "a duration like 30m, 7h, 1d" })
                : []),
            ...(scheduleKind == "cron"
                ? textField("expression", "schedule.expression", {
                    hint: "minute hour day-of-month month day-of-week",
                })
                : []),
            ...(["daily", "weekly", "monthly"].includes(scheduleKind)
                ? textField("at", "schedule.at", { hint: "09:00, 9am, noon" })
                : []),
            ...(scheduleKind == "weekly"
                ? textField("on days", "schedule.onText", { hint: "comma separated, e.g. monday,friday" })
                : []),
            ...(scheduleKind == "monthly"
                ? textField("on dates", "schedule.onText", { hint: "comma separated, e.g. 1,15" })
                : []),
            ...(scheduleKind != "manual" && scheduleKind != "interval"
                ? textField("time zone", "schedule.timeZone", {
                    hint: `"local", "utc", or an IANA name like America/Los_Angeles`,
                })
                : []),
            ...checkboxField("also run when the machine boots", "activation.onBoot"),
            ...checkboxField("also run when I log in", "activation.onLogin"),
            ...textField("working directory", "workingDirectory"),
            ...(canRunAsOthers
                ? textField("run as", "runAs", { hint: "a username; blank means whoever runs the daemon" })
                : [
                    make("label", {}, ["run as"]),
                    make("div", { class: "faint" }, ["install system-wide to run jobs as another user"]),
                ]),
            ...checkboxField("inherit the daemon's environment", "environment.inherit"),
            ...textField("extra environment", "environment.variablesText", {
                hint: "NAME=value, comma separated",
            }),
            ...textField("timeout", "timeout", { hint: "a duration like 30m; blank means no limit" }),
            ...selectField("if still running", "overlap", [
                { value: "skip", label: "skip this run" },
                { value: "queue", label: "queue it behind the current one" },
                { value: "allow", label: "start it anyway" },
            ]),
            ...textField("retries", "onFailure.retries", {
                type: "number",
                hint: "extra attempts after a failure",
            }),
            ...selectField("backoff", "onFailure.backoff.kind", [
                { value: "exponential", label: "exponential" },
                { value: "fixed", label: "fixed" },
            ]),
            ...textField("first retry wait", "onFailure.backoff.initial"),
            ...textField("longest wait", "onFailure.backoff.max"),
            ...textField("then run", "onFailure.thenRun", {
                hint: "another job's id, once every attempt has failed",
            }),
            ...textField("notify on failure", "onFailure.notify", {
                hint: "a shell command; the failure summary arrives on stdin",
            }),
            ...textField("log file", "log.path"),
            ...checkboxField("enabled", "enabled"),
            make("label", {}, [""]),
            make("div", { class: "actions" }, [
                make("button", { type: "submit" }, [isNew ? "add the job" : "save changes"]),
                make("button", { type: "button", onclick: () => setView("overview") }, ["cancel (esc)"]),
            ]),
        ]),
    ]
}

/** @returns {HTMLElement[]} */
function renderInstall() {
    const installation = state.overview?.installation
    return [
        make("h1", {}, ["install"]),
        make("div", { class: "subtitle" }, [`platform: ${installation?.platform ?? "—"}`]),
        make("dl", { class: "field-grid" }, [
            make("dt", {}, ["installed"]),
            make("dd", {}, [
                installation?.installed.length
                    ? installation.installed.map((entry) => `${entry.scope} → ${entry.unitPath}`).join("\n")
                    : "not installed as a service",
            ]),
            make("dt", {}, ["state directory"]),
            make("dd", {}, [state.overview?.stateDirectory ?? "—"]),
            make("dt", {}, ["run jobs as other users"]),
            make("dd", {}, [
                state.overview?.canRunJobsAsOtherUsers
                    ? "yes (system-scope install)"
                    : "no (user-scope install)",
            ]),
        ]),
        make("h2", {}, ["installing"]),
        make("p", { class: "dim" }, [
            "Installing touches launchd or systemd, so it is done from the terminal rather than from a web page:",
        ]),
        make("pre", { class: "log" }, [
            "# just for you — no sudo, starts when you log in\nsimple_schedule install\n\n" +
            "# system-wide — needs sudo, starts at boot, can run jobs as other users\nsudo simple_schedule install --scope system\n\n" +
            "# see exactly what would be written, without writing it\nsimple_schedule install --dry-run",
        ]),
    ]
}

function renderDetail() {
    const detail = find("#detail")
    if (state.view == "new") {
        fill(detail, renderForm(state.draft, true))
        return
    }
    if (state.view == "install") {
        fill(detail, renderInstall())
        return
    }
    const job = selectedJob()
    if (!job) {
        fill(detail, [
            make("h1", {}, ["simple_schedule"]),
            make("p", { class: "dim" }, ["Pick a job on the left, or press n to add one."]),
            make("p", { class: "faint" }, [
                "Press ? for every keyboard shortcut, or ctrl+k for the command palette.",
            ]),
        ])
        return
    }
    if (state.view == "edit") {
        fill(detail, renderForm(state.draft, false))
        return
    }
    if (state.view == "runs") {
        fill(detail, renderRuns(job))
        return
    }
    if (state.view == "logs") {
        fill(detail, renderLogs(job))
        return
    }
    fill(detail, renderOverview(job))
}

function render() {
    renderHeader()
    renderJobList()
    renderDetail()
}

// ---------- actions ----------

/** @param {string} id */
async function selectJob(id) {
    state.selectedId = id
    state.problems = null
    if (state.view == "edit" || state.view == "new" || state.view == "install") {
        state.view = "overview"
    }
    render()
    await loadDetail()
}

/** @param {"overview"|"runs"|"logs"|"edit"|"new"|"install"} view */
function setView(view) {
    state.problems = null
    if (view == "edit") {
        const job = selectedJob()
        if (!job) {
            return
        }
        state.draft = draftFromJob(job)
    }
    if (view == "new") {
        state.draft = blankDraft()
    }
    state.view = view
    render()
    if (view == "logs" || view == "runs") {
        loadDetail()
    }
}

async function loadDetail() {
    const id = state.selectedId
    if (!id) {
        return
    }
    try {
        const [stats, runs, logs] = await Promise.all([
            api(`/jobs/${encodeURIComponent(id)}/stats`),
            api(`/jobs/${encodeURIComponent(id)}/runs?limit=60`),
            api(`/jobs/${encodeURIComponent(id)}/logs?lines=400`),
        ])
        if (state.selectedId != id) {
            return
        }
        state.detail = { stats, runs, logs }
        renderDetail()
    } catch (error) {
        reportError(error)
    }
}

async function refresh() {
    try {
        state.overview = await api("/overview")
        if (!state.selectedId && state.overview.jobs.length > 0) {
            state.selectedId = state.overview.jobs[0].id
            await loadDetail()
        }
        render()
    } catch (error) {
        reportError(error)
    }
}

async function triggerSelected() {
    const job = selectedJob()
    if (!job) {
        return
    }
    toast(`running ${job.id}…`)
    try {
        const outcome = await api(`/jobs/${encodeURIComponent(job.id)}/trigger`, { method: "POST" })
        if (!outcome.started) {
            toast(`did not start: ${outcome.reason}`, "bad")
        } else if (outcome.result) {
            toast(
                `${job.id}: ${outcome.result.status} after ${outcome.result.attempts} attempt(s)`,
                outcome.result.status == "success" ? "good" : "bad",
            )
        } else {
            toast(`${job.id} started`, "good")
        }
        await refresh()
        await loadDetail()
    } catch (error) {
        reportError(error)
    }
}

async function skipSelected() {
    const job = selectedJob()
    if (!job) {
        return
    }
    const answer = prompt(`skip how many upcoming runs of "${job.id}"?`, "1")
    if (answer == null) {
        return
    }
    try {
        const result = await api(`/jobs/${encodeURIComponent(job.id)}/skip`, {
            method: "POST",
            body: JSON.stringify({ count: Number(answer) }),
        })
        toast(`${job.id}: skipping the next ${result.skipNext} run(s)`, "good")
        await refresh()
    } catch (error) {
        reportError(error)
    }
}

async function pauseSelected() {
    const job = selectedJob()
    if (!job) {
        return
    }
    try {
        if (job.state.pausedUntil) {
            await api(`/jobs/${encodeURIComponent(job.id)}/resume`, { method: "POST" })
            toast(`${job.id} resumed`, "good")
        } else {
            const until = prompt(
                `pause "${job.id}" until when? (an ISO timestamp, or blank for indefinitely)`,
                "",
            )
            if (until == null) {
                return
            }
            await api(`/jobs/${encodeURIComponent(job.id)}/pause`, {
                method: "POST",
                body: JSON.stringify(until.trim() ? { until: until.trim() } : {}),
            })
            toast(`${job.id} paused`, "good")
        }
        await refresh()
    } catch (error) {
        reportError(error)
    }
}

async function toggleSelected() {
    const job = selectedJob()
    if (!job) {
        return
    }
    try {
        await api(`/jobs/${encodeURIComponent(job.id)}`, {
            method: "PATCH",
            body: JSON.stringify({ enabled: !job.enabled }),
        })
        toast(`${job.id} ${job.enabled ? "disabled" : "enabled"}`, "good")
        await refresh()
    } catch (error) {
        reportError(error)
    }
}

async function deleteSelected() {
    const job = selectedJob()
    if (!job) {
        return
    }
    if (!confirm(`delete the job "${job.id}"? This cannot be undone.`)) {
        return
    }
    const forget = confirm("also delete its run history?")
    try {
        await api(`/jobs/${encodeURIComponent(job.id)}?forgetHistory=${forget}`, { method: "DELETE" })
        toast(`deleted ${job.id}`, "good")
        state.selectedId = null
        state.detail = null
        state.view = "overview"
        await refresh()
    } catch (error) {
        reportError(error)
    }
}

// ---------- the add/edit draft ----------

/** @returns {object} */
function blankDraft() {
    return {
        id: "",
        description: "",
        enabled: true,
        task: { type: "command", command: "" },
        schedule: { kind: "daily", at: "09:00", timeZone: "local", onText: "" },
        activation: { onBoot: false, onLogin: false },
        workingDirectory: null,
        environment: { inherit: true, variablesText: "" },
        runAs: null,
        timeout: null,
        overlap: "skip",
        onFailure: {
            retries: 0,
            backoff: { kind: "exponential", initial: "30s", max: "1h" },
            thenRun: null,
            notify: null,
        },
        log: { path: null },
    }
}

/** @param {any} job @returns {object} */
function draftFromJob(job) {
    return {
        id: job.id,
        description: job.description,
        enabled: job.enabled,
        task: { ...job.task },
        schedule: {
            ...job.schedule,
            onText: Array.isArray(job.schedule.on) ? job.schedule.on.join(",") : "",
        },
        activation: { ...job.activation },
        workingDirectory: job.workingDirectory,
        environment: {
            inherit: job.environment.inherit,
            variablesText: Object.entries(job.environment.variables).map(([name, value]) =>
                `${name}=${value}`
            ).join(","),
        },
        runAs: job.runAs,
        timeout: job.timeout,
        overlap: job.overlap,
        onFailure: JSON.parse(JSON.stringify(job.onFailure)),
        log: { path: job.log.path },
    }
}

/**
 * Turn the form's draft back into the JSON the API expects.
 * @param {object} draft
 * @returns {object}
 */
function draftToJob(draft) {
    const schedule = { ...draft.schedule }
    delete schedule.onText
    if (schedule.kind == "weekly") {
        schedule.on = String(draft.schedule.onText ?? "").split(",").map((piece) => piece.trim()).filter(
            Boolean,
        )
    } else if (schedule.kind == "monthly") {
        schedule.on = String(draft.schedule.onText ?? "").split(",").map((piece) => Number(piece.trim()))
            .filter((value) => !Number.isNaN(value))
    }
    const variables = {}
    for (
        const pair of String(draft.environment.variablesText ?? "").split(",").map((piece) => piece.trim())
            .filter(Boolean)
    ) {
        const equalsIndex = pair.indexOf("=")
        if (equalsIndex > 0) {
            variables[pair.slice(0, equalsIndex)] = pair.slice(equalsIndex + 1)
        }
    }
    const task = draft.task.type == "js"
        ? { type: "js", module: draft.task.module, export: draft.task.export || "default" }
        : { type: "command", command: draft.task.command }
    return {
        id: draft.id,
        description: draft.description ?? "",
        enabled: draft.enabled !== false,
        task,
        schedule,
        activation: { onBoot: Boolean(draft.activation.onBoot), onLogin: Boolean(draft.activation.onLogin) },
        workingDirectory: draft.workingDirectory || null,
        environment: { inherit: draft.environment.inherit !== false, variables, remove: [] },
        runAs: draft.runAs || null,
        timeout: draft.timeout || null,
        overlap: draft.overlap,
        onFailure: {
            retries: Number(draft.onFailure.retries ?? 0),
            backoff: { ...draft.onFailure.backoff },
            thenRun: draft.onFailure.thenRun || null,
            notify: draft.onFailure.notify || null,
        },
        log: draft.log.path ? { path: draft.log.path } : {},
    }
}

async function saveDraft() {
    const isNew = state.view == "new"
    const body = draftToJob(state.draft)
    state.problems = null
    try {
        if (isNew) {
            const job = await api("/jobs", { method: "POST", body: JSON.stringify(body) })
            toast(`added ${job.id}`, "good")
            state.selectedId = job.id
        } else {
            const job = await api(`/jobs/${encodeURIComponent(state.selectedId)}`, {
                method: "PATCH",
                body: JSON.stringify(body),
            })
            toast(`saved ${job.id}`, "good")
            state.selectedId = job.id
        }
        state.view = "overview"
        await refresh()
        await loadDetail()
    } catch (error) {
        reportError(error)
    }
}

// ---------- command palette ----------

const paletteState = { open: false, entries: [], filtered: [], index: 0 }

/** @returns {{label: string, where: string, run: () => void}[]} */
function paletteEntries() {
    const job = selectedJob()
    const entries = [
        { label: "add a job", where: "global", run: () => setView("new") },
        { label: "refresh everything", where: "global", run: () => refresh() },
        { label: "show install status", where: "global", run: () => setView("install") },
        { label: "show keyboard shortcuts", where: "global", run: () => toggleHelp(true) },
        { label: "focus the job filter", where: "global", run: () => find("#filter").focus() },
    ]
    if (job) {
        entries.push(
            { label: `run "${job.id}" now`, where: "selected job", run: () => triggerSelected() },
            { label: `skip the next run of "${job.id}"`, where: "selected job", run: () => skipSelected() },
            { label: `edit "${job.id}"`, where: "selected job", run: () => setView("edit") },
            {
                label: `${job.enabled ? "disable" : "enable"} "${job.id}"`,
                where: "selected job",
                run: () => toggleSelected(),
            },
            {
                label: `${job.state.pausedUntil ? "resume" : "pause"} "${job.id}"`,
                where: "selected job",
                run: () => pauseSelected(),
            },
            { label: `show the log of "${job.id}"`, where: "selected job", run: () => setView("logs") },
            { label: `show the runs of "${job.id}"`, where: "selected job", run: () => setView("runs") },
            { label: `delete "${job.id}"`, where: "selected job", run: () => deleteSelected() },
        )
    }
    for (const candidate of state.overview?.jobs ?? []) {
        entries.push({
            label: `go to ${candidate.id}`,
            where: candidate.scheduleText,
            run: () => selectJob(candidate.id),
        })
    }
    return entries
}

/** @param {boolean} open */
function togglePalette(open) {
    paletteState.open = open
    find("#palette-overlay").hidden = !open
    if (!open) {
        return
    }
    paletteState.entries = paletteEntries()
    paletteState.index = 0
    const input = find("#palette-input")
    input.value = ""
    filterPalette("")
    input.focus()
}

/** @param {string} needle */
function filterPalette(needle) {
    const lowered = needle.trim().toLowerCase()
    paletteState.filtered = lowered
        ? paletteState.entries.filter((entry) =>
            entry.label.toLowerCase().includes(lowered) || entry.where.toLowerCase().includes(lowered)
        )
        : paletteState.entries
    paletteState.index = Math.min(paletteState.index, Math.max(0, paletteState.filtered.length - 1))
    fill(
        find("#palette-list"),
        paletteState.filtered.map((entry, index) =>
            make("li", {
                class: index == paletteState.index ? "active" : "",
                role: "option",
                "aria-selected": index == paletteState.index,
                onclick: () => {
                    togglePalette(false)
                    entry.run()
                },
            }, [make("span", {}, [entry.label]), make("span", { class: "where" }, [entry.where])])
        ),
    )
}

/** @param {number} step */
function movePalette(step) {
    if (paletteState.filtered.length == 0) {
        return
    }
    paletteState.index = (paletteState.index + step + paletteState.filtered.length) %
        paletteState.filtered.length
    filterPalette(find("#palette-input").value)
    find("#palette-list").children[paletteState.index]?.scrollIntoView({ block: "nearest" })
}

// ---------- help ----------

const shortcuts = [
    ["j / ↓", "next job"],
    ["k / ↑", "previous job"],
    ["enter", "open the selected job"],
    ["n", "add a job"],
    ["t", "run the selected job now"],
    ["s", "skip its next run"],
    ["e", "edit it"],
    ["d", "enable or disable it"],
    ["p", "pause or resume it"],
    ["x", "delete it"],
    ["o", "overview tab"],
    ["r", "runs tab"],
    ["l", "log tab"],
    ["i", "install status"],
    ["/", "filter the job list"],
    ["ctrl+k or cmd+k", "command palette"],
    ["g g", "jump to the first job"],
    ["G", "jump to the last job"],
    ["R", "refresh"],
    ["?", "this list"],
    ["esc", "close, or leave a form"],
]

/** @param {boolean} open */
function toggleHelp(open) {
    find("#help-overlay").hidden = !open
    if (open) {
        fill(
            find("#help-grid"),
            shortcuts.flatMap(([keys, what]) => [make("kbd", {}, [keys]), make("span", {}, [what])]),
        )
    }
}

// ---------- keyboard ----------

let lastKey = ""

/** @param {number} step */
function moveSelection(step) {
    const jobs = visibleJobs()
    if (jobs.length == 0) {
        return
    }
    const currentIndex = jobs.findIndex((job) => job.id == state.selectedId)
    const nextIndex = currentIndex == -1
        ? (step > 0 ? 0 : jobs.length - 1)
        : (currentIndex + step + jobs.length) % jobs.length
    selectJob(jobs[nextIndex].id)
    find("#job-list").querySelector(".selected")?.scrollIntoView({ block: "nearest" })
}

/** @param {KeyboardEvent} event @returns {boolean} */
function isTypingTarget(event) {
    const tag = event.target?.tagName
    return tag == "INPUT" || tag == "TEXTAREA" || tag == "SELECT" || event.target?.isContentEditable
}

document.addEventListener("keydown", (event) => {
    if (paletteState.open) {
        if (event.key == "Escape") {
            togglePalette(false)
            event.preventDefault()
        } else if (event.key == "ArrowDown" || (event.key == "n" && event.ctrlKey)) {
            movePalette(1)
            event.preventDefault()
        } else if (event.key == "ArrowUp" || (event.key == "p" && event.ctrlKey)) {
            movePalette(-1)
            event.preventDefault()
        } else if (event.key == "Enter") {
            const entry = paletteState.filtered[paletteState.index]
            togglePalette(false)
            entry?.run()
            event.preventDefault()
        }
        return
    }
    if ((event.key == "k" || event.key == "K") && (event.metaKey || event.ctrlKey)) {
        togglePalette(true)
        event.preventDefault()
        return
    }
    if (event.key == "Escape") {
        if (!find("#help-overlay").hidden) {
            toggleHelp(false)
        } else if (state.view == "edit" || state.view == "new" || state.view == "install") {
            setView("overview")
        } else if (isTypingTarget(event)) {
            event.target.blur()
        }
        return
    }
    if (isTypingTarget(event) || event.metaKey || event.ctrlKey || event.altKey) {
        return
    }

    const key = event.key
    const actions = {
        j: () => moveSelection(1),
        ArrowDown: () => moveSelection(1),
        k: () => moveSelection(-1),
        ArrowUp: () => moveSelection(-1),
        Enter: () => find("#detail").focus(),
        n: () => setView("new"),
        t: () => triggerSelected(),
        s: () => skipSelected(),
        e: () => setView("edit"),
        d: () => toggleSelected(),
        p: () => pauseSelected(),
        x: () => deleteSelected(),
        o: () => setView("overview"),
        r: () => setView("runs"),
        l: () => setView("logs"),
        i: () => setView("install"),
        R: () => refresh(),
        G: () => {
            const jobs = visibleJobs()
            if (jobs.length > 0) {
                selectJob(jobs[jobs.length - 1].id)
            }
        },
        "?": () => toggleHelp(true),
        "/": () => find("#filter").focus(),
    }
    if (key == "g") {
        if (lastKey == "g") {
            const jobs = visibleJobs()
            if (jobs.length > 0) {
                selectJob(jobs[0].id)
            }
            lastKey = ""
        } else {
            lastKey = "g"
        }
        event.preventDefault()
        return
    }
    lastKey = ""
    const action = actions[key]
    if (action) {
        action()
        event.preventDefault()
    }
})

// ---------- wiring ----------

find("#filter").addEventListener("input", (event) => {
    state.filter = event.target.value
    renderJobList()
})
find("#palette-input").addEventListener("input", (event) => filterPalette(event.target.value))
find("#palette-overlay").addEventListener("click", (event) => {
    if (event.target == find("#palette-overlay")) {
        togglePalette(false)
    }
})
find("#help-overlay").addEventListener("click", (event) => {
    if (event.target == find("#help-overlay")) {
        toggleHelp(false)
    }
})
find("#new-job-button").addEventListener("click", () => setView("new"))
find("#palette-button").addEventListener("click", () => togglePalette(true))
find("#help-button").addEventListener("click", () => toggleHelp(true))

// the server pushes a full snapshot every few seconds, so the page stays live without polling logic
const events = new EventSource("/api/events")
events.addEventListener("message", (event) => {
    try {
        const snapshot = JSON.parse(event.data)
        const wasEmpty = state.overview == null
        state.overview = snapshot
        if (!state.selectedId && snapshot.jobs.length > 0) {
            state.selectedId = snapshot.jobs[0].id
            loadDetail()
        }
        // do not yank a form out from under someone who is typing in it
        if (state.view == "edit" || state.view == "new") {
            renderHeader()
            renderJobList()
        } else {
            render()
            if (wasEmpty) {
                loadDetail()
            }
        }
    } catch (_error) {
        // a malformed frame is not worth breaking the page over
    }
})
events.addEventListener("error", () => {
    find("#daemon-dot").className = "dot down"
    find("#daemon-text").textContent = "lost the server"
})

refresh()
