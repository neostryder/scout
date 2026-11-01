import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  FAILURE_CLASSES,
  SEVERITIES,
  acknowledge,
  digest,
  expectedKey,
  expectedPackets,
  fingerprint,
  heartbeatMetaKey,
  inQuietHours,
  incidentByFingerprint,
  incidentById,
  ingest,
  listIncidents,
  loadFleetConfig,
  muteRule,
  parsePacket,
  resolvePolicy,
  ruleKey,
  snooze,
  sweepEscalations,
  type Db,
  type FailureClass,
  type FleetDecision,
  type FleetFile,
  type FleetIncident,
  type FleetInvestigator,
  type FleetNotice,
  type FleetNotifier,
  type FleetTriage,
  type FleetTriageResult,
  type IncidentPacket,
  type Severity,
} from "@scout/core";
import { readJson } from "./services-api.ts";
import { desktopNotice } from "./notify.ts";

export interface TimerHandle { stop(): void }

export interface FleetServiceOptions {
  configPath: string;
  env?: (name: string) => string | undefined;
  log?: (line: string) => void;
  now?: () => Date;
  fetch?: typeof fetch;
  run?: (program: string, args: string[], stdin: string, timeoutMs: number) => Promise<{ code: number | null; error: string | null }>;
  runCapture?: (program: string, args: string[], stdin: string, timeoutMs: number) => Promise<{ code: number | null; stdout: string; error: string | null }>;
  desktop?: (notice: { title: string; body: string; severity: "high" | "info" }) => Promise<void>;
  later?: (fn: () => void, ms: number) => TimerHandle;
  every?: (fn: () => void, ms: number) => TimerHandle;
  investigator?: FleetInvestigator;
  triage?: FleetTriage;
}

type SendJson = (res: ServerResponse, status: number, value: unknown) => void;

interface Outbound { notice: FleetNotice; incidentId: number | null }
interface TriageCacheEntry { result: FleetTriageResult; expires: number; noiseRecorded?: boolean }

const ACTIONS: FleetNotice["actions"] = [
  { id: "investigate", label: "Investigate" },
  { id: "snooze", label: "Snooze" },
  { id: "mute", label: "Mute" },
];

const PACKET_LIMIT = 2_000_000;
const SWEEP_MS = 60_000;
const RETRY_MS = 60_000;
const CLASSES = new Set<string>(FAILURE_CLASSES);
const SEVERITY_SET = new Set<string>(SEVERITIES);
const TRIAGE_CACHES = new WeakMap<FleetTriage, Map<string, TriageCacheEntry>>();

function safeError(error: string): string {
  return error
    .replace(/https?:\/\/\S+/gi, "[redacted:url]")
    .replace(/\bBearer\s+\S+/gi, "[redacted:bearer]")
    .replace(/(?:github_pat_|ghp_|gho_)\S+/g, "[redacted:github]")
    .slice(0, 200);
}

function sameToken(expected: string, presented: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(presented);
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

function bearer(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(value);
  return match?.[1] ?? null;
}

function clock(now: Date): { day: string; hm: string } {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const date = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  return { day: `${year}-${month}-${date}`, hm: `${hours}:${minutes}` };
}

function defaultLater(fn: () => void, ms: number): TimerHandle {
  const timer = setTimeout(fn, ms);
  timer.unref();
  return { stop: () => clearTimeout(timer) };
}

function defaultEvery(fn: () => void, ms: number): TimerHandle {
  const timer = setInterval(fn, ms);
  timer.unref();
  return { stop: () => clearInterval(timer) };
}

/** On Windows a detached child is not tied to the stdin pipe, so a command we wait on stays hidden without being detached. */
export function runCommand(program: string, args: string[], stdin: string, timeoutMs: number): Promise<{ code: number | null; error: string | null }> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null, error: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, error });
    };
    const child = spawn(program, args, { windowsHide: true, detached: process.platform !== "win32", shell: false, stdio: ["pipe", "ignore", "ignore"] });
    timer = setTimeout(() => {
      child.kill();
      finish(null, "timeout");
    }, timeoutMs);
    child.once("error", (error) => finish(null, error.message));
    child.once("close", (code) => finish(code, code === 0 ? null : `exit ${code ?? "null"}`));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(stdin);
  });
}

