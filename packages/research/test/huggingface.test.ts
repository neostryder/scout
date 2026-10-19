import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openCatalog, getIntel, recordScan, upsertMachine } from "@scout/core";
import { huggingface, runResearch, DAILY, type Fetcher, type ResearchTarget } from "../src/index.ts";
import { huggingfaceRepo, modelFamily } from "../src/huggingface.ts";

interface Recorded { url: string; status: number; body: string }
const fixture = (name: string): Recorded => JSON.parse(readFileSync(new URL(`../../../fixtures/research/huggingface/${name}.json`, import.meta.url), "utf8")) as Recorded;
const observedAt = "2026-10-18T12:00:00Z";
const target = (key = "hf:Qwen/Qwen2.5-0.5B-Instruct"): ResearchTarget => ({ id: 1, ecosystem: "model", key, name: key, homepage: null, tap: null, details: {}, observedAt });
const parse = (name: string, t = target()) => { const f = fixture(name); return huggingface.parse(f.status, f.body, t); };

test("the researcher accepts only Hugging Face model identities and ignores variant suffixes", () => {
  assert.equal(huggingface.ttlMs, DAILY);
  assert.equal(huggingface.url(target("hf:owner/repo:UD-Q4_K_XL")), "https://huggingface.co/api/models/owner/repo");
  for (const key of ["local:custom", "hf:../repo", "hf:owner/repo/extra", "hf:owner/repo?token=secret", "hf:owner/repo:bad variant"]) assert.equal(huggingface.url(target(key)), null);
  assert.equal(huggingfaceRepo({ ...target(), ecosystem: "npm" }), null);
});

test("recorded repository revisions produce non-installable assertions and nullable comparisons", () => {
  const t = target();
  const result = parse("repo", t);
  const revision = (JSON.parse(fixture("repo").body) as { sha: string }).sha;
  assert.deepEqual(result.answers, [{ channel: "unknown", version: revision.slice(0, 12), installable: false }]);
  assert.equal(result.intel!.latestRevision, revision);
  assert.equal(result.intel!.hasNewerRevision, null);
  assert.equal(result.intel!.checkedAt, observedAt);
  t.details.revision = revision;
  assert.equal(parse("repo", t).intel!.hasNewerRevision, false);
  t.details.revision = "a".repeat(40);
  assert.equal(parse("repo", t).intel!.hasNewerRevision, true);
  const gguf = parse("gguf", target("hf:bartowski/Meta-Llama-3.1-8B-Instruct-GGUF:Q4_K_M"));
  assert.ok((gguf.intel!.ggufFiles as string[]).some((file) => /Q4_K_M/.test(file)));
  assert.ok((gguf.intel!.quantizations as string[]).includes("Q4_K_M"));
});

test("recorded variant lists flag uncensored fine-tunes and report possible successors", () => {
  const responses = Object.fromEntries(["quantized", "finetune", "successors"].map((name) => [name, fixture(name)]));
  const combined = huggingface.combine!(parse("repo"), responses, target());
  const related = combined.intel!.related as { id: string; uncensored: boolean; gguf: boolean }[];
  assert.ok(related.some((model) => /abliterated/i.test(model.id) && model.uncensored));
  assert.ok(related.some((model) => /heretic/i.test(model.id) && model.uncensored));
  assert.ok(related.some((model) => model.gguf));
  assert.ok(related.length <= 40);
  const successors = combined.intel!.successors as { id: string; reason: string }[];
  assert.ok(successors.length > 0 && successors.length <= 5);
  assert.ok(successors.every((model) => model.reason.startsWith("possible successor:")));
  assert.deepEqual(modelFamily("Llama-3.1-8B-Instruct-GGUF"), { stem: "llama", version: [3, 1] });
  const urls = huggingface.followups!(target(), fixture("repo").body);
  assert.equal(new URL(urls.quantized!).searchParams.get("filter"), "base_model:quantized:Qwen/Qwen2.5-0.5B-Instruct");
  assert.equal(new URL(urls.finetune!).searchParams.get("limit"), "20");
  assert.equal(new URL(urls.successors!).searchParams.get("sort"), "lastModified");
});

