import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprint, localConfig, localPackets, parseLocalWindowsEvents, parsePacket, reconcileCatalog, windowsEventQuery, type FleetLocalConfig, type LocalObservation } from "../src/index.ts";

const T = "2026-10-31T18:00:00.000Z";
const config = localConfig({ enabled: true, host: "Example", windowsEvents: [{ component: "Task failures", log: "Example-Operational", ids: [101, 201], levels: [1, 2, 3] }], wsl: { enabled: true }, logs: [{ component: "Example app", path: "C:/Example/app.log", pattern: "ERROR|Traceback", ignore: "known noise", staleAfterMinutes: 60 }] })!;
const success = { code: 0, stdout: "", error: null };
const disk: LocalObservation = { kind: "disk", path: "C:/", bsize: 1024 ** 3, blocks: 100, bavail: 4 };
const log: LocalObservation = { kind: "log", index: 0, text: "ERROR failed", mtimeMs: Date.parse(T) };

function event(id: number, time: string, text = "task failed", provider = "Example"): string {
  return `<Event xmlns="http://schemas.microsoft.com/win/2004/08/events/event"><System><Provider Name="${provider}"/><EventID Qualifiers="0">${id}</EventID><TimeCreated SystemTime="${time}"/></System><EventData><Data Name="Error">${text}</Data></EventData></Event>`;
}

function packets(observations: LocalObservation[], settings: FleetLocalConfig = config) {
  const result = localPackets(settings, observations, T);
  for (const item of result) {
    assert.equal(parsePacket(item).ok, true);
    assert.ok(item.summary.length < 300);
    assert.ok((item.evidence.journalTail?.length ?? 0) <= 1500);
    assert.ok((item.evidence.stderrTail?.length ?? 0) <= 1500);
    assert.equal(item.host, "Example");
    assert.equal(item.fingerprint, fingerprint(item.host, item.component, item.failureClass));
    assert.deepEqual(item.redaction, { applied: false, rules: [] });
  }
  return result;
}

test("disk math uses available blocks and distinguishes warning and critical thresholds", () => {
  const critical = packets([disk])[0]!;
  assert.equal(critical.component, "disk:C:/");
  assert.equal(critical.failureClass, "resources");
  assert.equal(critical.severity, "critical");
  assert.deepEqual(critical.evidence.snapshot, { freePercent: 4, freeGiB: 4, totalGiB: 100 });
  const warning = packets([{ ...disk, bavail: 5 }])[0]!;
  assert.equal(warning.severity, "warning");
  assert.equal(warning.fingerprint, critical.fingerprint);
  assert.deepEqual(packets([{ ...disk, bavail: 10 }]), []);
  assert.deepEqual(packets([{ ...disk, bavail: 80 }]), []);
  assert.equal(packets([{ ...disk, blocks: 0 }])[0]?.failureClass, "watcher-failure");
  assert.equal(packets([{ ...disk, bsize: NaN }])[0]?.failureClass, "watcher-failure");
  assert.equal(packets([{ kind: "disk-error", path: "C:/", error: "access denied" }])[0]?.failureClass, "watcher-failure");
});

test("event XPath contains only bounded integer conditions and the exact time window", () => {
  const entry = config.windowsEvents[0]!;
  assert.equal(windowsEventQuery(entry), "*[System[(EventID=101 or EventID=201) and (Level=1 or Level=2 or Level=3) and TimeCreated[timediff(@SystemTime) <= 1800000]]]");
  assert.equal(windowsEventQuery({ ...entry, ids: [], levels: [] }), "*[System[TimeCreated[timediff(@SystemTime) <= 1800000]]]");
  assert.equal(windowsEventQuery({ ...entry, providers: ["Provider with spaces"], component: "ignored", log: "ignored" }), windowsEventQuery(entry));
  for (const ids of [[0], [NaN], [1.1], ["1 or true()"]]) assert.throws(() => windowsEventQuery({ ...entry, ids: ids as number[] }));
  assert.throws(() => windowsEventQuery({ ...entry, maxAgeMinutes: Infinity }));
});