export function runCommandCapture(program: string, args: string[], stdin: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; error: string | null }> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (code: number | null, error: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(chunks).toString("utf8"), error });
    };
    const child = spawn(program, args, { windowsHide: true, detached: process.platform !== "win32", shell: false, stdio: ["pipe", "pipe", "ignore"] });
    child.stdout.on("data", (chunk: Buffer) => {
      const kept = chunk.subarray(0, Math.max(0, 65_536 - size));
      if (kept.length > 0) chunks.push(kept);
      size += kept.length;
    });
    timer = setTimeout(() => {
      child.kill();
      finish(null, "timeout");
    }, timeoutMs);
    child.once("error", (error) => finish(null, error.message));
    child.once("close", (code) => finish(code, code === 0 ? null : `exit ${code ?? "null"}`));
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
  });
}

export function commandInvestigator(config: { command: string[]; run?: FleetServiceOptions["runCapture"] }): FleetInvestigator {
  const run = config.run ?? runCommandCapture;
  const [program, ...args] = config.command;
  return {
    async investigate(incident, packet) {
      if (!program) return { ok: false, reference: null, error: "command is empty" };
      const { id, host, component, failureClass, severity, state, firstSeen, lastSeen, count } = incident;
      try {
        const result = await run(program, args, JSON.stringify({ incident: { id, host, component, failureClass, severity, state, firstSeen, lastSeen, count }, packet }), 90_000);
        if (result.error || result.code !== 0) return { ok: false, reference: null, error: safeError(result.error ?? `exit ${result.code ?? "null"}`) };
        const last = result.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0).at(-1) ?? "";
        let parsed: unknown;
        try { parsed = JSON.parse(last); } catch {
          return { ok: true, reference: result.stdout.slice(0, 200), error: null };
        }
        if (!parsed || typeof parsed !== "object" || !("ok" in parsed) || typeof parsed.ok !== "boolean") return { ok: false, reference: null, error: "invalid investigator response" };
        const reference = "reference" in parsed && typeof parsed.reference === "string" ? parsed.reference : null;
        const error = "error" in parsed && typeof parsed.error === "string" ? parsed.error : "investigation failed";
        return { ok: parsed.ok, reference, error: parsed.ok ? null : safeError(error) };
      } catch (error) {
        return { ok: false, reference: null, error: safeError(error instanceof Error ? error.message : "investigation failed") };
      }
    },
  };
}

function triageKey(packet: IncidentPacket): string {
  return JSON.stringify([packet.fingerprint, packet.summary.slice(0, 200).replace(/\d+/g, "#")]);
}

export function commandTriage(config: { command: string[]; run?: FleetServiceOptions["runCapture"]; now?: () => Date; ttlMs?: number; timeoutMs?: number }): FleetTriage {
  const run = config.run ?? runCommandCapture;
  const now = config.now ?? (() => new Date());
  const ttlMs = config.ttlMs ?? 6 * 60 * 60_000;
  const [program, ...args] = config.command;
  const cache = new Map<string, TriageCacheEntry>();
  const pending = new Map<string, Promise<FleetTriageResult>>();
  const classify = async (packet: IncidentPacket): Promise<FleetTriageResult> => {
    let verdict: FleetTriageResult = { noise: false };
    let success = false;
    try {
      if (!program) throw new Error("command is empty");
      const result = await run(program, args, JSON.stringify({ packet }), config.timeoutMs ?? 30_000);
      if (result.error || result.code !== 0) throw new Error("triage failed");
      const last = result.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0).at(-1) ?? "";
      const parsed: unknown = JSON.parse(last);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !("noise" in parsed) || typeof parsed.noise !== "boolean") throw new Error("invalid triage response");
      const row = parsed as Record<string, unknown>;
      verdict = { noise: parsed.noise };
      if (typeof row.failureClass === "string" && CLASSES.has(row.failureClass)) verdict.failureClass = row.failureClass as FailureClass;
      if (typeof row.severity === "string" && SEVERITY_SET.has(row.severity)) verdict.severity = row.severity as Severity;
      if (typeof row.ownerChat === "string") verdict.ownerChat = row.ownerChat.slice(0, 200);
      if (typeof row.groupWith === "string") verdict.groupWith = row.groupWith;
      if (typeof row.healSafe === "boolean") verdict.healSafe = row.healSafe;
      if (typeof row.cause === "string") verdict.cause = row.cause.slice(0, 300);
      success = true;
    } catch {
      verdict = { noise: false };
    }
    const key = triageKey(packet);
    cache.delete(key);
    cache.set(key, { result: verdict, expires: now().getTime() + (success ? ttlMs : 5 * 60_000) });
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
    return verdict;
  };
  const triage: FleetTriage = {
    classify(packet) {
      const key = triageKey(packet);
      const hit = cache.get(key);
      if (hit && hit.expires > now().getTime()) return Promise.resolve(hit.result);
      const active = pending.get(key);
      if (active) return active;
      const promise = classify(packet).finally(() => { pending.delete(key); });
      pending.set(key, promise);
      return promise;
    },
  };
  TRIAGE_CACHES.set(triage, cache);
  return triage;
}

