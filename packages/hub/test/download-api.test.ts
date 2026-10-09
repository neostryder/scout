import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { linkIdentity, openCatalog, recordResearch, recordScan, upsertMachine, type Exec } from "@scout/core";
import { createHub } from "../src/server.ts";

const hash = "a".repeat(64);
const release = (extra: Record<string, unknown> = {}) => ({ tag_name: "v2.0", draft: false, prerelease: false, assets: [{ name: "Demo-macos-arm64.dmg", browser_download_url: "https://files.example.test/Demo.dmg", content_type: "application/x-apple-diskimage", size: 123, digest: `sha256:${hash}` }], ...extra });

async function fixture(options: { platform?: "macos" | "windows"; ecosystem?: string; homepage?: string | null; arch?: "arm64" | "x64" | null; details?: Record<string, unknown>; document?: unknown; fetcher?: typeof fetch; exec?: Exec } = {}) {
  const platform = options.platform ?? "macos";
  const ecosystem = options.ecosystem ?? "bundle";
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "target", name: "Target", os: platform, kind: "host" });
  recordScan(db, "target", { sourceKind: "app", location: "", status: "ok", installs: [{ ecosystem, key: ecosystem === "winget" ? "Example.Demo" : ecosystem === "cask" ? "demo" : "org.example.demo", name: "Demo", kind: "app", version: "1.0", location: "/Applications/Demo.app", homepage: (options.homepage === undefined ? "https://github.com/example/demo" : options.homepage) ?? undefined, details: options.details }] }, new Date().toISOString());
  const { id, package_id: packageId } = db.prepare("SELECT id, package_id FROM installs").get() as { id: number; package_id: number };
  recordResearch(db, packageId, "github", "ok", [{ channel: "stable", version: "2.0", installable: false }], null);
  const calls: string[] = [];
  const targetCalls: string[][] = [];
  let document: unknown = options.document ?? release();
  let now = 1_000_000;
  const arch = options.arch === undefined ? platform === "macos" ? "arm64" : "x64" : options.arch;
  const server = createHub({ db, webRoot: "packages/web/public", jobs: { machines: [{ id: "target", transport: { type: "local" }, ...(arch ? { arch } : {}) }], exec: options.exec ?? (async (_transport, argv) => { targetCalls.push(argv); return { exitCode: 0, stdout: targetCalls.length === 1 ? "created\n" : "/Users/fixture/Downloads/Demo (1).dmg\n", stderr: "" }; }) }, downloads: { githubToken: "", now: () => now, fetch: options.fetcher ?? (async (url, init) => { calls.push(String(url)); assert.equal(new Headers(init?.headers).has("authorization"), false); return new Response(typeof document === "string" ? document : JSON.stringify(document), { status: 200 }); }) } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const get = (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, any> }> => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}`, ...(body !== undefined ? { "content-type": "application/json", origin: `http://127.0.0.1:${port}` } : {}), ...headers } }, (res) => {
      let text = "";
      res.on("data", (chunk) => text += chunk);
      res.on("end", () => { let parsed: Record<string, any> = {}; try { parsed = JSON.parse(text); } catch {} resolve({ status: res.statusCode ?? 0, body: parsed }); });
    });
    req.on("error", reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  return { db, id, packageId, calls, targetCalls, get, setDocument: (value: unknown) => { document = value; }, expire: () => { now += 3_600_001; }, close: async () => { await new Promise<void>((resolve) => server.close(() => resolve())); db.close(); } };
}

test("download plan uses public package endpoints and caches by version and target architecture", async () => {
  const f = await fixture();
  try {
    const plan = await f.get(`/api/downloads/plan?installId=${f.id}`);
    assert.equal(plan.status, 200);
    assert.deepEqual(plan.body, { installId: f.id, machineId: "target", name: "Demo", kind: "file", url: "https://files.example.test/Demo.dmg", fileName: "Demo-macos-arm64.dmg", size: 123, sha256: hash, source: "github", folder: "~/Downloads", warnings: [], allowed: true, refusal: null });
    await f.get(`/api/downloads/plan?installId=${f.id}`);
    assert.deepEqual(f.calls, ["https://api.github.com/repos/example/demo/releases/latest"]);
    f.expire();
    await f.get(`/api/downloads/plan?installId=${f.id}`);
    assert.equal(f.calls.length, 2);
    assert.equal(f.targetCalls.length, 0);
    assert.equal((await f.get("/api/downloads/plan?installId=0")).status, 400);
    assert.equal((await f.get("/api/downloads/plan?installId=9999")).status, 404);
    assert.equal((await f.get(`/api/downloads/plan?installId=${f.id}`, "GET", undefined, { host: "evil.example.test" })).status, 421);
  } finally { await f.close(); }
});

