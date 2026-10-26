import type { IncomingMessage, ServerResponse } from "node:http";
import { claimCompetitorRun, completeCompetitorRun, failCompetitorRun, dossierStub, getCandidate, holdStats, listCandidates, listOwnerDecisions, listPassedOver, listCompetitorRuns, listCompetitors, nearestWithCloseness, releaseHeld, setCandidateStatus, type Candidate, type Db, type RunState } from "@scout/core";
import type { CompetitorSchedule } from "./competitor-schedule.ts";
import type { DiscoverySchedule } from "./discovery-schedule.ts";

/** Ranks competitors by meaning for the search; the hub passes MiniMax, a test passes a stub. */
export type SemanticRanker = (query: string, items: { id: string; name: string; org: string | null; products: string[]; about: string | null }[]) => Promise<string[]>;

type SendJson = (res: ServerResponse, status: number, value: unknown) => void;

const MAX_BODY = 16_384;
const EXAMPLES_PER_SIDE = 2;

/** Each candidate with the owner's closest earlier decisions on each side, so the page can say what it reads like. A project is never its own example. */
function withExamples(db: Db, candidates: Candidate[]): (Candidate & { examples: { verdict: string; name: string; closeness: number }[] })[] {
  const decisions = listOwnerDecisions(db);
  return candidates.map((candidate) => ({
    ...candidate,
    examples: nearestWithCloseness(candidate.judgement?.summary ?? candidate.description, candidate.topics, decisions, EXAMPLES_PER_SIDE, candidate.id)
      .filter((item) => item.closeness > 0).map((item) => ({ verdict: item.decision.verdict, name: item.decision.name, closeness: Math.round(item.closeness * 100) / 100 })),
  }));
}
const RUN_STATES = new Set<RunState>(["pulling", "queued", "claimed", "done", "failed"]);

function httpError(message: string): number {
  if (message === "no such run") return 404;
  if (message === "run is not queued" || message === "run is not queued or claimed" || message === "run is not active" || message === "a run is already active") return 409;
  return 400;
}

async function readBody(req: IncomingMessage, res: ServerResponse, hostAllowed: (host: string | undefined) => boolean, json: SendJson): Promise<Record<string, unknown> | undefined> {
  const origin = req.headers.origin;
  if (origin !== undefined && !hostAllowed(URL.canParse(origin) ? new URL(origin).host : undefined)) {
    json(res, 403, { error: "cross-origin request refused" });
    return undefined;
  }
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
    json(res, 415, { error: "content type must be application/json" });
    return undefined;
  }
  let raw = "";
  for await (const chunk of req) {
    raw += String(chunk);
    if (raw.length > MAX_BODY) {
      json(res, 413, { error: "body too large" });
      return undefined;
    }
  }
  try {
    const body = JSON.parse(raw || "{}") as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("body must be an object");
    return body as Record<string, unknown>;
  } catch (error) {
    json(res, 400, { error: (error as Error).message });
    return undefined;
  }
}

function only(body: Record<string, unknown>, keys: string[]): void {
  for (const key of Object.keys(body)) if (!keys.includes(key)) throw new Error(`unknown field ${key}`);
}

function runNumber(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error("run id must be a positive integer");
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("run id must be a positive integer");
  return id;
}

