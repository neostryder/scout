import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname } from "node:path";
import { openCatalog } from "../../core/src/db.ts";
import { filtersApi } from "../../hub/src/filters-api.ts";
import { isLoopbackHost } from "../../hub/src/server.ts";

type Row = Record<string, any>;
const machines = ["hub", "laptop", "server", "mini"];
const ecosystems = ["winget", "brew", "npm", "cask", "pipx"];
const categories = ["editor", "browser", "build tool", "media", "terminal", "database", "system utility"];
const publishers = ["Northstar", "Open Tools", "Acme", "Community"];
const names = ["Orion Editor", "Atlas Browser", "Comet CLI", "River Player", "Cedar DB", "Maple Tools", "Nimbus Studio", "Quartz Shell"];
const daysAgo = (days: number) => new Date(Date.now() - days * 86400000).toISOString();
export const installs: Row[] = Array.from({ length: 300 }, (_, index) => {
  const id = index + 1;
  const ecosystem = ecosystems[index % ecosystems.length]!;
  const machineId = machines[index % machines.length]!;
  const name = `${names[index % names.length]} ${Math.floor(index / names.length) + 1}`;
  const installed = `1.${index % 8}.${index % 6}`;
  const jump = index % 4;
  const available = jump === 0 ? `2.${index % 8}.${index % 6}` : jump === 1 ? `1.${index % 8 + 1}.${index % 6}` : jump === 2 ? `1.${index % 8}.${index % 6 + 1}` : installed;
  const blockedBy = index % 19 === 0 ? "Frozen by policy" : null;
  const updatable = available !== installed && !blockedBy && index % 17 !== 0;
  const upstream = index % 9 === 0 ? "3.0.0" : null;
  const beta = index % 13 === 0 ? "4.0.0-beta" : null;
  const advisoryOnly = index % 17 === 0;
  const statuses = [updatable && "updatable", blockedBy && "blocked", upstream && "upstream", advisoryOnly && "advisory", available === installed && "current"].filter(Boolean);
  const lastUsed = index % 11 === 0 ? null : daysAgo(index % 120);
  const risk = updatable || upstream ? id === 7 ? { hard: 1, soft: 0 } : id === 3 ? { hard: 0, soft: 2 } : { hard: 0, soft: 0 } : null;
  return { installId: id, machineId, ecosystem, sourceKind: ecosystem, availableSource: ecosystem, key: `tool-${id}`, name, description: `${name} helps with ${categories[index % categories.length]}.`, publisher: publishers[index % publishers.length], category: categories[index % categories.length], kind: index % 5 === 0 ? "app" : "package", location: `C:/Tools/${ecosystem}/tool-${id}`, sourceRoot: `C:/Tools/${ecosystem}`, scope: index % 2 ? "user" : "machine", descriptionSource: index % 3 ? "source" : "generated", categorySource: "source", version: installed, installed, available, upstream, beta, blockedBy, updatable, advisoryOnly, statuses, risk, bump: available === installed ? null : jump === 0 ? "major" : jump === 1 ? "minor" : "patch", checkedAt: daysAgo(index % 20), firstSeen: daysAgo(300 - index % 200), lastSeen: daysAgo(index % 10), lastUsed, useCount: index % 11 === 0 ? 0 : index % 50, neverUsed: index % 11 === 0, unknownUse: index % 23 === 0, running: index % 17 === 0, autostart: index % 31 === 0, ai: index % 7 === 0, constrained: !!blockedBy, homepage: index % 6 ? `https://example.com/tool-${id}` : null, downloadUrl: !updatable && !blockedBy && (upstream || advisoryOnly) ? `https://example.com/tool-${id}` : null, hasDescription: true, presence: index % 4 === 0 ? "one" : "some", job: null };
});
export const proposals = Array.from({ length: 12 }, (_, index) => ({ id: index + 1, rule: "Matching product name", packages: [installs[index]!, installs[index + 12]!].map((r) => ({ name: r.name, description: r.description, ecosystem: r.ecosystem, key: r.key, publisher: r.publisher, installs: [r] })) }));
const updateDims = ["machine", "ecosystem", "source", "status", "bump", "category", "publisher"];
const catalogDims = ["machine", "source", "kind", "ecosystem", "category", "publisher", "scope", "descriptionSource"];
const field: Record<string, string> = { machine: "machineId", source: "sourceKind", status: "statuses", installed: "installed", path: "location", checked: "checkedAt" };
const get = (row: Row, key: string) => row[field[key] || key];
const list = (query: URLSearchParams, key: string) => (query.get(key) || "").split(",").filter(Boolean);
function versionCompare(a: string, b: string) { const aa = (a || "").match(/\d+/g)?.map(Number) || []; const bb = (b || "").match(/\d+/g)?.map(Number) || []; for (let i = 0; i < Math.max(aa.length, bb.length); i++) if ((aa[i] || 0) !== (bb[i] || 0)) return (aa[i] || 0) - (bb[i] || 0); return a.localeCompare(b); }
function compare(a: Row, b: Row, key: string, dir: string) {
  const order = key === "status" ? ["updatable", "blocked", "upstream", "advisory", "current"] : key === "bump" ? ["major", "minor", "patch", "other", null] : null;
  const av = key === "status" ? a.statuses[0] || "current" : get(a, key);
  const bv = key === "status" ? b.statuses[0] || "current" : get(b, key);
  const primary = order ? order.indexOf(av) - order.indexOf(bv) : ["installed", "available", "version"].includes(key) ? versionCompare(av || "", bv || "") : typeof av === "number" ? av - bv : String(av ?? "").localeCompare(String(bv ?? ""), undefined, { sensitivity: "base" });
  return primary ? primary * (dir === "desc" ? -1 : 1) : a.name.localeCompare(b.name) || a.machineId.localeCompare(b.machineId);
}
const autoRun = { enabled: false, lastWindowStart: null as string | null, lastQueued: 0, lastRunAt: null as string | null };
export function updateWindows() {
  const now = new Date();
  const start = new Date(now); start.setHours(3, 30, 0, 0); if (start.getTime() <= now.getTime()) start.setDate(start.getDate() + 1);
  const quiet = { startMinute: 210, lengthMinutes: 120, startsAt: start.toISOString(), endsAt: new Date(start.getTime() + 7_200_000).toISOString(), inWindow: false };
  const item = (row: Row) => ({ installId: row.installId, name: row.name, ecosystem: row.ecosystem, from: row.installed, to: row.available, bump: row.bump, running: row.running, warnings: [] as string[] });
  return { generatedAt: now.toISOString(), quiet, autoRun: { ...autoRun }, machines: machines.map((machineId) => {
    const rows = installs.filter((row) => row.machineId === machineId && row.updatable);
    const disruptive = (row: Row) => row.kind === "app" || row.running;
    return {
      machineId,
      now: rows.filter((row) => !disruptive(row)).slice(0, 4).map(item),
      atQuietHour: rows.filter(disruptive).slice(0, 3).map(item),
      held: installs.filter((row) => row.machineId === machineId && row.blockedBy).slice(0, 2).map((row) => ({ ...item(row), kind: "blocked", reason: row.blockedBy })),
    };
  }) };
}
export function queryRows(kind: "updates" | "installs", query: URLSearchParams, skip = "") {
  const dimensions = kind === "updates" ? updateDims : catalogDims;
  let rows = installs.filter((row) => {
    if (kind === "updates" && query.get("safe") === "1" && row.risk?.hard > 0) return false;
    if (kind === "updates" && skip !== "status" && !query.has("status") && !row.statuses.some((s: string) => s !== "current")) return false;
    for (const dim of dimensions) {
      if (dim === skip) continue;
      const selected = list(query, dim);
      if (selected.length && !(Array.isArray(get(row, dim)) ? get(row, dim).some((v: string) => selected.includes(v)) : selected.includes(String(get(row, dim))))) return false;
    }
    const terms = (query.get("q") || "").toLowerCase().split(/\s+/).filter(Boolean);
    const haystack = [row.name, row.key, row.description, row.publisher, row.machineId, row.ecosystem, row.category, ...(kind === "installs" ? [row.location] : [])].join(" ").toLowerCase();
    if (!terms.every((term) => haystack.includes(term))) return false;
    for (const flag of ["hasBeta", "hasUpstream", "running", "neverUsed", "unknownUse", "autostart", "ai", "constrained"]) if (query.get(flag) === "1" && !(flag === "hasBeta" ? row.beta : flag === "hasUpstream" ? row.upstream : row[flag])) return false;
    for (const flag of ["versionKnown", "hasHomepage", "hasDescription"]) if (query.has(flag) && query.get(flag) !== "" && !!(flag === "versionKnown" ? row.version : flag === "hasHomepage" ? row.homepage : row.description) !== (query.get(flag) === "1")) return false;
    if (query.get("path") && !row.location.startsWith(query.get("path"))) return false;
    if (query.get("presence") && row.presence !== query.get("presence")) return false;
    if (query.get("usedWithinDays") && (!row.lastUsed || Date.parse(row.lastUsed) < Date.now() - Number(query.get("usedWithinDays")) * 86400000)) return false;
    for (const [key, prop, op] of [["seenBefore", "lastSeen", -1], ["seenSince", "lastSeen", 1], ["installedBefore", "firstSeen", -1], ["newSince", "firstSeen", 1]] as const) if (query.get(key) && (op < 0 ? row[prop] > query.get(key)! : row[prop] < query.get(key)!)) return false;
    return true;
  });
  const sort = query.get("sort") || "name";
  const dir = query.get("dir") || (["lastUsed", "checked", "firstSeen", "lastSeen", "useCount", "bump"].includes(sort) ? "desc" : "asc");
  rows = rows.sort((a, b) => compare(a, b, sort, dir));
  return rows;
}
export function listResponse(kind: "updates" | "installs", query: URLSearchParams) {
  const rows = queryRows(kind, query);
  const dimensions = kind === "updates" ? updateDims : catalogDims;
  const facets = Object.fromEntries(dimensions.map((dim) => {
    const counts = new Map<string, number>();
    for (const row of queryRows(kind, query, dim)) for (const val of (Array.isArray(get(row, dim)) ? get(row, dim) : [get(row, dim)])) counts.set(String(val ?? "(none)"), (counts.get(String(val ?? "(none)")) || 0) + 1);
    return [dim, [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))];
  }));
  const offset = Math.max(0, Number(query.get("offset")) || 0);
  const limit = Math.min(1000, Math.max(1, Number(query.get("limit")) || 200));
  return { total: rows.length, updatable: rows.filter((r) => r.updatable).length, rows: rows.slice(offset, offset + limit), facets };
}
type Job = Row;
export const jobs: Job[] = [];
let nextJob = 1;
function dependencyInstall(row: Row) { return { id: row.installId, ecosystem: row.ecosystem, key: row.key, name: row.name, machine: row.machineId, version: row.installed }; }
function dependencyDetails(row: Row) {
  const runtime = { id: 1, from: dependencyInstall(installs[6]!), to: { id: null, ecosystem: "brew", key: "llhttp", name: "llhttp", version: null }, kind: "library", constraint: null, builtAgainst: "9.4.3", source: "brew-deps", evidence: "Installed Homebrew library", observedAt: daysAgo(1) };
  const dependent = { ...runtime, id: 2, from: dependencyInstall(installs[10]!), to: { id: 7, ecosystem: "brew", key: installs[6]!.key, name: installs[6]!.name, version: installs[6]!.installed }, builtAgainst: installs[6]!.installed };
  return { dependencies: { needs: row.installId === 7 ? [runtime] : row.installId === 11 ? [dependent] : [], neededBy: row.installId === 7 ? [dependent] : [] }, supportWindows: row.installId === 7 ? [{ cycle: "1", eol: "2025-12-31", eolPassed: true, latest: "1.0.0", lts: false, observedAt: daysAgo(1) }, { cycle: "2", eol: null, eolPassed: false, latest: "2.0.0", lts: true, observedAt: daysAgo(1) }] : [], changelog: row.installId === 7 ? { summary: "This release fixes parsing errors and updates the library interface.", sourceUrl: "https://example.com/releases/tool-7", model: "fixture-summary", createdAt: daysAgo(1) } : null };
}
function plan(id: number, alsoInstallIds: number[] = []) {
  const row = installs.find((r) => r.installId === id);
  const breaks: { hard: Row[]; soft: Row[] } = { hard: [], soft: [] };
  if (!row) return { installId: id, allowed: false, refusal: "Install not found", breaks, softConfirmation: null };
  if (row.risk?.hard > 0 && !alsoInstallIds.some((otherId) => otherId === 11 && installs.find((other) => other.installId === otherId)?.machineId === row.machineId)) breaks.hard.push({ dependent: dependencyInstall(installs[10]!), kind: "library", constraint: null, reason: `${installs[10]!.name} was built against ${row.name} ${row.installed}, which differs from ${row.available}.` });
  if (row.risk?.soft > 0) for (const dependent of [installs[6]!, installs[14]!]) breaks.soft.push({ dependent: dependencyInstall(dependent), kind: "runtime", constraint: "unreadable range", reason: "The runtime requirement could not be read." });
  const softConfirmation = breaks.soft.length ? { projects: ["C:/Projects/cedar"], dependents: breaks.soft.map((entry) => entry.dependent.name) } : null;
  const refusal = row.blockedBy ? `Blocked: ${row.blockedBy}` : !row.updatable ? "No installable update" : breaks.hard.length ? `Updating would break ${breaks.hard.map((entry) => entry.dependent.name).join(", ")}` : null;
  return { installId: id, machineId: row.machineId, name: row.name, ecosystem: row.ecosystem, from: row.installed, to: row.available, command: `${row.ecosystem} upgrade ${row.key}`, disruptive: row.kind === "app" || row.running, needsAdmin: false, running: row.running, warnings: row.running ? ["The app is running."] : [], allowed: !refusal, refusal, breaks, softConfirmation };
}
function downloadPlan(id: number) {
  const row = installs.find((r) => r.installId === id);
  if (!row) return null;
  const extension = row.machineId === "hub" ? ".exe" : ".dmg";
  const file = row.downloadUrl && row.installId % 2 === 0;
  return { installId: id, machineId: row.machineId, name: row.name, kind: file ? "file" : row.downloadUrl ? "page" : "none", url: file ? `https://example.com/tool-${id}${extension}` : row.downloadUrl, fileName: file ? `tool-${id}${extension}` : null, size: file ? 123456 : null, sha256: null, source: file ? "github" : null, folder: row.machineId === "hub" ? "User Downloads" : "~/Downloads", warnings: file ? ["No checksum is available."] : [], allowed: !!file && !row.blockedBy, refusal: row.blockedBy || (!file ? "No exact file is available" : null) };
}
/** Multiplies the mock job pauses so a person can watch the stages; tests leave it at 1. */
export const mockTiming = { scale: 1 };
function runJob(job: Job) {
  if (job.state !== "queued") return;
  if (jobs.some((j) => j !== job && j.machineId === job.machineId && ["preflight", "running"].includes(j.state))) { setTimeout(() => runJob(job), 100); return; }
  job.state = "preflight"; job.startedAt = new Date().toISOString(); job.steps.push({ seq: 1, name: job.action === "download" ? "resolve" : "preflight", state: "running", output: "", at: job.startedAt });
  setTimeout(() => {
    if (job.state === "stopped") return;
    job.steps[0].state = "done"; job.state = "running"; job.steps.push({ seq: 2, name: job.action === "download" ? "download" : "update", state: "running", output: "", at: new Date().toISOString() });
    if (job.action !== "download") {
      // A winget-like update: the stages arrive in order, and an install can wait on the Windows prompt.
      job.ecosystem = "winget"; job.phase = "download"; job.phaseAt = new Date().toISOString();
      setTimeout(() => { if (job.state === "running") { job.phase = "verify"; job.phaseAt = new Date().toISOString(); } }, 120 * mockTiming.scale);
      setTimeout(() => { if (job.state === "running") { job.phase = "install"; job.phaseAt = new Date().toISOString(); if (job.installId % 2 === 0) job.attention = { kind: "uac", detail: null, since: new Date().toISOString() }; } }, 240 * mockTiming.scale);
    }
    setTimeout(() => {
      if (job.state === "stopped") return;
      const failure = job.installId === 29;
      job.attention = null;
      job.steps[1].state = failure ? "failed" : "done"; job.steps[1].output = failure ? "Mock update failed." : "Update complete.";
      if (failure) { job.state = "failed"; job.message = "Mock update failed"; job.finishedAt = new Date().toISOString(); for (const next of jobs) if (next.batchId === job.batchId && next.state === "queued") { next.state = "stopped"; next.message = "stopped: an earlier update in this batch failed"; } return; }
      job.steps.push({ seq: 3, name: "verify", state: "running", output: "", at: new Date().toISOString() });
      setTimeout(() => { if (job.state === "stopped") return; job.steps[2].state = "done"; job.state = "done"; job.finishedAt = new Date().toISOString(); if (job.action === "download") { job.finalPath = `${job.machineId === "hub" ? "C:/Users/fixture/Downloads" : "~/Downloads"}/${job.download.fileName}`; job.steps[2].output = `${job.finalPath}\nunverified`; return; } job.steps[2].output = "Installed version verified."; const row = installs.find((r) => r.installId === job.installId)!; row.installed = row.available; row.version = row.available; row.updatable = false; row.bump = null; row.statuses = ["current"]; }, 350 * mockTiming.scale);
    }, 350 * mockTiming.scale);
  }, 350 * mockTiming.scale);
}
function json(res: import("node:http").ServerResponse, status: number, data: unknown) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); }
const publicDir = resolve(fileURLToPath(new URL("../public/", import.meta.url)));
export function createMockHub(options: { noModels?: boolean; controlOff?: boolean; recipesMissing?: boolean; portsMissing?: boolean; stacksMissing?: boolean; portsEmpty?: boolean; stacksEmpty?: boolean; planRefusal?: boolean; alertsMissing?: boolean; healthMissing?: boolean; noHealth?: boolean; healthRefreshStatus?: 404 | 409; alertScenario?: "zero" | "one" | "high"; runStatus?: 404 | 409; runScenario?: "done" | "failed" | "graceful-not-stopped" | "declined" } = {}) {
  const filtersDb = openCatalog(":memory:");
  const discoveryMock = createDiscoveryMock();
  const servicesMock = createServicesMock(options);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1:4871");
    const path = url.pathname;
    if (await servicesMock.route(req, res, url)) return;
    if (await discoveryMock(req, res, path)) return;
    if (path === "/api/filters" || path.startsWith("/api/filters/")) {
      if (!isLoopbackHost(req.headers.host)) return json(res, 421, { error: "misdirected request" });
      return filtersApi(filtersDb, req, url, res, isLoopbackHost, json);
    }
    if (path === "/favicon.ico") { res.writeHead(204); res.end(); return; }
    if (path === "/api/summary") return json(res, 200, { installs: installs.length, packages: installs.length, described: installs.length, openProposals: proposals.length, updatable: installs.filter((r) => r.updatable).length, machines: machines.map((id) => ({ id, kind: "host" })) });
    if (path === "/api/updates/window") return json(res, 200, updateWindows());
    if (path === "/api/updates/window/auto" && req.method === "POST") {
      let body: Row; try { body = JSON.parse(await new Promise<string>((resolveBody) => { let data = ""; req.on("data", (part) => data += part); req.on("end", () => resolveBody(data)); })); } catch { return json(res, 400, { error: "Invalid JSON" }); }
      if (typeof body?.enabled !== "boolean") return json(res, 400, { error: "enabled must be true or false" });
      autoRun.enabled = body.enabled;
      return json(res, 200, { ...autoRun });
    }
    if (path === "/api/updates/plan") return json(res, 200, plan(Number(url.searchParams.get("installId")), list(url.searchParams, "alsoInstallIds").map(Number)));
    if (path === "/api/downloads/plan") { const preview = downloadPlan(Number(url.searchParams.get("installId"))); return json(res, preview ? 200 : 404, preview || { error: "Install not found" }); }
    if (path === "/api/updates" || path === "/api/installs") return json(res, 200, listResponse(path.endsWith("updates") ? "updates" : "installs", url.searchParams));
    if (/^\/api\/installs\/\d+$/.test(path)) { const row = installs.find((r) => r.installId === Number(path.split("/").at(-1))); return json(res, row ? 200 : 404, row ? { ...row, ...dependencyDetails(row), details: {}, usage: [{ kind: "running", value: row.running ? "1" : "0", available: 1, origin: "mock" }], constraints: row.blockedBy ? [{ type: "freeze", spec: row.blockedBy, origin: "mock" }] : [], relations: [], sameSoftware: [] } : { error: "Not found" }); }
    if (path === "/api/proposals") return json(res, 200, proposals);
    if (/^\/api\/proposals\/\d+$/.test(path) && req.method === "POST") { const index = proposals.findIndex((p) => p.id === Number(path.split("/").at(-1))); if (index >= 0) proposals.splice(index, 1); return json(res, 200, { ok: true }); }
    if (path === "/api/jobs" && req.method === "GET") return json(res, 200, { jobs: jobs.slice(0, Math.min(1000, Number(url.searchParams.get("limit")) || 50)), active: jobs.filter((j) => ["queued", "preflight", "running"].includes(j.state)).length });
    if (path === "/api/jobs" && req.method === "POST") {
      let body: Row; try { body = JSON.parse(await new Promise<string>((resolveBody) => { let data = ""; req.on("data", (part) => data += part); req.on("end", () => resolveBody(data)); })); } catch { return json(res, 400, { error: "Invalid JSON" }); }
      if (body.confirm !== true || !Array.isArray(body.installIds)) return json(res, 400, { error: "Confirmation required" });
      if (body.action === "download") {
        const p = body.installIds.length === 1 ? downloadPlan(Number(body.installIds[0])) : null;
        if (!p?.allowed || ["url", "sha256", "size", "fileName"].some((key) => body[key] !== p[key as keyof typeof p])) return json(res, 400, { error: "Download plan changed" });
        const row = installs.find((r) => r.installId === p.installId)!;
        const job = { id: nextJob++, batchId: `mock-${Date.now()}`, installId: p.installId, machineId: p.machineId, name: p.name, action: "download", download: p, from: row.installed, to: row.upstream || row.available, state: "queued", requestedAt: new Date().toISOString(), steps: [] };
        jobs.unshift(job); setTimeout(() => runJob(job), 25);
        return json(res, 202, { batchId: job.batchId, jobs: [job], refused: [] });
      }
      const batchId = `mock-${Date.now()}`; const refused: Row[] = []; const queued: Job[] = [];
      for (const id of body.installIds) { const p = plan(Number(id), body.installIds.map(Number).filter((otherId: number) => otherId !== Number(id))); if (!p.allowed || p.disruptive && !body.allowDisruptive || p.needsAdmin && !body.allowAdmin || p.softConfirmation && body.confirmSoft !== true) { refused.push({ installId: id, reason: p.refusal || (p.softConfirmation && body.confirmSoft !== true ? `needs confirmation: ${[...p.softConfirmation.projects, ...p.softConfirmation.dependents].join(", ")}` : "Disruptive update needs confirmation") }); continue; } const job = { id: nextJob++, batchId, installId: id, machineId: p.machineId, name: p.name, ecosystem: p.ecosystem, action: "update", from: p.from, to: p.to, state: "queued", requestedAt: new Date().toISOString(), startedAt: null, finishedAt: null, message: null, steps: [] }; jobs.unshift(job); queued.push(job); }
      for (const job of queued) setTimeout(() => runJob(job), 25);
      return json(res, queued.length ? 202 : 409, { batchId, jobs: queued.map(({ id, installId, machineId, name, from, to, state }) => ({ id, installId, machineId, name, from, to, state })), refused });
    }
    if (/^\/api\/jobs\/\d+$/.test(path)) { const job = jobs.find((j) => j.id === Number(path.split("/").at(-1))); return json(res, job ? 200 : 404, job || { error: "Not found" }); }
    if (/^\/api\/jobs\/\d+\/stop$/.test(path) && req.method === "POST") { const job = jobs.find((j) => j.id === Number(path.split("/")[3])); if (!job) return json(res, 404, { error: "Not found" }); if (!["queued", "preflight", "running"].includes(job.state)) return json(res, 409, { error: "Job finished" }); job.state = "stopped"; job.finishedAt = new Date().toISOString(); return json(res, 200, job); }
    if (path.startsWith("/api/")) return json(res, 404, { error: "Not found" });
    const relative = path === "/" ? "index.html" : path.slice(1);
    if (!/^[\w-]+\.(?:html|js|css)$/.test(relative)) return json(res, 404, { error: "Not found" });
    try { const bytes = await readFile(resolve(publicDir, relative)); res.writeHead(200, { "content-type": extname(relative) === ".css" ? "text/css" : extname(relative) === ".js" ? "text/javascript" : "text/html", "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'" }); res.end(bytes); } catch { json(res, 404, { error: "Not found" }); }
  });
  server.on("close", () => filtersDb.close());
  server.on("close", servicesMock.close);
  return server;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv.find((arg) => arg.startsWith("--port="))?.slice(7) || 4871);
  const runStatus = Number(process.argv.find((arg) => arg.startsWith("--run-status="))?.slice(13));
  const scenario = process.argv.find((arg) => arg.startsWith("--run-scenario="))?.slice(15);
  const alertScenario = process.argv.find((arg) => arg.startsWith("--alerts="))?.slice(9);
  const healthRefreshStatus = Number(process.argv.find((arg) => arg.startsWith("--health-refresh-status="))?.slice(24));
  const runScenario = ["done", "failed", "graceful-not-stopped", "declined"].includes(scenario || "") ? scenario as "done" | "failed" | "graceful-not-stopped" | "declined" : undefined;
  createMockHub({ noModels: process.argv.includes("--no-models"), controlOff: process.argv.includes("--control-off"), recipesMissing: process.argv.includes("--recipes-missing"), portsMissing: process.argv.includes("--ports-missing"), stacksMissing: process.argv.includes("--stacks-missing"), portsEmpty: process.argv.includes("--ports-empty"), stacksEmpty: process.argv.includes("--stacks-empty"), planRefusal: process.argv.includes("--plan-refusal"), alertsMissing: process.argv.includes("--alerts-missing"), healthMissing: process.argv.includes("--health-missing"), noHealth: process.argv.includes("--no-health"), healthRefreshStatus: healthRefreshStatus === 404 || healthRefreshStatus === 409 ? healthRefreshStatus : undefined, alertScenario: ["zero", "one", "high"].includes(alertScenario || "") ? alertScenario as "zero" | "one" | "high" : undefined, runStatus: runStatus === 404 || runStatus === 409 ? runStatus : undefined, runScenario }).listen(port, "127.0.0.1", () => process.stdout.write(`Mock hub listening on http://127.0.0.1:${port}\n`));
}

