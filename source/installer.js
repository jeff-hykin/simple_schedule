// Making the daemon survive a reboot: a launchd job on macOS, a systemd unit on Linux, at either
// user scope (no sudo) or system scope (sudo, survives logout, can run jobs as other users).

import { fromFileUrl, join } from "jsr:@std/path@1.1.2"
import { daemonLogPath, homeDirectory, isRunningAsRoot, stateDirectory } from "./paths.js"

export const serviceLabel = "com.github.jeff-hykin.simple_schedule"
export const serviceName = "simple_schedule"
export const installScopes = ["user", "system"]

/**
 * How to start the daemon, as an argv. Works whether this is running from source or from a binary
 * built with `deno compile`.
 * @returns {string[]}
 */
export function daemonCommandLine() {
    const mainModule = fromFileUrl(import.meta.resolve("../main.js"))
    const executable = Deno.execPath()
    if (executable.endsWith("/deno") || executable.endsWith("deno")) {
        return [executable, "run", "--allow-all", "--quiet", mainModule, "daemon"]
    }
    return [executable, "daemon"]
}

/**
 * @param {"user"|"system"} scope
 * @returns {string} where the platform's unit file belongs
 */
export function unitPathFor(scope) {
    if (Deno.build.os == "darwin") {
        return scope == "system"
            ? `/Library/LaunchDaemons/${serviceLabel}.plist`
            : join(homeDirectory(), "Library", "LaunchAgents", `${serviceLabel}.plist`)
    }
    return scope == "system"
        ? `/etc/systemd/system/${serviceName}.service`
        : join(homeDirectory(), ".config", "systemd", "user", `${serviceName}.service`)
}

/**
 * A system-scope daemon starts at boot; a user-scope one starts when the user logs in. Jobs use this
 * to decide whether their on-boot or on-login trigger fires.
 * @param {"user"|"system"} scope
 * @returns {"boot"|"login"}
 */
export function activationContextFor(scope) {
    return scope == "system" ? "boot" : "login"
}

/** @param {string} text @returns {string} */
function escapeForXml(text) {
    return text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
}

/**
 * @param {{scope: "user"|"system", argv?: string[], environment?: Record<string, string>}} options
 * @returns {string}
 */
export function renderLaunchdPlist({ scope, argv = daemonCommandLine(), environment = {} }) {
    const fullArgv = [...argv, "--activation-context", activationContextFor(scope)]
    const argumentLines = fullArgv.map((piece) => `        <string>${escapeForXml(piece)}</string>`).join(
        "\n",
    )
    const environmentEntries = Object.entries(environment)
        .map(([name, value]) =>
            `        <key>${escapeForXml(name)}</key>\n        <string>${escapeForXml(value)}</string>`
        )
        .join("\n")
    const environmentBlock = environmentEntries.length == 0 ? "" : `    <key>EnvironmentVariables</key>
    <dict>
${environmentEntries}
    </dict>
`
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${serviceLabel}</string>
    <key>ProgramArguments</key>
    <array>
${argumentLines}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ProcessType</key>
    <string>Background</string>
${environmentBlock}    <key>StandardOutPath</key>
    <string>${escapeForXml(daemonLogPath())}</string>
    <key>StandardErrorPath</key>
    <string>${escapeForXml(daemonLogPath())}</string>
    <key>WorkingDirectory</key>
    <string>${escapeForXml(stateDirectory())}</string>
</dict>
</plist>
`
}

/**
 * @param {{scope: "user"|"system", argv?: string[], environment?: Record<string, string>}} options
 * @returns {string}
 */
export function renderSystemdUnit({ scope, argv = daemonCommandLine(), environment = {} }) {
    const fullArgv = [...argv, "--activation-context", activationContextFor(scope)]
    const quoted = fullArgv.map((piece) => (/[\s"']/.test(piece) ? JSON.stringify(piece) : piece)).join(" ")
    const environmentLines = Object.entries(environment)
        .map(([name, value]) => `Environment=${name}=${value}`)
        .join("\n")
    const wantedBy = scope == "system" ? "multi-user.target" : "default.target"
    const unitSection = ["[Unit]", "Description=simple_schedule job scheduler"]
    if (scope == "system") {
        unitSection.push("After=network.target")
    }
    const serviceSection = [
        "[Service]",
        "Type=simple",
        `ExecStart=${quoted}`,
        "Restart=always",
        "RestartSec=5",
        `WorkingDirectory=${stateDirectory()}`,
    ]
    if (environmentLines) {
        serviceSection.push(environmentLines)
    }
    return `${unitSection.join("\n")}\n\n${serviceSection.join("\n")}\n\n[Install]\nWantedBy=${wantedBy}\n`
}

/**
 * Everything `install` would do, without doing any of it. This is what `install --dry-run` prints.
 * @param {{scope?: "user"|"system", environment?: Record<string, string>}} [options]
 * @returns {{platform: string, scope: string, unitPath: string, contents: string, activateCommands: string[][], deactivateCommands: string[][], needsRoot: boolean}}
 */
export function installPlan({ scope = "user", environment = {} } = {}) {
    if (!installScopes.includes(scope)) {
        throw new Error(`scope must be one of ${installScopes.join(", ")}, got "${scope}"`)
    }
    // whatever state directory this process is using has to be the one the installed daemon uses too
    const stateOverride = Deno.env.get("SIMPLE_SCHEDULE_HOME")
    if (stateOverride) {
        environment = { SIMPLE_SCHEDULE_HOME: stateOverride, ...environment }
    }
    const unitPath = unitPathFor(scope)
    const needsRoot = scope == "system" && !isRunningAsRoot()
    if (Deno.build.os == "darwin") {
        const domain = scope == "system" ? "system" : `gui/${currentUserId()}`
        return {
            platform: "launchd",
            scope,
            unitPath,
            contents: renderLaunchdPlist({ scope, environment }),
            activateCommands: [
                ["launchctl", "bootout", domain, unitPath],
                ["launchctl", "bootstrap", domain, unitPath],
                ["launchctl", "enable", `${domain}/${serviceLabel}`],
            ],
            deactivateCommands: [["launchctl", "bootout", domain, unitPath]],
            needsRoot,
        }
    }
    if (Deno.build.os == "linux") {
        const systemctl = scope == "system" ? ["systemctl"] : ["systemctl", "--user"]
        return {
            platform: "systemd",
            scope,
            unitPath,
            contents: renderSystemdUnit({ scope, environment }),
            activateCommands: [
                [...systemctl, "daemon-reload"],
                [...systemctl, "enable", "--now", `${serviceName}.service`],
            ],
            deactivateCommands: [
                [...systemctl, "disable", "--now", `${serviceName}.service`],
                [...systemctl, "daemon-reload"],
            ],
            needsRoot,
        }
    }
    throw new Error(`simple_schedule supports macOS and Linux; this is ${Deno.build.os}`)
}

/** @returns {number} */
function currentUserId() {
    try {
        return Deno.uid() ?? 0
    } catch (_error) {
        return 0
    }
}

/**
 * @param {string[]} argv
 * @returns {{ok: boolean, output: string}}
 */
function runInstallCommand(argv) {
    try {
        const result = new Deno.Command(argv[0], { args: argv.slice(1), stdout: "piped", stderr: "piped" })
            .outputSync()
        const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`
            .trim()
        return { ok: result.success, output }
    } catch (error) {
        return { ok: false, output: error.message }
    }
}

