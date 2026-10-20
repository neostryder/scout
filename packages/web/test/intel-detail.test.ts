import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cloneBehindRelease, gitclone } from "../../research/src/gitclone.ts";
import { huggingface } from "../../research/src/huggingface.ts";
import type { ResearchTarget } from "../../research/src/types.ts";

const observedAt = "2026-10-18T12:00:00.000Z";
const { upstreamBlocks } = await import(new URL("../public/intel-detail.js", import.meta.url).href) as {
  upstreamBlocks: (detail: unknown) => { type: string; text?: string; items?: string[]; summary?: string }[];
};

type Block = { type: string; text?: string; items?: string[]; summary?: string };

function lines(blocks: Block[]): string[] {
  return blocks.flatMap((block) => block.type === "ul" ? block.items ?? [] : block.text ? [block.text] : []);
}

function gitFixture(name: string): { target: ResearchTarget; steps: { url: string; status: number; body: string }[]; expected: { intel: Record<string, unknown> } } {
  return JSON.parse(readFileSync(new URL(`../../../fixtures/research/gitclone/${name}.json`, import.meta.url), "utf8")) as { target: ResearchTarget; steps: { url: string; status: number; body: string }[]; expected: { intel: Record<string, unknown> } };
}

function gitDetail(name: string, details?: Record<string, unknown>) {
  const fixture = gitFixture(name);
  const parsed = gitclone.parse(fixture.steps[0]?.status ?? 0, JSON.stringify(fixture.steps), fixture.target);
  assert.deepEqual(parsed.intel, fixture.expected.intel);
  return { intel: [{ source: "gitclone", fetchedAt: observedAt, data: parsed.intel }], details: details ?? fixture.target.details };
}

function hfFixture(name: string): { status: number; body: string } {
  return JSON.parse(readFileSync(new URL(`../../../fixtures/research/huggingface/${name}.json`, import.meta.url), "utf8")) as { status: number; body: string };
}

function hfTarget(key = "hf:Qwen/Qwen2.5-0.5B-Instruct", details: Record<string, unknown> = {}): ResearchTarget {
  return { id: 1, ecosystem: "model", key, name: key, homepage: null, tap: null, details, observedAt };
}

function hfIntel(name: string, target = hfTarget()) {
  const fixture = hfFixture(name);
  return huggingface.parse(fixture.status, fixture.body, target).intel;
}

test("an install with no intel renders nothing", () => {
  assert.deepEqual(upstreamBlocks({}), []);
  assert.deepEqual(upstreamBlocks({ intel: [] }), []);
});

test("gitclone fixtures render branch, head date, release, distance and archive state", () => {
  const release = gitDetail("release");
  const releaseLines = lines(upstreamBlocks(release));
  const intel = gitFixture("release").expected.intel;
  const latest = intel["latestRelease"] as { tag: string; publishedAt: string; url: string };
  assert.ok(releaseLines.includes("Default branch: main"));
  assert.ok(releaseLines.includes(`Head commit date: ${intel["headAt"]}`));
  assert.ok(releaseLines.includes(`Latest release: ${latest.tag}, published ${latest.publishedAt}`));
  assert.ok(releaseLines.includes("This clone is 4 commits behind the default branch"));
  assert.ok(releaseLines.includes("Up to date with the latest release"));
  assert.equal(releaseLines.includes(latest.url), false);
  assert.equal(releaseLines.includes("Archived upstream"), false);

  const behind = lines(upstreamBlocks(gitDetail("release", { commit: gitFixture("release").target.details["commit"], nearestTag: "v1.0.0", describe: "v1.0.0-4-gaaaaaaa" })));
  assert.ok(behind.includes("A newer release exists: v2.0.0"));
  assert.equal(behind.includes("Up to date with the latest release"), false);

  const tags = lines(upstreamBlocks(gitDetail("tags-only")));
  assert.ok(tags.includes("This clone is 0 commits behind the default branch"));
  assert.ok(tags.includes("Archived upstream"));
  assert.equal(tags.some((line) => line.startsWith("Latest release:")), false);
  assert.equal(tags.includes("Up to date with the latest release"), false);

  const missing = lines(upstreamBlocks(gitDetail("compare-404")));
  assert.ok(missing.includes("Commits behind: not measured yet"));
  assert.equal(missing.includes("This clone is"), false);
});

test("the release line follows cloneBehindRelease", () => {
  const cases: [string | null, string | null, string][] = [
    ["v1.0.0", "v1.0.0-0-gabcdef0", "v1.2.0"],
    ["v1.2.0", "v1.2.0-0-gabcdef0", "v1.2.0"],
    ["v1.2.0", "v1.2.0-1-gabcdef0", "v1.2.0"],
    ["v1.2.0", "v1.2.0-1-gabcdef0", "v1.3.0"],
    [null, "v1.2.0-1-gabcdef0", "v1.3.0"],
    [null, "abcdef0", "v1.3.0"],
    ["v2.0.0", "v2.0.0-1-gabcdef0", "v1.0.0"],
  ];
  for (const [nearestTag, describe, tag] of cases) {
    const wanted = cloneBehindRelease(nearestTag, describe, tag) ? `A newer release exists: ${tag}` : "Up to date with the latest release";
    const rendered = lines(upstreamBlocks({
      intel: [{ source: "gitclone", data: { latestRelease: { tag, publishedAt: "2026-10-02T00:00:00Z", url: "https://example.test/release" }, clones: { abc: 1 } } }],
      details: { commit: "abc", nearestTag, describe },
    }));
    assert.ok(rendered.includes(wanted), `${nearestTag} ${describe} ${tag}`);
    assert.equal(rendered.includes("https://example.test/release"), false);
  }
  const noRelease = lines(upstreamBlocks({ intel: [{ source: "gitclone", data: { latestRelease: null, clones: {} } }], details: { nearestTag: "v1.0.0", describe: "v1.0.0-1-gabcdef0" } }));
  assert.equal(noRelease.some((line) => line.startsWith("A newer release") || line.startsWith("Up to date")), false);
  assert.ok(noRelease.includes("Commits behind: not measured yet"));
});

