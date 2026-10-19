import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { fixtureTests } from "@scout/core/testing";
import { adapter, quantization, readConfig, sourceFromPath } from "../src/index.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
fixtureTests(adapter, join(root, "fixtures/cogmodels"));
const probe = (stdout: string, exitCode = 0) => adapter.parse({ list: { stdout, exitCode, stderr: "" } }, "");
const file = (path: string, size = 8) => `---SCOUT-FILE---\n${path}\t${size}\t2026-10-01T00:00:00Z\n`;
const meta = (path: string, value: unknown) => `---SCOUT-META ${path}---\n${typeof value === "string" ? value : JSON.stringify(value)}\n---SCOUT-END---\n`;
const done = "---SCOUT-DONE---\n";

for (const os of ["windows", "macos", "linux"] as const) {
  test(`the ${os} probe matches its checked-in script byte for byte`, () => {
    const script = readFileSync(join(root, `tools/probes/${os}/cogmodels.${os === "windows" ? "ps1" : "sh"}`), "utf8");
    const argv = adapter.probes({ machineId: "host", os, roots: {} }, "")[0]!.argv;
    assert.equal(argv.at(-1), script);
    assert.equal(argv[0], os === "windows" ? "pwsh" : "/bin/bash");
  });
}

test("quantization follows the final matching token and ignores shard counters", () => {
  const cases: [string, string | null][] = [
    ["gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf", "UD-Q4_K_XL"],
    ["Gemma-4-12B-uncensored-bf16.Q5_K_M.gguf", "Q5_K_M"],
    ["nomic-embed-text-v1.5.Q8_0.gguf", "Q8_0"],
    ["model-Q4_K_XL.gguf", "Q4_K_XL"], ["model-BF16.gguf", "BF16"],
    ["mmproj-BF16.gguf", "BF16"], ["model.iq4_xs.gguf", "IQ4_XS"],
    ["model-UD-Q4_K_XL-00001-of-00003.gguf", "UD-Q4_K_XL"],
    ["model-Q4_K_M-00002-of-00003.gguf", "Q4_K_M"],
    ["model.F16.gguf", "F16"], ["model.MXFP4.gguf", "MXFP4"], ["model.gguf", null],
  ];
  for (const [name, expected] of cases) assert.equal(quantization(name), expected, name);
});

test("repository paths work on Windows and Unix", () => {
  assert.equal(sourceFromPath("C:\\Users\\fixture\\.lmstudio\\models\\owner\\repo\\file.gguf"), "hf:owner/repo");
  assert.equal(sourceFromPath("/home/fixture/.lmstudio/models/owner/repo/file.gguf"), "hf:owner/repo");
  assert.equal(sourceFromPath("/data/models/owner__repo/sub/file.gguf"), "hf:owner/repo");
  assert.equal(sourceFromPath("/data/models/file.gguf"), null);
});

test("the config reader retains paths and role links and discards secrets and templates", () => {
  const config = readConfig(String.raw`
[[engines]]
id = "vision"
args = [ # a comment with ] brackets
  "-m", "C:\\Model Folder\\model-Q4_K_M.gguf",
  "--mmproj", 'C:/Model Folder/mmproj-BF16.gguf',
  "--api-key", "FAKE-SECRET", "--embeddings"
]
key_file = "FAKE-SECRET"
[[peers]]
url = "FAKE-SECRET"
key_file = "FAKE-SECRET"
[register.text]
args = ["-m", "${"${MODEL}"}"]
[[roles]]
name = "describe"
chain = ["vision", "vision@another-host"]
[media]
model_dirs = ["C:/Media [one]", 'C:/Media #two'] # ]
store_dir = "C:/Store"
`);
  assert.deepEqual(config, {
    engines: [{ id: "vision", args: ["-m", "C:\\Model Folder\\model-Q4_K_M.gguf", "--mmproj", "C:/Model Folder/mmproj-BF16.gguf", "--embeddings"] }],
    roles: [{ name: "describe", chain: ["vision"] }], modelDirs: ["C:/Media [one]", "C:/Media #two"], storeDir: "C:/Store",
  });
  assert.equal(JSON.stringify(config).includes("FAKE-SECRET"), false);
  const parsed = probe(`---SCOUT-CONFIG---\n[[peers]]\nkey_file = "FAKE-SECRET"\n${file("/models/unknown.gguf")}${done}`);
  assert.equal(JSON.stringify(parsed).includes("FAKE-SECRET"), false);
});

test("lock and sidecar provenance take precedence over paths and catalog entries", () => {
  const path = "/models/owner__path-repo/model-Q4_K_M.gguf";
  const output = file(path) + meta("/models/lock.json", { models: [{ path, source: "hf:owner/locked", revision: "0123456789abcdef", sha256: "a".repeat(64) }] }) + meta(path.replace(".gguf", ".cogitator.json"), { repo: "owner/sidecar" }) + done;
  const install = probe(output).installs[0]!;
  assert.equal(install.key, "hf:owner/locked:Q4_K_M");
  assert.equal(install.version, "0123456789ab");
  assert.equal(install.details!.sourceFrom, "lock");
  const sidecar = probe(file(path) + meta(path.replace(".gguf", ".cogitator.json"), { repo: "owner/sidecar", sha256: "b".repeat(64) }) + done).installs[0]!;
  assert.equal(sidecar.key, "hf:owner/sidecar:Q4_K_M");
  assert.equal(sidecar.version, "bbbbbbbbbbbb");
  assert.equal(sidecar.details!.sourceFrom, "sidecar");
});

