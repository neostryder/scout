import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

const helpers = await import(new URL("../public/lib.js", import.meta.url).href);

class Element {
  tag: string;
  attrs: Record<string, any>;
  children: any[];
  textContent = "";
  disabled = false;
  checked = false;
  open = false;
  hidden = false;
  scrollTop = 0;
  constructor(tag = "div", attrs: Record<string, any> = {}, children: any[] = []) { this.tag = tag; this.attrs = attrs; this.children = children.flat(Infinity); this.disabled = !!attrs.disabled; this.checked = !!attrs.checked; }
  replaceChildren(...children: any[]) { this.children = children.flat(Infinity); }
  append(...children: any[]) { this.children.push(...children); }
  insertBefore(child: any, before: any) { this.children.splice(this.children.indexOf(before), 0, child); }
  showModal() { this.open = true; }
  close() { this.open = false; }
}
function text(node: any): string { return node instanceof Element ? [node.textContent, ...node.children.map(text)].join(" ") : String(node ?? ""); }
function nodes(node: any): Element[] { return node instanceof Element ? [node, ...node.children.flatMap(nodes)] : []; }
function page(fetcher: (...args: any[]) => Promise<any>) {
  const elements = new Map<string, Element>();
  for (const id of ["confirm", "confirm-title", "confirm-submit", "confirm-body", "detail", "filters", "chips"]) elements.set(id, new Element());
  const byId = (id: string) => elements.get(id);
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/^import .*\n/gm, "").split('\ndocument.querySelectorAll("[data-view]").forEach')[0]!;
  // Imports are removed before eval, so the detail helper has to be provided in this context.
  const context = createContext({ ...helpers, upstreamSections: () => [], $: byId, h: (tag: string, attrs: Record<string, any>, ...children: any[]) => { const element = new Element(tag, attrs, children); if (attrs.id) elements.set(attrs.id, element); return element; }, marked: (value: string) => value, location: { search: "", pathname: "/" }, URLSearchParams, document: { addEventListener: () => {} }, localStorage: { getItem: () => null }, fetch: fetcher });
  runInContext(source, context);
  runInContext("pollJobs = async () => {}; load = async () => {}; renderTable = () => {};", context);
  return { context, byId: (id: string) => byId(id)!, run: (code: string) => runInContext(code, context) };
}
const dependent = { id: 11, name: "Dependent tool", ecosystem: "npm", key: "dependent", machine: "mini", version: "1.0.0" };
const entry = { dependent, kind: "runtime", constraint: "<27", reason: "Dependent tool requires Node below version 27." };
const softPlan = { installId: 7, machineId: "mini", name: "Node", from: "26.0.0", to: "27.0.0", command: "brew upgrade node", allowed: true, disruptive: true, breaks: { hard: [], soft: [entry] }, softConfirmation: { projects: ["C:/Projects/app"], dependents: [dependent.name] } };

test("depui dialog requires both acknowledgements and posts soft confirmation", async () => {
  const calls: any[] = [];
  const p = page(async (url, options) => { calls.push({ url, body: options?.body ? JSON.parse(options.body) : null }); return { ok: true, json: async () => softPlan }; });
  await p.run("startPlan([7])");
  assert.equal(p.byId("confirm-submit").disabled, true);
  const shown = text(p.byId("confirm-body"));
  for (const expected of ["Also affects", dependent.name, "mini", entry.reason, "C:/Projects/app", "I have checked these"]) assert.ok(shown.includes(expected));
  await p.run("submitPlans()");
  assert.equal(calls.length, 1);
  p.byId("allow-disruptive").checked = true;
  p.byId("allow-disruptive").attrs.onchange();
  assert.equal(p.byId("confirm-submit").disabled, true);
  p.byId("confirm-soft").checked = true;
  p.byId("confirm-soft").attrs.onchange();
  assert.equal(p.byId("confirm-submit").disabled, false);
  p.byId("allow-disruptive").checked = false;
  p.byId("allow-disruptive").attrs.onchange();
  assert.equal(p.byId("confirm-submit").disabled, true);
  p.byId("allow-disruptive").checked = true;
  p.byId("allow-disruptive").attrs.onchange();
  await p.run("submitPlans()");
  assert.deepEqual(calls.at(-1).body, { installIds: [7], confirm: true, allowDisruptive: true, confirmSoft: true });
});