test("recorded 404 and gated 401 responses retain error intel without blocking research", () => {
  assert.equal(fixture("missing").status, 404);
  assert.equal(fixture("gated").status, 401);
  assert.deepEqual(parse("missing"), { status: "notfound", answers: [], intel: { error: "not-found", checkedAt: observedAt } });
  assert.deepEqual(parse("gated"), { status: "notfound", answers: [], intel: { error: "gated", checkedAt: observedAt } });
  for (const body of ["null", "[]", "{", "{}", "<html>"]) assert.equal(huggingface.parse(200, body, target()).status, "failed");
  assert.match(huggingface.parse(429, "", target(), { "retry-after": "60" }).message!, /60/);
});

function seed(keys = ["hf:Qwen/Qwen2.5-0.5B-Instruct:Q4_K_M"]) {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "host", name: "Host", os: "windows", kind: "host" });
  recordScan(db, "host", { sourceKind: "cogmodels", location: "", status: "ok", installs: keys.map((key) => ({ ecosystem: "model", kind: "model" as const, key, name: key, version: null, location: `/models/${key.split(":").at(-1)}`, details: { revision: "a".repeat(40) } })) }, "2026-10-18T00:00:00Z");
  return db;
}

test("the runner persists intel and assertions, paces every request, honors tokens and caches for a day", async () => {
  const db = seed();
  const times: number[] = [];
  const fetcher: Fetcher = async (url, init) => {
    times.push(Date.now());
    assert.equal(init.headers.authorization, "Bearer fixture-token");
    const parsed = new URL(url);
    const name = parsed.searchParams.has("author") ? "successors" : parsed.searchParams.get("filter")?.includes(":quantized:") ? "quantized" : parsed.searchParams.has("filter") ? "finetune" : "repo";
    const recorded = fixture(name);
    return { status: recorded.status, text: async () => recorded.body };
  };
  try {
    const [summary] = await runResearch(db, [huggingface], { fetch: fetcher, now: new Date(observedAt), env: { HUGGINGFACE_HUB_TOKEN: "fixture-token" }, concurrency: 4 });
    assert.deepEqual(summary, { source: "huggingface", asked: 1, ok: 1, notfound: 0, failed: 0, skipped: 0, answers: 1 });
    assert.equal(times.length, 4);
    for (let i = 1; i < times.length; i++) assert.ok(times[i]! - times[i - 1]! >= 250, `${times[i]! - times[i - 1]!} ms`);
    const row = db.prepare("SELECT id FROM packages").get() as { id: number };
    assert.equal(getIntel(db, row.id, "huggingface")!.data.hasNewerRevision, true);
    assert.equal((db.prepare("SELECT installable FROM assertions WHERE source = 'huggingface'").get() as { installable: number }).installable, 0);
    await runResearch(db, [huggingface], { fetch: fetcher, now: new Date("2026-10-19T11:59:00Z"), env: {} });
    assert.equal(times.length, 4);
  } finally { db.close(); }
});

test("the runner stores gated and missing intel, sends no token by default and stops on rate limits", async () => {
  for (const name of ["missing", "gated"]) {
    const db = seed();
    try {
      const recorded = fixture(name);
      const [summary] = await runResearch(db, [huggingface], { env: {}, now: new Date(observedAt), fetch: async (_url, init) => {
        assert.equal(init.headers.authorization, undefined);
        return { status: recorded.status, text: async () => recorded.body };
      } });
      assert.equal(summary!.notfound, 1);
      const row = db.prepare("SELECT id FROM packages").get() as { id: number };
      assert.equal(getIntel(db, row.id, "huggingface")!.data.error, name === "missing" ? "not-found" : "gated");
    } finally { db.close(); }
  }
  const db = seed(["hf:owner/repo:Q4_K_M", "hf:owner/repo:Q8_0"]);
  let calls = 0;
  try {
    const [summary] = await runResearch(db, [huggingface], { env: { HF_TOKEN: "preferred", HUGGINGFACE_HUB_TOKEN: "fallback" }, fetch: async (_url, init) => {
      calls++;
      assert.equal(init.headers.authorization, "Bearer preferred");
      return { status: 429, text: async () => "", headers: { get: () => "60" } };
    } });
    assert.equal(calls, 1);
    assert.equal(summary!.failed, 1);
    assert.equal(summary!.skipped, 1);
  } finally { db.close(); }
});