export function webhookNotifier(config: { id: string; url: () => string | undefined; fetch?: typeof fetch }): FleetNotifier {
  const fetchImpl = config.fetch ?? fetch;
  return {
    id: config.id,
    async send(notice: FleetNotice) {
      const url = config.url();
      if (!url) return { ok: false, error: "webhook url is not set" };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10_000);
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ title: notice.title, body: notice.body, severity: notice.severity, kind: notice.kind, incidentId: notice.incidentId, actions: notice.actions }),
        });
        if (!response.ok) return { ok: false, error: `webhook status ${response.status}` };
        return { ok: true, error: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : "webhook failed";
        return { ok: false, error: safeError(message) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

export function commandNotifier(config: { id: string; command: string[]; run: FleetServiceOptions["run"] }): FleetNotifier {
  const run = config.run ?? runCommand;
  const [program, ...args] = config.command;
  return {
    id: config.id,
    async send(notice: FleetNotice) {
      if (!program) return { ok: false, error: "command is empty" };
      const result = await run(program, args, JSON.stringify(notice), 15_000);
      if (result.error || result.code !== 0) return { ok: false, error: safeError(result.error ?? `exit ${result.code ?? "null"}`) };
      return { ok: true, error: null };
    },
  };
}

export function desktopNotifier(config: { id: string; desktop?: FleetServiceOptions["desktop"] }): FleetNotifier {
  const desktop = config.desktop ?? ((notice: { title: string; body: string; severity: "high" | "info" }) => desktopNotice(notice));
  return {
    id: config.id,
    async send(notice: FleetNotice) {
      try {
        await desktop({ title: notice.title, body: notice.body, severity: notice.severity === "info" ? "info" : "high" });
        return { ok: true, error: null };
      } catch (error) {
        return { ok: false, error: safeError(error instanceof Error ? error.message : "desktop notice failed") };
      }
    },
  };
}

async function readLimited(req: IncomingMessage, limit: number): Promise<{ ok: true; raw: string } | { ok: false; status: number; error: string }> {
  const type = req.headers["content-type"];
  if (typeof type !== "string" || !type.startsWith("application/json")) return { ok: false, status: 415, error: "content type must be application/json" };
  let raw = "";
  for await (const chunk of req) {
    raw += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (raw.length > limit) return { ok: false, status: 413, error: "body too large" };
  }
  return { ok: true, raw };
}

export class FleetService {
  private db: Db;
  private configPath: string;
  private env: (name: string) => string | undefined;
  private log: (line: string) => void;
  private now: () => Date;
  private fetchImpl: typeof fetch | undefined;
  private run: NonNullable<FleetServiceOptions["run"]>;
  private runCapture: NonNullable<FleetServiceOptions["runCapture"]>;
  private desktop: NonNullable<FleetServiceOptions["desktop"]> | undefined;
  private later: NonNullable<FleetServiceOptions["later"]>;
  private every: NonNullable<FleetServiceOptions["every"]>;
  private investigator: FleetInvestigator | undefined;
  private triage: FleetTriage | undefined;
  private configuredTriage: { key: string; triage: FleetTriage } | undefined;
  private triageNoise = new Map<string, number>();
  private healing = new Set<number>();
  private cached: FleetFile | null = null;
  private stamp = "";
  private timer: TimerHandle | undefined;
  private retries: TimerHandle[] = [];
  private wasQuiet: boolean | null = null;
  private digestSlot = "";

  constructor(db: Db, options: FleetServiceOptions) {
    this.db = db;
    this.configPath = options.configPath;
    this.env = options.env ?? ((name: string) => process.env[name]);
    this.log = options.log ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetch;
    this.run = options.run ?? runCommand;
    this.runCapture = options.runCapture ?? runCommandCapture;
    this.desktop = options.desktop;
    this.later = options.later ?? defaultLater;
    this.every = options.every ?? defaultEvery;
    this.investigator = options.investigator;
    this.triage = options.triage;
  }

  start(): void {
    if (this.timer) return;
    this.timer = this.every(() => this.tick(), SWEEP_MS);
  }

  stop(): void {
    this.timer?.stop();
    this.timer = undefined;
    for (const retry of this.retries) retry.stop();
    this.retries = [];
  }

  config(): FleetFile {
    let stamp = "missing";
    try {
      const stat = statSync(this.configPath);
      stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      stamp = "missing";
    }
    if (!this.cached || stamp !== this.stamp) {
      this.stamp = stamp;
      this.cached = loadFleetConfig(this.configPath, this.env);
    }
    return this.cached;
  }

  authorize(header: string | string[] | undefined): "ok" | "unauthorized" | "unconfigured" {
    const file = this.config();
    if (file.fileError || !file.ingestTokenEnv) return "unconfigured";
    const expected = this.env(file.ingestTokenEnv);
    if (!expected) return "unconfigured";
    const presented = bearer(header);
    if (presented === null || !sameToken(expected, presented)) return "unauthorized";
    return "ok";
  }

  tick(): void {
    try {
      this.tickInner();
    } catch (error) {
      this.log(`fleet tick failed: ${safeError(error instanceof Error ? error.message : "failed")}`);
    }
  }

  async accept(items: unknown[]): Promise<{ accepted: number; rejected: { index: number; error: string }[] }> {
    const rejected: { index: number; error: string }[] = [];
    const decisions: FleetDecision[] = [];
    let accepted = 0;
    for (let index = 0; index < items.length; index += 1) {
      const parsed = parsePacket(items[index]);
      if (!parsed.ok) {
        rejected.push({ index, error: parsed.error });
        continue;
      }
      try {
        decisions.push(...await this.take(parsed.packet));
        accepted += 1;
      } catch {
        rejected.push({ index, error: "ingest failed" });
      }
    }
    void this.dispatchDecisions(decisions).catch((error: unknown) => {
      this.log(`fleet dispatch failed: ${safeError(error instanceof Error ? error.message : "failed")}`);
    });
    return { accepted, rejected };
  }

  async handleAction(incidentId: number, action: "investigate" | "snooze" | "mute", actor?: string): Promise<{ ok: boolean; error: string | null; reference?: string | null }> {
    const incident = incidentById(this.db, incidentId);
    if (!incident) return { ok: false, error: "not found" };
    const now = this.now().toISOString();
    if (action === "investigate") {
      const investigator = this.currentInvestigator();
      if (!investigator) return { ok: false, error: "no investigator configured" };
      const result = await investigator.investigate(incident, incident.packet);
      this.record(incidentId, "investigate", result.ok ? (result.reference ?? "") : safeError(result.error ?? "failed"));
      return { ok: result.ok, error: result.error, reference: result.reference };
    }
    if (action === "snooze") {
      snooze(this.db, incidentId, new Date(this.now().getTime() + 60 * 60_000).toISOString(), now);
      return { ok: true, error: null };
    }
    muteRule(this.db, ruleKey(incident.host, incident.component, incident.failureClass), actor === undefined ? "muted from channel" : `muted from channel by ${actor}`, now);
    return { ok: true, error: null };
  }

  async investigateHttp(id: number): Promise<{ status: number; body: unknown }> {
    const incident = incidentById(this.db, id);
    if (!incident) return { status: 404, body: { error: "not found" } };
    const investigator = this.currentInvestigator();
    if (!investigator) return { status: 501, body: { error: "no investigator configured" } };
    const result = await investigator.investigate(incident, incident.packet);
    this.record(id, "investigate", result.ok ? (result.reference ?? "") : safeError(result.error ?? "failed"));
    return { status: 200, body: result };
  }

  incidents(filter: { state?: "open" | "acknowledged" | "resolved"; host?: string; failureClass?: string; limit?: number }): FleetIncident[] {
    return listIncidents(this.db, filter);
  }

  ack(id: number): FleetIncident | null {
    return acknowledge(this.db, id, this.now().toISOString());
  }

  snoozeFor(id: number, minutes: number): FleetIncident | null {
    const now = this.now();
    return snooze(this.db, id, new Date(now.getTime() + minutes * 60_000).toISOString(), now.toISOString());
  }

  muteIncident(id: number, reason: string): { incident: FleetIncident; ruleKey: string } | null {
    const existing = incidentById(this.db, id);
    if (!existing) return null;
    const key = ruleKey(existing.host, existing.component, existing.failureClass);
    const now = this.now().toISOString();
    muteRule(this.db, key, reason, now);
    const incident = incidentById(this.db, id);
    if (!incident) return null;
    return { incident, ruleKey: key };
  }

  private currentInvestigator(): FleetInvestigator | undefined {
    if (this.investigator) return this.investigator;
    const config = this.config().investigator;
    return config ? commandInvestigator({ command: config.command, run: this.runCapture }) : undefined;
  }

  private currentTriage(): FleetTriage | undefined {
    if (this.triage) return this.triage;
    const config = this.config().triage;
    if (!config) {
      this.configuredTriage = undefined;
      return undefined;
    }
    const key = JSON.stringify(config.command);
    if (this.configuredTriage?.key !== key) this.configuredTriage = { key, triage: commandTriage({ command: config.command, run: this.runCapture, now: this.now }) };
    return this.configuredTriage.triage;
  }

  private tickInner(): void {
    const file = this.config();
    const nowDate = this.now();
    const now = nowDate.toISOString();
    const policy = resolvePolicy(file.policy);
    const decisions: FleetDecision[] = [...sweepEscalations(this.db, now, file.policy)];
    const lastSeen = new Map<string, string | null>();
    for (const row of file.expected) {
      const meta = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(heartbeatMetaKey(row.host, row.component)) as { value: string } | undefined;
      lastSeen.set(expectedKey(row.host, row.component), meta?.value ?? null);
    }
    const due = expectedPackets(file.expected, lastSeen, now);
    const keep = new Set(due.map((packet) => packet.fingerprint));
    for (const packet of due) decisions.push(...ingest(this.db, packet, now, file.policy));
    const watched = new Set(file.expected.map((row) => expectedKey(row.host, row.component)));
    if (watched.size > 0) {
      for (const state of ["open", "acknowledged"] as const) {
        for (const incident of listIncidents(this.db, { state, limit: 500 })) {
          if (!watched.has(expectedKey(incident.host, incident.component))) continue;
          decisions.push(...this.recoverOne(incident, now, keep));
        }
      }
    }
    const quiet = inQuietHours(nowDate, policy.quietHours);
    const outbound: Outbound[] = [];
    if (this.wasQuiet === true && !quiet) outbound.push(...this.digestOutbound(digest(this.db, now, file.policy)));
    this.wasQuiet = quiet;
    const slot = clock(nowDate);
    if (file.digestTimes.includes(slot.hm)) {
      const key = `${slot.day} ${slot.hm}`;
      if (key !== this.digestSlot) {
        this.digestSlot = key;
        outbound.push(...this.digestOutbound(digest(this.db, now, file.policy)));
      }
    }
    void this.dispatchDecisions(decisions, outbound).catch((error: unknown) => {
      this.log(`fleet dispatch failed: ${safeError(error instanceof Error ? error.message : "failed")}`);
    });
  }

  private async take(packet: IncidentPacket): Promise<FleetDecision[]> {
    const file = this.config();
    const now = this.now().toISOString();
    if (packet.evidence.snapshot?.heartbeat === true) {
      ingest(this.db, packet, now, file.policy);
      return this.recoverHost(packet.host, packet.component, now, new Set());
    }
    let next = packet;
    let cause: string | undefined;
    const triage = this.currentTriage();
    if (triage) {
      const result = await triage.classify(packet);
      if (result.noise) {
        const key = triageKey(packet);
        const cached = TRIAGE_CACHES.get(triage)?.get(key);
        if (cached ? !cached.noiseRecorded : (this.triageNoise.get(key) ?? 0) <= this.now().getTime()) {
          this.record(null, "triage-noise", `${packet.host} ${packet.component}: ${result.cause ?? ""}`);
          if (cached) cached.noiseRecorded = true;
          else {
            this.triageNoise.delete(key);
            this.triageNoise.set(key, this.now().getTime() + 6 * 60 * 60_000);
            if (this.triageNoise.size > 500) this.triageNoise.delete(this.triageNoise.keys().next().value!);
          }
        }
        return [];
      }
      cause = result.cause?.slice(0, 300);
      if (result.failureClass && CLASSES.has(result.failureClass) && result.failureClass !== next.failureClass) {
        next = { ...next, failureClass: result.failureClass, fingerprint: fingerprint(next.host, next.component, result.failureClass) };
      }
      if (result.severity && SEVERITY_SET.has(result.severity)) next = { ...next, severity: result.severity };
      if (typeof result.ownerChat === "string" && result.ownerChat.length > 0 && result.ownerChat.length <= 200) next = { ...next, ownerChat: result.ownerChat };
    }
    const decisions = ingest(this.db, next, now, file.policy);
    if (cause) {
      const incident = incidentByFingerprint(this.db, next.fingerprint);
      if (incident && !this.db.prepare("SELECT 1 FROM fleet_events WHERE incident_id = ? AND kind = 'triage' AND detail = ?").get(incident.id, cause)) this.record(incident.id, "triage", cause);
    }
    return decisions;
  }

  private recoverHost(host: string, component: string, now: string, keep: ReadonlySet<string>): FleetDecision[] {
    const decisions: FleetDecision[] = [];
    for (const state of ["open", "acknowledged"] as const) {
      for (const incident of listIncidents(this.db, { state, host, limit: 500 })) {
        if (incident.component !== component) continue;
        decisions.push(...this.recoverOne(incident, now, keep));
      }
    }
    return decisions;
  }

  private recoverOne(incident: FleetIncident, now: string, keep: ReadonlySet<string>): FleetDecision[] {
    if (incident.failureClass !== "never-ran" && incident.failureClass !== "wedged") return [];
    if (keep.has(incident.fingerprint)) return [];
    const packet: IncidentPacket = { ...incident.packet, recovered: true, lastSeen: now };
    return ingest(this.db, packet, now, this.config().policy);
  }

  private digestOutbound(built: ReturnType<typeof digest>): Outbound[] {
    if (built.groups.length === 0) return [];
    const lines = built.groups.map((group) => {
      const items = group.incidents.map((incident) => `- ${incident.component}: ${incident.summary}`).join("\n");
      return `${group.host} (${group.count})\n${items}`;
    });
    let severity: Severity = "info";
    for (const group of built.groups) {
      for (const incident of group.incidents) {
        if (incident.severity === "critical") severity = "critical";
        else if (incident.severity === "warning" && severity === "info") severity = "warning";
      }
    }
    return [{
      incidentId: null,
      notice: { title: "fleet digest", body: lines.join("\n").slice(0, 4000), severity, incidentId: null, kind: "digest", actions: [] },
    }];
  }

  private noticeFor(decision: FleetDecision): Outbound | null {
    if (decision.kind === "digest") return null;
    if (decision.kind === "suppressed" && decision.reason !== "flapping") return null;
    const incident = decision.incident;
    const kind = decision.kind === "notify-now" ? "incident" : decision.kind === "escalate" ? "escalation" : decision.kind === "recovered" ? "recovered" : "flapping";
    const prefix = kind === "incident" ? incident.severity : kind === "escalation" ? "escalate" : kind;
    return {
      incidentId: incident.id,
      notice: {
        title: `${prefix}: ${incident.host} ${incident.component}`.slice(0, 200),
        body: incident.summary,
        severity: incident.severity,
        incidentId: incident.id,
        kind,
        actions: kind === "recovered" || kind === "flapping" ? [] : ACTIONS,
      },
    };
  }

  private notifiers(): FleetNotifier[] {
    const built: FleetNotifier[] = [];
    for (const row of this.config().notifiers) {
      if (row.type === "webhook") built.push(webhookNotifier({ id: row.id, url: () => row.url(), ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}) }));
      else if (row.type === "command" && row.command) built.push(commandNotifier({ id: row.id, command: row.command, run: this.run }));
      else if (row.type === "desktop") built.push(desktopNotifier({ id: row.id, ...(this.desktop ? { desktop: this.desktop } : {}) }));
    }
    return built;
  }

  private async dispatchDecisions(decisions: FleetDecision[], extra: Outbound[] = []): Promise<void> {
    const outbound: Outbound[] = [...extra];
    for (const decision of decisions) {
      const notice = this.noticeFor(decision);
      if (notice) outbound.push(notice);
    }
    await Promise.allSettled(outbound.map((item) => this.sendNotice(item, true)));
    for (const decision of decisions) {
      if (decision.kind !== "notify-now" && decision.kind !== "escalate") continue;
      void this.heal(decision.incident.id).catch((error: unknown) => {
        this.log(`fleet heal failed: ${safeError(error instanceof Error ? error.message : "failed")}`);
      });
    }
  }

  private async heal(incidentId: number): Promise<void> {
    if (this.healing.has(incidentId)) return;
    const incident = incidentById(this.db, incidentId);
    if (!incident || incident.state !== "open") return;
    const healer = this.config().healers.find((row) => row.host === incident.host && row.component === incident.component && row.failureClass === incident.failureClass);
    if (!healer) return;
    const now = this.now();
    const key = `${ruleKey(incident.host, incident.component, incident.failureClass)} `;
    const attempts = this.db.prepare("SELECT at FROM fleet_events WHERE kind IN ('heal', 'heal-failed') AND instr(detail, ?) = 1 AND at > ? ORDER BY at DESC").all(key, new Date(now.getTime() - 24 * 60 * 60_000).toISOString()) as { at: string }[];
    if (attempts.length >= healer.maxPerDay) {
      const day = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
      if (!this.db.prepare("SELECT 1 FROM fleet_events WHERE incident_id = ? AND kind = 'heal-skipped' AND at >= ?").get(incidentId, day)) this.record(incidentId, "heal-skipped", `${key}daily limit`);
      return;
    }
    if (attempts[0] && now.getTime() - Date.parse(attempts[0].at) < healer.cooldownMinutes * 60_000) return;
    this.healing.add(incidentId);
    try {
      this.record(incidentId, "heal-start", `${key}${healer.id}`);
      const { id, host, component, failureClass, severity, state, firstSeen, lastSeen, count, packet } = incident;
      let ok = false;
      let error: string | null = null;
      try {
        const [program, ...args] = healer.command;
        if (!program) throw new Error("command is empty");
        const result = await this.runCapture(program, args, JSON.stringify({ incident: { id, host, component, failureClass, severity, state, firstSeen, lastSeen, count }, packet }), healer.timeoutSeconds * 1000);
        if (result.error || result.code !== 0) throw new Error(result.error ?? `exit ${result.code ?? "null"}`);
        const last = result.stdout.split(/\r?\n/).filter((line) => line.trim().length > 0).at(-1) ?? "";
        let parsed: unknown;
        try { parsed = JSON.parse(last); } catch { ok = true; }
        if (!ok) {
          if (!parsed || typeof parsed !== "object" || !("ok" in parsed) || typeof parsed.ok !== "boolean") throw new Error("invalid healer response");
          ok = parsed.ok;
          if (!ok) error = "error" in parsed && typeof parsed.error === "string" ? parsed.error : "heal failed";
        }
      } catch (caught) {
        error = caught instanceof Error ? caught.message : "heal failed";
      }
      error = error === null ? null : safeError(error);
      this.record(incidentId, ok ? "heal" : "heal-failed", `${key}${ok ? healer.id : error}`);
      await this.sendNotice({ incidentId, notice: {
        title: `${ok ? "healed attempt" : "heal failed"}: ${host} ${component}`.slice(0, 200),
        body: ok ? "The heal command completed. The next check will determine recovery." : error ?? "heal failed",
        severity: ok ? "info" : "warning",
        incidentId,
        kind: ok ? "healed" : "heal-failed",
        actions: ok ? [] : ACTIONS,
      } }, true);
    } finally {
      this.healing.delete(incidentId);
    }
  }

  private async sendNotice(outbound: Outbound, retry: boolean): Promise<void> {
    const targets = this.notifiers();
    await Promise.allSettled(targets.map(async (notifier) => {
      const result = await notifier.send(outbound.notice);
      if (result.ok) {
        this.record(outbound.incidentId, "delivered", notifier.id);
        return;
      }
      const error = safeError(result.error ?? "failed");
      this.record(outbound.incidentId, "delivery-failed", `${notifier.id}: ${error}`);
      this.log(`fleet notice not delivered (${notifier.id}): ${error}`);
      if (!retry) return;
      const handle = this.later(() => {
        void this.sendNotice(outbound, false);
      }, RETRY_MS);
      this.retries.push(handle);
    }));
  }

  private record(incidentId: number | null, kind: string, detail: string): void {
    this.db.prepare("INSERT INTO fleet_events (incident_id, at, kind, detail) VALUES (?, ?, ?, ?)").run(incidentId, this.now().toISOString(), kind, detail.slice(0, 500));
  }
}

