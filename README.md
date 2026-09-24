# simple_schedule

cron, with a face. A single Deno tool for macOS and Linux that runs **shell commands or JavaScript functions**
on a schedule, with retries, backoff, per-job logs and real statistics — driven from an interactive **TUI**, a
JSON-in/JSON-out **CLI**, or a keyboard-first **web GUI**.

Windows is deliberately out of scope.

```sh
# add a job
simple_schedule add --id backup --command 'rsync -a ~/notes /backup' --schedule 'daily at 2am'

# run a JavaScript function every seven hours, retrying three times
simple_schedule add --id poll --js-module ~/jobs/poll.js --schedule 'every 7h' --retries 3

# make it all survive a reboot
simple_schedule install

# the interactive interface
simple_schedule

# the web GUI
simple_schedule serve --open
```

## Does this already exist?

Not quite. The nearest neighbors, and what each is missing:

|                                                           | what it is                                        | why it is not this                                                     |
| --------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------- |
| [Dagu](https://dagu.sh/cron-alternative)                  | Go, single binary, web UI, retries, DAG workflows | workflow-shaped, no TUI, no JavaScript jobs                            |
| [Cronicle](https://github.com/jhuckaby/Cronicle)          | Node, web UI, live logs, multi-server             | heavy, server-oriented, no TUI, shell/plugin jobs only                 |
| [cronboard](https://www.x-cmd.com/install/cronboard/)     | a genuinely nice TUI for cron                     | it edits crontab — no daemon, no retries, no stats                     |
| [crontab-ui](https://github.com/alseambusher/crontab-ui)  | web crontab editor                                | same: a front-end for cron, not a scheduler                            |
| [`Deno.cron`](https://docs.deno.com/api/deno/~/Deno.cron) | scheduling inside a Deno program                  | UTC-only, no CLI, no persistence, no UI                                |
| launchd / systemd timers                                  | the real thing, per OS                            | different config per platform, no retry policy, no stats, no shared UI |

Nothing combines _Deno + hot-imported JavaScript jobs + a TUI + a JSON CLI + a web GUI + installing itself on
launchd and systemd_. That combination is what this is.

## How it is put together

One long-lived **daemon** owns the clock. Installing registers exactly **one** launchd job or systemd unit —
for the daemon, not one per job. That is what makes retries, backoff, "skip the next run", overlap policies
and run statistics possible at all; a per-job crontab line cannot do any of it.

```
TUI ─┐
CLI ─┼─→ operations ─→ daemon (unix socket) ─→ runner ─→ your job, in its own process
web ─┘        └──────→ jobs.json + runs.sqlite directly, when no daemon is running
```

Every surface goes through the same operations layer, so they cannot drift apart. **Nothing requires the
daemon**: adding, editing, listing, triggering and reading stats all work against the files when it is not
running — you just do not get jobs firing on their own.

State lives in `~/.local/share/simple_schedule/` (`$SIMPLE_SCHEDULE_HOME` overrides it):

| file            | what it holds                                                       |
| --------------- | ------------------------------------------------------------------- |
| `jobs.json`     | job definitions — human-editable; the daemon watches it and reloads |
| `runs.sqlite`   | run history and per-job state (skips, pauses, next run)             |
| `logs/<id>.log` | each job's output, rotated by size                                  |
| `daemon.sock`   | the control socket                                                  |

## Jobs

Only `id` and `task` are required. Everything else has a working default.

```jsonc
{
    "id": "nightly-backup",
    "task": { "type": "command", "command": "rsync -a ~/notes /backup" },
    "schedule": { "kind": "daily", "at": "02:00", "timeZone": "local" }
}
```

### Tasks

```jsonc
{ "type": "command", "command": "rsync -a ~/notes /backup" }   // through /bin/sh
{ "type": "command", "argv": ["rsync", "-a", "src", "dst"] }   // no shell
{ "type": "js", "module": "/path/job.js", "export": "default", "arguments": [] }
```

A `js` job runs in **its own Deno process**, which imports the module with a cache-busting query string — so
editing the job file takes effect on the very next run, with no daemon restart. The import and the call are
both wrapped, and because it is a separate process a job that throws, hangs, or calls `Deno.exit()` is
recorded as a failed run and cannot touch the scheduler. Anything the function returns is written to the log;
anything it throws becomes the run's error. Narrow its permissions with
`"permissions": ["--allow-net", "--allow-read"]` (default: `["--allow-all"]`).

### Schedules

```jsonc
{ "kind": "interval", "every": "7h", "measuredFrom": "start" }      // or "completion"
{ "kind": "daily",    "at": "09:00", "timeZone": "local" }
{ "kind": "weekly",   "at": "09:00", "on": ["monday", "friday"] }
{ "kind": "monthly",  "at": "03:00", "on": [1] }                    // the first of the month
{ "kind": "cron",     "expression": "0 9 * * mon-fri" }
{ "kind": "manual" }                                                // only when triggered
```

`--schedule` and the TUI also take these as one-liners: `every 7h`, `daily at 9am`, `every monday at 09:00`,
`the first of the month at 03:00`, `0 9 * * mon-fri`, `manual`.

**Time zones matter here.** `"timeZone": "local"` means _the machine's own clock_: a 9am job stays at 9am when
you fly somewhere else and when daylight saving moves the clocks. `"utc"` pins it to UTC instead, so it drifts
by an hour in local terms twice a year. Any IANA name (`America/Los_Angeles`) works too. An `interval`
schedule has no wall clock to anchor, so it takes no time zone.

If the machine is asleep through several slots, an interval job lines back up on the next slot rather than
firing a burst of missed runs.

### The rest

```jsonc
{
    "activation": { "onBoot": false, "onLogin": false },
    "environment": { "inherit": true, "variables": {}, "remove": [] },
    "runAs": null, // a username — needs a system-scope install
    "workingDirectory": null,
    "timeout": null, // "30m" — the job is killed past this
    "overlap": "skip", // or "queue", "allow"
    "onFailure": {
        "retries": 0,
        "backoff": { "kind": "exponential", "initial": "30s", "max": "1h", "multiplier": 2, "jitter": 0 },
        "thenRun": null, // another job's id
        "notify": null // a shell command; the failure summary arrives on stdin
    },
    "log": { "path": null, "maxBytes": 5242880, "keepFiles": 3 },
    "keepRuns": 500,
    "enabled": true
}
```

`simple_schedule schema` prints all of this with an example, which is also what agents should read.

## Installing

```sh
simple_schedule install                        # just you: no sudo, starts when you log in
sudo simple_schedule install --scope system    # everyone: starts at boot, survives logout
simple_schedule install --dry-run              # print the unit file and commands, change nothing
simple_schedule uninstall [--scope system]
```

- **user scope** → a launchd `LaunchAgent` on macOS, a `systemd --user` unit on Linux. The daemon starts at
  login, so on-login activation fires.
- **system scope** → a launchd `LaunchDaemon` or a system systemd unit. It starts at boot, so on-boot
  activation fires, and **only then can a job set `runAs`** to run as a different user. The TUI and the web
  GUI hide that field until a system-scope install exists.

On-boot jobs fire once per actual boot, not every time the daemon restarts.

## The CLI

Everything is scriptable, every command takes `--json`, and job definitions can come from a file or stdin.
Errors name the field and the allowed values, and exit non-zero.

```sh
simple_schedule list --json
simple_schedule show backup
simple_schedule add --json-file job.json          # or:  … --json-file -   to read stdin
simple_schedule edit backup --retries 3 --backoff fixed --backoff-initial 1m
simple_schedule trigger backup                    # run it now, wait for the result
simple_schedule skip backup --count 2
simple_schedule pause backup --until 2026-10-01T00:00:00Z
simple_schedule stats backup --json
simple_schedule runs --limit 20
simple_schedule logs backup --lines 100
simple_schedule status
```

```console
$ echo '{"id":"x"}' | simple_schedule add --json-file -
that job definition has 1 problem:
  • task: required — give either {"type":"command","command":"..."} or {"type":"js","module":"..."}

run "simple_schedule schema" to see every field and its defaults
```

## The TUI

`simple_schedule` with no arguments. It covers installing, adding a job with guided prompts where only the id
and the command have no default, listing, and — per job — running it now, skipping the next run, editing,
changing the failure behavior, statistics with a per-day bar chart, and logs.

## The web GUI

`simple_schedule serve` (default `127.0.0.1:7373`). Job list, stat tiles, a runs-per-day chart and a
run-duration chart, run history, live log tail, and a full add/edit form. It refreshes itself over server-sent
events.

**Everything is reachable from the keyboard:**

| key                   |                                        |
| --------------------- | -------------------------------------- |
| `j` / `k`             | move through jobs                      |
| `n`                   | add a job                              |
| `t` / `s`             | run now / skip the next run            |
| `e` / `d` / `p` / `x` | edit / enable-disable / pause / delete |
| `o` / `r` / `l` / `i` | overview / runs / logs / install       |
| `/`                   | filter the job list                    |
| `ctrl+k` or `cmd+k`   | command palette                        |
| `g g` / `G`           | first / last job                       |
| `R`                   | refresh                                |
| `?`                   | every shortcut                         |
| `esc`                 | close, or leave a form                 |

## Development

```sh
deno task test     # the whole suite
deno task start    # run the CLI from source
```

No build step, no `package.json`, no `node_modules`. Dependencies are `jsr:@cliffy/*` for the CLI and prompts
and `jsr:@std/*` for paths and media types; SQLite comes from Deno's own `node:sqlite`. The web GUI is plain
JavaScript modules with JSDoc types and hand-drawn inline SVG charts.
