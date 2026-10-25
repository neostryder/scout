import { test } from "node:test";
import assert from "node:assert/strict";
import { commitIsVersionOnly, diffManifest, gatherFacts, isPlaceholderNotes, judgeSpan, manifestDependencies, patchIsVersionOnly, versionOnlyDraft, type FactsFetcher } from "../src/competitor-facts.ts";

const FROM = "a".repeat(40);
const MID = "b".repeat(40);
const TO = "c".repeat(40);
const REMOTE = "https://github.com/example/demo-module.git";
const BUMP = '@@ -3,3 +3,3 @@\n   "id": "demo",\n-  "version": "1.0.0",\n+  "version": "1.0.1",\n   "title": "Demo"';
const BUMP_AND_DOWNLOAD = '@@ -3,4 +3,4 @@\n-  "version": "1.0.0",\n+  "version": "1.0.1",\n-  "download": "https://example.com/v1.0.0.zip",\n+  "download": "https://example.com/v1.0.1.zip"';

interface World { commits?: Array<{ sha: string; files: Array<{ filename: string; patch?: string }>; message?: string }>; releases?: unknown[]; listing?: string[]; manifestNow?: unknown; manifestBefore?: unknown; license?: string | null; total?: number; status?: Record<string, number> }

function fake(world: World): { fetcher: FactsFetcher; calls: string[] } {
  const calls: string[] = [];
  const answer = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
  const commits = world.commits ?? [{ sha: TO, files: [{ filename: "module.json", patch: BUMP }] }];
  const fetcher: FactsFetcher = async (url) => {
    calls.push(url);
    const path = url.replace("https://api.github.com/repos/example/demo-module", "");
    for (const [needle, status] of Object.entries(world.status ?? {})) if (path.startsWith(needle)) return answer({}, status);
    if (path === "") return answer({ default_branch: "main", license: world.license === undefined ? null : world.license === null ? null : { spdx_id: world.license } });
    if (path.startsWith("/contents?")) return answer((world.listing ?? ["module.json", "README.md"]).map((name) => ({ name })));
    if (path.startsWith("/contents/")) return answer(JSON.stringify(path.includes(`ref=${FROM}`) ? world.manifestBefore ?? world.manifestNow ?? { id: "demo" } : world.manifestNow ?? { id: "demo", version: "1.0.1" }));
    if (path.startsWith("/compare/")) return answer({ total_commits: world.total ?? commits.length, base_commit: { commit: { committer: { date: "2026-10-20T00:00:00Z" } } }, commits: commits.map((c) => ({ sha: c.sha, commit: { message: c.message ?? "Update version", committer: { date: "2026-10-24T12:00:00Z" } } })) });
    if (path.startsWith("/commits/")) {
      const found = commits.find((c) => path.endsWith(c.sha));
      return found ? answer({ files: found.files }) : answer({}, 404);
    }
    if (path.startsWith("/releases")) return answer(world.releases ?? []);
    return answer({}, 404);
  };
  return { fetcher, calls };
}
const input = { remoteUrl: REMOTE, from: { version: "1.0.0", commit: FROM }, to: { version: "1.0.1", commit: TO } };
const release = (tag: string, body: string | null, assets = 4) => ({ tag_name: tag, name: tag, body, published_at: "2026-10-24T12:05:00Z", prerelease: false, draft: false, assets: Array.from({ length: assets }, () => ({})) });

test("a patch counts as version-only only when every changed line sets a version or download field", () => {
  assert.equal(patchIsVersionOnly(BUMP), true);
  assert.equal(patchIsVersionOnly(BUMP_AND_DOWNLOAD), true);
  assert.equal(patchIsVersionOnly('@@ -1,2 +1,2 @@\n-  "version": "1",\n+  "version": "2",\n-  "title": "A"\n+  "title": "B"'), false);
  assert.equal(patchIsVersionOnly('@@ -1 +1 @@\n-  "dependencies": {}\n+  "dependencies": {"x": "1"}'), false);
  assert.equal(patchIsVersionOnly(undefined), false);
  assert.equal(patchIsVersionOnly(""), false);
  assert.equal(commitIsVersionOnly([{ filename: "module.json", patch: BUMP }]), true);
  assert.equal(commitIsVersionOnly([{ filename: "module.json", patch: BUMP }, { filename: "README.md", patch: "@@\n+hi" }]), false);
  assert.equal(commitIsVersionOnly([{ filename: "packages/inner/package.json", patch: BUMP }]), true);
  assert.equal(commitIsVersionOnly([{ filename: "scripts/main.js", patch: '-  "version": "1"\n+  "version": "2"' }]), false);
});

