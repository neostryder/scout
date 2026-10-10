import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openCatalog, recordScan, upsertMachine } from "@scout/core";
import { provenanceCommand } from "../src/provenance.ts";

function fixture(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "scout-provenance-cli-"));
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  recordScan(db, "hub", { sourceKind: "registry", location: "HKLM", status: "ok", installs: [
    { ecosystem: "arp", key: "HKLM\a", name: "Fine Tool", kind: "package", version: "1", location: "C:/Program Files/Fine", publisher: "Acme", details: {} },
    { ecosystem: "arp", key: "HKCU\b", name: "Downloaded Tool", kind: "package", version: "1", location: "C:/Users/me/Downloads/Tool", publisher: "Acme", details: {} },
    { ecosystem: "arp", key: "HKLM\c", name: "Nameless Tool", kind: "package", version: "1", location: "C:/Program Files/Nameless", details: {} },
  ] }, "2026-10-10T12:00:00.000Z");
  db.prepare("INSERT INTO project_git (machine_id, root, remote_url, remote_host, remote_owner, remote_repo, author_email, last_commit_at, read_at) VALUES ('hub', 'C:/Repositories/scout', 'https://github.com/neostryder/scout', 'github.com', 'neostryder', 'scout', NULL, NULL, 't')").run();
  const lines: string[] = [];
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return { db, dir, lines, write: (line: string) => lines.push(line), minePath: join(dir, "mine.json") };
}

test("provenance lists projects with the reason each is mine, and says so when no profile is set", async (t) => {
  const f = fixture(t);
  await provenanceCommand(f.db, [], { minePath: f.minePath, write: f.write });
  assert.match(f.lines.join("\n"), /scout\s+https:\/\/github\.com\/neostryder\/scout\s+no/);
  assert.match(f.lines.at(-1)!, /No owners or emails are set/);
  writeFileSync(f.minePath, JSON.stringify({ owners: ["neostryder"] }));
  f.lines.length = 0;
  await provenanceCommand(f.db, [], { minePath: f.minePath, write: f.write });
  assert.match(f.lines.join("\n"), /its git remote is github\.com\/neostryder\/scout/);
});

test("provenance flags lists flagged installs, narrowed by kind and machine, and rejects an unknown kind", async (t) => {
  const f = fixture(t);
  await provenanceCommand(f.db, ["flags"], { minePath: f.minePath, write: f.write });
  const all = f.lines.join("\n");
  assert.match(all, /Downloaded Tool\s+odd-location/);
  assert.match(all, /Nameless Tool\s+no-publisher/);
  assert.doesNotMatch(all, /Fine Tool/);
  assert.match(f.lines.at(-1)!, /^2 flagged installs$/);
  f.lines.length = 0;
  await provenanceCommand(f.db, ["flags", "--kind", "no-publisher"], { minePath: f.minePath, write: f.write });
  assert.match(f.lines.at(-1)!, /^1 flagged install$/);
  f.lines.length = 0;
  await provenanceCommand(f.db, ["flags", "--machine", "elsewhere"], { minePath: f.minePath, write: f.write });
  assert.match(f.lines.at(-1)!, /^0 flagged installs$/);
  await assert.rejects(provenanceCommand(f.db, ["flags", "--kind", "bad"], { minePath: f.minePath, write: f.write }), /kind must be one of/);
  await assert.rejects(provenanceCommand(f.db, ["nonsense"], { minePath: f.minePath, write: f.write }), /requires scan, flags/);
});

test("provenance scan re-reads the git facts of the given projects", async (t) => {
  const f = fixture(t);
  await provenanceCommand(f.db, ["scan"], { minePath: f.minePath, projects: () => [], write: f.write });
  assert.deepEqual(JSON.parse(f.lines[0]!), { read: 0, withRemote: 0 });
});
