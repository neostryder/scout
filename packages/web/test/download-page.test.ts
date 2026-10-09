import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createMockHub, installs, jobs } from "../dev/mock-hub.ts";

class Element {
  tag: string;
  attrs: Record<string, any>;
  children: any[];
  textContent = "";
  disabled = false;
  open = false;
  constructor(tag = "div", attrs: Record<string, any> = {}, children: any[] = []) { this.tag = tag; this.attrs = attrs; this.children = children.flat(Infinity); }
  replaceChildren(...children: any[]) { this.children = children.flat(Infinity); }
  append(...children: any[]) { this.children.push(...children); }
  setAttribute(key: string, value: any) { this.attrs[key] = value; }
  removeAttribute(key: string) { delete this.attrs[key]; }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
const filePlan = { installId: 7, machineId: "mini", name: "Demo", kind: "file", url: "https://example.test/Demo.dmg", fileName: "Demo.dmg", size: 123, sha256: "a".repeat(64), source: "github", folder: "~/Downloads", warnings: [], allowed: true, refusal: null };
function page(fetcher: (...args: any[]) => Promise<any>) {
  const elements = new Map<string, Element>();
  const byId = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const opened: any[][] = [];
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/^import .*\n/gm, "").split('\ndocument.querySelectorAll("[data-view]").forEach')[0]!;
  const context = createContext({ $: byId, h: (tag: string, attrs: Record<string, any>, ...children: any[]) => new Element(tag, attrs, children), marked: (text: string) => text, safeUrl: (url: string) => url.startsWith("https:") ? url : null, defaultDir: () => "asc", location: { search: "", pathname: "/" }, URLSearchParams, document: { addEventListener: () => {} }, window: { open: (...args: any[]) => opened.push(args) }, fetch: fetcher, row: { installId: 7, name: "Demo", machineId: "mini", downloadUrl: filePlan.url, updatable: false }, button: new Element("button") });
  runInContext(source, context);
  runInContext("pollJobs = async () => {}; load = async () => {};", context);
  return { context, byId, opened, run: (text: string) => runInContext(text, context) };
}
function allText(node: any): string { return node instanceof Element ? [node.textContent, ...node.children.map(allText)].join(" ") : String(node ?? ""); }

test("download page displays a busy button and a labelled target confirmation", async () => {
  let finish!: (value: any) => void;
  const p = page(async () => new Promise((resolve) => { finish = resolve; }));
  const pending = p.run("startDownload(row, button)");
  assert.equal(p.context.button.disabled, true);
  assert.equal(p.context.button.textContent, "Checking...");
  assert.equal(p.context.button.attrs["aria-busy"], "true");
  finish({ ok: true, json: async () => filePlan });
  await pending;
  assert.equal(p.byId("confirm").open, true);
  assert.equal(p.byId("confirm-submit").textContent, "Download to mini");
  assert.equal(p.byId("confirm-submit").disabled, false);
  const text = allText(p.byId("confirm-body"));
  for (const value of ["Demo.dmg", "github", "123 bytes", "checksum from github", "mini", "~/Downloads"]) assert.ok(text.includes(value));
  assert.equal(p.context.button.disabled, false);
  const button = p.run("updateRow(row)").children.at(-1).children[0];
  assert.equal(button.tag, "button");
  assert.equal(button.attrs.type, "button");
  assert.equal(button.attrs["aria-label"], "Download Demo to mini");
  assert.ok(readFileSync(new URL("../public/index.html", import.meta.url), "utf8").includes('<dialog id="confirm" aria-labelledby="confirm-title">'));
});

test("download page posts the shown metadata and keeps update confirmation independent", async () => {
  const calls: { url: string; body: any }[] = [];
  const p = page(async (url, options) => { calls.push({ url, body: options?.body ? JSON.parse(options.body) : null }); return { ok: true, json: async () => url.startsWith("/api/updates/") ? { installId: 7, machineId: "mini", name: "Demo", allowed: true, from: "1.0", to: "2.0", command: "brew upgrade demo" } : filePlan }; });
  await p.run("startDownload(row, button)");
  await p.run("submitPlans()");
  assert.deepEqual(calls[1], { url: "/api/jobs", body: { action: "download", confirm: true, installIds: [7], url: filePlan.url, fileName: filePlan.fileName, size: 123, sha256: filePlan.sha256 } });
  assert.equal(p.byId("confirm").open, false);
  await p.run("startPlan([7])");
  assert.equal(p.byId("confirm-title").textContent, "Confirm updates");
  assert.equal(p.byId("confirm-submit").textContent, "Start updates");
  await p.run("submitPlans()");
  assert.equal(calls.at(-1)?.body.action, undefined);
});

test("download page opens fallback pages and refuses unavailable files", async () => {
  const p = page(async () => ({ ok: true, json: async () => ({ ...filePlan, kind: "page", allowed: false }) }));
  await p.run("startDownload(row, button)");
  assert.deepEqual(p.opened, [[filePlan.url, "_blank", "noopener,noreferrer"]]);
  assert.equal(p.byId("confirm").open, false);
  const refused = page(async () => ({ ok: true, json: async () => ({ ...filePlan, sha256: null, allowed: false, refusal: "This install is frozen." }) }));
  await refused.run("startDownload(row, button)");
  assert.equal(refused.byId("confirm-submit").disabled, true);
  assert.ok(allText(refused.byId("confirm-body")).includes("no checksum available"));
  assert.ok(allText(refused.byId("confirm-body")).includes("This install is frozen."));
});

test("download Jobs view displays the file and final target path", () => {
  const p = page(async () => ({}));
  p.context.job = { id: 1, action: "download", name: "Demo", machineId: "mini", state: "done", download: { fileName: "Demo.dmg" }, finalPath: "/Users/fixture/Downloads/Demo (1).dmg", steps: [] };
  p.run("state.jobs = [job]; renderJobs()");
  const text = allText(p.byId("jobs"));
  assert.ok(text.includes("Download: Demo.dmg"));
  assert.ok(text.includes("/Users/fixture/Downloads/Demo (1).dmg"));
});

test("download development routes return file and page plans without target operations", async () => {
  const server = createMockHub();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const get = (path: string, body?: unknown): Promise<{ status: number; body: any }> => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json" } }, (res) => { let text = ""; res.on("data", (chunk) => text += chunk); res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) })); });
    req.on("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  try {
    const file = installs.find((row) => row.downloadUrl && row.installId % 2 === 0)!;
    const plan = (await get(`/api/downloads/plan?installId=${file.installId}`)).body;
    assert.equal(plan.kind, "file");
    const installed = file.installed;
    const queued = await get("/api/jobs", { action: "download", confirm: true, installIds: [file.installId], url: plan.url, fileName: plan.fileName, size: plan.size, sha256: plan.sha256 });
    assert.equal(queued.status, 202);
    const job = jobs.find((row) => row.id === queued.body.jobs[0].id)!;
    job.state = "stopped";
    assert.equal(file.installed, installed);
    const fallback = installs.find((row) => row.downloadUrl && row.installId % 2 === 1)!;
    assert.equal((await get(`/api/downloads/plan?installId=${fallback.installId}`)).body.kind, "page");
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
