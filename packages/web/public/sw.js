// Scout's service worker. It makes the page installable and keeps a read-only copy of the portal for when the hub cannot be reached.
// Every same-origin GET goes to the network first and is copied into a cache when it succeeds. When the hub does not answer, the
// cached copy is served instead and the open pages are told how old it is. Anything that changes state is never cached and is
// refused while offline.
const SHELL = "scout-shell";
const DATA = "scout-data";
const DATA_LIMIT = 200;
const CACHED_AT = "x-scout-cached-at";
const PRECACHE = [
  "/", "/styles.css", "/services.css", "/resources.css", "/phone.css", "/app.js", "/lib.js", "/filters.js", "/saved-filters.js", "/theme.js", "/density.js", "/tabbar.js",
  "/offline.js", "/palette.js", "/palette-model.js", "/pwa.js", "/review-reminder.js", "/alerts-badge.js", "/download-kinds.js", "/dependency-cards.js", "/services.js", "/services-model.js",
  "/services-diagram.js", "/outages.js", "/outages-model.js", "/resources.js", "/resources-model.js", "/tray-settings.js", "/tray-model.js", "/tray-text.js",
  "/icon.svg", "/icon-192.png", "/favicon-32.png", "/manifest.webmanifest",
];

let offline = false;
const isApi = (url) => url.pathname.startsWith("/api/");
const cacheable = (response) => response.ok && !response.redirected && response.type === "basic" && !(response.headers.get("content-type") || "").includes("text/event-stream");

async function notify(message) {
  for (const client of await self.clients.matchAll({ includeUncontrolled: true })) client.postMessage(message);
}

async function stamp(response) {
  const headers = new Headers(response.headers);
  headers.set(CACHED_AT, new Date().toISOString());
  return new Response(await response.blob(), { status: response.status, statusText: response.statusText, headers });
}

async function trim(cache) {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - DATA_LIMIT))) await cache.delete(key);
}

async function remember(request, response, name) {
  const cache = await caches.open(name);
  await cache.put(request, name === DATA ? await stamp(response) : response);
  if (name === DATA) await trim(cache);
}

const refusal = () => new Response(JSON.stringify({ error: "Scout is offline, so nothing can be changed. Try again once the hub is back." }), { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function read(event, name, ignoreSearch) {
  const request = event.request;
  const url = new URL(request.url);
  let response = null;
  try {
    response = await fetch(request);
    if (isApi(url) && response.status >= 500) throw new Error("hub unavailable");
  } catch {
    const cached = await caches.match(ignoreSearch ? new Request(new URL("/", url).href) : request, { ignoreSearch });
    if (!cached) return response || (isApi(url) ? refusal() : Response.error());
    const at = cached.headers.get(CACHED_AT);
    if (isApi(url) && at) { offline = true; event.waitUntil(notify({ type: "offline", at })); }
    return cached;
  }
  if (cacheable(response)) event.waitUntil(remember(ignoreSearch ? new Request(new URL("/", url).href) : request, response.clone(), name));
  if (isApi(url) && response.ok && offline) { offline = false; event.waitUntil(notify({ type: "online" })); }
  return response;
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await Promise.allSettled(PRECACHE.map(async (path) => { const response = await fetch(path, { cache: "reload" }); if (cacheable(response)) await cache.put(path, response); }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name !== SHELL && name !== DATA) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.method !== "GET") {
    if (isApi(url)) event.respondWith(fetch(request).catch(refusal));
    return;
  }
  if (request.mode === "navigate") return event.respondWith(read(event, SHELL, true));
  event.respondWith(read(event, isApi(url) ? DATA : SHELL, false));
});
