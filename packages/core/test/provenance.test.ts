import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installFlags, mineFileReader, mineReason, oddLocation, openCatalog, parseRemote, programFlags, provenanceContext, provenanceResponse, readProjectGit, refreshProjectGit, upsertMachine, emptyProvenance, type GitRunner, type MineProfile, type ProvenanceContext } from "../src/index.ts";

const profile: MineProfile = { owners: ["neostryder"], emails: ["me@example.com"] };

function context(over: Partial<ProvenanceContext> = {}): ProvenanceContext {
  return {
    profile,
    projects: [{ machineId: "hub", root: "C:/Repositories/scout", remoteUrl: "https://github.com/neostryder/scout", remoteHost: "github.com", remoteOwner: "neostryder", remoteRepo: "scout", authorEmail: null, lastCommitAt: null, readAt: "2026-10-10T00:00:00Z", mine: "its git remote is github.com/neostryder/scout" }],
    recipePorts: new Map([["hub:4876", "C:/Repositories/scout"]]),
    ...over,
  };
}

test("odd locations name the folder that makes a path unusual and leave ordinary paths alone", () => {
  assert.equal(oddLocation("C:\\Users\\me\\AppData\\Local\\Temp\\setup\\tool.exe"), "the temp folder");
  assert.equal(oddLocation("C:/Users/me/Downloads/app"), "the downloads folder");
  assert.equal(oddLocation("/Users/me/Desktop/thing"), "the desktop folder");
  assert.equal(oddLocation("/tmp/x/run"), "a temporary folder");
  assert.equal(oddLocation("/private/var/folders/ab/cd/T/run"), "a temporary folder");
  assert.equal(oddLocation("C:/Users/Public/tool.exe"), "the shared Public folder");
  assert.equal(oddLocation("C:/$Recycle.Bin/S-1/x.exe"), "the Recycle Bin");
  for (const ordinary of ["C:/Program Files/Git/git.exe", "/Applications/Safari.app", "C:/Users/me/AppData/Local/Programs/Tool", "/usr/local/bin/node", "", null, undefined]) assert.equal(oddLocation(ordinary), null, String(ordinary));
  assert.equal(oddLocation("C:/Program Files/Contemporary/x.exe"), null);
});

test("remote URLs reduce to host, owner and repository and never keep credentials", () => {
  assert.deepEqual(parseRemote("git@github.com:neostryder/scout.git"), { url: "https://github.com/neostryder/scout", host: "github.com", owner: "neostryder", repo: "scout" });
  assert.deepEqual(parseRemote("https://user:ghp_secrettokenvalue1234567890@GitHub.com/RPGM-Tools/neo-angband.git"), { url: "https://github.com/RPGM-Tools/neo-angband", host: "github.com", owner: "RPGM-Tools", repo: "neo-angband" });
  assert.deepEqual(parseRemote("ssh://git@gitlab.example.com/group/sub/proj.git"), { url: "https://gitlab.example.com/group/sub/proj", host: "gitlab.example.com", owner: "group/sub", repo: "proj" });
  assert.equal(parseRemote(""), null);
  assert.equal(parseRemote("C:/local/path/repo"), null);
  assert.equal(parseRemote("file:///srv/repo.git"), null);
  assert.ok(!JSON.stringify(parseRemote("https://user:ghp_secrettokenvalue1234567890@github.com/a/b")).includes("ghp_"));
});

test("a project is mine by its remote owner or its author email, and says which", () => {
  assert.match(mineReason({ remoteOwner: "NeoStryder", remoteHost: "github.com", remoteRepo: "scout", authorEmail: null }, profile)!, /github\.com\/NeoStryder\/scout/);
  assert.match(mineReason({ remoteOwner: "other", remoteHost: "github.com", remoteRepo: "x", authorEmail: "ME@example.com" }, profile)!, /author emails/);
  assert.equal(mineReason({ remoteOwner: "other", remoteHost: "github.com", remoteRepo: "x", authorEmail: "you@example.com" }, profile), null);
  assert.equal(mineReason({ remoteOwner: "neostryder", remoteHost: "github.com", remoteRepo: "x", authorEmail: "me@example.com" }, { owners: [], emails: [] }), null);
});

