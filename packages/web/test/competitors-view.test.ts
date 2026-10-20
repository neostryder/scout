import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import { createContext, runInContext } from "node:vm";

const model = await import(new URL("../public/competitors-model.js", import.meta.url).href);

class TextNode { constructor(text: unknown) { this.text = String(text ?? ""); } text: string; }
class El {
  tag: string;
  children: any[] = [];
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<(event: any) => void>> = {};
  className = "";
  textContent = "";
  hidden = false;
  disabled = false;
  checked = false;
  open = false;
  classList = { add: (name: string) => { this.className = `${this.className} ${name}`.trim(); } };
  constructor(tag: string) { this.tag = tag; }
  setAttribute(key: string, value: unknown) { this.attrs[key] = String(value); }
  getAttribute(key: string) { return this.attrs[key]; }
  addEventListener(type: string, fn: (event: any) => void) { (this.listeners[type] ||= []).push(fn); }
  replaceChildren(...nodes: any[]) { this.children = nodes.flat(Infinity); }
  focus() { this.attrs.focused = "true"; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  get isConnected() { return true; }
}

const source = readFileSync(new URL("../public/competitors.js", import.meta.url), "utf8").replace(/^import .*\n/gm, "").replace(/^export /gm, "");

function safeUrl(value: unknown) {
  try { const url = new URL(String(value)); return ["https:", "http:"].includes(url.protocol) ? url.href : null; }
  catch { return null; }
}

function h(tag: string, attrs: Record<string, unknown> = {}, ...children: any[]) {
  const el = new El(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    if (key.startsWith("on") && typeof value === "function") el.addEventListener(key.slice(2), value as (event: any) => void);
    else if (key === "class") el.className = String(value);
    else if (key === "checked") el.checked = Boolean(value);
    else if (key === "disabled") el.disabled = Boolean(value);
    else el.attrs[key] = value === true ? "" : String(value);
  }
  el.children = children.flat(Infinity).map((child) => (child instanceof El ? child : new TextNode(child)));
  return el;
}

function allText(node: any): string {
  if (node instanceof TextNode) return node.text;
  if (node instanceof El) return [node.textContent, ...node.children.map(allText)].join(" ");
  return node == null ? "" : String(node);
}

function walk(node: any, found: El[] = []) {
  if (node instanceof El) { found.push(node); node.children.forEach((child) => walk(child, found)); }
  return found;
}

async function click(el: El) { for (const fn of el.listeners.click || []) await fn({ currentTarget: el, target: el }); }
function fire(el: El, type: string, target: Record<string, unknown>) { for (const fn of el.listeners[type] || []) fn({ target, currentTarget: el }); }

const row = (over: Record<string, unknown> = {}) => ({
  id: "acme-tools", name: "Acme Tools", org: "Acme", remoteUrl: "https://example.test/acme-tools", packageUrl: "https://example.test/packages/acme",
  flags: ["forge"], mirrorPresent: true, dossierReviewed: "2026-05-05",
  baseline: { version: "1.2.0", commit: "abc", at: "2026-05-05", source: "analysis" },
  latest: { version: "1.3.0", prerelease: "1.4.0-rc.1", commit: "def", checkedAt: "2026-10-01T00:00:00.000Z", error: null },
  status: "new", newBasis: "version", run: null, mirrorPath: "C:/secret/mirrors/acme", dossierDir: "C:/secret/dossiers/Acme", ...over,
});

function listed(root: El) { return walk(root).filter((el) => el.tag === "tr" && el.children.some((child) => child instanceof El && child.tag === "td")); }
function button(root: El, label: string) { return walk(root).find((el) => el.tag === "button" && allText(el).includes(label)); }

async function open(t: TestContext, answer: () => any) {
  const calls: Array<{ url: string; method: string; body?: string; headers?: Record<string, string> }> = [];
  const badge = new El("span");
  const root = new El("main");
  const context = createContext({
    ...model,
    h, safeUrl, fetch: async (url: string, options?: { method?: string; body?: string; headers?: Record<string, string> }) => {
      calls.push({ url: String(url), method: options?.method || "GET", body: options?.body, headers: options?.headers });
      const body = answer();
      return body && body.status ? body : { ok: true, status: 200, json: async () => body };
    },
    document: { hidden: false, getElementById: (id: string) => (id === "competitors-count" ? badge : null), addEventListener() {} },
    AbortController, setTimeout, clearTimeout, encodeURIComponent, URL, Error,
  });
  runInContext(source, context);
  const view = (context as { createCompetitorsView: (root: El) => { show: () => Promise<void>; hide: () => void } }).createCompetitorsView(root);
  t.after(() => view.hide());
  await view.show();
  return { root, calls, badge, view };
}

const ok = (competitors: any[], extra: Record<string, unknown> = {}) => ({ configured: true, intervalSeconds: 21600, checkedAt: "2026-10-19T12:04:00.000Z", competitors, ...extra });

test("a configured list shows the count, the new row, the links, and no mirror path", async (t) => {
  const current = row({ id: "other", name: "Other", org: "Beta", status: "current", newBasis: null, latest: { version: "2.0.0", prerelease: null, error: null } });
  const page = await open(t, () => ok([row({ newBasis: "commits", run: { id: 1, state: "queued", stale: true, claimedBy: null, error: null } }), current]));
  const text = allText(page.root);
  assert.equal(page.badge.textContent, "1");
  assert.match(text, /1 of 2 have a new version/);
  assert.match(text, /Last check 2026-10-19 12:04/);
  assert.match(text, /New version/);
  assert.match(text, /New commits/);
  assert.match(text, /Stale, queued over 14 days ago/);
  assert.match(text, /1\.4\.0-rc\.1/);
  assert.equal(text.includes("Other"), false);
  assert.equal(text.includes("C:/secret"), false);
  assert.equal(text.includes("dossier"), false);
  const analyzed = walk(page.root).find((el) => el.attrs.title === "analysis");
  assert.ok(analyzed);
  assert.match(allText(analyzed), /1\.2\.0, 2026-05-05/);
  const link = walk(page.root).find((el) => el.tag === "a");
  assert.equal(link?.attrs.href, "https://example.test/packages/acme");
  const toggle = walk(page.root).find((el) => el.tag === "input" && el.attrs.type === "checkbox");
  assert.equal(toggle?.checked, true);
  fire(toggle!, "change", { checked: false });
  assert.equal(listed(page.root).length, 2);
  assert.match(allText(listed(page.root)[0]), /Acme Tools/);
  const search = walk(page.root).find((el) => el.tag === "input" && el.attrs.type === "search");
  fire(search!, "input", { value: "beta" });
  assert.equal(listed(page.root).length, 1);
  assert.match(allText(listed(page.root)[0]), /Other/);
  fire(search!, "input", { value: "missing" });
  assert.match(allText(page.root), /Nothing matches\./);
});

test("Update confirms with the set sentence, then posts JSON, and a missing mirror shows the reason", async (t) => {
  let competitors = [row(), row({ id: "plain", name: "Plain", mirrorPresent: false, org: "Plain", status: "current" })];
  const page = await open(t, () => ok(competitors));
  const toggle = walk(page.root).find((el) => el.tag === "input" && el.attrs.type === "checkbox");
  fire(toggle!, "change", { checked: false });
  const plain = listed(page.root).find((el) => allText(el).includes("Plain"));
  assert.match(allText(plain), /No local mirror/);
  assert.equal(walk(plain!).find((el) => el.tag === "button")?.disabled, true);
  const update = walk(page.root).filter((el) => el.tag === "button" && allText(el).trim() === "Update" && !el.disabled && el.attrs["data-id"] === "acme-tools")[0];
  click(update!);
  const dialog = walk(page.root).find((el) => el.tag === "dialog");
  assert.equal(dialog?.open, true);
  assert.match(allText(dialog), /Pull the local mirror and queue a research request\. Nothing is installed and no research runs until a Claude session picks it up\./);
  const confirm = walk(dialog!).find((el) => el.tag === "button" && el.className.includes("primary"));
  competitors = [row({ run: { id: 9, state: "pulling", stale: false, claimedBy: null, error: null } })];
  await click(confirm!);
  const post = page.calls.find((call) => call.method === "POST");
  assert.equal(post?.url, "/api/competitors/acme-tools/update");
  assert.equal(post?.body, "{}");
  assert.equal(post?.headers?.["content-type"], "application/json");
  assert.equal(dialog?.open, false);
  assert.match(allText(page.root), /Pulling/);
});

test("an unset watch shows the setup sentence once, and a failed read shows one message", async (t) => {
  const missing = await open(t, () => ({ configured: false, intervalSeconds: 21600, checkedAt: null, competitors: [] }));
  const missingText = allText(missing.root);
  assert.match(missingText, /Competitor watch is not set up\. Run the seed command described in the setup guide\./);
  assert.equal(missingText.split("Competitor watch is not set up").length - 1, 1);
  assert.equal(button(missing.root, "Check now")?.hidden, true);
  assert.equal(missing.badge.textContent, "");
  const failed = await open(t, () => ({ status: 404, ok: false, json: async () => ({ error: "missing" }) }));
  const failedText = allText(failed.root);
  assert.match(failedText, /This hub is too old to report competitors\. Update the hub\./);
  assert.equal(failedText.split("too old").length - 1, 1);
});

test("Check now posts JSON and shows a refusal once", async (t) => {
  let checking = false;
  const page = await open(t, () => checking ? { status: 409, ok: false, json: async () => ({ error: "A check is already running." }) } : ok([row()]));
  checking = true;
  await click(button(page.root, "Check now")!);
  const text = allText(page.root);
  assert.match(text, /A check is already running\./);
  assert.equal(text.split("already running").length - 1, 1);
  const post = page.calls.find((call) => call.url === "/api/competitors/check");
  assert.equal(post?.method, "POST");
  assert.equal(post?.body, "{}");
  assert.equal(post?.headers?.["content-type"], "application/json");
});
