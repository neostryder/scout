import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync, sign } from "node:crypto";
import { openCatalog, recordScan, upsertMachine } from "@scout/core";
import { DAILY, github, npmRegistry, SIX_HOURS, type Researcher, type RunOptions, type SourceSummary } from "@scout/research";
import { ResearchSchedule, type ScheduleClock, type ScheduleOptions } from "../src/schedule.ts";
import { createHub } from "../src/server.ts";
import type { AccessConfig, Jwk } from "../src/access.ts";

const START = Date.parse("2026-09-30T00:00:00Z");
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const summary = (source: string, extra: Partial<SourceSummary> = {}): SourceSummary => ({ source, asked: 2, ok: 1, notfound: 1, failed: 0, skipped: 0, answers: 1, ...extra });

class FakeClock implements ScheduleClock {
  time = START;
  timers = new Map<number, { at: number; callback: () => void }>();
  private serial = 0;

  now(): number { return this.time; }
  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.serial;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return id;
  }
  clearTimeout(timer: unknown): void { this.timers.delete(timer as number); }
  async advance(ms: number): Promise<void> {
    const until = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.time = due[1].at;
      this.timers.delete(due[0]);
      due[1].callback();
      await settle();
    }
    this.time = until;
    await settle();
  }
}

test("research schedule uses each source's cadence and reports the last run", async () => {
  const db = openCatalog(":memory:");
  const clock = new FakeClock();
  const calls: { sources: string[]; at: number; options: RunOptions }[] = [];
  const schedule = new ResearchSchedule(db, { researchers: [npmRegistry, github], clock, run: async (_db, sources, options) => {
    calls.push({ sources: sources.map((source) => source.source), at: clock.now(), options });
    return sources.map((source) => summary(source.source));
  } });
  try {
    assert.deepEqual(schedule.status().map((state) => [state.lastRunAt, state.lastOk, state.running]), [[null, null, false], [null, null, false]]);
    schedule.start();
    schedule.start();
    await settle();
    assert.deepEqual(calls.map((call) => call.sources), [["npm", "github"]]);
    assert.equal(calls[0]?.options.concurrency, 4);
    assert.equal(calls[0]?.options.force, false);
    assert.deepEqual(schedule.status()[0], { source: "npm", lastRunAt: new Date(START).toISOString(), lastOk: true, asked: 2, answered: 1, failed: 0, nextDueAt: new Date(START + DAILY).toISOString(), running: false });
    await clock.advance(SIX_HOURS - 1);
    assert.equal(calls.length, 1);
    await clock.advance(1);
    assert.deepEqual(calls[1]?.sources, ["github"]);
    await clock.advance(3 * SIX_HOURS);
    assert.deepEqual(calls.map((call) => call.sources), [["npm", "github"], ["github"], ["github"], ["github"], ["npm", "github"]]);
    assert.equal(calls.at(-1)?.at, START + DAILY);
    schedule.stop();
    assert.equal(clock.timers.size, 0);
    await clock.advance(DAILY);
    assert.equal(calls.length, 5);
  } finally {
    schedule.stop();
    db.close();
  }
});

test("research schedule queues manual refreshes without overlapping runs", async () => {
  const db = openCatalog(":memory:");
  const clock = new FakeClock();
  const calls: { sources: string[]; force: boolean | undefined }[] = [];
  let active = 0;
  let maximum = 0;
  let release: (() => void) | undefined;
  const schedule = new ResearchSchedule(db, { researchers: [npmRegistry, github], clock, run: async (_db, sources, options) => {
    active++;
    maximum = Math.max(maximum, active);
    calls.push({ sources: sources.map((source) => source.source), force: options.force });
    if (calls.length === 1) await new Promise<void>((resolve) => { release = resolve; });
    active--;
    return sources.map((source) => summary(source.source));
  } });
  try {
    schedule.start();
    assert.ok(schedule.status().every((state) => state.running));
    const first = schedule.runNow(["github"]);
    const second = schedule.runNow(["github"]);
    await clock.advance(DAILY);
    assert.equal(calls.length, 1);
    release?.();
    await Promise.all([first, second]);
    assert.equal(maximum, 1);
    assert.deepEqual(calls, [{ sources: ["npm", "github"], force: false }, { sources: ["github"], force: true }]);
    assert.ok(schedule.status().every((state) => !state.running));
    schedule.stop();
    await schedule.runNow(["npm"]);
    assert.deepEqual(calls.at(-1), { sources: ["npm"], force: true });
    await schedule.runNow();
    assert.deepEqual(calls.at(-1)?.sources, ["npm", "github"]);
    const snapshot = schedule.status();
    if (snapshot[0]) snapshot[0].asked = 999;
    assert.equal(schedule.status()[0]?.asked, 2);
    assert.throws(() => schedule.runNow(["unknown"]), /known research sources/);
    const count = calls.length;
    await schedule.runNow([]);
    assert.equal(calls.length, count);
  } finally {
    release?.();
    schedule.stop();
    db.close();
  }
});