export async function competitorsApi(db: Db, req: IncomingMessage, url: URL, res: ServerResponse, hostAllowed: (host: string | undefined) => boolean, json: SendJson, schedule: CompetitorSchedule | undefined, discovery?: DiscoverySchedule, semantic?: SemanticRanker): Promise<void> {
  const path = url.pathname;
  const read = req.method === "GET" || req.method === "HEAD";
  if (path === "/api/competitors") {
    if (!read) return json(res, 405, { error: "method not allowed" });
    const status = schedule?.status() ?? { configured: false, intervalSeconds: 21_600, checkedAt: null, running: false };
    return json(res, 200, { configured: status.configured, intervalSeconds: status.intervalSeconds, checkedAt: status.checkedAt, competitors: status.configured ? listCompetitors(db) : [] });
  }
  if (path === "/api/competitors/gate" && read) {
    if (!schedule) return json(res, 404, { error: "competitor watch is off" });
    try { return json(res, 200, schedule.gateSettings()); } catch (error) { return json(res, 400, { error: (error as Error).message }); }
  }
  if (path === "/api/competitors/candidates") {
    if (!read) return json(res, 405, { error: "method not allowed" });
    return json(res, 200, { configured: discovery !== undefined, discovery: discovery?.status() ?? null, candidates: withExamples(db, listCandidates(db)), passedOver: withExamples(db, listPassedOver(db)), holds: holdStats(db) });
  }
  const candidatePath = /^\/api\/competitors\/candidates\/([^/]+)\/(track|dismiss|release)$/.exec(path);
  const dossierPath = /^\/api\/competitors\/([^/]+)\/dossier$/.exec(path);
  if (dossierPath?.[1]) {
    if (!read) return json(res, 405, { error: "method not allowed" });
    const dossier = schedule?.readDossier(decodeURIComponent(dossierPath[1])) ?? null;
    return dossier ? json(res, 200, dossier) : json(res, 404, { error: "this competitor has no dossier folder to read" });
  }
  const runPath = /^\/api\/competitors\/runs\/(\d+)\/(claim|complete|fail)$/.exec(path);
  const updatePath = /^\/api\/competitors\/([^/]+)\/update$/.exec(path);
  const watchPath = /^\/api\/competitors\/([^/]+)\/watch$/.exec(path);
  if (path === "/api/competitors/runs") {
    if (!read) return json(res, 405, { error: "method not allowed" });
    const raw = url.searchParams.get("state");
    if (raw === null || raw.trim() === "") return json(res, 400, { error: "state is required" });
    const states = [...new Set(raw.split(",").map((item) => item.trim()).filter(Boolean))];
    if (!states.length || states.some((state) => !RUN_STATES.has(state as RunState))) return json(res, 400, { error: "state must be pulling, queued, claimed, done, or failed" });
    return json(res, 200, listCompetitorRuns(db, states as RunState[]));
  }
  const repoPath = /^\/api\/competitors\/([^/]+)\/repo$/.exec(path);
  const removePath = /^\/api\/competitors\/([^/]+)\/remove$/.exec(path);
  const known = path === "/api/competitors/discover" || path === "/api/competitors/semantic" || candidatePath || path === "/api/competitors/check" || path === "/api/competitors/gate" || runPath || updatePath || watchPath || repoPath || removePath;
  if (req.method !== "POST") return json(res, known ? 405 : 404, { error: known ? "method not allowed" : "no such route" });
  const body = await readBody(req, res, hostAllowed, json);
  if (!body) return;
  const now = new Date().toISOString();
  try {
    if (path === "/api/competitors/check") {
      if (!schedule) return json(res, 404, { error: "competitor watch is off" });
      only(body, ["id"]);
      const id = body["id"];
      if (id !== undefined && (typeof id !== "string" || id.length < 1 || id.length > 80)) throw new Error("id must be a string up to 80 characters");
      const result = schedule.runNow(typeof id === "string" ? id : undefined);
      return result.started ? json(res, 202, { started: true }) : json(res, 409, { error: result.reason });
    }
    if (path === "/api/competitors/semantic") {
      if (!semantic) return json(res, 404, { error: "similar-meaning search is off" });
      only(body, ["query"]);
      const query = body["query"];
      if (typeof query !== "string" || !query.trim() || query.length > 200) throw new Error("query must be text of up to 200 characters");
      const items = listCompetitors(db).map((row) => ({ id: row.id, name: row.name, org: row.org, products: row.flags, about: row.about }));
      try { return json(res, 200, { ids: await semantic(query, items) }); } catch (error) { return json(res, 502, { error: `similar-meaning search failed: ${(error as Error).message}` }); }
    }
    if (path === "/api/competitors/discover") {
      if (!discovery) return json(res, 404, { error: "competitor discovery is off" });
      only(body, []);
      const result = discovery.runNow();
      return result.started ? json(res, 202, { started: true }) : json(res, 409, { error: result.reason });
    }
    if (candidatePath?.[1] && candidatePath[2]) {
      only(body, []);
      const id = decodeURIComponent(candidatePath[1]);
      const candidate = getCandidate(db, id);
      if (!candidate) return json(res, 404, { error: "no such candidate" });
      const rescue = candidatePath[2] === "track" && candidate.passedOver && candidate.status === "dismissed";
      if (candidatePath[2] === "release") {
        try { return json(res, 200, releaseHeld(db, id)); } catch (error) { return json(res, 409, { error: (error as Error).message }); }
      }
      if (candidate.status !== "new" && !rescue) return json(res, 409, { error: `this candidate is already ${candidate.status}` });
      if (candidatePath[2] === "track") {
        if (!schedule) return json(res, 404, { error: "competitor watch is off" });
        const near = nearestWithCloseness(candidate.judgement?.summary ?? candidate.description, candidate.topics, listOwnerDecisions(db), EXAMPLES_PER_SIDE, candidate.id).filter((item) => item.closeness > 0);
        const added = await schedule.addCompetitor({ id: candidate.id, name: candidate.name, org: candidate.org, remoteUrl: candidate.repoUrl, packageUrl: candidate.url, batch: candidate.foundAt, dossier: dossierStub(candidate, near, now) });
        return json(res, 200, { ...setCandidateStatus(db, id, "tracked", now), mirror: added.mirror, mirrorNote: added.note, dossier: added.dossier !== null });
      }
      return json(res, 200, setCandidateStatus(db, id, "dismissed", now));
    }
    if (path === "/api/competitors/gate") {
      if (!schedule) return json(res, 404, { error: "competitor watch is off" });
      only(body, ["id", "set", "clear"]);
      const id = body["id"];
      if (id !== undefined && (typeof id !== "string" || id.length < 1 || id.length > 80)) throw new Error("id must be a string up to 80 characters");
      const set = body["set"];
      if (set !== undefined && (!set || typeof set !== "object" || Array.isArray(set))) throw new Error("set must be an object");
      const clear = body["clear"];
      if (clear !== undefined && (!Array.isArray(clear) || clear.some((item) => typeof item !== "string"))) throw new Error("clear must be a list of field names");
      return json(res, 200, schedule.updateGate({ ...(typeof id === "string" ? { id } : {}), ...(set ? { set: set as Record<string, unknown> } : {}), ...(clear ? { clear: clear as string[] } : {}) }));
    }
    if (watchPath?.[1]) {
      if (!schedule) return json(res, 404, { error: "competitor watch is off" });
      only(body, ["watch"]);
      if (!("watch" in body)) throw new Error("watch is required, or null to remove it");
      schedule.updateWatch(decodeURIComponent(watchPath[1]), body["watch"]);
      return json(res, 200, { ok: true });
    }
    if (repoPath?.[1]) {
      if (!schedule) return json(res, 404, { error: "competitor watch is off" });
      only(body, ["repo"]);
      if (!("repo" in body)) throw new Error("repo is required");
      return json(res, 200, { ok: true, ...schedule.updateRepo(decodeURIComponent(repoPath[1]), body["repo"]) });
    }
    if (removePath?.[1]) {
      if (!schedule) return json(res, 404, { error: "competitor watch is off" });
      only(body, []);
      schedule.removeCompetitor(decodeURIComponent(removePath[1]));
      return json(res, 200, { ok: true });
    }
    if (updatePath?.[1]) {
      if (!schedule) return json(res, 404, { error: "competitor watch is off" });
      only(body, []);
      const result = schedule.requestUpdate(decodeURIComponent(updatePath[1]));
      return result.status === 202 ? json(res, 202, result.run) : json(res, result.status, { error: result.error });
    }
    if (runPath?.[1] && runPath[2]) {
      const id = runNumber(runPath[1]);
      if (runPath[2] === "claim") {
        only(body, ["by"]);
        const by = body["by"];
        if (typeof by !== "string" || by.trim().length < 1 || by.trim().length > 80) throw new Error("by must be text up to 80 characters");
        return json(res, 200, claimCompetitorRun(db, id, by.trim(), now));
      }
      if (runPath[2] === "complete") {
        only(body, ["resultPath", "summary", "analyzedVersion"]);
        const resultPath = body["resultPath"];
        const summary = body["summary"];
        const analyzedVersion = body["analyzedVersion"];
        if (typeof resultPath !== "string" || resultPath.length < 1 || resultPath.length > 1024) throw new Error("resultPath must be text up to 1024 characters");
        if (typeof summary !== "string" || summary.length > 2000) throw new Error("summary must be text up to 2000 characters");
        if (analyzedVersion !== undefined && (typeof analyzedVersion !== "string" || analyzedVersion.length < 1 || analyzedVersion.length > 80)) throw new Error("analyzedVersion must be text up to 80 characters");
        return json(res, 200, completeCompetitorRun(db, id, { resultPath, summary, ...(typeof analyzedVersion === "string" ? { analyzedVersion } : {}) }, now));
      }
      only(body, ["error"]);
      const message = body["error"];
      if (typeof message !== "string" || message.trim().length < 1 || message.length > 2000) throw new Error("error must be text up to 2000 characters");
      return json(res, 200, failCompetitorRun(db, id, message.trim(), now));
    }
    return json(res, 404, { error: "no such route" });
  } catch (error) {
    const message = (error as Error).message;
    json(res, httpError(message), { error: message });
  }
}