export async function fleetActions(service: FleetService, req: IncomingMessage, res: ServerResponse, json: SendJson): Promise<void> {
  if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
  const auth = service.authorize(req.headers.authorization);
  if (auth === "unconfigured") return json(res, 503, { error: "ingest token is not configured" });
  if (auth !== "ok") return json(res, 401, { error: "unauthorized" });
  const body = await readLimited(req, 4096);
  if (!body.ok) return json(res, body.status, { error: body.error });
  if (Buffer.byteLength(body.raw, "utf8") > 4096) return json(res, 413, { error: "body too large" });
  let parsed: unknown;
  try { parsed = JSON.parse(body.raw); } catch { return json(res, 400, { error: "invalid json" }); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json(res, 400, { error: "body must be an object" });
  const { incidentId, action, actor } = parsed as Record<string, unknown>;
  if (typeof incidentId !== "number" || !Number.isSafeInteger(incidentId) || incidentId <= 0) return json(res, 400, { error: "incidentId must be a positive safe integer" });
  if (action !== "investigate" && action !== "snooze" && action !== "mute") return json(res, 400, { error: "action is invalid" });
  if (actor !== undefined && (typeof actor !== "string" || /^[A-Za-z0-9 _.-]{1,40}$/.exec(actor)?.[0] !== actor)) return json(res, 400, { error: "actor is invalid" });
  const result = await service.handleAction(incidentId, action, actor ?? "api");
  const reference = result.reference?.trim().slice(0, 120);
  const message = result.ok
    ? action === "investigate" ? reference ? `Investigation started: ${reference}` : "Investigation started." : action === "snooze" ? "Snoozed for an hour." : "Muted this rule."
    : result.error ?? "failed";
  return json(res, 200, { ok: result.ok, message });
}

export async function fleetPackets(service: FleetService, req: IncomingMessage, res: ServerResponse, json: SendJson): Promise<void> {
  const auth = service.authorize(req.headers.authorization);
  if (auth === "unconfigured") return json(res, 503, { error: "ingest token is not configured" });
  if (auth !== "ok") return json(res, 401, { error: "unauthorized" });
  const body = await readLimited(req, PACKET_LIMIT);
  if (!body.ok) return json(res, body.status, { error: body.error });
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.raw);
  } catch {
    return json(res, 400, { error: "invalid json" });
  }
  if (Array.isArray(parsed)) {
    if (parsed.length > 100) return json(res, 400, { error: "at most 100 packets" });
    return json(res, 200, await service.accept(parsed));
  }
  if (!parsed || typeof parsed !== "object") return json(res, 400, { error: "body must be a packet or an array" });
  return json(res, 200, await service.accept([parsed]));
}