test("huggingface fixtures render revisions, quantizations, related models, successors and errors", () => {
  const repo = hfIntel("repo")!;
  const quiet = lines(upstreamBlocks({ intel: [{ source: "huggingface", data: repo }] }));
  const revision = String(repo["latestRevision"]);
  assert.ok(quiet.includes(`Latest revision ${revision.slice(0, 12)}, changed ${repo["lastModified"]}`));
  assert.equal(quiet.includes("A newer revision exists"), false);
  assert.equal(quiet.includes("This is the latest revision"), false);

  const newer = lines(upstreamBlocks({ intel: [{ source: "huggingface", data: { ...repo, hasNewerRevision: true } }] }));
  assert.ok(newer.includes("A newer revision exists"));
  const same = lines(upstreamBlocks({ intel: [{ source: "huggingface", data: { ...repo, hasNewerRevision: false } }] }));
  assert.ok(same.includes("This is the latest revision"));

  const gguf = hfIntel("gguf", hfTarget("hf:bartowski/Meta-Llama-3.1-8B-Instruct-GGUF:Q4_K_M"))!;
  const quantBlocks = upstreamBlocks({ intel: [{ source: "huggingface", data: gguf }] });
  const quantList = quantBlocks.find((block) => block.type === "ul");
  assert.deepEqual(quantList?.items, gguf["quantizations"]);
  assert.ok((quantList?.items ?? []).includes("Q4_K_M"));

  const target = hfTarget();
  const combined = huggingface.combine!(huggingface.parse(hfFixture("repo").status, hfFixture("repo").body, target), {
    quantized: hfFixture("quantized"), finetune: hfFixture("finetune"), successors: hfFixture("successors"),
  }, target).intel!;
  const related = combined["related"] as { id: string; downloads: number; uncensored: boolean }[];
  const successors = combined["successors"] as { id: string; reason: string }[];
  const shown = upstreamBlocks({ intel: [{ source: "huggingface", data: combined }] });
  const lists = shown.filter((block) => block.type === "ul");
  assert.equal(lists[0]?.items?.length, Math.min(8, related.length));
  assert.deepEqual(lists[0]?.items, related.slice(0, 8).map((model) => `${model.id}, ${model.downloads} downloads${model.uncensored ? ", uncensored" : ""}`));
  assert.ok(shown.some((block) => block.text === "Related models"));
  assert.ok(shown.some((block) => block.text === "Possible successors"));
  assert.deepEqual(lists[1]?.items, successors.map((model) => `${model.id}: ${model.reason}`));
  for (const item of lists[1]?.items ?? []) assert.match(item, /possible/i);
  const flagged = related.filter((model) => model.uncensored);
  assert.ok(flagged.length > 0);
  const flaggedLines = lines(upstreamBlocks({ intel: [{ source: "huggingface", data: { ...combined, related: flagged.slice(0, 8), successors: [] } }] }));
  for (const model of flagged.slice(0, 8)) assert.ok(flaggedLines.includes(`${model.id}, ${model.downloads} downloads, uncensored`));

  assert.deepEqual(lines(upstreamBlocks({ intel: [{ source: "huggingface", data: hfIntel("missing") }] })), ["Upstream", "Hugging Face does not list this repository"]);
  assert.deepEqual(lines(upstreamBlocks({ intel: [{ source: "huggingface", data: hfIntel("gated") }] })), ["Upstream", "This repository is gated; sign in to Hugging Face to see more"]);
});

test("an unknown source is a collapsed details block capped at 4 KB", () => {
  const blocks = upstreamBlocks({ intel: [{ source: "vendor", fetchedAt: observedAt, data: { note: "n".repeat(8000), page: "https://example.test/home" } }] });
  assert.equal(blocks[0]?.text, "Upstream");
  const details = blocks.find((block) => block.type === "details");
  assert.equal(details?.summary, "Details");
  assert.ok((details?.text ?? "").startsWith("{\n"));
  assert.ok(new TextEncoder().encode(details?.text ?? "").length <= 4096);
  assert.equal(blocks.some((block) => block.type === "a"), false);
});

test("a truncated document replaces its fields with one line", () => {
  const blocks = upstreamBlocks({ intel: [{ source: "gitclone", truncated: true, data: { defaultBranch: "main" } }] });
  assert.deepEqual(lines(blocks), ["Upstream", "This upstream record is too large to show."]);
});

test("the page appends upstream sections from the detail helper", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(app, /import \{ upstreamSections \} from "\.\/intel-detail\.js";/);
  assert.match(app, /sections\.push\(\.\.\.upstreamSections\(d\)\);/);
});
