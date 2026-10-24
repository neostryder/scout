import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { linuxWorkspaceAdapter, macWorkspaceAdapter, windowsWorkspaceAdapter } from "../src/index.ts";
import { LINUX_WORKSPACE_SCRIPT, MAC_WORKSPACE_SCRIPT, WINDOWS_WORKSPACE_SCRIPT } from "../src/workspace-probes.ts";

const output = (stdout: string, exitCode = 0) => ({ workspace: { stdout, exitCode, stderr: "" } });

test("workspace probes are the recorded scripts with fixed argument arrays", () => {
  for (const [adapter, file, script, argv] of [
    [windowsWorkspaceAdapter, "windows/workspace-installs.ps1", WINDOWS_WORKSPACE_SCRIPT, ["pwsh", "-NoProfile", "-Command"]],
    [macWorkspaceAdapter, "macos/workspace-installs.sh", MAC_WORKSPACE_SCRIPT, ["/bin/sh", "-c"]],
    [linuxWorkspaceAdapter, "linux/workspace-installs.sh", LINUX_WORKSPACE_SCRIPT, ["/bin/sh", "-c"]],
  ] as const) {
    assert.equal(script, readFileSync(new URL(`../../../tools/probes/${file}`, import.meta.url), "utf8").replaceAll("\r\n", "\n"));
    assert.deepEqual(adapter.probes({ machineId: "m", os: adapter.os[0]!, roots: {} }), [{ id: "workspace", argv: [...argv, script] }]);
  }
});

test("the Windows reader stores the matched path and never the command line", () => {
  const rows = [
    { Kind: "scheduled-task", Name: "ScoutHub", Location: "\\", Command: "node.exe D:\\Repositories\\scout\\hub.js --secret-flag value" },
    { Kind: "run-key", Name: "Tray", Location: "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", Command: "\"C:\\Users\\Aaron\\Repositories\\tray\\tray.exe\"" },
    { Kind: "startup-folder", Name: "x.lnk", Location: "C:\\Users\\Aaron\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup", Command: "C:\\Windows\\notepad.exe" },
  ];
  const result = windowsWorkspaceAdapter.parse(output(JSON.stringify(rows)));
  assert.equal(result.status, "ok");
  assert.deepEqual(result.facts, [
    { kind: "scheduled-task", name: "ScoutHub", location: "/", workspacePath: "D:/Repositories/scout/hub.js" },
    { kind: "run-key", name: "Tray", location: "HKCU:/Software/Microsoft/Windows/CurrentVersion/Run", workspacePath: "C:/Users/USER/Repositories/tray/tray.exe" },
  ]);
  assert.equal(JSON.stringify(result).includes("secret-flag"), false);
});

test("the Windows reader accepts one object, an empty list, and reports bad rows and bad JSON", () => {
  assert.equal(windowsWorkspaceAdapter.parse(output("")).facts.length, 0);
  assert.equal(windowsWorkspaceAdapter.parse(output("[]")).status, "ok");
  assert.equal(windowsWorkspaceAdapter.parse(output(JSON.stringify({ Kind: "run-key", Name: "T", Location: "k", Command: "D:\\Repositories\\t.exe" }))).facts.length, 1);
  const partial = windowsWorkspaceAdapter.parse(output(JSON.stringify([{ Kind: "run-key", Name: "T", Location: "k", Command: "D:\\Repositories\\t.exe" }, { Kind: "bogus", Name: "B", Command: "x" }])));
  assert.equal(partial.status, "partial");
  assert.equal(partial.facts.length, 1);
  assert.equal(windowsWorkspaceAdapter.parse(output("not json")).status, "failed");
  assert.equal(windowsWorkspaceAdapter.parse({}).status, "failed");
  assert.equal(windowsWorkspaceAdapter.parse(output("", 9009)).status, "skipped");
});

test("the macOS reader names each plist that runs from the workspace", () => {
  const text = [
    "---SCOUT-ITEM---launchd\t/Users/neo/Library/LaunchAgents/com.example.app.plist",
    "<plist><dict><key>ProgramArguments</key><array><string>/usr/local/bin/node</string><string>/Users/neo/Repositories/app/server.js</string></array></dict></plist>",
    "---SCOUT-ITEM---launchd\t/Library/LaunchDaemons/other.plist",
    "<plist><dict><key>Label</key><string>none</string></dict></plist>",
    "",
  ].join("\n");
  const result = macWorkspaceAdapter.parse(output(text));
  assert.equal(result.status, "ok");
  assert.deepEqual(result.facts, [{ kind: "launchd", name: "com.example.app.plist", location: "/Users/USER/Library/LaunchAgents/com.example.app.plist", workspacePath: "/Users/USER/Repositories/app/server.js" }]);
  assert.equal(macWorkspaceAdapter.parse(output("")).status, "ok");
  assert.equal(macWorkspaceAdapter.parse(output("", 127)).status, "skipped");
});

test("the Linux reader covers systemd units and autostart entries", () => {
  const text = [
    "---SCOUT-ITEM---systemd\t/home/aaron/.config/systemd/user/app.service",
    "[Service]\nExecStart=/usr/bin/node /home/aaron/Repositories/app/index.js\nWorkingDirectory=/home/aaron/Repositories/app",
    "---SCOUT-ITEM---autostart\t/home/aaron/.config/autostart/tray.desktop",
    "[Desktop Entry]\nExec=/home/aaron/Repositories/tray/tray",
    "---SCOUT-ITEM---other\t/x",
    "D:/Repositories/x",
    "",
  ].join("\n");
  const result = linuxWorkspaceAdapter.parse(output(text));
  assert.equal(result.status, "partial");
  assert.deepEqual(result.facts.map((fact) => [fact.kind, fact.name, fact.workspacePath]), [
    ["systemd", "app.service", "/home/USER/Repositories/app/index.js"],
    ["autostart", "tray.desktop", "/home/USER/Repositories/tray/tray"],
  ]);
});
