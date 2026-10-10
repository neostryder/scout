import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { openCatalog, recordScan, upsertMachine } from "@scout/core";
import { createHub } from "../src/server.ts";

const db = openCatalog(":memory:");
upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
recordScan(db, "hub", { sourceKind: "registry", location: "HKLM", status: "ok", installs: [
  { ecosystem: "arp", key: "HKLM\\plain", name: "Plain Tool", kind: "package", version: "1.0", location: "C:/Program Files/Plain", publisher: "Acme", details: {} },
  { ecosystem: "arp", key: "HKLM\\nopub", name: "Nameless Tool", kind: "package", version: "1.0", location: "C:/Program Files/Nameless", details: { systemComponent: false } },
  { ecosystem: "arp", key: "HKLM\\sys", name: "System Part", kind: "package", version: "1.0", location: "", details: { systemComponent: true } },
  { ecosystem: "arp", key: "HKCU\\dl", name: "Downloaded Tool", kind: "package", version: "1.0", location: "C:/Users/me/Downloads/Tool", publisher: "Acme", details: {} },
] }, "2026-10-10T12:00:00.000Z");
recordScan(db, "hub", { sourceKind: "appx", location: "appx", status: "ok", installs: [
  { ecosystem: "appx", key: "Side.Loaded", name: "Side.Loaded", kind: "app", version: "1.0", location: "C:/Program Files/WindowsApps/Side", details: { publisher: "CN=Someone", signatureKind: 0 } },
] }, "2026-10-10T12:00:00.000Z");
recordScan(db, "hub", { sourceKind: "npm", location: "npm", status: "ok", installs: [
  { ecosystem: "npm", key: "scout-cli", name: "scout-cli", kind: "package", version: "0.1.0", location: "C:\\Repositories\\scout\\packages\\cli", details: {} },
] }, "2026-10-10T12:00:00.000Z");
db.prepare("INSERT INTO project_git (machine_id, root, remote_url, remote_host, remote_owner, remote_repo, author_email, last_commit_at, read_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
  .run("hub", "C:/Repositories/scout", "https://github.com/neostryder/scout", "github.com", "neostryder", "scout", "someone@example.com", "2026-10-10T09:00:00-07:00", "2026-10-10T17:00:00Z");
db.prepare("INSERT INTO project_git (machine_id, root, remote_url, remote_host, remote_owner, remote_repo, author_email, last_commit_at, read_at) VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)")
  .run("hub", "C:/Repositories/stranger", "2026-10-10T17:00:00Z");
db.prepare("INSERT INTO listeners (machine_id, port, protocol, address, bind, pid, process_name, process_path, first_seen_at, last_seen_at) VALUES ('hub', 4876, 'tcp', '127.0.0.1', 'loopback', 10, 'node', 'C:/Program Files/nodejs/node.exe', '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z')").run();
db.prepare("INSERT INTO listeners (machine_id, port, protocol, address, bind, pid, process_name, process_path, first_seen_at, last_seen_at) VALUES ('hub', 9999, 'tcp', '0.0.0.0', 'all', 11, 'dropper', 'C:/Users/me/AppData/Local/Temp/dropper.exe', '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z')").run();

const dir = mkdtempSync(join(tmpdir(), "scout-provenance-api-"));
const minePath = join(dir, "mine.json");
writeFileSync(minePath, JSON.stringify({ owners: ["NeoStryder"], emails: [] }));
const server = createHub({ db, webRoot: dir, minePath });
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
// The hub marks recipes it cannot find under any project as gone at start, so the recipe is stored once it is up.
db.prepare("INSERT INTO launch_recipes (machine_id, root, source, name, argv_json, port, hash, state, proposed_at, last_seen_at) VALUES ('hub', 'C:/Repositories/scout', 'package-json', 'dev', '[\"pnpm\",\"run\",\"dev\"]', 4876, 'h', 'approved', '2026-10-10T00:00:00Z', '2026-10-10T00:00:00Z')").run();
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(async () => { await new Promise<void>((done) => { server.close(() => done()); server.closeAllConnections(); }); db.close(); rmSync(dir, { recursive: true, force: true }); });
const get = async (path: string) => (await (await fetch(`${base}${path}`)).json()) as Record<string, any>;

test("catalog rows carry provenance flags with evidence and leave ordinary installs unflagged", async () => {
  const body = await get("/api/installs?limit=50&libs=1");
  const flags = (name: string) => body.rows.find((row: any) => row.name === name)?.flags.map((flag: any) => flag.kind);
  assert.deepEqual(flags("Plain Tool"), []);
  assert.deepEqual(flags("Nameless Tool"), ["no-publisher"]);
  assert.deepEqual(flags("System Part"), []);
  assert.deepEqual(flags("Downloaded Tool"), ["odd-location"]);
  assert.deepEqual(flags("Side.Loaded"), ["unsigned"]);
  assert.deepEqual(flags("scout-cli"), ["mine"]);
  const mine = body.rows.find((row: any) => row.name === "scout-cli").flags[0];
  assert.match(mine.evidence, /Inside scout/);
  assert.match(mine.evidence, /github\.com\/neostryder\/scout/);
});

test("an install detail returns the same flags", async () => {
  const rows = (await get("/api/installs?limit=50&libs=1")).rows as any[];
  const id = rows.find((row) => row.name === "Downloaded Tool").installId;
  const detail = await get(`/api/installs/${id}`);
  assert.deepEqual(detail.flags.map((flag: any) => flag.kind), ["odd-location"]);
  assert.match(detail.flags[0].evidence, /downloads folder/);
});

test("listeners are flagged by odd path and by the project that owns their port", async () => {
  const body = await get("/api/listeners?all=1");
  const byPort = (port: number) => body.rows.find((row: any) => row.port === port).flags;
  assert.deepEqual(byPort(9999).map((flag: any) => flag.kind), ["odd-location"]);
  assert.deepEqual(byPort(4876).map((flag: any) => flag.kind), ["mine"]);
  assert.match(byPort(4876)[0].evidence, /launch recipe of scout/);
});

test("the provenance route lists the profile, the projects and why each is mine", async () => {
  const body = await get("/api/provenance");
  assert.deepEqual(body.profile, { owners: ["NeoStryder"], emails: [], file: ".scout-data/mine.json", fileError: null });
  const scout = body.projects.find((project: any) => project.project === "scout");
  assert.match(scout.mine, /github\.com\/neostryder\/scout/);
  assert.equal(body.projects.find((project: any) => project.project === "stranger").mine, null);
});

test("with no mine file nothing is marked as mine", async () => {
  const bare = createHub({ db, webRoot: dir, minePath: join(dir, "absent.json") });
  await new Promise<void>((resolve) => bare.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(bare.address() as AddressInfo).port}`;
  const body = await (await fetch(`${url}/api/installs?limit=50&libs=1`)).json() as Record<string, any>;
  assert.deepEqual(body.rows.find((row: any) => row.name === "scout-cli").flags, []);
  await new Promise<void>((done) => { bare.close(() => done()); bare.closeAllConnections(); });
});