test("event XML handles provider, id, time, Data or Message text and names the newest event", () => {
  const xml = `<Events>${event(101, "2026-10-31T17:58:00Z", "older &amp; failed")}${event(201, "2026-10-31T17:59:00Z", "newest &lt;failure&gt;")}</Events>`;
  assert.deepEqual(parseLocalWindowsEvents(xml)[0], { id: 101, provider: "Example", time: "2026-10-31T17:58:00Z", text: "older & failed" });
  const item = packets([{ kind: "windowsEvents", index: 0, result: { ...success, stdout: xml } }])[0]!;
  assert.equal(item.component, "Task failures");
  assert.equal(item.failureClass, "ran-failed");
  assert.equal(item.summary, "newest event 201; 2 events");
  assert.match(item.evidence.journalTail!, /^2026-10-31T17:59:00Z Example EventID=201 newest <failure>/);
  const message = event(101, T).replace("</Event>", "<RenderingInfo><Message>formatted &quot;failure&quot;</Message></RenderingInfo></Event>");
  assert.equal(parseLocalWindowsEvents(message)[0]?.text, 'formatted "failure"');
  assert.deepEqual(packets([{ kind: "windowsEvents", index: 0, result: success }]), []);
});

test("event provider and age filtering discard unrelated or expired events", () => {
  const settings = { ...config, windowsEvents: [{ ...config.windowsEvents[0]!, providers: ["EXAMPLE"], failureClass: "dead" as const }] };
  const stdout = event(101, T, "right") + event(201, T, "wrong provider", "Other") + event(101, "2026-10-31T17:29:59Z", "expired");
  const item = packets([{ kind: "windowsEvents", index: 0, result: { ...success, stdout } }], settings)[0]!;
  assert.equal(item.failureClass, "dead");
  assert.equal(item.summary, "newest event 101; 1 events");
  assert.doesNotMatch(item.evidence.journalTail!, /wrong provider|expired/);
});

test("event output and evidence stay capped and failed queries become watcher failures", () => {
  const stdout = Array.from({ length: 25 }, (_, i) => event(101, T, `${i} ${"x".repeat(1000)}`)).join("");
  assert.equal(parseLocalWindowsEvents(stdout).length, 20);
  const item = packets([{ kind: "windowsEvents", index: 0, result: { ...success, stdout } }])[0]!;
  assert.equal(item.evidence.journalTail!.split("\n").length, 5);
  const failure = packets([{ kind: "windowsEvents", index: 0, result: { code: 1, stdout: "", error: "x".repeat(2000) } }])[0]!;
  assert.equal(failure.component, "windowsEvents:Task failures");
  assert.equal(failure.failureClass, "watcher-failure");
  assert.equal(failure.evidence.stderrTail!.length, 1500);
});

test("WSL uses only status and silently skips ENOENT", () => {
  assert.deepEqual(packets([{ kind: "wsl", result: { ...success, stdout: "\u0000\ufffdunparseable UTF-16" } }]), []);
  for (const result of [{ code: 1, stdout: "\u0000broken", error: "exit 1" }, { code: null, stdout: "", error: "timeout" }]) {
    const item = packets([{ kind: "wsl", result }])[0]!;
    assert.equal(item.component, "wsl");
    assert.equal(item.failureClass, "dead");
    assert.equal(item.severity, "critical");
    assert.equal(item.evidence.journalTail, undefined);
    assert.equal(item.evidence.stderrTail, undefined);
  }
  assert.deepEqual(packets([{ kind: "wsl", result: { code: null, stdout: "", error: "spawn wsl.exe ENOENT" } }]), []);
});