/**
 * Write the unit file and hand it to the init system.
 * @param {{scope?: "user"|"system", environment?: Record<string, string>}} [options]
 * @returns {{plan: object, steps: {command: string[], ok: boolean, output: string}[]}}
 */
export function install(options = {}) {
    const plan = installPlan(options)
    if (plan.needsRoot) {
        throw new Error(
            `a system-scope install writes to ${plan.unitPath}; re-run this with sudo, or install at user scope instead`,
        )
    }
    Deno.mkdirSync(join(plan.unitPath, ".."), { recursive: true })
    Deno.writeTextFileSync(plan.unitPath, plan.contents)
    const steps = []
    for (const command of plan.activateCommands) {
        const result = runInstallCommand(command)
        steps.push({ command, ...result })
        // booting out a job that was never loaded is expected to fail, so only the last step must work
    }
    const last = steps[steps.length - 1]
    if (!last.ok && !isAlreadyLoaded(last.output)) {
        throw new Error(
            `wrote ${plan.unitPath} but could not start it: ${last.command.join(" ")} said "${last.output}"`,
        )
    }
    return { plan, steps }
}

/** @param {string} output @returns {boolean} */
function isAlreadyLoaded(output) {
    return /already (loaded|bootstrapped|enabled)/i.test(output)
}

/**
 * @param {{scope?: "user"|"system"}} [options]
 * @returns {{plan: object, steps: {command: string[], ok: boolean, output: string}[], removedUnit: boolean}}
 */
export function uninstall(options = {}) {
    const plan = installPlan(options)
    if (plan.needsRoot) {
        throw new Error(`a system-scope uninstall removes ${plan.unitPath}; re-run this with sudo`)
    }
    const steps = plan.deactivateCommands.map((command) => ({ command, ...runInstallCommand(command) }))
    let removedUnit = false
    try {
        Deno.removeSync(plan.unitPath)
        removedUnit = true
    } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
            throw error
        }
    }
    return { plan, steps, removedUnit }
}

/**
 * Which scopes currently have a unit file on disk.
 * @returns {{platform: string, installed: {scope: string, unitPath: string}[]}}
 */
export function installationStatus() {
    const platform = Deno.build.os == "darwin"
        ? "launchd"
        : Deno.build.os == "linux"
        ? "systemd"
        : Deno.build.os
    const installed = []
    for (const scope of installScopes) {
        let unitPath
        try {
            unitPath = unitPathFor(scope)
        } catch (_error) {
            continue
        }
        try {
            Deno.statSync(unitPath)
            installed.push({ scope, unitPath })
        } catch (_error) {
            // not installed at this scope
        }
    }
    return { platform, installed }
}

/**
 * A system-scope install is what makes per-job `runAs` meaningful, so the TUI and CLI only offer it
 * when one exists.
 * @returns {boolean}
 */
export function canRunJobsAsOtherUsers() {
    return isRunningAsRoot() || installationStatus().installed.some((entry) => entry.scope == "system")
}
