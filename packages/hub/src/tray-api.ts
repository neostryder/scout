import type { IncomingMessage, ServerResponse } from "node:http";
import { parseTrayRules, programFlags, trayResponse, writeTrayRules, type Db, type ProvenanceContext, type TrayFile, type TrayStack } from "@scout/core";
import type { LiveSchedule } from "./live.ts";

type SendJson = (res: ServerResponse, status: number, value: unknown) => void;

const MAX_BODY = 65_536;

export interface TrayDeps {
  rulesPath: string;
  read: () => TrayFile;
  stacks: () => TrayStack[];
  provenance: () => ProvenanceContext;
  live?: LiveSchedule | undefined;
  control: { context: () => import("@scout/core").ProtectedContext };
}

async function readBody(req: IncomingMessage, res: ServerResponse, hostAllowed: (host: string | undefined) => boolean, json: SendJson): Promise<unknown | undefined> {
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
    raw += chunk;
    if (raw.length > MAX_BODY) {
      json(res, 413, { error: "body too large" });
      return undefined;
    }
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    json(res, 400, { error: "body is not valid JSON" });
    return undefined;
  }
}

/** The panel's read model and its hide rules. The panel polls /api/tray with the last version in If-None-Match. */
export async function trayApi(db: Db, req: IncomingMessage, url: URL, res: ServerResponse, hostAllowed: (host: string | undefined) => boolean, json: SendJson, deps: TrayDeps): Promise<void> {
  if (url.pathname === "/api/tray") {
    if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method not allowed" });
    const file = deps.read();
    const states = new Map((deps.live?.status() ?? []).map((s) => [s.id, s.state]));
    const provenance = deps.provenance();
    const body = trayResponse(db, file.rules, {
      context: deps.control.context(),
      stacks: deps.stacks(),
      mine: (row) => programFlags(row.machineId, row.path, row.ports[0] ?? null, provenance).some((flag) => flag.kind === "mine"),
      reachable: (id) => { const state = states.get(id); return state === undefined || state === "never" ? null : state === "fresh" || state === "stale"; },
    });
    const etag = `"${body.version}"`;
    res.setHeader("ETag", etag);
    res.setHeader("Cache-Control", "no-cache");
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304);
      res.end();
      return;
    }
    return json(res, 200, { ...body, fileError: file.fileError });
  }
  if (url.pathname === "/api/tray/rules") {
    if (req.method === "GET" || req.method === "HEAD") {
      const file = deps.read();
      return json(res, 200, { rules: file.rules, fileError: file.fileError });
    }
    if (req.method !== "PUT") return json(res, 405, { error: "method not allowed" });
    const body = await readBody(req, res, hostAllowed, json);
    if (body === undefined) return;
    try {
      const rules = writeTrayRules(deps.rulesPath, (body as { rules?: unknown } | null)?.rules ?? body);
      return json(res, 200, { rules, fileError: null });
    } catch (err) {
      return json(res, 400, { error: (err as Error).message });
    }
  }
  if (url.pathname === "/api/tray/hide") {
    // The panel's right-click menu: hide one row, or pin it back, without sending the whole rules document.
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
    const body = await readBody(req, res, hostAllowed, json) as { machine?: unknown; key?: unknown; name?: unknown; undo?: unknown } | null | undefined;
    if (body === undefined) return;
    if (!body || typeof body.machine !== "string" || typeof body.name !== "string" || body.name === "") return json(res, 400, { error: "machine and name are required" });
    try {
      const { rules } = deps.read();
      const next = parseTrayRules(structuredClone(rules));
      const exact = body.name.replace(/[*]/g, "");
      next.hide.names = next.hide.names.filter((rule) => !(rule.machine === body.machine && rule.match === exact));
      next.pins = next.pins.filter((pin) => !(typeof body.key === "string" && pin.machine === body.machine && pin.key === body.key));
      if (body.undo === true) {
        if (typeof body.key === "string") next.pins.push({ machine: body.machine, key: body.key });
      } else {
        next.hide.names.push({ machine: body.machine, match: exact });
      }
      return json(res, 200, { rules: writeTrayRules(deps.rulesPath, next), fileError: null });
    } catch (err) {
      return json(res, 400, { error: (err as Error).message });
    }
  }
  return json(res, 404, { error: "no such route" });
}