test("download plan falls back to a page or none for ambiguity, mismatched versions, failures and unknown architecture", async () => {
  for (const options of [{ document: release({ assets: [] }) }, { document: release({ tag_name: "v3.0" }) }, { arch: null }, { document: "malformed" }, { fetcher: async () => { throw new Error("fixture request failed"); } }]) {
    const f = await fixture(options);
    try {
      const result = await f.get(`/api/downloads/plan?installId=${f.id}`);
      assert.equal(result.body.kind, "page");
      assert.equal(result.body.url, "https://github.com/example/demo/releases/latest");
      assert.equal(result.body.allowed, false);
    } finally { await f.close(); }
  }
  const f = await fixture({ homepage: null });
  try { const result = await f.get(`/api/downloads/plan?installId=${f.id}`); assert.equal(result.body.kind, "none"); assert.equal(result.body.url, null); assert.equal(f.calls.length, 0); } finally { await f.close(); }
});

test("download plan refuses frozen rows and oversized files", async () => {
  const f = await fixture();
  try {
    f.db.prepare("INSERT INTO constraints (install_id, type, hard, spec, origin, observed_at) VALUES (?, 'freeze', 1, '1.0', 'fixture', ?)").run(f.id, new Date().toISOString());
    assert.equal((await f.get(`/api/downloads/plan?installId=${f.id}`)).body.allowed, false);
    assert.equal(f.calls.length, 0);
    f.db.exec("DELETE FROM constraints");
    f.setDocument(release({ assets: [{ ...release().assets[0], size: 2147483649 }] }));
    const plan = (await f.get(`/api/downloads/plan?installId=${f.id}`)).body;
    assert.equal(plan.allowed, false);
    assert.equal(plan.refusal, "The file is larger than 2 GB.");
  } finally { await f.close(); }
});

test("download plan reuses the declared cask-to-bundle identity link", async () => {
  const f = await fixture({ homepage: "https://vendor.example.test", document: { version: "2.0", url: "https://vendor.example.test/Demo-arm64.dmg", sha256: "no_check" } });
  try {
    recordScan(f.db, "target", { sourceKind: "brew", location: "/opt/homebrew", status: "ok", installs: [{ ecosystem: "cask", key: "demo", name: "Demo", kind: "app", version: "1.0", location: "/opt/homebrew/Caskroom/demo", details: { appNames: ["Demo.app"] } }] }, new Date().toISOString());
    linkIdentity(f.db);
    const plan = (await f.get(`/api/downloads/plan?installId=${f.id}`)).body;
    assert.equal(plan.source, "cask");
    assert.equal(plan.kind, "file");
    assert.equal(plan.sha256, null);
    assert.deepEqual(f.calls, ["https://formulae.brew.sh/api/cask/demo.json"]);
  } finally { await f.close(); }
});

test("download plan parses a full Sparkle enclosure for the confirmed version", async () => {
  const xml = '<rss><channel><item><enclosure url="https://vendor.example.test/Demo.dmg" length="123" sparkle:shortVersionString="2.0" sparkle:edSignature="fixture" /></item><item><enclosure url="https://vendor.example.test/old.dmg" sparkle:shortVersionString="1.0" /></item></channel></rss>';
  const f = await fixture({ homepage: null, details: { sparkleFeed: "https://vendor.example.test/appcast.xml" }, document: xml });
  try {
    const plan = (await f.get(`/api/downloads/plan?installId=${f.id}`)).body;
    assert.equal(plan.source, "sparkle");
    assert.equal(plan.sha256, null);
    assert.equal(plan.size, 123);
    assert.ok(plan.warnings[0].includes("does not verify Sparkle EdDSA"));
    assert.deepEqual(f.calls, ["https://vendor.example.test/appcast.xml"]);
    f.setDocument(xml.replace("old.dmg", "second.dmg").replace('shortVersionString="1.0"', 'shortVersionString="2.0"'));
    f.expire();
    const second = (await f.get(`/api/downloads/plan?installId=${f.id}`)).body;
    assert.equal(second.kind, "page");
    assert.equal(second.url, "https://vendor.example.test/");
  } finally { await f.close(); }
});