test("the catalog supplies source only and unknown files retain a local identity", () => {
  const installs = probe(file("/models/nomic-embed-text-v1.5.Q8_0.gguf") + file("/models/custom.onnx") + done).installs;
  const catalog = installs.find((i) => i.details!.sourceFrom === "catalog")!;
  assert.equal(catalog.key, "hf:nomic-ai/nomic-embed-text-v1.5-GGUF:Q8_0");
  assert.equal(catalog.version, null);
  assert.equal(catalog.details!.revision, null);
  assert.equal(catalog.details!.family, "embedding");
  const local = installs.find((i) => i.key === "local:custom")!;
  assert.equal(local.details!.format, "onnx");
  assert.equal(local.details!.family, "other");
  const localCatalog = '[[model]]\nsource = "hf:owner/local-catalog"\nkind = "speech"\n[[model.file]]\npath = "custom.onnx"\n';
  const custom = probe(meta("/data/catalog.local.toml", localCatalog) + file("/models/custom.onnx") + done).installs[0]!;
  assert.equal(custom.key, "hf:owner/local-catalog");
  assert.equal(custom.details!.family, "speech");
});

test("projectors and split shards fold into one install with their sizes", () => {
  const main = "/models/owner__repo/model-Q4_K_M-00001-of-00002.gguf";
  const second = main.replace("00001", "00002");
  const projector = "/models/owner__repo/mmproj-BF16.gguf";
  const config = `---SCOUT-CONFIG---\n[[engines]]\nid = "vision"\nargs = ["-m", "${main}", "--mmproj", "${projector}"]\n[[roles]]\nname = "describe"\nchain = ["vision"]\n`;
  const parsed = probe(config + file(main, 10) + file(second, 20) + file(projector, 3) + done);
  assert.equal(parsed.installs.length, 1);
  assert.equal(parsed.installs[0]!.key, "hf:owner/repo:Q4_K_M");
  assert.equal(parsed.installs[0]!.details!.sizeBytes, 33);
  assert.equal((parsed.installs[0]!.details!.companions as unknown[]).length, 2);
  assert.deepEqual(parsed.installs[0]!.details!.roles, ["describe"]);
});

test("malformed and interrupted output reports partial without throwing", () => {
  assert.equal(probe("").status, "skipped");
  assert.equal(probe("", 1).status, "partial");
  assert.equal(adapter.parse({}, "").status, "failed");
  for (const bad of ["{", "null", "[]", '{"models":[null]}']) assert.equal(probe(meta("/models/lock.json", bad) + done).status, "partial");
  assert.equal(probe(file("/models/a.gguf") + "---SCOUT-PARTIAL---\n" + done).status, "partial");
  assert.equal(probe(file("/models/a.gguf")).installs.length, 1);
  assert.equal(probe("---SCOUT-FILE---\n/path\tbad\tno date\n" + done).status, "partial");
});

test("the Windows probe omits secret settings, validates magic and caps model files", { skip: process.platform !== "win32" }, () => {
  const scratch = join(root, ".scout-data"); mkdirSync(scratch, { recursive: true });
  const temp = mkdtempSync(join(scratch, "cogmodels-test-"));
  try {
    const data = join(temp, "Cogitator"); const models = join(data, "models"); mkdirSync(models, { recursive: true });
    writeFileSync(join(data, "cogitator.toml"), '[[engines]]\nid = "stub"\nargs = ["--api-key", "FAKE-SECRET"]\n[[peers]]\nkey_file = "FAKE-SECRET"\n');
    writeFileSync(join(data, "manage.key"), "FAKE-SECRET");
    writeFileSync(join(models, "invalid.gguf"), "not gguf");
    const run = () => spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", join(root, "tools/probes/windows/cogmodels.ps1")], { encoding: "utf8", windowsHide: true, env: { ...process.env, LOCALAPPDATA: temp }, timeout: 25_000 });
    const invalid = run();
    assert.equal(invalid.status, 0, invalid.stderr);
    assert.equal(invalid.stdout.includes("FAKE-SECRET"), false);
    assert.equal(probe(invalid.stdout).status, "partial");
    assert.equal(probe(invalid.stdout).installs.length, 0);
    for (let i = 0; i < 2001; i++) writeFileSync(join(models, `model-${i}.bin`), "stub");
    const capped = run();
    assert.equal(capped.status, 0, capped.stderr);
    assert.equal(probe(capped.stdout).status, "partial");
    assert.equal(probe(capped.stdout).installs.length, 2000);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});
