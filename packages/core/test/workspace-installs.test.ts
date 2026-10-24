import { test } from "node:test";
import assert from "node:assert/strict";
import { listWorkspaceInstalls, openCatalog, recordWorkspaceInstalls, upsertMachine, workspacePathIn, type WorkspaceInstallFact, type WorkspaceInstallResult } from "../src/index.ts";

const T1 = "2026-10-23T10:00:00.000Z";
const T2 = "2026-10-23T11:00:00.000Z";
const T3 = "2026-10-23T12:00:00.000Z";

test("a path inside the Repositories tree is found in any command shape", () => {
  assert.equal(workspacePathIn("D:\\Repositories\\scout\\hub.js"), "D:/Repositories/scout/hub.js");
  assert.equal(workspacePathIn("node.exe \"C:\\Repositories\\app\\run.js\" --port 80"), "C:/Repositories/app/run.js");
  assert.equal(workspacePathIn("pwsh -File=D:/Repositories/tools/start.ps1"), "D:/Repositories/tools/start.ps1");
  assert.equal(workspacePathIn("/usr/bin/node /home/aaron/Repositories/api/index.js"), "/home/USER/Repositories/api/index.js");
  assert.equal(workspacePathIn("C:\\Users\\Aaron\\Repositories\\x\\a.exe"), "C:/Users/USER/Repositories/x/a.exe");
  assert.equal(workspacePathIn("D:\\Repositories\\_worktrees\\scout\\s-fix\\run.js"), "D:/Repositories/_worktrees/scout/s-fix/run.js");
  assert.equal(workspacePathIn("<string>/Users/neo/Repositories/app/bin/serve</string>"), "/Users/USER/Repositories/app/bin/serve");
  assert.equal(workspacePathIn("%USERPROFILE%\\Repositories\\tray\\tray.exe"), "%USERPROFILE%/Repositories/tray/tray.exe");
  assert.equal(workspacePathIn("ExecStart=/opt/app/_worktrees/a/run"), "/opt/app/_worktrees/a/run");
});

test("a path outside the Repositories tree is not a match", () => {
  assert.equal(workspacePathIn("C:\\Program Files\\Scout\\scout.exe"), null);
  assert.equal(workspacePathIn("C:\\Windows\\System32\\svchost.exe -k netsvcs"), null);
  assert.equal(workspacePathIn("D:\\MyRepositories\\app.exe"), null);
  assert.equal(workspacePathIn("D:\\Repositories2\\app.exe"), null);
  assert.equal(workspacePathIn(""), null);
});

function fact(over: Partial<WorkspaceInstallFact> = {}): WorkspaceInstallFact {
  return { kind: "scheduled-task", name: "ScoutHub", location: "/", workspacePath: "D:/Repositories/scout/hub.js", ...over };
}
const result = (facts: WorkspaceInstallFact[], status: WorkspaceInstallResult["status"] = "ok"): WorkspaceInstallResult => ({ origin: "workspace-windows", status, facts });

test("workspace installs are stored, retired when gone, and restored when they return", () => {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  const tray = fact({ kind: "run-key", name: "Tray", location: "HKCU:/Software/Microsoft/Windows/CurrentVersion/Run", workspacePath: "D:/Repositories/tray/tray.exe" });
  assert.deepEqual(recordWorkspaceInstalls(db, "hub", result([fact(), tray]), T1), { present: 2, gone: 0 });
  assert.deepEqual(listWorkspaceInstalls(db).map((row) => [row.kind, row.name, row.machineName, row.firstSeenAt]), [["run-key", "Tray", "Hub", T1], ["scheduled-task", "ScoutHub", "Hub", T1]]);
  assert.deepEqual(recordWorkspaceInstalls(db, "hub", result([tray]), T2), { present: 1, gone: 1 });
  assert.deepEqual(listWorkspaceInstalls(db).map((row) => row.name), ["Tray"]);
  recordWorkspaceInstalls(db, "hub", result([tray, fact()]), T3);
  const back = listWorkspaceInstalls(db).find((row) => row.name === "ScoutHub");
  assert.equal(back?.firstSeenAt, T1);
  assert.equal(back?.lastSeenAt, T3);
  db.close();
});

test("a partial or failed read never retires what it did not see", () => {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  recordWorkspaceInstalls(db, "hub", result([fact()]), T1);
  assert.deepEqual(recordWorkspaceInstalls(db, "hub", result([], "partial"), T2), { present: 0, gone: 0 });
  assert.deepEqual(recordWorkspaceInstalls(db, "hub", result([], "failed"), T2), { present: 0, gone: 0 });
  assert.equal(listWorkspaceInstalls(db).length, 1);
  db.close();
});

test("a reader retires only the kinds it reads and the list can be limited to one machine", () => {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  upsertMachine(db, { id: "mini", name: "Mini", os: "macos", kind: "host" });
  recordWorkspaceInstalls(db, "hub", result([fact()]), T1);
  recordWorkspaceInstalls(db, "mini", { origin: "workspace-macos", status: "ok", facts: [fact({ kind: "launchd", name: "a.plist", location: "/Users/USER/Library/LaunchAgents/a.plist", workspacePath: "/Users/USER/Repositories/a" })] }, T1);
  recordWorkspaceInstalls(db, "hub", { origin: "workspace-macos", status: "ok", facts: [] }, T2);
  assert.equal(listWorkspaceInstalls(db, { machine: "hub" }).length, 1);
  assert.equal(listWorkspaceInstalls(db, { machine: "mini" }).length, 1);
  assert.equal(listWorkspaceInstalls(db).length, 2);
  db.close();
});