function createServicesMock(options: { noModels?: boolean; controlOff?: boolean; recipesMissing?: boolean; portsMissing?: boolean; stacksMissing?: boolean; portsEmpty?: boolean; stacksEmpty?: boolean; planRefusal?: boolean; alertsMissing?: boolean; healthMissing?: boolean; noHealth?: boolean; healthRefreshStatus?: 404 | 409; alertScenario?: "zero" | "one" | "high"; runStatus?: 404 | 409; runScenario?: "done" | "failed" | "graceful-not-stopped" | "declined" } = {}) {
  const now = () => new Date().toISOString();
  const machineRows: Row[] = machines.map((id, index) => ({ id, name: ["Hub", "Laptop", "Server", "Mini"][index], os: index === 0 ? "Windows" : "macOS", live: { state: ["fresh", "stale", "fresh", "unreachable"][index], lastLiveAt: daysAgo(index === 3 ? 1 : 0), cadenceMs: index === 0 ? 3000 : 20000, error: index === 3 ? "Mock machine is offline" : null } }));
  const serviceNames = ["System network", "System maintenance", "scout-hub", "Backup schedule", "tailscaled", "Print support", "mediaanalysisd", "User agent", "Database", "Retired helper"];
  const services: Row[] = machineRows.flatMap((machine, machineIndex) => Array.from({ length: 10 }, (_, index) => {
    const official = [0, 1, 5, 6, 7].includes(index);
    const className = index < 2 ? "essential" : official ? "optional" : "third-party";
    const kind = machineIndex === 0 ? [1, 3, 7].includes(index) ? "scheduled-task" : "windows-service" : "launchd";
    const name = machineIndex === 0 ? serviceNames[index] : `com.${official ? "apple" : "local"}.${serviceNames[index]!.toLowerCase().replaceAll(" ", "-")}`;
    const source = ["hand", "project", "install", "public", "os", "none"][(machineIndex * 10 + index) % 6]!;
    const description = source === "none" ? null : { text: `${name} supports ${["local service tasks", "the project build", "installed package operations", "the public service role", "operating system functions"][(["hand", "project", "install", "public", "os"].indexOf(source))]}.`, source, generated: ["project", "public"].includes(source), confidence: ["project", "public"].includes(source) ? 0.82 : null, at: new Date().toISOString(), subject: `service:${kind}:${name}`, hasHandEdit: source === "hand", evidence: source === "project" ? [`${name} supports the project build.`] : [] };
    return { id: machineIndex * 10 + index + 1, machineId: machine.id, machineName: machine.name, kind, domain: index === 7 && machineIndex > 0 ? "gui/501" : "system", name, displayName: serviceNames[index], description, program: machineIndex === 0 ? official ? `C:/Windows/System32/service-${index}.exe` : `C:/Program Files/${serviceNames[index]}/service.exe` : official ? `/System/Library/service-${index}` : `/usr/local/bin/service-${index}`, state: index === 1 ? "disabled" : [5, 9].includes(index) ? "stopped" : index === 7 ? "other" : "running", startMode: index === 1 ? "disabled" : index === 3 ? "scheduled" : "auto", enabled: index !== 1, pid: [1, 5, 7, 9].includes(index) ? null : 4100 + machineIndex * 100 + index, runAs: machineIndex === 0 ? "LocalSystem" : index === 7 ? "user" : "root", triggers: kind === "scheduled-task" ? ["Daily at 03:00"] : null, lastRun: kind === "scheduled-task" ? daysAgo(1) : null, lastResult: kind === "scheduled-task" ? index === 7 ? 1 : 0 : null, firstSeenAt: daysAgo(90), lastSeenAt: daysAgo(index === 9 ? 2 : 0), goneAt: index === 9 ? daysAgo(2) : null, classification: { class: className, vendor: official ? machineIndex === 0 ? "microsoft" : "apple" : index === 4 ? "tailscale" : "other", official, hidden: index < 2, evidence: official ? ["Program is inside an OS directory", `Platform ${kind} name matches a classification rule`] : ["Program is outside OS directories"], whatBreaks: index === 6 ? "Photos search and Live Text indexing stop until the service is enabled again." : index === 0 ? "Network name resolution stops." : null, confidence: index === 6 || index === 0 ? "curated" : official ? "rule" : "default" } };
  }));
  const listeners: Row[] = machineRows.flatMap((machine, machineIndex) => Array.from({ length: 8 }, (_, index) => {
    const joined = services[machineIndex * 10 + [0, 2, 3, 4, 6, 6, 2, 8][index]!]!;
    const bind = index === 0 ? "loopback" : ["loopback", "lan", "all"][(index - 1) % 3]!;
    const source = ["hand", "project", "install", "public", "os", "none"][(machineIndex * 8 + index) % 6]!;
    const description = source === "none" ? null : { text: `${joined.name} supports ${source} listener tasks.`, source, generated: ["project", "public"].includes(source), confidence: ["project", "public"].includes(source) ? 0.78 : null, at: now(), subject: `listener:${machine.id}:${index === 6 ? "container" : joined.name}`, hasHandEdit: source === "hand", evidence: source === "project" ? [`${joined.name} supports project listener tasks.`] : [] };
    return { id: machineIndex * 8 + index + 1, machineId: machine.id, machineName: machine.name, port: index === 0 ? 5353 : [4870, 8010, 41641, 7000, 7001, 8644, 5432][index - 1], protocol: "tcp", address: bind === "loopback" ? "127.0.0.1" : bind === "lan" ? `192.168.1.${150 + machineIndex}` : "0.0.0.0", bind, pid: joined.pid, processName: index === 6 ? "docker" : joined.displayName, processPath: index === 6 ? "/usr/local/bin/docker" : joined.program, containerName: index === 6 ? "hooks" : null, containerImage: index === 6 ? "local/hooks:stable" : null, firstSeenAt: daysAgo(60), lastSeenAt: now(), goneAt: index === 7 && machineIndex > 1 ? daysAgo(1) : null, classification: { ...joined.classification, evidence: [...joined.classification.evidence] }, serviceName: index === 6 ? null : joined.name, serviceKind: index === 6 ? null : joined.kind, description };
  }));
  const protectedGroups = [
    ["essential", "Essential system service", true, true, "Stopping an essential service can make the machine unusable."],
    ["scout", "Scout", true, true, "Scout needs its own services to keep the catalog available."],
    ["cloudflared", "Cloudflare tunnel", true, true, "Stopping the tunnel can interrupt remote access."],
    ["ssh", "Remote login", true, true, "Stopping remote login can lock you out."],
    ["cogitator", "Cogitator", true, true, "Stopping Cogitator can interrupt machine management."],
    ["remote-access", "Remote access", true, false, "Stopping these could lock you out of a machine you reach remotely."],
    ["dns-network", "DNS and network", true, false, "Stopping these can interrupt name resolution or network access."],
    ["containers", "Containers", true, false, "Stopping these can stop containers and their services."],
    ["custom", "Custom", false, false, "This row matches a custom protected rule."],
  ].map(([id, label, builtIn, alwaysOn, reason]) => ({ id, label, builtIn, alwaysOn, enabled: true, reason }));
  for (const row of services) {
    const group = row.id === 9 ? null : row.id === 12 ? "dns-network" : row.id === 19 ? "containers" : row.machineId === "hub" ? ["essential", "essential", "scout", "cloudflared", "ssh", "cogitator", "remote-access", "custom", "containers", null][(row.id - 1) % 10] || null : null;
    row.control = { mechanism: row.kind === "scheduled-task" ? "scheduled-task" : row.kind === "launchd" ? "launchd" : "windows-service", actions: ["start", "stop", "restart"].map((action) => { const available = !(action === "start" ? row.state === "running" : row.state !== "running") && !(row.goneAt && action !== "start") && (action === "start" || !group); return { action, available, reason: available ? null : action === "start" && row.state === "running" ? "Already running" : action !== "start" && row.state !== "running" ? "Not running" : group ? `Protected: ${group}` : null }; }), protected: { protected: !!group, group, reason: group ? protectedGroups.find((item) => item.id === group)!.reason : null }, needsAdmin: row.machineId === "hub" ? row.kind === "windows-service" : row.kind === "launchd" && row.domain === "system", uninstall: true };
    const startupOk = row.control.mechanism === "launchd" || row.control.mechanism === "scheduled-task";
    const off = row.state === "disabled";
    row.control.actions.push({ action: "disable", available: startupOk && !off && !row.goneAt && !group, reason: !startupOk ? "Only launchd jobs and scheduled tasks can be disabled or enabled" : off ? "Already disabled" : row.goneAt ? "The row is no longer present" : group ? `Protected: ${group}` : null }, { action: "enable", available: startupOk && off && !row.goneAt, reason: !startupOk ? "Only launchd jobs and scheduled tasks can be disabled or enabled" : !off ? "Already enabled" : row.goneAt ? "The row is no longer present" : null });
    if (options.controlOff) for (const action of row.control.actions) { action.available = false; action.reason = "Control is off."; }
  }
  for (const row of listeners) {
    const joined = services.find((service) => service.machineId === row.machineId && service.name === row.serviceName && service.kind === row.serviceKind);
    row.control = joined ? { ...joined.control, actions: joined.control.actions.map((action: Row) => ({ ...action })), protected: { ...joined.control.protected } } : { mechanism: row.serviceName ? row.serviceKind === "scheduled-task" ? "scheduled-task" : row.serviceKind === "launchd" ? "launchd" : "windows-service" : "process", actions: ["start", "stop", "restart"].map((action) => ({ action, available: action === "stop" && !row.goneAt, reason: action === "stop" && !row.goneAt ? null : action === "start" ? "A bare process has no start command" : action === "restart" ? "A bare process has no restart command" : "Not running" })), protected: { protected: false, group: null, reason: null }, needsAdmin: false, uninstall: true };
    if (options.controlOff) for (const action of row.control.actions) { action.available = false; action.reason = "Control is off."; }
  }
  const fallback = (description: Row | null) => description?.source === "hand" ? { ...description, source: "install", generated: false, confidence: null, hasHandEdit: false, evidence: [] } : description;
  const automaticDescriptions = new Map<string, Row | null>([...services.map((row) => [`service:${row.id}`, fallback(row.description)] as [string, Row | null]), ...listeners.map((row) => [`listener:${row.id}`, fallback(row.description)] as [string, Row | null])]);
  const events: Row[] = ["service_new", "service_gone", "service_changed", "listener_new", "listener_gone", "listener_changed"].map((kind, index) => ({ id: index + 1, at: new Date(Date.now() - index * 60000).toISOString(), machineId: machines[index % 4], kind, summary: `${machineRows[index % 4]!.name}: ${kind.replaceAll("_", " ")} in the mock catalog`, detail: { name: "scout-hub", state: "running" } }));
  const streams = new Set<import("node:http").ServerResponse>();
  const alertSeeds: [number, string, string, string, string, number, string][] = [
    [1, "new-listener", "warn", "Hub", "listener", 2, "open"],
    [2, "new-daemon", "info", "Laptop", "service", 13, "open"],
    [3, "service-down", "warn", "Hub", "service", 3, "open"],
    [4, "domain-origin-down", "high", "Hub", "route", 3, "open"],
    [5, "exposure-change", "high", "Mini", "listener", 26, "open"],
    [6, "new-listener", "info", "Server", "listener", 18, "acknowledged"],
    [7, "service-down", "warn", "Mini", "service", 39, "resolved"],
    [8, "unhealthy", "high", "Hub", "listener", 2, "open"],
    [9, "cert-expiring", "warn", "Hub", "route", 2, "open"],
    [10, "crash-loop", "warn", "Laptop", "service", 13, "open"],
  ];
  const alertLabels: Row = { unhealthy: "Unhealthy target", "cert-expiring": "Certificate expiring", "crash-loop": "Crash loop" };
  const alerts: Row[] = alertSeeds.map(([id, kind, severity, machineName, targetType, targetId, state], index) => ({ id, at: new Date(Date.now() - index * 3600000).toISOString(), kind, severity, machineId: machineName === "Hub" ? "hub" : machineName === "Laptop" ? "laptop" : machineName === "Mini" ? "mini" : "server", machineName, key: `${kind}:${machineName.toLowerCase()}:${targetId}`, title: `${alertLabels[kind] || `${kind[0]!.toUpperCase()}${kind.slice(1).replaceAll("-", " ")}`} on ${machineName}`, detail: kind === "unhealthy" ? "A web endpoint has not answered for 3 checks (timeout)." : kind === "cert-expiring" ? "The certificate for service-5.example.test ends in 9 days." : kind === "crash-loop" ? "ssh restarted 4 times in 30 minutes." : `${machineName} has a ${kind.replaceAll("-", " ")} that needs review.`, target: { type: targetType, id: targetId }, state, acknowledgedAt: state === "acknowledged" ? now() : null, resolvedAt: state === "resolved" ? now() : null, muted: false }));
  let mutes: Row[] = [{ key: "new-listener:hub:8080:*", match: "new-listener:hub:8080:*", reason: "dev ports", source: "file", at: now() }];
  const recipes: Row[] = [
    { id: 1, project: "scout", source: "package-json", name: "dev", argv: ["pnpm", "run", "dev"], port: null, state: "proposed", detail: "node server.js" },
    { id: 2, project: "dashboard", source: "launch-json", name: "web", argv: ["node", "server.js", "--port=4876"], port: 4876, state: "approved" },
    { id: 3, project: "archive", source: "compose", name: "compose.yaml", argv: ["docker", "compose", "-f", "compose.yaml", "up", "-d"], port: null, state: "rejected" },
    { id: 4, project: "legacy", source: "launch-json", name: "legacy", argv: ["cmd", "/c", "legacy.cmd"], port: null, state: "unsupported", reason: "The executable must be a supported bare name." },
    { id: 5, project: "removed", source: "package-json", name: "start", argv: ["npm", "run", "start"], port: null, state: "approved", gone: true },
  ].map((recipe) => {
    const root = `C:/Repositories/${recipe.project}`;
    return { ...recipe, machineId: "hub", root, cwd: root, command: recipe.argv.join(" "), hash: createHash("sha256").update(JSON.stringify({ argv: recipe.argv, cwd: root })).digest("hex"), reason: recipe.reason ?? null, detail: recipe.detail ?? null, proposedAt: now(), decidedAt: recipe.state === "approved" || recipe.state === "rejected" ? now() : null, lastSeenAt: now(), gone: recipe.gone ?? false, running: recipe.port === null ? null : false };
  });
  const recipeCounts = () => ({ proposed: recipes.filter((recipe) => recipe.state === "proposed").length, approved: recipes.filter((recipe) => recipe.state === "approved").length, rejected: recipes.filter((recipe) => recipe.state === "rejected").length, unsupported: recipes.filter((recipe) => recipe.state === "unsupported").length });
  const ports = { ranges: [
    { name: "dev", from: 4870, to: 4899, note: "Scout and its neighbours", size: 30, usedCount: 7, freeCount: 20, used: [4870, 4871, 4875, 4881, 4882, 4890, 4891], next: 4873 },
    { name: "full", from: 65530, to: 65535, note: "No free ports", size: 6, usedCount: 6, freeCount: 0, used: [65530, 65531, 65532, 65533, 65534, 65535], next: null },
  ], reserved: [
    { port: 4870, name: "Scout hub", match: "node", note: "production", state: "listening", by: "node" },
    { port: 4872, name: "Scout dev", match: null, note: "reserved", state: "free", by: null },
    { port: 4874, name: "Wrong owner", match: "node", note: "clash case", state: "clash", by: "python" },
  ], clashes: [
    { key: "reserved:4874", kind: "reserved-taken", port: 4874, detail: "Port 4874 is reserved for Wrong owner but python is listening on it" },
    { key: "recipe:4876", kind: "recipe-port-taken", port: 4876, detail: "Port 4876 is used by another process while dashboard dev is approved" },
    { key: "shared:4877", kind: "recipe-port-shared", port: 4877, detail: "Port 4877 is declared by two recipes" },
  ], file: { path: ".scout-data/ports.json", exists: true, error: "The ports file contains one invalid reserved entry, which Scout ignored." }, generatedAt: now() };
  for (const [index, clash] of ports.clashes.entries()) alerts.push({ id: 11 + index, at: now(), kind: "port-clash", severity: clash.kind === "recipe-port-shared" ? "warn" : "high", machineId: "hub", machineName: "Hub", key: `port-clash:${clash.key}`, title: `Port clash: ${clash.port}`, detail: clash.detail, target: null, state: "open", acknowledgedAt: null, resolvedAt: null, muted: false });
  if (options.alertScenario === "zero") for (const alert of alerts) if (alert.state === "open") alert.state = "resolved";
  if (options.alertScenario === "one") { let kept = false; for (const alert of alerts) if (alert.state === "open") { if (kept) alert.state = "acknowledged"; else { kept = true; alert.severity = "info"; } } }
  if (options.alertScenario === "high") { let kept = false; for (const alert of alerts) if (alert.state === "open") { if (kept) alert.state = "acknowledged"; else { kept = true; alert.severity = "high"; } } }
  const stacks: Row[] = [
    { name: "app-dev", label: "App dev", state: "ready", members: [{ order: 1, type: "service", label: "Cogitator", machineId: "hub", detail: "scheduled task \\Cogitator", waitPort: 8470, waitSeconds: 30, running: false, available: true, reason: null }, { order: 2, type: "recipe", label: "neo-angband dev", detail: "pnpm run dev in C:/Repositories/neo-angband", waitPort: 4876, waitSeconds: 30, running: false, available: true, reason: null }] },
    { name: "app-partial", label: "App partial", state: "partial", members: [{ order: 1, type: "service", label: "Cogitator", machineId: "hub", detail: "scheduled task \\Cogitator", waitPort: 8470, waitSeconds: 30, running: true, available: true, reason: null }, { order: 2, type: "recipe", label: "dashboard dev", detail: "pnpm run dev", waitPort: 4876, waitSeconds: 30, running: false, available: true, reason: null }] },
    { name: "app-running", label: "App already running", state: "running", members: [{ order: 1, type: "service", label: "Cogitator", machineId: "hub", detail: "scheduled task \\Cogitator", waitPort: 8470, waitSeconds: 30, running: true, available: true, reason: null }] },
    { name: "app-blocked", label: "App blocked", state: "blocked", members: [{ order: 1, type: "recipe", label: "legacy dev", detail: "npm run dev", waitPort: 4890, waitSeconds: 30, running: false, available: false, reason: "The recipe needs approval." }, { order: 2, type: "service", label: "Missing service", machineId: "hub", detail: "scheduled task \\Missing", waitPort: null, waitSeconds: 30, running: null, available: false, reason: "No such service." }] },
  ];
  const actions: Row[] = [];
  const plans = new Map<string, Row>();
  let nextAction = 1;
  const broadcastAction = (action: Row) => { for (const stream of streams) send(stream, "action", action); };
  const probes = new Map<string, Row>();
  let describeState: Row = { scope: "public", state: "idle", done: 0, total: 0, applied: 0, error: null, at: null };
  let describeTimer: ReturnType<typeof setTimeout> | null = null;
  const edge = { state: "fresh", lastReadAt: now(), error: null, zones: 2, tunnels: 3 };
  const domains: Row[] = Array.from({ length: 14 }, (_, index) => {
    const state = ["ok", "ok", "origin-down", "dns-dangling", "no-origin", "unknown", "ok", "origin-down", "ok", "dns-dangling", "ok", "no-origin", "ok", "unknown"][index]!;
    const via = ["tunnel", "worker", "proxied-origin", "dns-only"][index % 4]!;
    const machineId = index === 13 ? null : machines[index % machines.length]!;
    const machineName = machineId ? machineRows.find((machine) => machine.id === machineId)!.name : null;
    const port = [4870, 8010, 5432, 8644][index % 4]!;
    const origin = ["no-origin", "dns-dangling"].includes(state) ? null : { service: `http://localhost:${port}`, scheme: "http", host: "localhost", port };
    const confidence = ["listener", "cloudflared", "single-host", null][index % 4]!;
    return { id: index + 1, hostname: `service-${index + 1}.example.test`, path: index % 3 === 0 ? "/status" : null, zone: "example.test", via, dns: { type: index % 2 ? "CNAME" : "A", content: `tunnel-${String.fromCharCode(97 + index)}${String.fromCharCode(97 + index)}${String.fromCharCode(97 + index)}${String.fromCharCode(97 + index)}.example.test`, proxied: index % 2 === 0 }, tunnel: via === "tunnel" ? { id: `tunnel-${String.fromCharCode(97 + index)}${String.fromCharCode(97 + index)}${String.fromCharCode(97 + index)}${String.fromCharCode(97 + index)}`, name: machineId || "tunnel-unplaced", status: state === "origin-down" ? "healthy" : state === "dns-dangling" ? "down" : "healthy", connections: index % 5 } : null, worker: via === "worker" ? { pattern: `service-${index + 1}.example.test/*`, script: `worker-${index + 1}` } : null, access: index % 2 === 0 ? { name: "Example Access", appId: `app-${index + 1}`, policies: index % 3 + 1 } : null, origin, machineId, machineName, machineConfidence: confidence, listener: machineId && origin && state === "ok" ? { id: index + 1, port, bind: "loopback", processName: ["node", "python", "nginx"][index % 3]!, serviceName: null } : null, state, stateText: state === "origin-down" ? `Tunnel healthy but no listener on port ${port}` : state === "ok" ? `Port ${port} is listening on ${machineName}` : `${state} route` };
  });
  for (const domain of domains) {
    const listener = listeners.find((row) => row.machineId === domain.machineId && row.port === domain.origin?.port);
    domain.description = listener?.description || null;
  }
  const healthStates = ["up", "slow", "failing", "down", "up", "unknown", "up", "up", "slow", "up", "failing", "up", "up", "unknown"];
  const sampleHistory = (state: string, latencyMs: number | null) => Array.from({ length: 60 }, (_, index) => {
    const failed = state === "down" ? index >= 57 : state === "failing" ? index === 59 : state === "not-http" ? true : index % 19 === 11;
    const ms = latencyMs == null ? null : Math.max(4, latencyMs + (index % 7 - 3) * 3);
    return { at: new Date(Date.now() - (59 - index) * 300000).toISOString(), ok: !failed, latencyMs: failed ? null : ms, status: failed ? null : 302 };
  }).filter(() => state !== "unknown");
  const healthTargets: Row[] = domains.map((domain, index) => {
    const state = healthStates[index]!; const latencyMs = state === "unknown" || state === "not-http" ? null : state === "slow" ? 2600 : [48, 80, 120, 35][index % 4]!;
    const tlsDaysLeft = index === 4 ? 9 : index % 3 === 0 ? null : 60 + index;
    const target = { key: `domain:${domain.hostname}`, kind: "domain", label: domain.hostname, machineId: domain.machineId, port: null, url: `https://${domain.hostname}/`, state, status: latencyMs == null || state === "failing" || state === "down" ? null : 302, latencyMs: ["failing", "down"].includes(state) ? null : latencyMs, lastOkAt: state === "unknown" ? null : state === "down" ? daysAgo(1) : now(), lastProbeAt: state === "unknown" ? null : now(), failures: state === "down" ? 3 : state === "failing" ? 1 : 0, error: state === "down" || state === "failing" ? "timeout" : null, tlsNotAfter: state === "unknown" || tlsDaysLeft == null ? null : new Date(Date.now() + tlsDaysLeft * 86400000).toISOString(), tlsDaysLeft: state === "unknown" ? null : tlsDaysLeft, history: sampleHistory(state, latencyMs) };
    domain.health = { key: target.key, state, latencyMs, lastOkAt: target.lastOkAt, failures: target.failures, tlsDaysLeft };
    return target;
  });
  for (let index = 0; index < 6; index++) {
    const row = listeners[index + 2]!; const state = ["up", "slow", "failing", "down", "not-http", "unknown"][index]!; const latencyMs = [12, 2840, 90, null, null, null][index]!;
    const target = { key: `listener:${row.machineId}:${row.port}`, kind: "listener", label: `${row.machineName}:${row.port}`, machineId: row.machineId, port: row.port, url: `http://127.0.0.1:${row.port}/`, state, status: index === 0 || index === 1 ? 200 : null, latencyMs, lastOkAt: state === "unknown" ? null : state === "down" ? daysAgo(1) : now(), lastProbeAt: state === "unknown" ? null : now(), failures: index === 2 ? 1 : index === 3 ? 3 : 0, error: index === 2 || index === 3 ? index === 2 ? "connection refused" : "timeout" : null, tlsNotAfter: null, tlsDaysLeft: null, history: sampleHistory(state, latencyMs) };
    row.health = { key: target.key, state, latencyMs, lastOkAt: target.lastOkAt, failures: target.failures, tlsDaysLeft: null };
    healthTargets.push(target);
  }
  if (options.healthMissing) { for (const row of listeners) delete row.health; for (const domain of domains) delete domain.health; }
  const healthCounts = () => Object.fromEntries(["up", "slow", "failing", "down", "not-http", "unknown"].map((state) => [state, healthTargets.filter((target) => target.state === state).length]));
  const healthResponse = (query: URLSearchParams) => ({ targets: [...healthTargets].filter((target) => (!query.get("state") || query.get("state") === "all" || target.state === query.get("state")) && (!query.get("kind") || query.get("kind") === "all" || target.kind === query.get("kind"))).sort((a, b) => ["down", "failing", "slow", "unknown", "up", "not-http"].indexOf(a.state) - ["down", "failing", "slow", "unknown", "up", "not-http"].indexOf(b.state) || a.label.localeCompare(b.label)), counts: healthCounts(), probe: { running: healthRunning, lastRunAt: null, nextRunAt: null, intervalSeconds: options.noHealth ? 0 : 300, done: healthDone, total: healthTargets.length }, generatedAt: now() });
  let healthRunning = false; let healthDone = 0; let healthTimer: ReturnType<typeof setTimeout> | null = null;
  function routeOverview() { return { reader: { ...edge }, totals: { domains: domains.length, ok: domains.filter((row) => row.state === "ok").length, originDown: domains.filter((row) => row.state === "origin-down").length, dnsDangling: domains.filter((row) => row.state === "dns-dangling").length, noOrigin: domains.filter((row) => row.state === "no-origin").length, unknown: domains.filter((row) => row.state === "unknown").length }, generatedAt: now() }; }
  function routeRows(query: URLSearchParams) {
    for (const domain of domains) domain.description = listeners.find((row) => row.machineId === domain.machineId && row.port === domain.origin?.port)?.description || null;
    let rows = domains.filter((row) => (!query.get("machine") || row.machineId === query.get("machine")) && (!query.get("state") || row.state === query.get("state")) && (!query.get("q") || [row.hostname, row.tunnel?.name, row.origin?.service].join(" ").toLowerCase().includes(query.get("q")!.toLowerCase())));
    const facets = Object.fromEntries(["machine", "state", "via"].map((dimension) => {
      const counts = new Map<string, number>();
      for (const row of domains.filter((candidate) => dimension === "machine" ? !query.get("machine") || candidate.machineId === query.get("machine") : dimension === "state" ? !query.get("state") || candidate.state === query.get("state") : true)) {
        const value = String(dimension === "machine" ? row.machineId || "unplaced" : row[dimension]); counts.set(value, (counts.get(value) || 0) + 1);
      }
      return [dimension, [...counts].map(([value, count]) => ({ value, label: dimension === "machine" ? machineRows.find((machine) => machine.id === value)?.name || "Unplaced" : value, count }))];
    }));
    rows = [...rows].sort((a, b) => String(a.hostname).localeCompare(String(b.hostname)));
    const total = rows.length; const limit = Math.min(500, Math.max(1, Number(query.get("limit")) || 200)); const offset = Math.max(0, Number(query.get("offset")) || 0);
    return { reader: { ...edge }, total, rows: rows.slice(offset, offset + limit), facets, generatedAt: now() };
  }
  let edgeTimer: ReturnType<typeof setTimeout> | null = null;
  const timers = new Set<ReturnType<typeof setInterval>>();
  const send = (res: import("node:http").ServerResponse, name: string, data: unknown) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  const broadcast = (name: string, data: unknown) => { for (const res of streams) send(res, name, data); };
  const alertCounts = () => ({ open: alerts.filter((alert) => alert.state === "open" && !alert.muted).length, high: alerts.filter((alert) => alert.state === "open" && alert.severity === "high" && !alert.muted).length });
  const broadcastAlert = (alert: Row, change: string) => { broadcast("alert", { alert, change }); };
  const glob = (match: string, value: string) => {
    const escaped = [...match].map((part) => part === "*" ? ".*" : part === "?" ? "." : "\\^$+().|{}[]".includes(part) ? `\\${part}` : part).join("");
    return new RegExp(`^${escaped}$`).test(value);
  };
  for (const alert of alerts) alert.muted = mutes.some((mute) => glob(mute.match, alert.key));
  function joinedServices(): Row[] {
    return services.map((row) => {
      const ports = listeners.filter((listener) => !listener.goneAt && listener.machineId === row.machineId && listener.serviceName === row.name).map(({ port, bind, address, health }) => ({ port, bind, address, health: health || null }));
      const exposure = ["all", "lan", "loopback"].find((bind) => ports.some((port) => port.bind === bind)) || "none";
      return { ...row, ports, exposure };
    });
  }
  function matches(row: Row, query: URLSearchParams, skip = "") {
    if (query.get("gone") === "gone" ? !row.goneAt : !!row.goneAt) return false;
    for (const [key, value] of Object.entries({ machine: row.machineId, kind: row.kind, state: row.state, class: row.classification.class, exposure: row.exposure, bind: row.bind, port: row.port })) if (key !== skip && query.get(key) && String(value) !== query.get(key)) return false;
    if (query.has("official") && row.classification.official !== (query.get("official") === "1")) return false;
    if (query.get("hasPort") === "1" && !row.ports?.length) return false;
    const term = (query.get("q") || "").toLowerCase();
    if (skip !== "description" && query.get("desc") && !query.get("desc")!.split(",").includes(row.description?.source || "none")) return false;
    return !term || [row.name, row.displayName, row.program, row.machineName, row.processName, row.processPath, row.containerName, row.serviceName, row.port, row.description?.text, ...(row.ports || []).map((port: Row) => port.port)].join(" ").toLowerCase().includes(term);
  }
  function response(kind: "services" | "listeners", query: URLSearchParams) {
    const source = kind === "services" ? joinedServices() : listeners;
    const visible = (row: Row) => query.get("all") === "1" || !row.classification.hidden;
    const filtered = source.filter((row) => matches(row, query));
    const rows = filtered.filter(visible);
    const dimensions = kind === "services" ? ["machine", "kind", "class", "state", "exposure", "description"] : ["machine", "bind", "class", "description"];
    const facets = Object.fromEntries(dimensions.map((dimension) => {
      const counts = new Map<string, number>();
      for (const row of source.filter((candidate) => visible(candidate) && matches(candidate, query, dimension))) {
        const value = String(dimension === "machine" ? row.machineId : dimension === "class" ? row.classification.class : dimension === "description" ? row.description?.source || "none" : row[dimension]);
        counts.set(value, (counts.get(value) || 0) + 1);
      }
        return [dimension, [...counts].map(([value, count]) => ({ value, label: dimension === "machine" ? machineRows.find((machine) => machine.id === value)!.name : dimension === "description" ? value === "none" ? "None" : value : value, count })).sort((a, b) => a.value.localeCompare(b.value))];
    }));
    const sort = query.get("sort") || "machine";
    const sortable = (row: Row) => sort === "machine" ? row.machineName : sort === "class" ? row.classification.class : sort === "lastSeen" ? row.lastSeenAt : sort === "ports" ? Math.min(...row.ports.map((port: Row) => port.port), Infinity) : row[sort];
    if (kind === "services") rows.sort((a, b) => {
      const av = sortable(a); const bv = sortable(b);
      const cmp = typeof av === "number" ? av === bv ? 0 : av < bv ? -1 : 1 : String(av).localeCompare(String(bv));
      return cmp * (query.get("dir") === "desc" ? -1 : 1) || a.id - b.id;
    });
    const limit = Math.min(500, Math.max(1, Number(query.get("limit")) || 100));
    const offset = Math.max(0, Number(query.get("offset")) || 0);
    return { total: rows.length, hiddenCount: filtered.filter((row) => row.classification.hidden).length, rows: rows.slice(offset, offset + limit), facets };
  }
  function overview() {
    return { generatedAt: now(), machines: machineRows.map((machine) => {
      const presentServices = services.filter((row) => row.machineId === machine.id && !row.goneAt && !row.classification.hidden);
      const presentListeners = listeners.filter((row) => row.machineId === machine.id && !row.goneAt && !row.classification.hidden);
      return { ...machine, services: { total: presentServices.length, running: presentServices.filter((row) => row.state === "running").length, optionalRunning: presentServices.filter((row) => row.state === "running" && row.classification.class === "optional").length, thirdParty: presentServices.filter((row) => row.classification.class === "third-party").length }, listeners: { total: presentListeners.length, ...Object.fromEntries(["loopback", "lan", "all"].map((bind) => [bind, presentListeners.filter((row) => row.bind === bind).length])) } };
    }) };
  }
  function descriptionOverview() {
    const rows = [...joinedServices(), ...listeners].filter((row) => !row.classification.hidden && !row.goneAt);
    const subjects = new Map(rows.map((row) => [row.description?.subject || `${row.kind ? "service" : "listener"}:${row.id}`, row.description]));
    const bySource: Row = { hand: 0, project: 0, install: 0, public: 0, os: 0, none: 0 };
    for (const description of subjects.values()) bySource[description?.source || "none"]++;
    const total = subjects.size;
    return { total, described: total - bySource.none, bySource, public: { todo: bySource.none, lastRunAt: describeState.at || null }, project: options.noModels ? { state: "off", todo: 0, reason: "not configured" } : { state: "ready", todo: 3, reason: null, lastRunAt: describeState.at || null }, generatedAt: now() };
  }
  function startProbe(machineId: string) {
    if (probes.has(machineId)) return false;
    const probe = { machineId, probe: machineId === "hub" ? "win-tasks" : "launchd-slow", label: machineId === "hub" ? "Scheduled tasks" : "launchd jobs", phase: "start", startedAt: now(), elapsedMs: 0, message: null };
    probes.set(machineId, probe); broadcast("probe", probe);
    const timer = setInterval(() => {
      probe.elapsedMs = Date.now() - Date.parse(probe.startedAt);
      if (probe.elapsedMs >= 20000) { probe.phase = "done"; probes.delete(machineId); clearInterval(timer); timers.delete(timer); }
      broadcast("probe", probe);
    }, 2000);
    timer.unref(); timers.add(timer);
    return true;
  }
  let changedTimer: ReturnType<typeof setInterval> | null = null;
  function watch() {
    if (changedTimer) return;
    changedTimer = setInterval(() => {
      const row = services[2]!;
      row.state = row.state === "running" ? "stopped" : "running";
      row.lastSeenAt = now();
      const listener = listeners[1]!;
      listener.goneAt = row.state === "running" ? null : now(); listener.lastSeenAt = now();
      machineRows[0]!.live.lastLiveAt = now();
      events.unshift({ id: events.length + 1, at: now(), machineId: "hub", kind: "service_changed", summary: `Hub: scout-hub is ${row.state}`, detail: { name: row.name, state: row.state } });
      broadcast("changed", { machineId: "hub", tables: ["services", "listeners"], at: now() });
      const domain = domains[0]!; domain.state = domain.state === "ok" ? "origin-down" : "ok"; domain.stateText = domain.state === "ok" ? "Port 4870 is listening on Hub" : "Tunnel healthy but no listener on port 4870";
      edge.lastReadAt = now(); broadcast("edge", { state: "fresh", lastReadAt: edge.lastReadAt, error: null, changed: true });
      stacks[0]!.state = stacks[0]!.state === "ready" ? "partial" : "ready";
      stacks[0]!.members[0]!.running = stacks[0]!.state === "partial";
      broadcast("stack", { name: stacks[0]!.name, state: stacks[0]!.state });
    }, 3000);
    changedTimer.unref();
  }
  return {
    close() { for (const timer of timers) clearInterval(timer); if (changedTimer) clearInterval(changedTimer); if (edgeTimer) clearTimeout(edgeTimer); if (describeTimer) clearTimeout(describeTimer); if (healthTimer) clearTimeout(healthTimer); for (const stream of streams) stream.end(); },
    async route(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, url: URL): Promise<boolean> {
      const path = url.pathname;
      if (!path.startsWith("/api/services") && path !== "/api/listeners") return false;
      if (!isLoopbackHost(req.headers.host)) { json(res, 421, { error: "misdirected request" }); return true; }
      if (path.startsWith("/api/services/recipes") && options.recipesMissing) { json(res, 404, { error: "not found" }); return true; }
      if (path.startsWith("/api/services/ports") && options.portsMissing) { json(res, 404, { error: "not found" }); return true; }
      if (path.startsWith("/api/services/stacks") && options.stacksMissing) { json(res, 404, { error: "not found" }); return true; }
      if (path.startsWith("/api/services/health") && options.healthMissing) { json(res, 404, { error: "not found" }); return true; }
      if (path.startsWith("/api/services/outages")) {
        const sub = path.slice("/api/services/outages".length);
        if (sub === "" && req.method === "GET") { json(res, 200, outagesMock(now())); return true; }
        if (req.method === "POST") {
          let raw = ""; for await (const chunk of req) raw += chunk;
          let body: Record<string, any>; try { body = JSON.parse(raw || "{}"); } catch { json(res, 400, { error: "Invalid JSON" }); return true; }
          if (sub === "/test") { json(res, 200, { results: [{ channel: "discord", ok: true }, { channel: "desktop", ok: true }] }); return true; }
          if (sub === "/watch") {
            if ("pausedUntil" in body) outageConfig.pausedUntil = body.pausedUntil;
            else if (typeof body.check === "string") (outageConfig.checks as Record<string, boolean>)[body.check] = body.watched;
            else if (typeof body.machine === "string") (outageConfig.machines as Record<string, boolean>)[body.machine] = body.watched;
            else if (typeof body.item === "string") (outageConfig.items as Record<string, boolean>)[body.item] = body.watched;
            else { json(res, 400, { error: "unknown change" }); return true; }
            json(res, 200, { config: outageConfig }); return true;
          }
        }
        json(res, 404, { error: "not found" }); return true;
      }
      if (path === "/api/services/ports" && req.method === "GET") { json(res, 200, options.portsEmpty ? { ranges: [], reserved: [], clashes: [], file: { path: ".scout-data/ports.json", exists: false, error: null }, generatedAt: now() } : ports); return true; }
      if (path === "/api/services/ports/next" && req.method === "GET") {
        const range = ports.ranges.find((item) => item.name === url.searchParams.get("range"));
        if (!range) { json(res, 404, { error: "unknown range" }); return true; }
        if (range.next == null) { json(res, 409, { error: "range is full" }); return true; }
        json(res, 200, { range: range.name, port: range.next }); return true;
      }
      if (path === "/api/services/stacks" && req.method === "GET") { json(res, 200, { stacks: options.stacksEmpty ? [] : stacks, file: { path: ".scout-data/stacks.json", exists: !options.stacksEmpty, error: null }, generatedAt: now() }); return true; }
      if (path === "/api/services/health/refresh" && req.method === "POST") {
        if (options.noHealth || options.healthRefreshStatus === 404) { json(res, 404, { error: "health checks are off" }); return true; }
        if (options.healthRefreshStatus === 409 || healthRunning) { json(res, 409, { error: "a probe is already running" }); return true; }
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { json(res, 403, { error: "cross-origin request refused" }); return true; }
        if (!(req.headers["content-type"] || "").startsWith("application/json")) { json(res, 415, { error: "content type must be application/json" }); return true; }
        let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 4096) { json(res, 413, { error: "body too large" }); return true; } }
        try { const body = JSON.parse(raw); if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) throw new Error("body must be {}"); } catch (error) { json(res, 400, { error: (error as Error).message }); return true; }
        healthRunning = true; healthDone = 0; json(res, 202, { state: "running" });
        const step = () => {
          healthDone++;
          if (healthDone === 3) { const target = healthTargets[2]!; target.state = "up"; target.status = 302; target.latencyMs = 48; target.lastOkAt = now(); target.lastProbeAt = target.lastOkAt; target.failures = 0; target.error = null; target.history.push({ at: now(), ok: true, latencyMs: 48, status: 302 }); target.history = target.history.slice(-60); domains[2]!.health = { key: target.key, state: target.state, latencyMs: target.latencyMs, lastOkAt: target.lastOkAt, failures: 0, tlsDaysLeft: target.tlsDaysLeft }; for (const stream of streams) send(stream, "health", { target: { ...target, history: undefined }, change: "state" }); }
          for (const stream of streams) send(stream, "health-run", { running: healthDone < healthTargets.length, done: healthDone, total: healthTargets.length });
          if (healthDone >= healthTargets.length) { healthRunning = false; healthTimer = null; }
          else { healthTimer = setTimeout(step, 120); healthTimer.unref(); }
        };
        healthTimer = setTimeout(step, 120); healthTimer.unref(); return true;
      }
      if (path === "/api/services/health" && req.method === "GET") { json(res, 200, healthResponse(url.searchParams)); return true; }
      if (options.controlOff && req.method === "POST" && ["/api/services/actions/plan", "/api/services/actions/run", "/api/services/recipes/decide"].includes(path)) { json(res, 404, { error: "control is off" }); return true; }
      if (path === "/api/services/recipes" && req.method === "GET") {
        const state = url.searchParams.get("state") || "all";
        if (!["all", "proposed", "approved", "rejected", "unsupported"].includes(state)) { json(res, 400, { error: "Invalid recipe state" }); return true; }
        json(res, 200, { recipes: recipes.filter((recipe) => state === "all" || recipe.state === state).sort((a, b) => b.proposedAt.localeCompare(a.proposedAt) || b.id - a.id), counts: recipeCounts(), generatedAt: now() }); return true;
      }
      if ((path === "/api/services/recipes/scan" || path === "/api/services/recipes/decide") && req.method === "POST") {
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { json(res, 403, { error: "cross-origin request refused" }); return true; }
        if (!(req.headers["content-type"] || "").startsWith("application/json")) { json(res, 415, { error: "content type must be application/json" }); return true; }
        let body: Row;
        try { body = JSON.parse(await new Promise<string>((resolveBody) => { let data = ""; req.on("data", (part) => data += part); req.on("end", () => resolveBody(data)); })); }
        catch { json(res, 400, { error: "Invalid JSON" }); return true; }
        if (!body || typeof body !== "object" || Array.isArray(body)) { json(res, 400, { error: "The body must be an object." }); return true; }
        if (path.endsWith("/scan")) {
          for (const recipe of recipes.filter((item) => !item.gone)) { recipe.lastSeenAt = now(); broadcast("recipe", { recipe, change: "updated" }); }
          json(res, 200, { found: recipes.filter((recipe) => !recipe.gone).length, proposed: recipeCounts().proposed }); return true;
        }
        if (!Number.isSafeInteger(body.id) || body.id <= 0 || typeof body.hash !== "string" || !/^[a-f0-9]{64}$/.test(body.hash) || !["approve", "reject"].includes(body.decision) || body.confirm !== true) { json(res, 400, { error: "id, hash, decision and confirm: true are required" }); return true; }
        const recipe = recipes.find((item) => item.id === body.id);
        if (!recipe) { json(res, 404, { error: "not found" }); return true; }
        if (recipe.hash !== body.hash || recipe.gone || recipe.state === "unsupported") { json(res, 409, { error: recipe.hash !== body.hash ? "changed since you looked" : recipe.reason || "The recipe source is gone." }); return true; }
        recipe.state = body.decision === "approve" ? "approved" : "rejected"; recipe.decidedAt = now();
        broadcast("recipe", { recipe, change: recipe.state }); json(res, 200, { recipe }); return true;
      }
      if (path.startsWith("/api/services/recipes")) { json(res, 405, { error: "method not allowed" }); return true; }
      if (path.startsWith("/api/services/alerts") && options.alertsMissing) { json(res, 404, { error: "not found" }); return true; }
      if (path === "/api/services/alerts/summary" && req.method === "GET") { json(res, 200, { ...alertCounts(), latestAt: alerts.filter((alert) => alert.state === "open" && !alert.muted).map((alert) => alert.at).sort().at(-1) || null }); return true; }
      if (path === "/api/services/alerts" && req.method === "GET") {
        const state = url.searchParams.get("state") || "open"; const kind = url.searchParams.get("kind"); const machine = url.searchParams.get("machine"); const includeMuted = url.searchParams.get("include") === "muted";
        let rows = alerts.filter((alert) => (state === "all" || alert.state === state) && (!kind || alert.kind === kind) && (!machine || alert.machineId === machine) && (includeMuted || !alert.muted));
        rows = [...rows].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 50));
        json(res, 200, { alerts: rows.slice(0, limit), total: rows.length, counts: { ...alertCounts(), acknowledged: alerts.filter((alert) => alert.state === "acknowledged" && !alert.muted).length, resolved: alerts.filter((alert) => alert.state === "resolved" && !alert.muted).length }, mutes, generatedAt: now() }); return true;
      }
      if ((path === "/api/services/alerts/ack" || path === "/api/services/alerts/mute") && req.method === "POST") {
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { json(res, 403, { error: "cross-origin request refused" }); return true; }
        if (!(req.headers["content-type"] || "").startsWith("application/json")) { json(res, 415, { error: "content type must be application/json" }); return true; }
        let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 4096) { json(res, 413, { error: "body too large" }); return true; } }
        let body: Row; try { body = JSON.parse(raw); } catch { json(res, 400, { error: "Invalid JSON" }); return true; }
        if (path.endsWith("/ack")) {
          const one = Number.isInteger(body?.id) && body.all === undefined && body.kind === undefined;
          const all = body?.all === true && body.id === undefined && (body.kind === undefined || ["new-listener", "new-daemon", "service-down", "domain-origin-down", "exposure-change"].includes(body.kind));
          if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["id", "all", "kind"].includes(key)) || !(one || all)) { json(res, 400, { error: "Invalid acknowledgement request" }); return true; }
          const targets = body.id !== undefined ? alerts.filter((alert) => alert.id === body.id && alert.state === "open") : alerts.filter((alert) => alert.state === "open" && (!body.kind || alert.kind === body.kind));
          if (body.id !== undefined && !targets.length) { json(res, 404, { error: "not found" }); return true; }
          for (const alert of targets) { alert.state = "acknowledged"; alert.acknowledgedAt = now(); broadcastAlert(alert, "acknowledged"); }
          json(res, 200, { acknowledged: targets.length }); return true;
        }
        if (!body || typeof body.key !== "string" || !body.key || body.reason !== undefined && typeof body.reason !== "string" || body.remove !== undefined && body.remove !== true || Object.keys(body).some((key) => !["key", "reason", "remove"].includes(key)) || body.remove === true && Object.keys(body).some((key) => !["key", "remove"].includes(key))) { json(res, 400, { error: "Invalid mute request" }); return true; }
        if (body.remove === true) {
          mutes = mutes.filter((mute) => mute.key !== body.key || mute.source === "file");
          for (const alert of alerts.filter((item) => glob(body.key, item.key))) { alert.muted = mutes.some((mute) => glob(mute.match, alert.key)); broadcastAlert(alert, "muted"); }
        } else {
          if (!mutes.some((mute) => mute.key === body.key && mute.source === "page")) mutes.push({ key: body.key, match: body.key, reason: body.reason || "", source: "page", at: now() });
          for (const alert of alerts.filter((item) => glob(body.key, item.key))) { alert.muted = true; broadcastAlert(alert, "muted"); }
        }
        json(res, 200, { mutes }); return true;
      }
      if (path === "/api/services/actions/plan" && req.method === "POST") {
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { json(res, 403, { error: "cross-origin request refused" }); return true; }
        if (!(req.headers["content-type"] || "").startsWith("application/json")) { json(res, 415, { error: "content type must be application/json" }); return true; }
        let body: Row; try { body = JSON.parse(await new Promise<string>((resolveBody) => { let data = ""; req.on("data", (part) => data += part); req.on("end", () => resolveBody(data)); })); } catch { json(res, 400, { error: "Invalid JSON" }); return true; }
        if (body?.target === "stack") {
          if (options.stacksMissing || options.controlOff) { json(res, 404, { error: "control is off" }); return true; }
          if (typeof body.name !== "string" || typeof body.action !== "string" || Object.keys(body).some((key) => !["target", "name", "action"].includes(key))) { json(res, 400, { error: "Invalid stack plan request" }); return true; }
          if (body.action !== "start") { json(res, 200, { plan: { allowed: false, refusal: "Stacks support Start only.", refusalKind: "unsupported", target: "stack", name: body.name, action: body.action, steps: [], effects: [] } }); return true; }
          const stack = stacks.find((item) => item.name === body.name);
          if (!stack) { json(res, 200, { plan: { allowed: false, refusal: "Unknown stack.", refusalKind: "unknown", target: "stack", name: body.name, action: "start", steps: [], effects: [] } }); return true; }
          const steps = stack.members.map((member: Row) => ({ order: member.order, label: member.label, type: member.type, command: member.type === "service" ? `Start-ScheduledTask -TaskName ${member.label}` : `pnpm run dev`, skipped: member.running === true, allowed: member.available !== false, refusal: member.reason || null }));
          const refused = steps.find((step: Row) => !step.skipped && !step.allowed);
          const alreadyRunning = steps.every((step: Row) => step.skipped);
          const allowed = !refused && !alreadyRunning && !options.planRefusal;
          const refusal = refused ? `${refused.label}: ${refused.refusal}` : alreadyRunning ? "Everything in this stack is already running." : options.planRefusal ? "The action is unavailable in this mock scenario." : null;
          const plan = { allowed, refusal, refusalKind: refused ? "unavailable" : alreadyRunning ? "unavailable" : null, id: allowed ? `p_stack_${stack.name}_${Date.now()}` : null, token: allowed ? `token_stack_${stack.name}_${Date.now()}` : null, expiresAt: new Date(Date.now() + 120000).toISOString(), target: "stack", rowId: 0, name: stack.name, displayName: stack.label, action: "start", machineId: "hub", machineName: "Hub", mechanism: "stack", command: steps.map((step: Row) => step.command).join("\n"), admin: "none", graceful: true, effects: steps.map((step: Row) => `${step.order}. Start ${step.label}${step.order === 2 ? ", then wait for port 4876" : " (scheduled task)"}`), steps };
          if (allowed) plans.set(plan.id!, { ...plan, stackName: stack.name });
          json(res, 200, { plan }); return true;
        }
        if (!body || !["service", "listener", "recipe"].includes(body.target) || !Number.isInteger(body.id) || !["start", "stop", "restart", "disable", "enable"].includes(body.action) || body.hard !== undefined && typeof body.hard !== "boolean" || body.hard && body.action !== "stop" || Object.keys(body).some((key) => !["target", "id", "action", "hard"].includes(key))) { json(res, 400, { error: "Invalid action plan request" }); return true; }
        if (body.target === "recipe") {
          if (options.recipesMissing) { json(res, 404, { error: "not found" }); return true; }
          const recipe = recipes.find((item) => item.id === body.id);
          if (!recipe) { json(res, 404, { error: "not found" }); return true; }
          const allowed = recipe.state === "approved" && !recipe.gone && body.action === "start" && !body.hard && !options.planRefusal;
          const plan = { allowed, refusal: allowed ? null : recipe.gone ? "The recipe source is gone." : "The recipe needs approval and supports Start only.", refusalKind: allowed ? null : "unavailable", id: allowed ? `p_recipe_${recipe.id}_${Date.now()}` : null, token: allowed ? `token_recipe_${recipe.id}_${Date.now()}` : null, expiresAt: new Date(Date.now() + 120000).toISOString(), machineId: "hub", machineName: "Hub", target: "recipe", rowId: recipe.id, name: recipe.name, displayName: recipe.project, action: body.action, hard: false, mechanism: "recipe", command: recipe.command, admin: "none", sudoCommand: null, graceful: true, waitSeconds: 20, effects: [`Runs in ${recipe.cwd}`], whatBreaks: null };
          if (allowed) plans.set(plan.id!, { ...plan, recipeHash: recipe.hash });
          json(res, 200, { plan }); return true;
        }
        const row = (body.target === "service" ? services : listeners).find((entry) => entry.id === body.id);
        if (!row) { json(res, 404, { error: "not found" }); return true; }
        const control = row.control;
        const allowed = (body.action === "start" || !row.control.protected.protected) && control.actions.find((item: Row) => item.action === body.action)?.available;
        const admin = row.control.needsAdmin ? row.machineId === "hub" ? "uac" : "sudo" : "none";
        const refusal = options.planRefusal ? "The action is unavailable in this mock scenario." : allowed ? null : control.protected.protected ? control.protected.reason : control.actions.find((item: Row) => item.action === body.action)?.reason || "This action is unavailable.";
        const planAllowed = !!allowed && !options.planRefusal;
        const plan = { allowed: planAllowed, refusal, refusalKind: planAllowed ? null : control.protected.protected ? "protected" : "unavailable", id: planAllowed ? `p_${body.target}_${body.action}_${body.id}${body.hard ? "_hard" : ""}` : null, token: planAllowed ? `token_${body.id}_${Date.now()}` : null, expiresAt: new Date(Date.now() + 120000).toISOString(), machineId: row.machineId, machineName: row.machineName, target: body.target, rowId: row.id, name: row.name || row.processName, displayName: row.displayName || row.processName, action: body.action, hard: !!body.hard, mechanism: control.mechanism, command: `${body.action === "stop" ? "Stop" : body.action === "start" ? "Start" : body.action === "disable" ? "Disable" : body.action === "enable" ? "Enable" : "Restart"}-Service -Name ${row.name || row.processName}${body.hard ? " -Force" : ""}`, admin, sudoCommand: admin === "sudo" ? `sudo launchctl ${body.action === "stop" ? "kill" : "kickstart"} system/${row.name || row.processName}` : null, graceful: body.action === "stop" && !body.hard, waitSeconds: 20, effects: row.control.protected.protected ? [] : [`Changes ${row.displayName || row.processName || row.name} on ${row.machineName}.`], whatBreaks: row.classification?.whatBreaks || null };
        if (planAllowed) plans.set(plan.id!, plan);
        json(res, 200, { plan }); return true;
      }
      if (path === "/api/services/actions/run" && req.method === "POST") {
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { json(res, 403, { error: "cross-origin request refused" }); return true; }
        if (!(req.headers["content-type"] || "").startsWith("application/json")) { json(res, 415, { error: "content type must be application/json" }); return true; }
        let body: Row; try { body = JSON.parse(await new Promise<string>((resolveBody) => { let data = ""; req.on("data", (part) => data += part); req.on("end", () => resolveBody(data)); })); } catch { json(res, 400, { error: "Invalid JSON" }); return true; }
        if (!body || typeof body.planId !== "string" || typeof body.token !== "string" || body.confirm !== true || Object.keys(body).some((key) => !["planId", "token", "confirm"].includes(key))) { json(res, 400, { error: "Confirmation required" }); return true; }
        if (options.runStatus) { json(res, options.runStatus, { error: options.runStatus === 404 ? "unknown or expired plan" : "changed since the plan" }); return true; }
        const plan = plans.get(body.planId);
        if (!plan || plan.token !== body.token || Date.parse(plan.expiresAt) <= Date.now()) { json(res, 404, { error: "unknown or expired plan" }); return true; }
        plans.delete(body.planId);
        const { target, rowId, action } = plan;
        if (target === "stack") {
          const stack = stacks.find((item) => item.name === plan.stackName);
          if (!stack) { json(res, 409, { error: "changed since the plan" }); return true; }
          json(res, 202, { actionId: nextAction, state: "running" });
          const members = stack.members.filter((member: Row) => member.running !== true);
          const failAtSecond = options.runScenario === "failed";
          const emit = (index: number) => {
            const member = members[index];
            if (!member) {
              members.forEach((item: Row, itemIndex: number) => { item.running = failAtSecond ? itemIndex === 0 : true; });
              stack.state = failAtSecond ? "partial" : "running"; broadcast("stack", { name: stack.name, state: stack.state });
              const record: Row = { id: nextAction++, at: now(), finishedAt: now(), machineId: "hub", target: "stack", rowId: 0, name: stack.name, action: "start", hard: false, mechanism: "stack", command: plan.command, admin: plan.admin, state: failAtSecond ? "failed" : "done", exitCode: failAtSecond ? 1 : 0, message: failAtSecond ? `Started 1 of ${members.length}; stopped at ${members[1]?.label}: Port ${members[1]?.waitPort} did not open within 30 s` : `Started ${stack.members.length} of ${stack.members.length} members` };
              actions.unshift(record); broadcastAction(record); return;
            }
            const record: Row = { id: nextAction++, at: now(), finishedAt: now(), machineId: member.machineId || "hub", target: member.type, rowId: member.type === "recipe" ? 2 : 4, name: member.label, action: "start", hard: false, mechanism: member.type, command: plan.command, admin: "none", state: failAtSecond && index === 1 ? "failed" : "done", exitCode: failAtSecond && index === 1 ? 1 : 0, message: failAtSecond && index === 1 ? "Port 4876 did not open within 30 s" : "Started." };
            actions.unshift(record); broadcastAction(record);
            if (failAtSecond && index === 1) { emit(members.length); return; }
            setTimeout(() => emit(index + 1), 300).unref();
          };
          setTimeout(() => emit(0), 300).unref();
          return true;
        }
        const row = (target === "recipe" ? recipes : target === "service" ? services : listeners).find((entry) => entry.id === rowId);
        if (!row) { json(res, 404, { error: "unknown or expired plan" }); return true; }
        if (target === "recipe" && (row.state !== "approved" || row.gone || row.hash !== plan.recipeHash)) { json(res, 409, { error: "changed since the plan" }); return true; }
        const waiting = plan.admin === "sudo";
        const record: Row = { id: nextAction++, at: now(), finishedAt: null, machineId: row.machineId, target, rowId, name: row.name || row.processName, action, hard: plan.hard, mechanism: plan.mechanism, command: plan.command, admin: plan.admin, state: waiting ? "waiting" : "running", exitCode: null, message: waiting ? "Waiting for the change." : "The action is running." };
        actions.unshift(record); broadcastAction(record);
        if (waiting) { json(res, 200, { actionId: record.id, state: "waiting", sudoCommand: `sudo launchctl ${action} system/${record.name}` }); setTimeout(() => { record.state = "confirmed"; record.finishedAt = now(); record.message = "The change was confirmed."; broadcastAction(record); }, 350).unref(); return true; }
        json(res, 202, { actionId: record.id, state: "running" });
        const failed = options.runScenario === "failed" || !options.runScenario && rowId % 7 === 4;
        const gracefulMiss = action === "stop" && !record.hard && (options.runScenario === "graceful-not-stopped" || !options.runScenario && rowId % 7 === 5);
        const declined = options.runScenario === "declined" && record.admin === "uac";
        setTimeout(() => { record.state = declined ? "declined" : failed || gracefulMiss ? "failed" : "done"; record.finishedAt = now(); record.exitCode = failed ? 1 : 0; record.message = declined ? "The elevation request was declined." : gracefulMiss ? "Still running after 20 s" : failed ? "The mock command failed." : `Finished ${action}.`; broadcastAction(record); if (target === "recipe" && record.state === "done") { row.running = row.port === null ? null : true; broadcast("recipe", { recipe: row, change: "updated" }); } }, 350).unref();
        return true;
      }
      if (path === "/api/services/actions" && req.method === "GET") { json(res, 200, { items: actions.slice(0, Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50))), generatedAt: now() }); return true; }
      if (path === "/api/services/protected" && req.method === "GET") { json(res, 200, { groups: protectedGroups, custom: [{ machine: "*", match: "Backup schedule", reason: "Keep the scheduled backup available." }], file: ".scout-data/protected.json", generatedAt: now() }); return true; }
      if (path === "/api/services/uninstall" && req.method === "GET") {
        const target = url.searchParams.get("target"); const rowId = Number(url.searchParams.get("id")); const row = (target === "service" ? services : target === "listener" ? listeners : []).find((entry) => entry.id === rowId);
        if (!row) { json(res, 404, { error: "not found" }); return true; }
        json(res, 200, { available: true, title: `How to remove ${row.displayName || row.name || row.processName}`, steps: ["Open the machine settings for installed services.", `Choose ${row.displayName || row.name || row.processName} and remove it.`], leftovers: [], note: "Scout never runs an uninstall.", command: null }); return true;
      }
      if ((path === "/api/services/actions/plan" || path === "/api/services/actions/run") && req.method !== "GET") { json(res, 405, { error: "method not allowed" }); return true; }
      if (path === "/api/services/description" && req.method === "POST") {
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { json(res, 403, { error: "cross-origin request refused" }); return true; }
        if (!(req.headers["content-type"] || "").startsWith("application/json")) { json(res, 415, { error: "content type must be application/json" }); return true; }
        let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 4096) { json(res, 413, { error: "body too large" }); return true; } }
        let body: Row; try { body = JSON.parse(raw); } catch { json(res, 400, { error: "Invalid JSON" }); return true; }
        if (!body || !["service", "listener"].includes(body.target) || !Number.isInteger(body.id) || Object.keys(body).some((key) => !["target", "id", "text"].includes(key)) || !(body.text === null || typeof body.text === "string")) { json(res, 400, { error: "Invalid description request" }); return true; }
        const row = (body.target === "service" ? services : listeners).find((item) => item.id === body.id);
        if (!row) { json(res, 404, { error: "not found" }); return true; }
        if (body.text !== null && body.text !== "" && (body.text.length < 8 || body.text.length > 400 || /[\r\n\x00-\x1f\x7f]/.test(body.text))) { json(res, 400, { error: "Description must be 8 to 400 characters with no line breaks or control characters." }); return true; }
        const subject = row.description?.subject || (body.target === "service" ? `service:${row.kind}:${row.name}` : `listener:${row.machineId}:${row.containerName || row.processName || row.processPath}`);
        const related = (body.target === "service" ? services : listeners).filter((candidate) => (candidate.description?.subject || (body.target === "service" ? `service:${candidate.kind}:${candidate.name}` : `listener:${candidate.machineId}:${candidate.containerName || candidate.processName || candidate.processPath}`)) === subject);
        for (const candidate of related) {
          if (body.text === null || body.text === "") candidate.description = automaticDescriptions.get(`${body.target}:${candidate.id}`) || null;
          else candidate.description = { text: body.text, source: "hand", generated: false, confidence: null, at: now(), subject, hasHandEdit: true, evidence: [] };
        }
        json(res, 200, { description: row.description }); return true;
      }
      if (path === "/api/services/descriptions/refresh" && req.method === "POST") {
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { json(res, 403, { error: "cross-origin request refused" }); return true; }
        if (!(req.headers["content-type"] || "").startsWith("application/json")) { json(res, 415, { error: "content type must be application/json" }); return true; }
        let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 4096) { json(res, 413, { error: "body too large" }); return true; } }
        let body: Row; try { body = JSON.parse(raw); } catch { json(res, 400, { error: "Invalid JSON" }); return true; }
        if (!body || !["public", "project"].includes(body.scope) || Object.keys(body).length !== 1) { json(res, 400, { error: "Invalid description refresh request" }); return true; }
        if (options.noModels) { json(res, 404, { error: "descriptions model is off" }); return true; }
        if (describeState.state === "running") { json(res, 200, { started: false, reason: "running" }); return true; }
        const scope = body.scope as "public" | "project";
        const total = scope === "project" ? 3 : descriptionOverview().public.todo;
        describeState = { scope, state: "running", done: 0, total, applied: 0, error: null, at: now() };
        broadcast("describe", describeState); json(res, 202, { started: true });
        describeTimer = setTimeout(() => {
          const candidates = [...services.filter((row) => !row.goneAt && !row.classification.hidden && !row.description).map((row) => ({ row, target: "service" })), ...listeners.filter((row) => !row.goneAt && !row.classification.hidden && !row.description).map((row) => ({ row, target: "listener" }))];
          for (const candidate of candidates.slice(0, 2)) {
            const row = candidate.row;
            const name = row.displayName || row.processName || row.containerName;
            row.description = { text: `${name} manages its local ${candidate.target} role.`, source: "public", generated: true, confidence: 0.75, at: now(), subject: candidate.target === "service" ? `service:${row.kind}:${row.name}` : `listener:${row.machineId}:${row.containerName || row.processName || row.processPath}`, hasHandEdit: false, evidence: [] };
          }
          describeState = { ...describeState, state: "done", done: total, applied: scope === "project" ? 3 : Math.min(2, candidates.length), at: now() };
          broadcast("describe", describeState); describeTimer = null;
        }, 1600);
        describeTimer.unref(); return true;
      }
      if (path === "/api/services/routes/refresh" && req.method === "POST") {
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { json(res, 403, { error: "cross-origin request refused" }); return true; }
        if (!(req.headers["content-type"] || "").startsWith("application/json")) { json(res, 415, { error: "content type must be application/json" }); return true; }
        let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 4096) { json(res, 413, { error: "body too large" }); return true; } }
        try { JSON.parse(raw); } catch (error) { json(res, 400, { error: (error as Error).message }); return true; }
        if (edgeTimer) { json(res, 200, { started: false, reason: "running" }); return true; }
        json(res, 202, { started: true }); edgeTimer = setTimeout(() => { edgeTimer = null; edge.state = "fresh"; edge.lastReadAt = now(); edge.error = null; broadcast("edge", { state: "fresh", lastReadAt: edge.lastReadAt, error: null, changed: false }); }, 6000); edgeTimer.unref(); return true;
      }
      if (path === "/api/services/refresh" && req.method === "POST") {
        if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) { json(res, 403, { error: "cross-origin request refused" }); return true; }
        if (!(req.headers["content-type"] || "").startsWith("application/json")) { json(res, 415, { error: "content type must be application/json" }); return true; }
        let raw = "";
        for await (const chunk of req) { raw += chunk; if (raw.length > 4096) { json(res, 413, { error: "body too large" }); return true; } }
        let body: Row;
        try { body = JSON.parse(raw); } catch { json(res, 400, { error: "Invalid JSON" }); return true; }
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some((key) => !["machineId", "slow"].includes(key)) || body.slow !== undefined && typeof body.slow !== "boolean" || body.machineId !== undefined && !machines.includes(body.machineId)) { json(res, 400, { error: "Invalid refresh request" }); return true; }
        const targets = body.machineId ? [body.machineId] : machines;
        if (targets.some((id: string) => probes.has(id))) { json(res, 200, { started: false, reason: "running" }); return true; }
        for (const id of targets) {
          const machine = machineRows.find((row) => row.id === id)!;
          machine.live = { ...machine.live, state: "fresh", lastLiveAt: now(), error: null };
          broadcast("machine", { id, ...machine.live });
          if (body.slow) startProbe(id);
        }
        json(res, 202, { started: true, machines: targets }); return true;
      }
      if (req.method !== "GET") { json(res, 405, { error: "method not allowed" }); return true; }
      if (path === "/api/services/live") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        streams.add(res);
        send(res, "hello", { machines: machineRows.map((machine) => ({ id: machine.id, ...machine.live })), edge: { state: edge.state, lastReadAt: edge.lastReadAt, error: edge.error }, describe: describeState, actions: { running: actions.filter((item) => item.state === "running").length }, ...(options.recipesMissing ? {} : { recipes: (({ proposed, approved }) => ({ proposed, approved }))(recipeCounts()) }), alerts: alertCounts(), ...(options.healthMissing ? {} : { health: { down: healthCounts().down, failing: healthCounts().failing, expiring: healthTargets.filter((target) => target.tlsDaysLeft != null && target.tlsDaysLeft <= 14).length } }), ...(!options.stacksMissing ? { stacks: { total: stacks.length, running: stacks.filter((stack) => stack.state === "running").length } } : {}) });
        for (const alert of alerts) send(res, "alert", { alert, change: alert.state === "resolved" ? "resolved" : alert.state === "acknowledged" ? "acknowledged" : alert.muted ? "muted" : "created" });
        if (!startProbe("hub")) for (const probe of probes.values()) send(res, "probe", probe);
        watch();
        const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 15000); heartbeat.unref();
        res.on("close", () => { clearInterval(heartbeat); streams.delete(res); if (!streams.size && changedTimer) { clearInterval(changedTimer); changedTimer = null; } });
        return true;
      }
      if (path === "/api/services/routes") json(res, 200, routeRows(url.searchParams));
      else if (path === "/api/services/routes/overview") json(res, 200, routeOverview());
      else if (path === "/api/services/descriptions/overview") json(res, 200, descriptionOverview());
      else if (path === "/api/services" || path === "/api/listeners") json(res, 200, response(path === "/api/services" ? "services" : "listeners", url.searchParams));
      else if (path === "/api/services/overview") json(res, 200, overview());
      else if (path === "/api/services/events") json(res, 200, { events: events.filter((event) => !url.searchParams.get("machine") || event.machineId === url.searchParams.get("machine")).slice(0, Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50))) });
      else json(res, 404, { error: "Not found" });
      return true;
    },
  };
}