test("download plan falls back to the product page an appcast names, then to the site that serves it", async () => {
  const named = await fixture({ homepage: null, details: { sparkleFeed: "https://vendor.example.test/appcast.xml" }, document: "<rss><channel><title>Demo</title><link>http://demo.example.test/product?a=1&amp;b=2</link><item><title>2.0</title></item></channel></rss>" });
  try {
    const plan = (await named.get(`/api/downloads/plan?installId=${named.id}`)).body;
    assert.equal(plan.kind, "page");
    assert.equal(plan.url, "https://demo.example.test/product?a=1&b=2");
  } finally { await named.close(); }
  const plain = await fixture({ homepage: null, details: { sparkleFeed: "http://updates.example.test/app/appcast.xml" } });
  try {
    const plan = (await plain.get(`/api/downloads/plan?installId=${plain.id}`)).body;
    assert.equal(plan.kind, "page");
    assert.equal(plan.url, "https://updates.example.test/");
    assert.equal(plan.allowed, false);
  } finally { await plain.close(); }
});

test("download plan runs the exact winget show argv through the configured target transport", async () => {
  const calls: string[][] = [];
  const f = await fixture({ platform: "windows", ecosystem: "winget", homepage: null, exec: async (transport, argv) => { assert.deepEqual(transport, { type: "local" }); calls.push(argv); return { exitCode: 0, stdout: `Installer Type: exe\nInstaller Url: https://vendor.example.test/Demo.exe\nArchitecture: x64\nInstaller SHA256: ${hash}`, stderr: "" }; } });
  try {
    const plan = (await f.get(`/api/downloads/plan?installId=${f.id}`)).body;
    assert.equal(plan.source, "winget");
    assert.equal(plan.folder, "User Downloads");
    assert.deepEqual(calls, [["winget", "show", "--id", "Example.Demo", "--exact", "--version", "2.0"]]);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("download POST uses the mutation gates and queues the confirmed file", async () => {
  const f = await fixture();
  try {
    const plan = (await f.get(`/api/downloads/plan?installId=${f.id}`)).body;
    const body = { action: "download", confirm: true, installIds: [f.id], url: plan.url, sha256: plan.sha256, size: plan.size, fileName: plan.fileName };
    assert.equal((await f.get("/api/jobs", "POST", body, { origin: "https://evil.example.test" })).status, 403);
    assert.equal((await f.get("/api/jobs", "POST", body, { "content-type": "text/plain" })).status, 415);
    assert.equal((await f.get("/api/jobs", "POST", { ...body, confirm: false })).status, 400);
    assert.equal((await f.get("/api/jobs", "POST", { ...body, installIds: [f.id, f.id] })).status, 400);
    assert.equal((await f.get("/api/jobs", "POST", { ...body, sha256: null })).status, 400);
    assert.equal((await f.get("/api/jobs", "POST", { ...body, action: "install" })).status, 400);
    const response = await f.get("/api/jobs", "POST", body);
    assert.equal(response.status, 202);
    const jobId = response.body.jobs[0].id;
    let job = (await f.get(`/api/jobs/${jobId}`)).body;
    for (let n = 0; n < 20 && job.state !== "done"; n++) job = (await f.get(`/api/jobs/${jobId}`)).body;
    assert.equal(job.action, "download");
    assert.equal(job.state, "done");
    assert.ok(job.finalPath.endsWith("Demo (1).dmg"));
    assert.deepEqual(job.steps.map((step: { name: string }) => step.name), ["resolve", "download", "verify"]);
    assert.equal(f.calls.length, 2);
    assert.equal(f.targetCalls.length, 2);
  } finally { await f.close(); }
});

test("download job re-fetches and refuses a changed checksum after confirmation", async () => {
  const f = await fixture();
  try {
    const plan = (await f.get(`/api/downloads/plan?installId=${f.id}`)).body;
    f.setDocument(release({ assets: [{ ...release().assets[0], digest: `sha256:${"b".repeat(64)}` }] }));
    const response = await f.get("/api/jobs", "POST", { action: "download", confirm: true, installIds: [f.id], url: plan.url, sha256: plan.sha256, size: plan.size, fileName: plan.fileName });
    assert.equal(response.status, 202);
    let job = (await f.get(`/api/jobs/${response.body.jobs[0].id}`)).body;
    for (let n = 0; n < 20 && job.state !== "failed"; n++) job = (await f.get(`/api/jobs/${job.id}`)).body;
    assert.equal(job.state, "failed");
    assert.equal(job.steps[0].name, "resolve");
    assert.equal(f.targetCalls.length, 0);
  } finally { await f.close(); }
});
