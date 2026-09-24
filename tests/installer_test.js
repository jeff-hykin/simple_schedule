import { assertEquals, assertMatch, assertStringIncludes, assertThrows } from "jsr:@std/assert@1.0.13"
import {
    activationContextFor,
    daemonCommandLine,
    installPlan,
    installScopes,
    renderLaunchdPlist,
    renderSystemdUnit,
    serviceLabel,
} from "../source/installer.js"

Deno.test("daemonCommandLine points at something runnable", () => {
    const argv = daemonCommandLine()
    assertEquals(argv[argv.length - 1], "daemon")
    assertEquals(typeof argv[0], "string")
    assertStringIncludes(argv.join(" "), "daemon")
})

Deno.test("a system-scope daemon starts at boot, a user-scope one at login", () => {
    assertEquals(activationContextFor("system"), "boot")
    assertEquals(activationContextFor("user"), "login")
})

Deno.test("the launchd plist is well formed and carries the activation context", () => {
    const plist = renderLaunchdPlist({ scope: "user" })
    assertStringIncludes(plist, `<?xml version="1.0" encoding="UTF-8"?>`)
    assertStringIncludes(plist, `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"`)
    assertStringIncludes(plist, `<string>${serviceLabel}</string>`)
    assertStringIncludes(plist, "<key>RunAtLoad</key>\n    <true/>")
    assertStringIncludes(plist, "<key>KeepAlive</key>\n    <true/>")
    assertStringIncludes(plist, "<string>--activation-context</string>")
    assertStringIncludes(plist, "<string>login</string>")
    // every opened tag is closed
    assertEquals((plist.match(/<dict>/g) ?? []).length, (plist.match(/<\/dict>/g) ?? []).length)
    assertEquals((plist.match(/<array>/g) ?? []).length, (plist.match(/<\/array>/g) ?? []).length)
    assertEquals((plist.match(/<string>/g) ?? []).length, (plist.match(/<\/string>/g) ?? []).length)

    const systemPlist = renderLaunchdPlist({ scope: "system" })
    assertStringIncludes(systemPlist, "<string>boot</string>")
})

Deno.test("the launchd plist escapes characters that would break the XML", () => {
    const plist = renderLaunchdPlist({ scope: "user", argv: ["/bin/echo", "a & b < c"] })
    assertStringIncludes(plist, "a &amp; b &lt; c")
})

Deno.test("the systemd unit has the three sections it needs", () => {
    const unit = renderSystemdUnit({ scope: "system", environment: { SIMPLE_SCHEDULE_HOME: "/var/lib/x" } })
    assertStringIncludes(unit, "[Unit]")
    assertStringIncludes(unit, "[Service]")
    assertStringIncludes(unit, "[Install]")
    assertStringIncludes(unit, "WantedBy=multi-user.target")
    assertStringIncludes(unit, "After=network.target")
    assertStringIncludes(unit, "Restart=always")
    assertStringIncludes(unit, "Environment=SIMPLE_SCHEDULE_HOME=/var/lib/x")
    assertMatch(unit, /ExecStart=.+ daemon --activation-context boot/)

    const userUnit = renderSystemdUnit({ scope: "user" })
    assertStringIncludes(userUnit, "WantedBy=default.target")
    assertMatch(userUnit, /ExecStart=.+ daemon --activation-context login/)
    // a user unit has no business waiting on the network target
    assertEquals(userUnit.includes("After="), false)
})

Deno.test("installPlan describes the right file and commands for this platform", () => {
    for (const scope of installScopes) {
        const plan = installPlan({ scope })
        assertEquals(plan.scope, scope)
        assertEquals(plan.platform, Deno.build.os == "darwin" ? "launchd" : "systemd")
        assertEquals(plan.activateCommands.length > 0, true)
        assertEquals(plan.deactivateCommands.length > 0, true)
        assertStringIncludes(plan.contents, "daemon")
        if (Deno.build.os == "darwin") {
            assertStringIncludes(plan.unitPath, `${serviceLabel}.plist`)
            assertEquals(plan.activateCommands.every((command) => command[0] == "launchctl"), true)
        } else {
            assertStringIncludes(plan.unitPath, "simple_schedule.service")
            assertEquals(plan.activateCommands.every((command) => command[0] == "systemctl"), true)
        }
    }
    assertEquals(installPlan({ scope: "user" }).needsRoot, false)
})

Deno.test("installPlan refuses a scope it does not know", () => {
    assertThrows(() => installPlan({ scope: "everyone" }), Error, "scope must be one of")
})

Deno.test("installPlan carries the state directory override into the unit", () => {
    const previous = Deno.env.get("SIMPLE_SCHEDULE_HOME")
    Deno.env.set("SIMPLE_SCHEDULE_HOME", "/tmp/simple_schedule_installer_test")
    try {
        const plan = installPlan({ scope: "user" })
        assertStringIncludes(plan.contents, "/tmp/simple_schedule_installer_test")
    } finally {
        if (previous == null) {
            Deno.env.delete("SIMPLE_SCHEDULE_HOME")
        } else {
            Deno.env.set("SIMPLE_SCHEDULE_HOME", previous)
        }
    }
})