test("a span of version bumps with notes-free releases is version-only, and the draft records the facts", async () => {
  const { fetcher } = fake({
    commits: [{ sha: MID, files: [{ filename: "module.json", patch: BUMP }] }, { sha: TO, files: [{ filename: "module.json", patch: BUMP_AND_DOWNLOAD }] }],
    releases: [release("v1.0.1", ""), release("v1.0.0", "Old notes")],
    manifestNow: { id: "demo", version: "1.0.1", license: "MIT", compatibility: { minimum: "13", verified: "13" }, relationships: { requires: [{ id: "lib-one", type: "module", compatibility: { minimum: "2.0.0" } }] } },
    license: null,
  });
  const facts = await gatherFacts(input, fetcher);
  const verdict = judgeSpan(facts);
  assert.equal(verdict.versionOnly, true, verdict.reason);
  assert.deepEqual(facts.releases.map((r) => [r.tag, r.assetCount, r.hasNotes]), [["v1.0.1", 4, false]]);
  assert.deepEqual(facts.dependencies, [{ id: "lib-one", type: "module", version: "2.0.0" }]);
  assert.deepEqual([facts.license.fileInRepo, facts.license.spdx, facts.license.manifestDeclares], [null, null, "MIT"]);
  assert.equal(facts.span.commitCount, 2);
  const draft = versionOnlyDraft("Example Module", facts, verdict);
  assert.match(draft, /Version-only, no research run\./);
  assert.match(draft, /v1\.0\.1 on 2026-10-24: 4 assets, no notes/);
  assert.match(draft, /lib-one \(module\) 2\.0\.0/);
  assert.match(draft, /Repository file: none\./);
  assert.match(draft, /Manifest declares: MIT\./);
  assert.ok(/^[\x09\x0a\x20-\x7e]*$/.test(draft), "the draft is plain ASCII");
});

test("one commit that changes anything besides version fields keeps the span for research", async () => {
  const { fetcher } = fake({ commits: [{ sha: MID, files: [{ filename: "module.json", patch: BUMP }] }, { sha: TO, files: [{ filename: "scripts/app.js", patch: "@@\n+code" }] }] });
  const verdict = judgeSpan(await gatherFacts(input, fetcher));
  assert.equal(verdict.versionOnly, false);
  assert.match(verdict.reason, /ccccccc changes more than manifest version fields \(scripts\/app\.js\)/);
});

test("a release with notes keeps the span for research", async () => {
  const { fetcher } = fake({ releases: [release("v1.0.1", "Adds a new generator.")] });
  const verdict = judgeSpan(await gatherFacts(input, fetcher));
  assert.equal(verdict.versionOnly, false);
  assert.match(verdict.reason, /release v1\.0\.1 carries notes/);
});

test("a release at or before the baseline is not part of the span", async () => {
  const { fetcher } = fake({ releases: [{ ...release("v1.0.0", "Old notes"), published_at: "2026-10-19T00:00:00Z" }, release("v1.0.1", null)] });
  const facts = await gatherFacts(input, fetcher);
  assert.deepEqual(facts.releases.map((r) => r.tag), ["v1.0.1"]);
  assert.equal(judgeSpan(facts).versionOnly, true);
});

