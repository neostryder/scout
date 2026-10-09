import type { IncomingMessage, ServerResponse } from "node:http";
import { deleteFilter, filterView, listSavedFilters, renameFilter, saveFilter, type Db } from "@scout/core";

type SendJson = (res: ServerResponse, status: number, value: unknown) => void;
const MAX_BODY = 32768;

export async function filtersApi(db: Db, req: IncomingMessage, url: URL, res: ServerResponse, hostAllowed: (host: string | undefined) => boolean, json: SendJson): Promise<void> {
  const path = url.pathname;
  if (!["/api/filters", "/api/filters/rename", "/api/filters/delete"].includes(path)) return json(res, 404, { error: "no such route" });
  if (req.method === "GET" || req.method === "HEAD") {
    if (path !== "/api/filters") return json(res, 405, { error: "method not allowed" });
    try {
      const view = filterView(url.searchParams.get("view"));
      return json(res, 200, listSavedFilters(db).filter((filter) => filter.view === view));
    } catch (err) { return json(res, 400, { error: (err as Error).message }); }
  }
  if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
  const origin = req.headers.origin;
  if (origin !== undefined && !hostAllowed(URL.canParse(origin) ? new URL(origin).host : undefined)) return json(res, 403, { error: "cross-origin request refused" });
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return json(res, 415, { error: "content type must be application/json" });
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) return json(res, 413, { error: "body too large" });
  }
  try {
    const body = JSON.parse(raw) as { name: string; view: unknown; params: Record<string, string>; from: string; to: string } | null;
    const view = filterView(body?.view);
    if (!body) throw new Error("body must be an object");
    if (path === "/api/filters") return json(res, 200, saveFilter(db, { name: body.name, view, spec: body.params }));
    if (path === "/api/filters/rename") return json(res, 200, renameFilter(db, body.from, body.to, view));
    deleteFilter(db, body.name, view);
    return json(res, 200, { ok: true });
  } catch (err) { json(res, 400, { error: (err as Error).message }); }
}
