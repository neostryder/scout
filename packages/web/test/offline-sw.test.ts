import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const ORIGIN = "https://scout.example";

type Handler = (event: any) => void;

function worker() {
  const handlers = new Map<string, Handler>();
  const stores = new Map<string, Map<string, Response>>();
  const posted: Array<{ type: string; at?: string }> = [];
  const network = { up: true, responses: new Map<string, () => Response>() };
  const keyOf = (request: Request | string) => (typeof request === "string" ? request : request.url);
  const match = (store: Map<string, Response>, request: Request | string, options?: { ignoreSearch?: boolean }) => {
    const wanted = new URL(keyOf(request));
    for (const [key, value] of store) {
      const have = new URL(key);
      if (have.pathname === wanted.pathname && (options?.ignoreSearch || have.search === wanted.search)) return value.clone();
    }
    return undefined;
  };
  const caches = {
    async open(name: string) {
      const store = stores.get(name) ?? new Map<string, Response>();
      stores.set(name, store);
      return {
        async put(request: Request | string, response: Response) { store.delete(keyOf(request)); store.set(keyOf(request), response); },
        async keys() { return [...store.keys()].map((key) => new Request(key)); },
        async delete(request: Request | string) { return store.delete(keyOf(request)); },
      };
    },
    async match(request: Request | string, options?: { ignoreSearch?: boolean }) {
      for (const store of stores.values()) { const hit = match(store, request, options); if (hit) return hit; }
      return undefined;
    },
    async keys() { return [...stores.keys()]; },
    async delete(name: string) { return stores.delete(name); },
  };
  const fakeFetch = async (input: Request | string) => {
    if (!network.up) throw new TypeError("Failed to fetch");
    const url = new URL(keyOf(input));
    const make = network.responses.get(url.pathname + url.search) ?? network.responses.get(url.pathname);
    const response = make ? make() : new Response("not found", { status: 404 });
    Object.defineProperty(response, "type", { value: "basic" });
    return response;
  };
  const self: any = {
    location: { origin: ORIGIN },
    addEventListener: (name: string, handler: Handler) => handlers.set(name, handler),
    skipWaiting: async () => {},
    clients: { claim: async () => {}, matchAll: async () => [{ postMessage: (message: any) => posted.push(message) }] },
  };
  vm.runInNewContext(source, { self, caches, fetch: fakeFetch, Response, Request, Headers, URL, Promise, Error, TypeError, JSON, Math, Date, Set });
  async function dispatch(request: Request) {
    let answer: Promise<Response> | undefined;
    const pending: Promise<unknown>[] = [];
    handlers.get("fetch")!({ request, respondWith: (value: Promise<Response>) => { answer = value; }, waitUntil: (value: Promise<unknown>) => pending.push(value) });
    const response = answer ? await answer : undefined;
    await Promise.all(pending);
    return response;
  }
  return { network, posted, stores, dispatch, handlers };
}

const get = (path: string, mode?: string) => { const request = new Request(ORIGIN + path); if (mode) Object.defineProperty(request, "mode", { value: mode }); return request; };
const body = (value: unknown) => () => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

test("an API read is served from the saved copy when the hub is unreachable, and the pages are told how old it is", async () => {
  const w = worker();
  w.network.responses.set("/api/summary", body({ installs: 3 }));
  const live = await w.dispatch(get("/api/summary"));
  assert.deepEqual(await live!.json(), { installs: 3 });
  assert.equal(w.posted.length, 0);
  w.network.up = false;
  const saved = await w.dispatch(get("/api/summary"));
  assert.deepEqual(await saved!.json(), { installs: 3 });
  assert.equal(w.posted.length, 1);
  assert.equal(w.posted[0]!.type, "offline");
  assert.match(w.posted[0]!.at!, /^\d{4}-\d{2}-\d{2}T/);
  w.network.up = true;
  await w.dispatch(get("/api/summary"));
  assert.deepEqual(w.posted.slice(1).map((message) => message.type), ["online"]);
  await w.dispatch(get("/api/summary"));
  assert.equal(w.posted.length, 2);
});

test("a hub that answers with a server error falls back to the saved copy", async () => {
  const w = worker();
  w.network.responses.set("/api/summary", body({ installs: 1 }));
  await w.dispatch(get("/api/summary"));
  w.network.responses.set("/api/summary", () => new Response("bad gateway", { status: 502 }));
  const saved = await w.dispatch(get("/api/summary"));
  assert.deepEqual(await saved!.json(), { installs: 1 });
  assert.equal(w.posted.at(-1)!.type, "offline");
});

test("an API read that was never saved is refused while offline", async () => {
  const w = worker();
  w.network.up = false;
  const response = await w.dispatch(get("/api/never-seen"));
  assert.equal(response!.status, 503);
});

test("a change is never saved and is refused while offline", async () => {
  const w = worker();
  w.network.up = false;
  const response = await w.dispatch(new Request(ORIGIN + "/api/services/refresh", { method: "POST", body: "{}" }));
  assert.equal(response!.status, 503);
  assert.match(((await response!.json()) as { error: string }).error, /offline/);
  assert.equal([...w.stores.values()].reduce((count, store) => count + store.size, 0), 0);
});

test("a page load offline shows the saved portal whatever its address", async () => {
  const w = worker();
  w.network.responses.set("/", () => new Response("<html>portal</html>", { headers: { "content-type": "text/html" } }));
  await w.dispatch(get("/?view=services", "navigate"));
  w.network.up = false;
  const page = await w.dispatch(get("/?view=resources&tab=alerts", "navigate"));
  assert.equal(await page!.text(), "<html>portal</html>");
});

test("a response that redirected to a sign-in page is not saved", async () => {
  const w = worker();
  w.network.responses.set("/api/summary", () => { const r = new Response("login", { status: 200 }); Object.defineProperty(r, "redirected", { value: true }); return r; });
  await w.dispatch(get("/api/summary"));
  assert.equal([...w.stores.values()].reduce((count, store) => count + store.size, 0), 0);
});

test("a live stream is passed through unsaved", async () => {
  const w = worker();
  w.network.responses.set("/api/events", () => new Response("data: x\n\n", { headers: { "content-type": "text/event-stream" } }));
  await w.dispatch(get("/api/events"));
  assert.equal([...w.stores.values()].reduce((count, store) => count + store.size, 0), 0);
});

test("the saved API copies stay under the limit, oldest first", async () => {
  const w = worker();
  for (let index = 0; index < 205; index += 1) {
    w.network.responses.set(`/api/item/${index}`, body({ index }));
    await w.dispatch(get(`/api/item/${index}`));
  }
  const data = w.stores.get("scout-data")!;
  assert.equal(data.size, 200);
  assert.ok(![...data.keys()].some((key) => key.endsWith("/api/item/0")));
  assert.ok([...data.keys()].some((key) => key.endsWith("/api/item/204")));
});
