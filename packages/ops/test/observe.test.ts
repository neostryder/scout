import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { AttentionTracker, parseObservation, windowsObserver } from "../src/observe.ts";

test("a reading parses whether PowerShell wrote no window, one, or several", () => {
  assert.deepEqual(parseObservation('{"uac":false,"windows":null}'), { uac: false, windows: [] });
  assert.deepEqual(parseObservation('{"uac":false,"windows":[]}'), { uac: false, windows: [] });
  assert.deepEqual(parseObservation('{"uac":true,"windows":{"pid":7,"process":"setup","title":"Setup"}}'), { uac: true, windows: [{ pid: 7, process: "setup", title: "Setup" }] });
  assert.equal(parseObservation('{"uac":false,"windows":[{"pid":7,"process":"a","title":"A"},{"pid":"x"}]}')?.windows.length, 1);
  assert.equal(parseObservation("not json"), null);
  assert.equal(parseObservation('{"windows":[]}'), null);
});

test("the observer runs one read-only script for one process and ignores a failed or unreadable look", async () => {
  const seen: string[][] = [];
  const reading = windowsObserver(async (_t, argv) => { seen.push(argv); return { exitCode: 0, stdout: '{"uac":true,"windows":[]}', stderr: "" }; });
  assert.deepEqual(await reading(321, new AbortController().signal), { uac: true, windows: [] });
  assert.equal(seen[0]?.at(-1), "321");
  assert.equal(seen[0]?.[0], "pwsh");
  assert.equal(await windowsObserver(async () => ({ exitCode: 1, stdout: "", stderr: "x" }))(321, new AbortController().signal), null);
  assert.equal(await reading(0, new AbortController().signal), null);
});

test("the prompt is expected from winget's line, shown when seen, and over when it closes", () => {
  const tracker = new AttentionTracker();
  assert.equal(tracker.current(), null);
  tracker.line({ uacExpected: true });
  assert.deepEqual(tracker.current(), { kind: "uac", detail: null });
  assert.equal(tracker.prompting, false);
  tracker.look({ uac: false, windows: [] });
  assert.equal(tracker.current()?.kind, "uac", "a look before the prompt appears does not end the wait");
  tracker.look({ uac: true, windows: [] });
  assert.equal(tracker.prompting, true);
  tracker.look({ uac: false, windows: [] });
  assert.equal(tracker.current(), null, "the prompt closing ends the wait");
  assert.equal(tracker.uacSeen, true);
});

test("the prompt ends with the finish stage when nothing could look, and outranks an installer window", () => {
  const tracker = new AttentionTracker();
  tracker.line({ uacExpected: true });
  tracker.look(null);
  assert.equal(tracker.current()?.kind, "uac");
  tracker.line({ phase: "finish" });
  assert.equal(tracker.current(), null);
  tracker.line({ uacExpected: true });
  tracker.look({ uac: true, windows: [{ pid: 9, process: "setup", title: "Setup Wizard" }] });
  assert.equal(tracker.current()?.kind, "uac");
  tracker.look({ uac: false, windows: [{ pid: 9, process: "setup", title: "Setup Wizard" }] });
  assert.deepEqual(tracker.current(), { kind: "window", detail: "Setup Wizard (setup)" });
  assert.equal(tracker.windowSeen, true);
  tracker.look({ uac: false, windows: [] });
  assert.equal(tracker.current(), null);
});

test("on Windows the real script finds a visible window opened by a child of the watched process", { skip: process.platform !== "win32" }, async () => {
  const root = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "Start-Process (Join-Path $env:WINDIR 'System32/winver.exe'); Start-Sleep 30"], { windowsHide: true, stdio: "ignore" });
  try {
    const look = windowsObserver();
    let found = null;
    for (let n = 0; n < 20 && !found; n++) {
      await new Promise((r) => setTimeout(r, 750));
      const seen = await look(root.pid!, new AbortController().signal);
      found = seen?.windows.find((w) => w.process === "winver") ?? null;
    }
    assert.ok(found, "winver's window is seen under the watched process");
    assert.equal((await look(root.pid!, new AbortController().signal))?.uac, false);
  } finally {
    root.kill();
    spawn("taskkill", ["/IM", "winver.exe", "/F"], { windowsHide: true, stdio: "ignore" });
  }
});