function createDiscoveryMock() {
  const proposal = { id: 1001, kind: "dependency_proposal", subject: { from: { ecosystem: "npm", key: "language-server" }, to: { ecosystem: "brew", key: "compiler" }, kind: "runtime", constraint: ">=5 <6", together: true, confidence: "high", evidence: "The language server requires the compiler's matching major version.", machines: ["mini"] }, packages: [{ name: "Language server", ecosystem: "npm", key: "language-server", installs: [] }, { name: "Compiler", ecosystem: "brew", key: "compiler", installs: [] }] };
  let pending = true;
  return async (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, path: string): Promise<boolean> => {
    if (path === "/dependency-cards.js" && req.method === "GET") {
      const bytes = await readFile(resolve(publicDir, "dependency-cards.js"));
      res.writeHead(200, { "content-type": "text/javascript" }); res.end(bytes); return true;
    }
    if (path === "/api/proposals" && req.method === "GET") { json(res, 200, [...proposals.map((p) => ({ ...p, kind: "merge_proposal" })), ...(pending ? [proposal] : [])]); return true; }
    if (req.method !== "POST" || !["/api/dependencies/discover", "/api/proposals/1001"].includes(path)) return false;
    if (!isLoopbackHost(req.headers.host)) { json(res, 421, { error: "misdirected request" }); return true; }
    if (req.headers.origin && !isLoopbackHost(URL.canParse(req.headers.origin) ? new URL(req.headers.origin).host : undefined)) { json(res, 403, { error: "cross-origin request refused" }); return true; }
    if (!(req.headers["content-type"] ?? "").startsWith("application/json")) { json(res, 415, { error: "content type must be application/json" }); return true; }
    let raw = "";
    for await (const chunk of req) { raw += chunk; if (raw.length > 4096) { json(res, 413, { error: "body too large" }); return true; } }
    try {
      const body = JSON.parse(raw);
      if (path === "/api/dependencies/discover") {
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) throw new Error("body must be {}");
        json(res, 200, { status: "ok", proposed: pending ? 1 : 0, skipped: pending ? 0 : 1, omitted: 0 });
      } else {
        if (typeof body?.accept !== "boolean") throw new Error("accept must be a boolean");
        pending = false; json(res, 200, { ok: true });
      }
    } catch (error) { json(res, 400, { error: (error as Error).message }); }
    return true;
  };
}