test("a span longer than the read cap, a failed read, and a missing baseline are never called version-only", async () => {
  const many = Array.from({ length: 31 }, (_, index) => ({ sha: index.toString(16).padStart(40, "d"), files: [{ filename: "module.json", patch: BUMP }] }));
  const long = judgeSpan(await gatherFacts(input, fake({ commits: many }).fetcher));
  assert.equal(long.versionOnly, false);
  assert.match(long.reason, /31 commits and only the newest 30/);

  const failed = judgeSpan(await gatherFacts(input, fake({ status: { "/commits/": 500 } }).fetcher));
  assert.equal(failed.versionOnly, false);
  assert.match(failed.reason, /GitHub answered 500/);

  const none = await gatherFacts({ ...input, from: { version: null, commit: null } }, fake({}).fetcher);
  assert.equal(judgeSpan(none).versionOnly, false);
  assert.match(judgeSpan(none).reason, /no earlier baseline/);
});

test("a remote that is not on GitHub is not read at all", async () => {
  const { fetcher, calls } = fake({});
  const facts = await gatherFacts({ ...input, remoteUrl: "https://gitlab.com/example/demo-module.git" }, fetcher);
  assert.equal(facts.supported, false);
  assert.equal(calls.length, 0);
  assert.equal(judgeSpan(facts).versionOnly, false);
});

test("a manifest id change and a license file are reported", async () => {
  const { fetcher } = fake({
    listing: ["module.json", "LICENSE.md"],
    manifestBefore: { id: "demo", title: "Demo", system: ["old-system"] },
    manifestNow: { id: "demo", title: "Demo", system: ["new-system"] },
  });
  const facts = await gatherFacts(input, fetcher);
  assert.equal(facts.license.fileInRepo, "LICENSE.md");
  assert.deepEqual(facts.manifestChanges.map((change) => change.key), ["system"]);
  assert.deepEqual(facts.dependencies, [{ id: "new-system", type: "system", version: null }]);
});

test("the token is sent only as a bearer header", async () => {
  const seen: Array<Record<string, string> | undefined> = [];
  const { fetcher } = fake({});
  await gatherFacts(input, async (url, init) => { seen.push(init?.headers); return fetcher(url, init); }, { token: "test-token-value" });
  assert.ok(seen.length > 3);
  assert.ok(seen.every((headers) => headers?.["authorization"] === "Bearer test-token-value"));
});

test("manifest helpers read the older flat fields and ignore junk", () => {
  assert.deepEqual(manifestDependencies({ dependencies: [{ name: "x" }, "plain-id"], system: "sys" }), [{ id: "plain-id", type: "dependencies", version: null }, { id: "sys", type: "system", version: null }]);
  assert.deepEqual(manifestDependencies(null), []);
  assert.deepEqual(diffManifest({ version: "1" }, { version: "2" }).map((change) => change.key), ["version"]);
  assert.deepEqual(diffManifest(null, { version: "2" }), []);
});

test("a release body that only restates the tag, name, or repository is not notes, and real text is", async () => {
  assert.equal(isPlaceholderNotes("demo-module v1.0.1", "v1.0.1", null, "demo-module"), true);
  assert.equal(isPlaceholderNotes("Release 1.0.1", "v1.0.1", "v1.0.1", "demo-module"), true);
  assert.equal(isPlaceholderNotes("**Full Changelog**: https://github.com/example/demo-module/compare/v1.0.0...v1.0.1", "v1.0.1", null, "demo-module"), true);
  assert.equal(isPlaceholderNotes("", "v1.0.1", null, "demo-module"), true);
  assert.equal(isPlaceholderNotes("demo-module v1.0.1\n\nAdds a name generator.", "v1.0.1", null, "demo-module"), false);
  assert.equal(isPlaceholderNotes("Fixes 12 bugs", "v1.0.1", null, "demo-module"), false);
  const { fetcher } = fake({ releases: [release("v1.0.1", "demo-module v1.0.1")] });
  const facts = await gatherFacts(input, fetcher);
  assert.equal(facts.releases[0]?.hasNotes, false);
  assert.equal(judgeSpan(facts).versionOnly, true);
});

test("a release published long after the target commit is not part of the span", async () => {
  const later = { ...release("v1.0.2", "Adds a feature."), published_at: "2026-10-27T00:00:00Z" };
  const facts = await gatherFacts(input, fake({ releases: [later, release("v1.0.1", null)] }).fetcher);
  assert.deepEqual(facts.releases.map((r) => r.tag), ["v1.0.1"]);
  assert.equal(judgeSpan(facts).versionOnly, true);
});