test("research schedule stops pending work while an active run finishes", async () => {
  const db = openCatalog(":memory:");
  const clock = new FakeClock();
  let release: (() => void) | undefined;
  let calls = 0;
  const schedule = new ResearchSchedule(db, { researchers: [github], clock, run: async () => {
    calls++;
    await new Promise<void>((resolve) => { release = resolve; });
    return [summary("github")];
  } });
  try {
    schedule.start();
    const pending = schedule.runNow();
    schedule.stop();
    release?.();
    await pending;
    await clock.advance(DAILY);
    assert.equal(calls, 1);
    assert.equal(clock.timers.size, 0);
    assert.equal(schedule.status()[0]?.running, false);
  } finally {
    schedule.stop();
    db.close();
  }
});

test("research schedule retries failures after an hour and survives a rejected runner", async () => {
  const db = openCatalog(":memory:");
  const clock = new FakeClock();
  let calls = 0;
  const schedule = new ResearchSchedule(db, { researchers: [github], clock, run: async () => {
    calls++;
    if (calls === 1) throw new Error("fixture failure");
    return [summary("github", calls === 2 ? { failed: 1 } : {})];
  } });
  try {
    schedule.start();
    await settle();
    assert.equal(schedule.status()[0]?.lastOk, false);
    assert.equal(schedule.status()[0]?.failed, 1);
    assert.equal(schedule.status()[0]?.nextDueAt, new Date(START + 3_600_000).toISOString());
    await clock.advance(2 * 3_600_000);
    assert.equal(calls, 3);
    assert.equal(schedule.status()[0]?.lastOk, true);
    assert.equal(schedule.status()[0]?.nextDueAt, new Date(clock.now() + SIX_HOURS).toISOString());
  } finally {
    schedule.stop();
    db.close();
  }
});

test("research schedule's runner keeps request concurrency within the service caps", async () => {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "test", name: "Test", os: "macos", kind: "host" });
  recordScan(db, "test", { sourceKind: "test", location: "", status: "ok", installs: Array.from({ length: 10 }, (_, index) => ({ ecosystem: "npm", key: `demo${index}`, name: `demo${index}`, kind: "package", version: "1.0.0", location: `/test/${index}`, homepage: `https://github.com/example/demo${index}` })) }, new Date(START).toISOString());
  let active = 0;
  let maximum = 0;
  let githubMaximum = 0;
  const schedule = new ResearchSchedule(db, { researchers: [npmRegistry, github], clock: new FakeClock(), runOptions: { env: {}, concurrency: 100, fetch: async (url) => {
    active++;
    maximum = Math.max(maximum, active);
    if (url.includes("api.github.com")) githubMaximum = Math.max(githubMaximum, active);
    await settle();
    active--;
    return { status: 200, text: async () => url.includes("api.github.com") ? "[]" : '{"latest":"2.0.0"}' };
  } } });
  try {
    await schedule.runNow();
    assert.equal(maximum, 4);
    assert.equal(githubMaximum, 1);
    assert.equal(schedule.status()[0]?.answered, 10);
    assert.ok(schedule.status().every((state) => state.lastOk && !state.running));
  } finally {
    schedule.stop();
    db.close();
  }
});

async function hub(options: { run?: ScheduleOptions["run"]; access?: Parameters<typeof createHub>[0]["access"]; researchers?: Researcher[] } = {}) {
  const db = openCatalog(":memory:");
  const schedule = new ResearchSchedule(db, { researchers: options.researchers ?? [npmRegistry, github], clock: new FakeClock(), run: options.run ?? (async (_db, researchers) => researchers.map((researcher) => summary(researcher.source))) });
  const server = createHub({ db, webRoot: process.cwd(), research: schedule, ...(options.access ? { access: options.access } : {}) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const call = (path: string, method = "GET", body?: string, headers: Record<string, string> = {}) => new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let text = "";
      res.on("data", (chunk) => text += chunk);
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(body);
  });
  return { schedule, call, port, async close() {
    schedule.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  } };
}