export async function fleetApi(service: FleetService, req: IncomingMessage, url: URL, res: ServerResponse, hostAllowed: (host: string | undefined) => boolean, json: SendJson): Promise<void> {
  if (url.pathname === "/api/fleet/incidents") {
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method not allowed" });
    const state = url.searchParams.get("state");
    const host = url.searchParams.get("host");
    const failureClass = url.searchParams.get("class");
    const limitRaw = url.searchParams.get("limit");
    if (state !== null && state !== "open" && state !== "acknowledged" && state !== "resolved") return json(res, 400, { error: "state is invalid" });
    if (host !== null && (host.length === 0 || host.length > 200)) return json(res, 400, { error: "host is invalid" });
    if (failureClass !== null && !CLASSES.has(failureClass)) return json(res, 400, { error: "class is invalid" });
    let limit = 50;
    if (limitRaw !== null) {
      if (!/^\d+$/.test(limitRaw)) return json(res, 400, { error: "limit must be a whole number from 1 to 200" });
      limit = Number(limitRaw);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) return json(res, 400, { error: "limit must be a whole number from 1 to 200" });
    }
    const incidents = service.incidents({
      ...(state ? { state } : {}),
      ...(host ? { host } : {}),
      ...(failureClass ? { failureClass: failureClass as FailureClass } : {}),
      limit,
    });
    return json(res, 200, { incidents });
  }
  const match = /^\/api\/fleet\/incidents\/(\d+)\/(ack|snooze|mute|investigate)$/.exec(url.pathname);
  if (!match || !match[1] || !match[2]) return json(res, 404, { error: "no such route" });
  if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
  const id = Number(match[1]);
  if (!Number.isSafeInteger(id) || id <= 0) return json(res, 404, { error: "not found" });
  if (match[2] === "investigate") {
    const result = await service.investigateHttp(id);
    return json(res, result.status, result.body);
  }
  const body = await readJson(req, res, hostAllowed, json);
  if (!body) return;
  if (match[2] === "ack") {
    const incident = service.ack(id);
    return incident ? json(res, 200, { incident }) : json(res, 404, { error: "not found" });
  }
  if (match[2] === "snooze") {
    const minutes = body.minutes;
    if (typeof minutes !== "number" || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 10080) return json(res, 400, { error: "minutes must be a whole number from 1 to 10080" });
    const incident = service.snoozeFor(id, minutes);
    return incident ? json(res, 200, { incident }) : json(res, 404, { error: "not found" });
  }
  const reason = body.reason;
  if (typeof reason !== "string" || reason.trim().length === 0 || reason.trim().length > 500) return json(res, 400, { error: "reason is required" });
  const muted = service.muteIncident(id, reason.trim());
  return muted ? json(res, 200, muted) : json(res, 404, { error: "not found" });
}