const outageConfig: { checks: Record<string, boolean>; machines: Record<string, boolean>; items: Record<string, boolean>; pausedUntil: string | null; fileError: string | null } = { checks: { machine: true, url: true, service: true }, machines: {}, items: {}, pausedUntil: null, fileError: null };

function outagesMock(at: string) {
  const ago = (minutes: number) => new Date(Date.parse(at) - minutes * 60_000).toISOString();
  const outages = [
    { id: 3, kind: "service", state: "not-running", label: "Cogitator on Hub", startedAt: ago(14), endedAt: null, durationMs: 14 * 60_000, detail: "Stopped." },
    { id: 2, kind: "machine", state: "hung", label: "Server", startedAt: ago(500), endedAt: ago(380), durationMs: 120 * 60_000, detail: "The ssh port accepted a connection but sent no greeting." },
    { id: 1, kind: "monitor-gap", state: "monitor-gap", label: "Hub", startedAt: ago(2000), endedAt: ago(1960), durationMs: 40 * 60_000, detail: "Scout was not running." },
  ];
  const items = [
    { kind: "machine", key: "machine:server", machineId: "server", label: "Server", watched: outageConfig.machines.server !== false, failures: 0 },
    { kind: "url", key: "url:example.test", machineId: null, label: "example.test", watched: outageConfig.items["url:example.test"] !== false, failures: 0 },
    { kind: "service", key: "service:hub:cogitator", machineId: "hub", label: "Cogitator on Hub", watched: outageConfig.items["service:hub:cogitator"] !== false, failures: 2 },
  ];
  return { outages, open: 1, items, config: outageConfig, watch: { running: true, intervalMs: 120_000, lastCycleAt: ago(1), paused: Boolean(outageConfig.pausedUntil), channels: { discord: false, desktop: true } }, generatedAt: at };
}