test("log matching filters old timestamps and ignored lines with case-insensitive regexes", () => {
  const localOld = new Date(Date.parse(T) - 31 * 60_000);
  const localTimestamp = `${localOld.getFullYear()}-${String(localOld.getMonth() + 1).padStart(2, "0")}-${String(localOld.getDate()).padStart(2, "0")} ${String(localOld.getHours()).padStart(2, "0")}:${String(localOld.getMinutes()).padStart(2, "0")}:${String(localOld.getSeconds()).padStart(2, "0")}`;
  const text = ["2026-10-31T17:29:59Z ERROR old ISO", `${localTimestamp} ERROR old local`, "2026-10-31T17:30:00Z error boundary", "2026-10-31T17:59:00+00:00 ERROR fresh", "ERROR without timestamp", "invalid timestamp Traceback current", "ERROR KNOWN NOISE", "INFO healthy"].join("\r\n");
  const item = packets([{ ...log, text }])[0]!;
  assert.equal(item.summary, "4 matching log lines");
  assert.equal(item.component, "Example app");
  assert.doesNotMatch(item.evidence.journalTail!, /old ISO|old local|KNOWN NOISE|INFO/);
  assert.match(item.evidence.journalTail!, /boundary/);
  assert.match(item.evidence.journalTail!, /without timestamp/);
  assert.deepEqual(packets([{ ...log, text: "INFO healthy" }]), []);
});

test("log evidence keeps the newest five matches and caps each line and the whole tail", () => {
  const text = Array.from({ length: 10 }, (_, i) => `ERROR line ${i} ${"x".repeat(600)}`).join("\n");
  const item = packets([{ ...log, text }])[0]!;
  assert.equal(item.summary, "10 matching log lines");
  assert.equal(item.evidence.journalTail!.length, 1500);
  assert.equal(item.evidence.journalTail!.split("\n").length, 5);
  assert.match(item.evidence.journalTail!, /^ERROR line 5/);
  assert.match(item.evidence.journalTail!, /ERROR line 9/);
  for (const line of item.evidence.journalTail!.split("\n")) assert.ok(line.length <= 300);
});

test("stale logs open critical wedged incidents and missing logs open watcher failures", () => {
  const item = packets([{ ...log, text: "", mtimeMs: Date.parse(T) - 60 * 60_000 - 1 }])[0]!;
  assert.equal(item.failureClass, "wedged");
  assert.equal(item.severity, "critical");
  assert.equal(item.evidence.snapshot?.staleAfterMinutes, 60);
  assert.deepEqual(packets([{ ...log, text: "", mtimeMs: Date.parse(T) - 60 * 60_000 }]), []);
  const settings = { ...config, logs: [{ ...config.logs[0]!, staleAfterMinutes: null }] };
  assert.deepEqual(packets([{ ...log, text: "", mtimeMs: 0 }], settings), []);
  const missing = { kind: "log-error" as const, index: 0, error: "ENOENT" };
  const failure = packets([missing], settings)[0]!;
  assert.equal(failure.component, "log:Example app");
  assert.equal(failure.failureClass, "watcher-failure");
  assert.equal(packets([missing, missing], settings).length, 1);
});

test("each local source reconciles recovery once with its original fingerprint", () => {
  const failures: LocalObservation[] = [disk, { kind: "windowsEvents", index: 0, result: { ...success, stdout: event(101, T) } }, { kind: "wsl", result: { code: 1, stdout: "", error: "exit 1" } }, log];
  for (const observation of failures) {
    const current = packets([observation]);
    assert.equal(current.length, 1);
    const opened = reconcileCatalog(new Map(), current, T);
    assert.deepEqual(opened.send, current);
    const repeated = reconcileCatalog(opened.next, current, T);
    assert.equal(repeated.send[0]?.fingerprint, current[0]?.fingerprint);
    const recovered = reconcileCatalog(repeated.next, [], T);
    assert.deepEqual(recovered.send, [{ ...current[0], recovered: true, lastSeen: T, summary: "recovered" }]);
    assert.deepEqual(reconcileCatalog(recovered.next, [], T).send, []);
  }
  assert.deepEqual(localPackets(config, failures, "invalid"), []);
});
