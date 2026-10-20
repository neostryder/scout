import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCompetitorRuns, openCatalog, startPullingRun, syncCompetitors } from "@scout/core";
import { checkRemote, pullMirror, readRemoteRefs, runCompetitorUpdate, selectLatestTags, spawnGit, supportedRemote, type GitRunner } from "../src/index.ts";

const NOW = "2026-05-20T00:00:00.000Z";
const FORBIDDEN = /^(reset|clean|checkout|stash|rebase|push|gc)$/;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Dev",
      GIT_AUTHOR_EMAIL: "dev@example.test",
      GIT_COMMITTER_NAME: "Dev",
      GIT_COMMITTER_EMAIL: "dev@example.test",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

function configure(repo: string): void {
  git(repo, ["config", "user.email", "dev@example.test"]);
  git(repo, ["config", "user.name", "Dev"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  git(repo, ["config", "tag.gpgsign", "false"]);
}

function head(repo: string): string {
  return git(repo, ["rev-parse", "HEAD"]).trim();
}

function recording(calls: string[][]): GitRunner {
  return (args, options) => {
    calls.push(args);
    return spawnGit(args, options);
  };
}

function safeCalls(calls: string[][]): void {
  for (const args of calls) for (const arg of args) assert.equal(FORBIDDEN.test(arg) || arg === "--prune", false, args.join(" "));
}

test("only https and ssh forges are accepted, and version tags ignore a prerelease that is not newer", () => {
  assert.equal(supportedRemote("https://github.com/example/acme-tools.git"), true);
  assert.equal(supportedRemote("https://user:secret@gitlab.com/example/acme-tools"), true);
  assert.equal(supportedRemote("ssh://git@codeberg.org/example/acme-tools.git"), true);
  assert.equal(supportedRemote("git@bitbucket.org:example/acme-tools.git"), true);
  assert.equal(supportedRemote("http://github.com/example/acme-tools"), false);
  assert.equal(supportedRemote("https://git.example.com/example/acme-tools"), false);
  assert.equal(supportedRemote("git@git.example.com:example/acme-tools.git"), false);
  assert.equal(supportedRemote("C:/mirrors/acme-tools"), false);
  assert.deepEqual(selectLatestTags(["v1.0.0", "v1.2.0", "v1.3.0-rc.1", "nightly", "not-a-version"]), { version: "1.2.0", prerelease: "1.3.0-rc.1" });
  assert.deepEqual(selectLatestTags(["v1.2.0", "v1.2.0-rc.1"]), { version: "1.2.0", prerelease: null });
  assert.deepEqual(selectLatestTags(["v2.0.0-beta.1"]), { version: null, prerelease: "2.0.0-beta.1" });
  assert.deepEqual(selectLatestTags([]), { version: null, prerelease: null });
});

test("the ref check reads tags from a throwaway repository and rejects an unsupported remote without running git", async () => {
  const root = mkdtempSync(join(tmpdir(), "scout-comp-refs-"));
  try {
    const tagged = join(root, "tagged");
    git(root, ["-c", "init.defaultBranch=main", "init", tagged]);
    configure(tagged);
    writeFileSync(join(tagged, "README.md"), "one\n");
    git(tagged, ["add", "."]);
    git(tagged, ["commit", "-m", "first"]);
    git(tagged, ["tag", "v1.0.0"]);
    git(tagged, ["tag", "v1.2.0"]);
    git(tagged, ["tag", "v1.3.0-rc.1"]);
    git(tagged, ["tag", "nightly"]);
    const found = await readRemoteRefs(tagged);
    assert.equal(found.error, null);
    assert.equal(found.version, "1.2.0");
    assert.equal(found.prerelease, "1.3.0-rc.1");
    assert.equal(found.commit, head(tagged));
    const plain = join(root, "plain");
    git(root, ["-c", "init.defaultBranch=main", "init", plain]);
    configure(plain);
    writeFileSync(join(plain, "README.md"), "one\n");
    git(plain, ["add", "."]);
    git(plain, ["commit", "-m", "first"]);
    const untagged = await readRemoteRefs(plain);
    assert.equal(untagged.version, null);
    assert.equal(untagged.prerelease, null);
    assert.equal(untagged.commit, head(plain));
    let called = 0;
    const refused = await checkRemote("https://git.example.com/example/acme-tools", async () => { called += 1; return { code: 0, stdout: "", stderr: "", timedOut: false }; });
    assert.equal(refused.error, "unsupported remote");
    assert.equal(called, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("update refuses a dirty tree, a path outside the mirror root, a non-fast-forward, and a missing origin", async () => {
  const root = mkdtempSync(join(tmpdir(), "scout-comp-refuse-"));
  const mirrors = join(root, "mirrors");
  try {
    mkdirSync(mirrors);
    const remote = join(root, "remote.git");
    const upstream = join(root, "upstream");
    const mirror = join(mirrors, "acme-tools");
    git(root, ["-c", "init.defaultBranch=main", "init", "--bare", remote]);
    git(root, ["clone", remote, upstream]);
    configure(upstream);
    writeFileSync(join(upstream, "README.md"), "one\n");
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "first"]);
    git(upstream, ["push", "-u", "origin", "HEAD"]);
    git(root, ["clone", remote, mirror]);
    configure(mirror);
    const before = head(mirror);
    writeFileSync(join(mirror, "README.md"), "dirty\n");
    const dirty = await pullMirror(mirror, mirrors);
    assert.equal(dirty.ok, false);
    if (!dirty.ok) assert.equal(dirty.error, "mirror has uncommitted changes");
    assert.equal(head(mirror), before);
    git(mirror, ["checkout", "--", "README.md"]);
    const outside = await pullMirror(upstream, mirrors);
    assert.equal(outside.ok, false);
    if (!outside.ok) assert.match(outside.error, /mirror root/);
    writeFileSync(join(upstream, "README.md"), "upstream\n");
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "upstream"]);
    git(upstream, ["push", "origin", "HEAD"]);
    writeFileSync(join(mirror, "LOCAL.md"), "local\n");
    git(mirror, ["add", "."]);
    git(mirror, ["commit", "-m", "local"]);
    const localHead = head(mirror);
    const diverged = await pullMirror(mirror, mirrors);
    assert.equal(diverged.ok, false);
    if (!diverged.ok) assert.equal(diverged.error, "the mirror has local commits; fetched only");
    assert.equal(head(mirror), localHead);
    const orphan = join(mirrors, "orphan");
    git(root, ["-c", "init.defaultBranch=main", "init", orphan]);
    configure(orphan);
    writeFileSync(join(orphan, "README.md"), "one\n");
    git(orphan, ["add", "."]);
    git(orphan, ["commit", "-m", "first"]);
    const noOrigin = await pullMirror(orphan, mirrors);
    assert.equal(noOrigin.ok, false);
    if (!noOrigin.ok) assert.equal(noOrigin.error, "mirror has no origin");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fast-forward update advances the mirror and queues the commits, files, and notes", async () => {
  const root = mkdtempSync(join(tmpdir(), "scout-comp-update-"));
  const mirrors = join(root, "mirrors");
  try {
    mkdirSync(mirrors);
    const remote = join(root, "remote.git");
    const upstream = join(root, "upstream");
    const mirror = join(mirrors, "acme-tools");
    git(root, ["-c", "init.defaultBranch=main", "init", "--bare", remote]);
    git(root, ["clone", remote, upstream]);
    configure(upstream);
    writeFileSync(join(upstream, "CHANGELOG.md"), "# Changelog\n\n## 1.0.0\n\n- first\n");
    writeFileSync(join(upstream, "package.json"), "{\"name\":\"acme-tools\",\"version\":\"1.0.0\"}\n");
    writeFileSync(join(upstream, "plans.md"), "plan: free\n");
    writeFileSync(join(upstream, "src.txt"), "one\n");
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "first release"]);
    git(upstream, ["tag", "v1.0.0"]);
    git(upstream, ["push", "-u", "origin", "HEAD"]);
    git(upstream, ["push", "origin", "--tags"]);
    git(root, ["clone", remote, mirror]);
    configure(mirror);
    const from = head(mirror);
    writeFileSync(join(upstream, "CHANGELOG.md"), "# Changelog\n\n## 1.1.0\n\n- second\n");
    writeFileSync(join(upstream, "package.json"), "{\"name\":\"acme-tools\",\"version\":\"1.1.0\"}\n");
    writeFileSync(join(upstream, "plans.md"), "plan: paid\n");
    writeFileSync(join(upstream, "src.txt"), "two\n");
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "second release"]);
    git(upstream, ["tag", "v1.1.0"]);
    git(upstream, ["push", "origin", "HEAD"]);
    git(upstream, ["push", "origin", "--tags"]);
    const db = openCatalog(":memory:");
    syncCompetitors(db, [{
      id: "acme-tools", name: "Acme Tools", org: "Acme", remoteUrl: "https://user:secret@github.com/example/acme-tools",
      mirrorPath: mirror, packageUrl: "https://example.test/packages/acme", dossierDir: join(root, "dossier"), dossierReviewed: "2026-05-05",
      flags: ["forge"], baseline: { version: "1.0.0", commit: from, at: "2026-05-05", source: "mirror" },
    }]);
    const run = startPullingRun(db, "acme-tools", NOW);
    const calls: string[][] = [];
    await runCompetitorUpdate(db, run.id, { mirrorRoot: mirrors, now: NOW, git: recording(calls) });
    safeCalls(calls);
    assert.equal(head(mirror), head(upstream));
    const queued = listCompetitorRuns(db, ["queued"], NOW);
    assert.equal(queued.length, 1);
    assert.equal(queued[0]?.toVersion, "1.1.0");
    const request = queued[0]?.request as { commits: { subject: string }[]; changedFiles: { path: string }[]; notes: string; pricingFiles: string[]; commitCount: number; competitor: { remoteUrl: string } };
    assert.equal(request.commitCount, 1);
    assert.equal(request.commits[0]?.subject, "second release");
    assert.equal(request.changedFiles.some((file) => file.path === "src.txt"), true);
    assert.match(request.notes, /1\.1\.0/);
    assert.match(request.notes, /second/);
    assert.deepEqual(request.pricingFiles, ["plans.md"]);
    assert.equal(request.competitor.remoteUrl.includes("secret"), false);
    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
