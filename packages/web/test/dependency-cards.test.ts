import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import type { AddressInfo } from "node:net";
import { createMockHub } from "../dev/mock-hub.ts";

class Element {
  tag: string;
  attrs: Record<string, any>;
  children: any[];
  textContent = "";
  disabled = false;
  constructor(tag: string, attrs: Record<string, any>, children: any[]) { this.tag = tag; this.attrs = attrs; this.children = children.flat(Infinity); this.disabled = attrs.disabled ?? false; }
}

const proposal = { id: 7, kind: "dependency_proposal", subject: { from: { ecosystem: "npm", key: "language-server" }, to: { ecosystem: "brew", key: "node" }, kind: "runtime", constraint: ">=26", together: false, confidence: "high", evidence: "The language server requires Node.", machines: ["host-a", "host-b"] }, packages: [{ name: "Language server" }, { name: "Node" }] };

function moduleContext() {
  const source = readFileSync(new URL("../public/dependency-cards.js", import.meta.url), "utf8").replace(/^import .*\n/gm, "").replace(/^export /gm, "");
  const context = createContext({ h: (tag: string, attrs: Record<string, any>, ...children: any[]) => new Element(tag, attrs, children) });
  runInContext(source, context);
  return context;
}

function text(node: any): string { return node instanceof Element ? [node.textContent, ...node.children.map(text)].join(" ") : String(node ?? ""); }
function buttons(node: Element): Element[] { return [node, ...node.children.filter((child) => child instanceof Element).flatMap(buttons)].filter((child) => child.tag === "button"); }

test("dependency cards show names, facts, confidence and machines with confirm and reject decisions", async () => {
  const context = moduleContext();
  const decisions: any[] = [];
  const card = context.dependencyCard(proposal, (...args: any[]) => decisions.push(args));
  for (const value of ["Language server needs Node", "runtime", ">=26", "high confidence", proposal.subject.evidence, "host-a, host-b"]) assert.ok(text(card).includes(value), value);
  const actions = buttons(card);
  assert.deepEqual(actions.map(text), [" Confirm", " Reject"]);
  await actions[0]!.attrs.onclick();
  await actions[1]!.attrs.onclick();
  assert.deepEqual(decisions, [[7, true], [7, false]]);
  assert.equal(card.tag, "article");
  assert.equal(card.attrs.class, "proposal");
});

test("dependency cards display updates together with and without an explicit constraint and treat text as text", () => {
  const context = moduleContext();
  for (const constraint of [null, ">=26"]) {
    const card = context.dependencyCard({ ...proposal, subject: { ...proposal.subject, together: true, constraint, evidence: "<script>unsafe()</script>" } }, () => {});
    assert.ok(text(card).includes("updates together"));
    assert.ok(text(card).includes("<script>unsafe()</script>"));
    assert.equal(card.children.find((child: any) => child instanceof Element && child.tag === "script"), undefined);
  }
});

test("discovery controls post an empty JSON object, prevent duplicate clicks and reload with a size result", async () => {
  const context = moduleContext();
  let finish!: (value: any) => void;
  const calls: any[] = [];
  let reloads = 0;
  const control = context.discoveryControls(async () => { reloads++; }, async (...args: any[]) => { calls.push(args); return new Promise((resolve) => { finish = resolve; }); });
  const button = buttons(control)[0]!;
  const pending = button.attrs.onclick();
  assert.equal(button.disabled, true);
  await button.attrs.onclick();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0], "/api/dependencies/discover");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][1])), { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  finish({ ok: true, json: async () => ({ status: "ok", proposed: 6, omitted: 2 }) });
  await pending;
  assert.equal(reloads, 1);
  assert.equal(button.disabled, false);
  assert.ok(text(control).includes("Found 6 possible dependencies. 2 were left out for size."));
  const reloaded = context.discoveryControls(() => {}, async () => ({}));
  assert.ok(text(reloaded).includes("Found 6 possible dependencies. 2 were left out for size."));
  assert.equal(reloaded.children[1].attrs["aria-live"], "polite");
});

test("discovery controls report no runner, unusable responses and request failures", async () => {
  for (const [result, expected, ok] of [[{ status: "no_model" }, "No model is configured.", true], [{ status: "unusable" }, "The response could not be read. The queue has not changed.", true], [{ error: "Request refused." }, "Request refused.", false]] as const) {
    const context = moduleContext();
    let reloads = 0;
    const control = context.discoveryControls(() => { reloads++; }, async () => ({ ok, json: async () => result }));
    const button = buttons(control)[0]!;
    await button.attrs.onclick();
    assert.ok(text(control).includes(expected));
    assert.equal(reloads, ok ? 1 : 0);
    assert.equal(button.disabled, false);
  }
  const context = moduleContext();
  const control = context.discoveryControls(() => {}, async () => { throw new Error("Connection failed."); });
  await buttons(control)[0]!.attrs.onclick();
  assert.ok(text(control).includes("Connection failed."));
});

test("the Review queue hooks dependency cards and the new module is included in the page", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  assert.ok(app.includes('import { dependencyCard, discoveryControls } from "./dependency-cards.js";'));
  assert.ok(app.includes('p.kind === "dependency_proposal" ? dependencyCard(p, decide)'));
  assert.ok(app.includes("discoveryControls(load)"));
  assert.ok(html.includes('<script type="module" src="/dependency-cards.js"></script>'));
});

test("the mock serves dependency cards and discovery and retains decisions", async () => {
  const server = createMockHub();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown = {}, headers = {}) => fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    const module = await fetch(`${base}/dependency-cards.js`);
    assert.equal(module.status, 200);
    assert.ok((await module.text()).includes("dependencyCard"));
    const proposals = await (await fetch(`${base}/api/proposals`)).json() as any[];
    const dependency = proposals.find((p) => p.kind === "dependency_proposal");
    assert.equal(dependency.subject.machines[0], "mini");
    assert.ok(proposals.some((p) => p.kind === "merge_proposal"));
    assert.deepEqual(await (await post("/api/dependencies/discover")).json(), { status: "ok", proposed: 1, skipped: 0, omitted: 0 });
    assert.equal((await post("/api/dependencies/discover", {}, { origin: "https://foreign.test" })).status, 403);
    assert.equal((await post("/api/dependencies/discover", { extra: true })).status, 400);
    assert.equal((await post(`/api/proposals/${dependency.id}`, { accept: false })).status, 200);
    assert.equal((await post("/api/dependencies/discover")).status, 200);
    assert.equal((await (await post("/api/dependencies/discover")).json() as any).proposed, 0);
    assert.ok(!(await (await fetch(`${base}/api/proposals`)).json() as any[]).some((p) => p.kind === "dependency_proposal"));
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});