test("install flags report an odd location, a missing publisher, an unsigned package and ownership, each with evidence", () => {
  const base = { machineId: "hub", ecosystem: "arp", location: "C:/Program Files/Tool", publisher: "Acme", homepage: null, details: {} };
  assert.deepEqual(installFlags(base, context()), []);
  const odd = installFlags({ ...base, location: "C:/Users/me/Downloads/Tool" }, context());
  assert.deepEqual(odd.map((f) => f.kind), ["odd-location"]);
  assert.match(odd[0]!.evidence, /downloads folder/);
  assert.deepEqual(installFlags({ ...base, publisher: null }, context()).map((f) => f.kind), ["no-publisher"]);
  assert.deepEqual(installFlags({ ...base, publisher: null, details: { systemComponent: true } }, context()), []);
  assert.deepEqual(installFlags({ ...base, ecosystem: "npm", publisher: null }, context()), []);
  const appx = { ...base, ecosystem: "appx", publisher: "CN=Someone", details: { publisher: "CN=Someone", signatureKind: 0 } };
  assert.deepEqual(installFlags(appx, context()).map((f) => f.kind), ["unsigned"]);
  assert.match(installFlags(appx, context())[0]!.evidence, /no signature/);
  for (const signatureKind of [1, 2, 3, 4]) assert.deepEqual(installFlags({ ...appx, details: { publisher: "CN=Someone", signatureKind } }, context()), [], `signature kind ${signatureKind}`);
  assert.deepEqual(installFlags({ ...base, ecosystem: "pkgutil", location: "/private/tmp/com.vendor.package" }, context()), []);
  const inside = installFlags({ ...base, ecosystem: "npm", location: "C:\\Repositories\\scout\\packages\\cli" }, context());
  assert.deepEqual(inside.map((f) => f.kind), ["mine"]);
  assert.match(inside[0]!.evidence, /Inside scout/);
  assert.deepEqual(installFlags({ ...base, ecosystem: "npm", location: "C:/Repositories/scout-other/x" }, context()), []);
  assert.deepEqual(installFlags({ ...base, machineId: "mini", ecosystem: "npm", location: "C:/Repositories/scout/x" }, context()), []);
  const home = installFlags({ ...base, ecosystem: "npm", homepage: "https://github.com/neostryder/tool#readme" }, context());
  assert.match(home[0]!.evidence, /github\.com\/neostryder/);
  assert.deepEqual(installFlags({ ...base, ecosystem: "npm", homepage: "https://github.com/stranger/tool" }, context()), []);
  assert.deepEqual(installFlags({ ...base, ecosystem: "npm", homepage: "https://github.com/neostryder/tool" }, emptyProvenance()), []);
});

test("program flags use the path and, for a listener, the port of a launch recipe", () => {
  assert.deepEqual(programFlags("hub", "C:/Windows/System32/svchost.exe", 135, context()), []);
  assert.deepEqual(programFlags("hub", "C:/Users/me/AppData/Local/Temp/x.exe", null, context()).map((f) => f.kind), ["odd-location"]);
  const byPath = programFlags("hub", "C:/Repositories/scout/dist/scout.exe", 9000, context());
  assert.deepEqual(byPath.map((f) => f.kind), ["mine"]);
  const byPort = programFlags("hub", "C:/Program Files/nodejs/node.exe", 4876, context());
  assert.deepEqual(byPort.map((f) => f.kind), ["mine"]);
  assert.match(byPort[0]!.evidence, /Port 4876 belongs to a launch recipe of scout/);
  assert.deepEqual(programFlags("mini", "/usr/bin/node", 4876, context()), []);
  assert.deepEqual(programFlags("hub", "C:/Program Files/nodejs/node.exe", 4876, { ...context(), projects: [] }), []);
});

test("the mine file is optional, cached and refuses a malformed shape", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "scout-mine-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "mine.json");
  const read = mineFileReader(file);
  assert.deepEqual(read(), { profile: { owners: [], emails: [] }, fileError: null });
  writeFileSync(file, JSON.stringify({ owners: ["neostryder"], emails: ["me@example.com"] }));
  assert.deepEqual(read().profile, profile);
  writeFileSync(file, JSON.stringify({ owners: "neostryder" }));
  const bad = read();
  assert.deepEqual(bad.profile, { owners: [], emails: [] });
  assert.match(bad.fileError!, /malformed/);
  writeFileSync(file, "[1, 2]  ");
  assert.match(read().fileError!, /malformed/);
});

test("git facts are read through fixed arguments, stored without the raw remote, and refreshed per machine", async () => {
  const calls: string[][] = [];
  const git: GitRunner = async (_root, args) => {
    calls.push(args);
    if (args[0] === "config") return "https://token:abc123abc123abc123@github.com/neostryder/scout.git\n";
    return "me@example.com\n2026-10-10T09:00:00-07:00\n";
  };
  const fact = await readProjectGit({ machineId: "hub", name: "scout", root: "C:/Repositories/scout" }, git, "2026-10-10T17:00:00Z");
  assert.deepEqual(calls, [["config", "--get", "remote.origin.url"], ["log", "-1", "--format=%ae%n%aI"]]);
  assert.equal(fact.remoteUrl, "https://github.com/neostryder/scout");
  assert.equal(fact.authorEmail, "me@example.com");
  assert.equal(fact.lastCommitAt, "2026-10-10T09:00:00-07:00");
  const none = await readProjectGit({ machineId: "hub", name: "bare", root: "C:/Repositories/bare" }, async () => null);
  assert.deepEqual([none.remoteUrl, none.authorEmail, none.lastCommitAt], [null, null, null]);

  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  const projects = [{ machineId: "hub", name: "scout", root: "C:/Repositories/scout" }, { machineId: "hub", name: "gone", root: "C:/Repositories/gone" }];
  assert.deepEqual(await refreshProjectGit(db, projects, git), { read: 2, withRemote: 2 });
  assert.deepEqual(await refreshProjectGit(db, projects.slice(0, 1), git), { read: 1, withRemote: 1 });
  const stored = db.prepare("SELECT root, remote_url AS remote FROM project_git").all();
  assert.deepEqual(stored.map((row) => ({ ...row })), [{ root: "C:/Repositories/scout", remote: "https://github.com/neostryder/scout" }]);
  assert.ok(!JSON.stringify(db.prepare("SELECT * FROM project_git").all()).includes("abc123"));
  const response = provenanceResponse(db, { profile, fileError: null });
  assert.equal(response.projects[0]!.mine !== null, true);
  assert.equal(response.projects[0]!.project, "scout");
  assert.equal(provenanceContext(db, profile).projects[0]!.mine, "its git remote is github.com/neostryder/scout");
  db.close();
});
