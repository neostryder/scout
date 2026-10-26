import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cloneMirror, githubRepoSizeKb, type GitResult, type GitRunner } from "../src/index.ts";

const HEAD = "a".repeat(40);
const done = (over: Partial<GitResult> = {}): GitResult => ({ code: 0, stdout: "", stderr: "", timedOut: false, ...over });
const root = (): string => mkdtempSync(join(tmpdir(), "scout-clone-"));

function runner(calls: string[][], clone: (target: string) => GitResult): GitRunner {
  return async (args) => {
    calls.push(args);
    if (args[0] === "clone") { const target = args.at(-1)!; mkdirSync(join(target, ".git"), { recursive: true }); return clone(target); }
    if (args[0] === "rev-parse") return done({ stdout: HEAD + "\n" });
    return done();
  };
}

test("a public repository is cloned under the mirror root and its head commit comes back", async () => {
  const dir = root();
  try {
    const calls: string[][] = [];
    const result = await cloneMirror("https://github.com/acme/Mapper.git", dir, "github-acme-mapper", { run: runner(calls, () => done()), sizeKb: 1200 });
    assert.deepEqual(result, { ok: true, mirrorPath: join(dir, "github-acme-mapper").replace(/\\/g, "/"), head: HEAD });
    assert.deepEqual(calls[0]?.slice(0, 3), ["clone", "--quiet", "--"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("any repository size is cloned, and only a nearly full drive refuses", async () => {
  const dir = root();
  try {
    const big = await cloneMirror("https://github.com/acme/Huge.git", dir, "huge", { run: runner([], () => done()), sizeKb: 5_000_000, freeKb: 100 * 1024 * 1024 });
    assert.equal(big.ok, true);
    const tight = await cloneMirror("https://github.com/acme/Huge.git", dir, "tight", { run: runner([], () => done()), sizeKb: 5_000_000, freeKb: 22 * 1024 * 1024 });
    assert.match(tight.ok ? "" : tight.error, /22 GB free and a clone of 4883 MB would leave it under 20 GB/);
    assert.equal(existsSync(join(dir, "tight")), false);
    const capped = await cloneMirror("https://github.com/acme/Huge.git", dir, "capped", { run: runner([], () => done()), sizeKb: 900_000, maxKb: 400_000, freeKb: null });
    assert.match(capped.ok ? "" : capped.error, /over the 391 MB limit/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an unsupported host, a bad folder name, and an existing folder are refused before any clone", async () => {
  const dir = root();
  try {
    const calls: string[][] = [];
    const run = runner(calls, () => done());
    assert.equal((await cloneMirror("https://example.test/acme/x.git", dir, "x", { run })).ok, false);
    assert.equal((await cloneMirror("https://github.com/acme/x.git", dir, "../escape", { run })).ok, false);
    mkdirSync(join(dir, "taken"));
    const taken = await cloneMirror("https://github.com/acme/x.git", dir, "taken", { run });
    assert.match(taken.ok ? "" : taken.error, /already in the mirror root/);
    assert.equal((await cloneMirror("https://github.com/acme/x.git", join(dir, "missing"), "x", { run })).ok, false);
    assert.equal(calls.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a failed or timed-out clone leaves no folder behind", async () => {
  const dir = root();
  try {
    const failed = await cloneMirror("https://github.com/acme/x.git", dir, "x", { run: runner([], () => done({ code: 128, stderr: "fatal: repository not found" })) });
    assert.match(failed.ok ? "" : failed.error, /repository not found/);
    assert.equal(existsSync(join(dir, "x")), false);
    const slow = await cloneMirror("https://github.com/acme/y.git", dir, "y", { run: runner([], () => done({ code: null, timedOut: true })) });
    assert.match(slow.ok ? "" : slow.error, /timed out/);
    assert.equal(existsSync(join(dir, "y")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the repository size comes from GitHub, and anything unreadable is null", async () => {
  const seen: string[] = [];
  const fetcher = async (url: string) => { seen.push(url); return { ok: true, json: async () => ({ size: 4321 }) }; };
  assert.equal(await githubRepoSizeKb("https://github.com/acme/Mapper.git", fetcher), 4321);
  assert.deepEqual(seen, ["https://api.github.com/repos/acme/Mapper"]);
  assert.equal(await githubRepoSizeKb("https://gitlab.com/acme/x", fetcher), null);
  assert.equal(await githubRepoSizeKb("https://github.com/acme/x", async () => ({ ok: false, json: async () => ({}) })), null);
  assert.equal(await githubRepoSizeKb("https://github.com/acme/x", async () => { throw new Error("offline"); }), null);
});