test("depui hard refusals name affected installs and cannot start", async () => {
  const p = page(async () => ({ ok: true, json: async () => ({ ...softPlan, allowed: false, refusal: "Updating would break Dependent tool", breaks: { hard: [entry], soft: [] }, softConfirmation: null }) }));
  await p.run("startPlan([7])");
  assert.equal(p.byId("confirm-submit").disabled, true);
  assert.ok(text(p.byId("confirm-body")).includes("Cannot update"));
  assert.ok(text(p.byId("confirm-body")).includes("Updating would break Dependent tool"));
  assert.ok(text(p.byId("confirm-body")).includes(entry.reason));
});

test("depui batch requests keep machine ids after selected rows leave the page", async () => {
  const urls: string[] = [];
  const p = page(async (url) => { urls.push(url); return { ok: true, json: async () => ({ installId: 1, allowed: true, breaks: { hard: [], soft: [] }, softConfirmation: null }) }; });
  p.run('state.selected.set(1, "mini"); state.selected.set(2, "hub"); state.selected.set(3, "mini"); state.rows = [];');
  await p.run("startPlan([1, 2, 3])");
  assert.deepEqual(urls.map((url) => Object.fromEntries(new URLSearchParams(url.split("?")[1]))), [{ installId: "1", alsoInstallIds: "3" }, { installId: "2" }, { installId: "3", alsoInstallIds: "1" }]);
});

test("depui hard badges leave the muted update button enabled", () => {
  const p = page(async () => ({}));
  p.context.row = { installId: 7, name: "Node", machineId: "mini", updatable: true, risk: { hard: 2, soft: 0 } };
  const row = p.run("updateRow(row)");
  const button = nodes(row).find((node) => node.tag === "button")!;
  assert.equal(button.disabled, false);
  assert.equal(button.attrs.class, "primary muted-action");
  assert.equal(button.attrs.title, "Breaks 2");
  const badge = nodes(row).find((node) => node.attrs.class === "risk hard")!;
  assert.equal(text(badge), " Breaks 2");
  assert.equal(badge.attrs.title, "Updating would break 2 installs that depend on this");
});

test("depui detail renders dependency edges, support windows and safe release links", async () => {
  const edge = { from: dependent, to: { name: "llhttp", ecosystem: "brew" }, kind: "library", constraint: ">=9", builtAgainst: "9.4.3" };
  const detail: any = { name: "Node", ecosystem: "brew", key: "node", machineId: "mini", dependencies: { needs: [edge], neededBy: [edge] }, supportWindows: [{ cycle: "26", eol: "2025-12-31", eolPassed: true, lts: true }, { cycle: "27", eol: null, eolPassed: false, lts: false }], changelog: { summary: "A release fixes parsing.\nThe runtime changed.", sourceUrl: "https://example.test/releases", model: "fixture-summary" } };
  const p = page(async () => ({ ok: true, json: async () => detail }));
  await p.run("openDetail(7)");
  const shown = text(p.byId("detail"));
  for (const expected of ["Needs", "Needed by", "llhttp", dependent.name, "mini", "library", ">=9", "built against 9.4.3", "Support", "Passed, LTS", "no end date announced", "Release notes", detail.changelog.summary, "fixture-summary"]) assert.ok(shown.includes(expected), expected);
  const link = nodes(p.byId("detail")).find((node) => node.tag === "a")!;
  assert.equal(link.attrs.href, detail.changelog.sourceUrl);
  assert.equal(link.attrs.rel, "noopener noreferrer");
  detail.changelog.sourceUrl = "javascript:alert(1)";
  await p.run("openDetail(7)");
  assert.equal(nodes(p.byId("detail")).some((node) => node.tag === "a"), false);
  detail.changelog = null; detail.dependencies = { needs: [], neededBy: [] }; detail.supportWindows = [];
  await p.run("openDetail(7)");
  assert.equal(nodes(p.byId("detail")).some((node) => node.tag === "h3" && ["Needs", "Needed by", "Support", "Release notes"].includes(text(node).trim())), false);
});

test("depui safe checkbox is off by default and sends its URL parameter", () => {
  const p = page(async () => ({}));
  p.run("renderFilters()");
  const label = nodes(p.byId("filters")).find((node) => node.tag === "label" && text(node).includes("Hide updates that would break something"))!;
  const checkbox = nodes(label).find((node) => node.tag === "input")!;
  assert.equal(checkbox.checked, false);
  p.run("url = () => {}; renderChips = () => {};");
  checkbox.attrs.onchange({ target: { checked: true } });
  assert.equal(p.run('state.params.get("safe")'), "1");
  checkbox.attrs.onchange({ target: { checked: false } });
  assert.equal(p.run('state.params.has("safe")'), false);
});