test("research routes return status and refresh selected or all sources", async () => {
  const instance = await hub();
  const headers = { "content-type": "application/json", origin: `http://127.0.0.1:${instance.port}` };
  try {
    const before = await instance.call("/api/research/status");
    assert.equal(before.status, 200);
    assert.ok(JSON.parse(before.body).every((state: { lastRunAt: string | null }) => state.lastRunAt === null));
    assert.equal(before.headers["cache-control"], "no-store");
    const refreshed = await instance.call("/api/research/refresh", "POST", '{"sources":["github"]}', headers);
    assert.equal(refreshed.status, 200);
    const states = JSON.parse(refreshed.body) as { source: string; lastOk: boolean | null }[];
    assert.deepEqual(states.map((state) => [state.source, state.lastOk]), [["npm", null], ["github", true]]);
    assert.equal((await instance.call("/api/research/refresh", "POST", "{}", headers)).status, 200);
    assert.ok(JSON.parse((await instance.call("/api/research/status")).body).every((state: { lastOk: boolean }) => state.lastOk));
    assert.equal((await instance.call("/api/research/refresh", "POST", "{}", { "content-type": "application/json" })).status, 200);
  } finally {
    await instance.close();
  }
});

test("research routes enforce the jobs host, origin, content type and body rules", async () => {
  let runs = 0;
  const instance = await hub({ run: async (_db, sources) => { runs++; return sources.map((source) => summary(source.source)); } });
  const json = { "content-type": "application/json" };
  try {
    assert.equal((await instance.call("/api/research/status", "GET", undefined, { host: "evil.example" })).status, 421);
    assert.equal((await instance.call("/api/research/refresh", "POST", "{}", { ...json, host: "evil.example" })).status, 421);
    assert.equal((await instance.call("/api/research/refresh", "POST", "{}", { ...json, origin: "https://evil.example" })).status, 403);
    assert.equal((await instance.call("/api/research/refresh", "POST", "{}", { ...json, origin: "invalid" })).status, 403);
    assert.equal((await instance.call("/api/research/refresh", "POST", "{}", { "content-type": "text/plain" })).status, 415);
    assert.equal((await instance.call("/api/research/refresh", "POST", " ".repeat(4097), json)).status, 413);
    for (const body of ["{broken", "null", "[]", '{"sources":null}', '{"sources":"github"}', '{"sources":[1]}', '{"sources":["unknown"]}']) {
      assert.equal((await instance.call("/api/research/refresh", "POST", body, json)).status, 400);
    }
    assert.equal((await instance.call("/api/research/status", "POST", "{}", json)).status, 405);
    assert.equal((await instance.call("/api/research/refresh", "GET")).status, 404);
    assert.equal((await instance.call("/api/research/status", "DELETE")).status, 405);
    assert.equal(runs, 0);
  } finally {
    await instance.close();
  }
});

test("research routes expose an active refresh while a second refresh waits", async () => {
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let runs = 0;
  const instance = await hub({ researchers: [github], run: async () => {
    runs++;
    if (runs === 1) {
      entered?.();
      await new Promise<void>((resolve) => { release = resolve; });
    }
    return [summary("github")];
  } });
  try {
    const first = instance.call("/api/research/refresh", "POST", "{}", { "content-type": "application/json" });
    await started;
    const state = JSON.parse((await instance.call("/api/research/status")).body) as { running: boolean }[];
    assert.equal(state[0]?.running, true);
    const second = instance.call("/api/research/refresh", "POST", "{}", { "content-type": "application/json" });
    await settle();
    assert.equal(runs, 1);
    release?.();
    const responses = await Promise.all([first, second]);
    assert.ok(responses.every((response) => response.status === 200));
    assert.equal(runs, 2);
  } finally {
    release?.();
    await instance.close();
  }
});

test("research routes require Access credentials in production and the public origin", async () => {
  const config: AccessConfig = { host: "scout.example.test", teamDomain: "team.example.test", aud: "research-test", allowedEmails: ["test@example.test"] };
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const key: Jwk = { ...(pair.publicKey.export({ format: "jwk" }) as Jwk), kid: "research-key", alg: "RS256", use: "sig" };
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: key.kid })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iss: `https://${config.teamDomain}`, aud: config.aud, email: "test@example.test", exp: now + 3600, nbf: now - 10 })).toString("base64url");
  const credential = `${header}.${payload}.${sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), pair.privateKey).toString("base64url")}`;
  const instance = await hub({ access: { config, keys: async () => [key] } });
  const headers = { host: config.host, "content-type": "application/json", "cf-access-jwt-assertion": credential };
  try {
    assert.equal((await instance.call("/api/research/status")).status, 421);
    assert.equal((await instance.call("/api/research/status", "GET", undefined, { host: config.host })).status, 403);
    assert.equal((await instance.call("/api/research/refresh", "POST", "{}", { host: config.host, "content-type": "application/json" })).status, 403);
    assert.equal((await instance.call("/api/research/status", "GET", undefined, headers)).status, 200);
    assert.equal((await instance.call("/api/research/refresh", "POST", "{}", { ...headers, origin: "http://127.0.0.1" })).status, 403);
    assert.equal((await instance.call("/api/research/refresh", "POST", "{}", { ...headers, origin: `https://${config.host}` })).status, 200);
  } finally {
    await instance.close();
  }
});
