import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { alertsResponse, listOutages, openCatalog, recordServices, upsertMachine, type Db, type OutageNotice, type ServiceFact } from "@scout/core";
import type { MachineProbe, WatchedMachine } from "@scout/ops";
import { createHub } from "../src/server.ts";
import { Notifier, type ChannelResult } from "../src/notify.ts";
import { HubWatch } from "../src/watch.ts";

const WEBHOOK = "https://discord.com/api/webhooks/123456789/abcDEF-ghi_JKL";
const worker: ServiceFact = { kind: "windows-service", name: "worker", displayName: "Worker", domain: "system", program: "C:/Tools/worker.exe", state: "running", startMode: "auto", enabled: true, pid: 42, runAs: null, triggers: null, lastRun: null, lastResult: null };
const machines: WatchedMachine[] = [{ id: "gm", name: "Server", host: "192.0.2.5", port: 22 }];

interface Sent { title: string; body: string }

function setup(t: TestContext, mode: { state: MachineProbe["state"] } = { state: "up" }) {
  const dir = mkdtempSync(join(tmpdir(), "scout-hub-watch-"));
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "gm", name: "Server", os: "macos", kind: "host" });
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  const sent: Sent[] = [];
  const posted: string[] = [];
  const notifier = new Notifier({
    webhook: () => WEBHOOK,
    fetch: (async (url: string, init: { body: string }) => { posted.push(url); sent.push(JSON.parse(init.body).content); return { ok: true, status: 204 }; }) as never,
    desktop: async (notice: OutageNotice) => { sent.push({ title: notice.title, body: notice.body }); },
    log: () => {},
  });
  let now = Date.parse("2026-10-10T08:00:00.000Z");
  const clock = { now: () => now, setTimeout: () => ({}), clearTimeout: () => {} };
  const watch = new HubWatch(db, { machines: () => machines, configPath: join(dir, "watch.json"), heartbeatPath: join(dir, "heartbeat.json"), notifier, clock, log: () => {}, check: { probe: async () => ({ state: mode.state, detail: mode.state === "up" ? "" : "No SSH greeting.", latencyMs: null }) } });
  t.after(() => { watch.stop(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { db, dir, watch, sent, posted, advance: (ms: number) => { now += ms; }, mode };
}

test("a hung machine opens an outage after two rounds, notifies once on both channels and notifies the recovery with the duration", async (t) => {
  const { db, watch, sent, advance, mode } = setup(t);
  await watch.cycle();
  mode.state = "hung";
  advance(120_000);
  assert.deepEqual(await watch.cycle(), []);
  advance(120_000);
  const changes = await watch.cycle();
  assert.equal(changes.length, 1);
  assert.equal(sent.length, 2, "one Discord post and one desktop notice");
  assert.match(sent[0]!.title ?? String(sent[0]), /Outage: Server is hung/);
  advance(120_000);
  assert.deepEqual(await watch.cycle(), []);
  assert.equal(sent.length, 2, "a continuing outage is not announced again");
  mode.state = "up";
  advance(120_000);
  await watch.cycle();
  assert.equal(sent.length, 4);
  assert.match(JSON.stringify(sent[3]), /Recovered: Server/);
  assert.match(JSON.stringify(sent[3]), /after 6 min/);
  assert.equal(listOutages(db, { state: "open" }).length, 0);
});

test("a pause stops checks and notices and the page can switch a machine off", async (t) => {
  const { watch, sent, advance, mode } = setup(t, { state: "hung" });
  watch.update({ pausedUntil: new Date(Date.parse("2026-10-10T08:00:00.000Z") + 3_600_000).toISOString() });
  await watch.cycle();
  advance(120_000);
  await watch.cycle();
  assert.equal(sent.length, 0);
  assert.equal(watch.status().paused, true);
  watch.update({ pausedUntil: null });
  watch.update({ machine: "gm", watched: false });
  advance(120_000);
  await watch.cycle();
  advance(120_000);
  await watch.cycle();
  assert.equal(sent.length, 0);
  assert.equal(mode.state, "hung");
});

test("service checks count once an interval even when reads arrive every few seconds, and a stopped service is announced after two of them", async (t) => {
  const { db, watch, sent, advance } = setup(t);
  recordServices(db, "gm", { origin: "services", status: "ok", facts: [worker] }, "2026-10-10T08:00:00.000Z");
  watch.observeServices("gm", "2026-10-10T08:00:00.000Z");
  recordServices(db, "gm", { origin: "services", status: "ok", facts: [{ ...worker, state: "stopped" }] }, "2026-10-10T08:00:03.000Z");
  advance(3_000);
  assert.deepEqual(watch.observeServices("gm", "2026-10-10T08:00:03.000Z"), []);
  advance(3_000);
  assert.deepEqual(watch.observeServices("gm", "2026-10-10T08:00:06.000Z"), [], "a read a few seconds later is the same check window");
  advance(110_000);
  assert.deepEqual(watch.observeServices("gm", "2026-10-10T08:01:56.000Z").length, 0, "first failed check");
  advance(120_000);
  const changes = watch.observeServices("gm", "2026-10-10T08:03:56.000Z");
  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.outage.kind, "service");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(JSON.stringify(sent), /Worker on Server is not running/);
});

test("starting after a long silence records a monitor gap and a short one does not", async (t) => {
  const { db, dir, watch, sent } = setup(t);
  writeFileSync(join(dir, "heartbeat.json"), JSON.stringify({ at: "2026-10-10T07:00:00.000Z", pid: 1, startedAt: "2026-10-10T06:00:00.000Z" }));
  watch.start();
  await new Promise((resolve) => setImmediate(resolve));
  const [gap] = listOutages(db, { state: "closed" });
  assert.equal(gap!.kind, "monitor-gap");
  assert.equal(gap!.startedAt, "2026-10-10T07:00:00.000Z");
  assert.equal(gap!.endedAt, "2026-10-10T08:00:00.000Z");
  assert.match(JSON.stringify(sent), /Scout was not running/);
  const beat = JSON.parse(readFileSync(join(dir, "heartbeat.json"), "utf8"));
  assert.equal(beat.at, "2026-10-10T08:00:00.000Z");
  watch.stop();
  const again = setup(t);
  writeFileSync(join(again.dir, "heartbeat.json"), JSON.stringify({ at: "2026-10-10T07:58:00.000Z", pid: 1, startedAt: "x" }));
  again.watch.start();
  assert.equal(listOutages(again.db).length, 0);
});

test("the Discord post carries the notice, refuses a non-Discord address and never mentions anyone", async (t) => {
  let body = "";
  const ok = new Notifier({ webhook: () => WEBHOOK, fetch: (async (_url: string, init: { body: string }) => { body = init.body; return { ok: true, status: 204 }; }) as never, desktop: async () => {}, log: () => {} });
  const results = await ok.send({ title: "Outage: X is down", body: "Since now.", severity: "high" });
  assert.deepEqual(results.map((row: ChannelResult) => [row.channel, row.ok]), [["discord", true], ["desktop", true]]);
  assert.deepEqual(JSON.parse(body), { content: "**Outage: X is down**\nSince now.", allowed_mentions: { parse: [] } });
  const bad = new Notifier({ webhook: () => "https://evil.example.test/hook", fetch: (async () => { throw new Error("must not be called"); }) as never, desktop: async () => { throw new Error("no display"); }, log: () => {} });
  const refused = await bad.send({ title: "t", body: "b", severity: "info" });
  assert.deepEqual(refused.map((row) => [row.channel, row.ok, row.error]), [["discord", false, "SCOUT_DISCORD_WEBHOOK is not a Discord webhook address"], ["desktop", false, "no display"]]);
  assert.deepEqual(new Notifier({ webhook: () => undefined }).channels(), { discord: false, desktop: true });
  t.after(() => {});
});

async function api(db: Db, watch: HubWatch | undefined, t: TestContext) {
  const server = createHub({ db, webRoot: ".", control: false, ...(watch ? { watch } : {}), alerts: { alertsPath: "fixtures/alerts/missing.json" } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  t.after(async () => { await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); });
  return (path: string, body?: unknown): Promise<{ status: number; body: any }> => new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port, path: `/api/services/outages${path}`, method: body === undefined ? "GET" : "POST", headers: body === undefined ? {} : { "content-type": "application/json" } }, (res) => {
      let raw = "";
      res.setEncoding("utf8");
      res.on("data", (part) => { raw += part; });
      res.on("end", () => resolve({ status: res.statusCode!, body: JSON.parse(raw) }));
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test("the outages API lists outages, edits the watch file, sends a test notice and is read-only without a watch", async (t) => {
  const { db, watch, sent, advance, mode } = setup(t, { state: "down" });
  const call = await api(db, watch, t);
  await watch.cycle();
  advance(120_000);
  await watch.cycle();
  const listed = await call("");
  assert.equal(listed.status, 200);
  assert.equal(listed.body.open, 1);
  assert.equal(listed.body.outages[0].state, "down");
  assert.equal(listed.body.items[0].watched, true);
  assert.equal(listed.body.watch.channels.discord, true);
  assert.equal(alertsResponse(db, new URLSearchParams("kind=machine-outage"), "2026-10-10T08:05:00.000Z").alerts.length, 1);
  const off = await call("/watch", { machine: "gm", watched: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.config.machines.gm, false);
  assert.equal((await call("/watch", { bogus: true })).status, 400);
  const test = await call("/test", {});
  assert.equal(test.status, 200);
  assert.deepEqual(test.body.results.map((row: ChannelResult) => row.channel), ["discord", "desktop"]);
  assert.match(JSON.stringify(sent), /Scout test notice/);
  assert.equal((await call("/test", { x: 1 })).status, 400);
  assert.equal(mode.state, "down");
  const bare = await api(openCatalog(":memory:"), undefined, t);
  assert.equal((await bare("")).body.open, 0);
  assert.equal((await bare("/test", {})).status, 404);
  assert.equal((await bare("?state=bogus")).status, 400);
});
