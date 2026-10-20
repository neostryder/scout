import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeChange, changeSizeScore, type ChangeInput } from "../src/competitor-analysis.ts";

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
}

function record(subject: string, body = ""): string {
  return `abc\x1f2026-01-01T00:00:00Z\x1f${subject}\x1f${body}\x1e`;
}

function diffFile(path: string, removed: string, added: string): string {
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", `-${removed}`, `+${added}`].join("\n");
}

function files(lines: string[]): Pick<ChangeInput, "nameStatusText" | "numstatText"> {
  const names: string[] = [];
  const stats: string[] = [];
  for (const line of lines) {
    const [status, path, added, deleted] = line.split("|");
    names.push(`${status}\t${path}`);
    stats.push(`${added}\t${deleted}\t${path}`);
  }
  return { nameStatusText: names.join("\n"), numstatText: stats.join("\n") };
}

test("the change score is a log of weighted churn", () => {
  assert.equal(changeSizeScore(0), 0);
  assert.equal(changeSizeScore(100), 54);
  assert.equal(changeSizeScore(500) >= 70, true);
});

test("analyzeChange counts commits, files, manifests, hosts, settings, notes, and prices", () => {
  const logText = [
    record("feat(api): add a call"),
    record("fix!: break the call"),
    record("docs: notes", "BREAKING: the note moved"),
    record("chore: tidy"),
    record("refactor: move"),
    record("test: cover"),
    record("build: pack"),
    record("ci: run"),
    record("random subject"),
  ].join("");
  const listed = files([
    "M|src/app.ts|20|0",
    "M|test/app.test.ts|2|0",
    "M|README.md|1|0",
    "M|.github/workflows/ci.yml|1|0",
    "M|assets/logo.png|1|0",
    "M|dist/app.min.js|1000|0",
    "M|package-lock.json|4|0",
    "M|package.json|2|0",
    "M|data.bin|1|0",
    "A|src/added.ts|3|0",
    "D|src/gone.ts|0|2",
    "M|plans.md|1|0",
  ]);
  listed.nameStatusText += "\nR100\tsrc/old.ts\tsrc/new.ts";
  listed.numstatText += "\n1\t1\tsrc/{old.ts => new.ts}";
  const diffText = [
    diffFile("src/app.ts", "const x = 1", 'fetch("https://cdn.example.net/a.js"); fetch("https://known.example.net/old.js"); fetch("https://github.com/example/acme"); fetch("https://gitlab.com/example/acme")'),
    diffFile("src/added.ts", "old", 'game.settings.register("acme", "volume"); registerSetting("tone"); config.get("region"); process.env.ACME_TOKEN'),
    diffFile("CHANGELOG.md", "old", "## 1.1.0"),
    diffFile("plans.md", "plan: free", "The pro plan is 9 per month"),
  ].join("\n");
  const analysis = analyzeChange({
    logText,
    ...listed,
    diffText,
    oldFiles: [{ path: "src/app.ts", text: "see https://known.example.net/old.js\n" }],
    remoteHost: "gitlab.com",
    shipsCode: true,
    manifests: [
      { path: "package.json", before: JSON.stringify({ name: "acme-tools", version: "1.0.0", main: "old.js", dependencies: { left: "^1" } }), after: JSON.stringify({ name: "acme-tools", version: "1.1.0", main: "new.js", dependencies: { left: "^2", right: "^1" } }) },
      { path: "module.json", before: JSON.stringify({ relationships: { systems: ["old"] } }), after: JSON.stringify({ relationships: { systems: ["acme"] }, flags: ["helper"] }) },
      { path: "manifest.json", before: JSON.stringify({ permissions: ["storage"], background: { service_worker: "old.js" } }), after: JSON.stringify({ permissions: ["storage", "tabs"], background: { service_worker: "new.js" } }) },
      { path: "pyproject.toml", before: "[project]\nversion = \"1.0.0\"\ndependencies = [\"left>=1\"]\n", after: "[project]\nversion = \"1.1.0\"\ndependencies = [\"left>=1\", \"right>=2\"]\n" },
      { path: "Cargo.toml", before: "[package]\nversion = \"1.0.0\"\n[dependencies]\nleft = \"1\"\n", after: "[package]\nversion = \"1.1.0\"\n[dependencies]\nleft = \"1\"\nright = \"2\"\n[bin]\nname = \"acme\"\npath = \"src/main.rs\"\n" },
      { path: "go.mod", before: "module example.test/acme\n\ngo 1.22\n\nrequire example.test/left v1.0.0\n", after: "module example.test/acme\n\ngo 1.22\n\nrequire (\n\texample.test/left v1.0.0\n\texample.test/right v1.2.0\n)\n" },
      { path: "broken.json", before: "{", after: "not json" },
    ],
  });
  assert.equal(analysis.commitClasses.feat, 1);
  assert.equal(analysis.commitClasses.fix, 1);
  assert.equal(analysis.commitClasses.docs, 1);
  assert.equal(analysis.commitClasses.chore, 1);
  assert.equal(analysis.commitClasses.refactor, 1);
  assert.equal(analysis.commitClasses.test, 1);
  assert.equal(analysis.commitClasses.build, 1);
  assert.equal(analysis.commitClasses.ci, 1);
  assert.equal(analysis.commitClasses.other, 1);
  assert.equal(analysis.commitClasses.breaking, 2);
  assert.equal(analysis.fileCategories.source >= 1, true);
  assert.equal(analysis.fileCategories.tests, 1);
  assert.equal(analysis.fileCategories.docs >= 1, true);
  assert.equal(analysis.fileCategories.config, 1);
  assert.equal(analysis.fileCategories.assets, 1);
  assert.equal(analysis.fileCategories.generated, 1);
  assert.equal(analysis.fileCategories.lockfile, 1);
  assert.equal(analysis.fileCategories.manifest, 1);
  assert.equal(analysis.fileCategories.other, 1);
  assert.equal(analysis.changeSize.files >= 10, true);
  assert.equal(analysis.changeSize.added > 0, true);
  assert.equal(analysis.renamed, 1);
  assert.deepEqual(analysis.addedFiles, ["src/added.ts"]);
  assert.deepEqual(analysis.removedFiles, ["src/gone.ts"]);
  assert.deepEqual(analysis.newOutboundHosts, [{ host: "cdn.example.net", file: "src/app.ts" }]);
  assert.deepEqual(analysis.newSettingsKeys, ["acme.volume", "tone", "region", "ACME_TOKEN"]);
  assert.equal(analysis.changelog.releaseNotesFound, true);
  assert.match(analysis.changelog.text, /1\.1\.0/);
  assert.deepEqual(analysis.pricingFiles.includes("plans.md"), true);
  assert.equal(analysis.pricingTermsAdded.some((line) => line.includes("per month")), true);
  const pkg = analysis.manifestDiff.find((file) => file.path === "package.json");
  assert.deepEqual(pkg?.version, { from: "1.0.0", to: "1.1.0" });
  assert.deepEqual(pkg?.dependenciesAdded, [{ name: "left", range: "^2" }, { name: "right", range: "^1" }]);
  assert.deepEqual(pkg?.dependenciesRemoved, [{ name: "left", range: "^1" }]);
  assert.deepEqual(pkg?.entryPointsChanged, ["main: old.js -> new.js"]);
  const foundry = analysis.manifestDiff.find((file) => file.path === "module.json");
  assert.equal(foundry?.permissionsAdded.includes("systems:acme"), true);
  assert.equal(foundry?.permissionsAdded.includes("flag:helper"), true);
  assert.equal(foundry?.permissionsRemoved.includes("systems:old"), true);
  const extension = analysis.manifestDiff.find((file) => file.path === "manifest.json");
  assert.deepEqual(extension?.permissionsAdded, ["tabs"]);
  assert.equal(extension?.entryPointsChanged.includes("background.service_worker: old.js -> new.js"), true);
  const python = analysis.manifestDiff.find((file) => file.path === "pyproject.toml");
  assert.deepEqual(python?.version, { from: "1.0.0", to: "1.1.0" });
  assert.equal(python?.dependenciesAdded.some((item) => item.name === "right"), true);
  const cargo = analysis.manifestDiff.find((file) => file.path === "Cargo.toml");
  assert.equal(cargo?.dependenciesAdded.some((item) => item.name === "right"), true);
  assert.equal(cargo?.entryPointsChanged.some((item) => item.includes("src/main.rs")), true);
  const gomod = analysis.manifestDiff.find((file) => file.path === "go.mod");
  assert.equal(gomod?.dependenciesAdded.some((item) => item.name === "example.test/right"), true);
  const broken = analysis.manifestDiff.find((file) => file.path === "broken.json");
  assert.equal(broken?.malformed, true);
  assert.deepEqual(broken?.dependenciesAdded, []);
  assert.equal(analysis.flags.minifiedOrGenerated, true);
  assert.equal(analysis.flags.reaRecommended, true);
  assert.equal(analysis.flags.reaReason, "new outbound host");
  assert.equal(analysis.truncated, false);
});

test("each analysis flag has its own reason, and a bad manifest does not throw", () => {
  const source = files(["M|src/app.ts|1|0"]);
  const none = analyzeChange({ baseline: "none", shipsCode: true, manifests: [{ path: "package.json", before: null, after: "{\"version\":\"1.2.0\",\"dependencies\":{\"left\":\"1.0.0\"}}" }] });
  assert.equal(none.baseline, "none");
  assert.equal(none.flags.reaRecommended, false);
  assert.equal(none.flags.reaReason, "no baseline");
  assert.equal(none.commitClasses.feat, 0);
  assert.deepEqual(none.manifestDiff[0]?.version, { from: null, to: "1.2.0" });
  assert.deepEqual(none.manifestDiff[0]?.dependenciesAdded, [{ name: "left", range: "1.0.0" }]);
  const quiet = analyzeChange({ ...source, shipsCode: false, diffText: diffFile("src/app.ts", "a", "https://cdn.example.net/a.js") });
  assert.equal(quiet.flags.reaReason, "no shipped code");
  assert.equal(quiet.flags.reaRecommended, false);
  const docs = analyzeChange({ ...files(["M|README.md|4|0"]), shipsCode: true });
  assert.equal(docs.flags.docsOnly, true);
  assert.equal(docs.flags.reaReason, "docs only");
  const bump = analyzeChange({
    ...files(["M|package-lock.json|5|1", "M|package.json|1|1"]),
    shipsCode: true,
    manifests: [{ path: "package.json", before: "{\"dependencies\":{\"left\":\"1\"}}", after: "{\"dependencies\":{\"left\":\"2\"}}" }],
  });
  assert.equal(bump.flags.dependencyBumpOnly, true);
  assert.equal(bump.flags.reaReason, "dependency bump only");
  const versionOnly = analyzeChange({
    ...files(["M|package.json|1|1"]),
    shipsCode: true,
    manifests: [{ path: "package.json", before: "{\"version\":\"1.0.0\"}", after: "{\"version\":\"1.1.0\"}" }],
  });
  assert.equal(versionOnly.flags.dependencyBumpOnly, false);
  const minified = analyzeChange({ ...files(["M|src/app.ts|10|0", "M|dist/app.min.js|1000|0"]), shipsCode: true });
  assert.equal(minified.flags.minifiedOrGenerated, true);
  assert.equal(minified.flags.reaReason, "minified code changed");
  const rewrite = analyzeChange({ ...files(["M|src/app.ts|500|0"]), shipsCode: true });
  assert.equal(rewrite.flags.largeRewrite, true);
  assert.equal(rewrite.changeSize.score >= 70, true);
  assert.match(rewrite.flags.reaReason, /^source score /);
  const tiny = analyzeChange({ ...source, shipsCode: true });
  assert.equal(tiny.flags.reaRecommended, false);
  assert.equal(tiny.flags.reaReason, "change is tiny");
  const mid = analyzeChange({ ...files(["M|src/app.ts|20|0"]), shipsCode: true });
  assert.equal(mid.changeSize.score >= 10 && mid.changeSize.score < 40, true);
  assert.equal(mid.flags.reaReason, "below the source score threshold");
  const host = analyzeChange({ ...source, shipsCode: true, diffText: diffFile("src/app.ts", "a", "https://cdn.example.net/a.js") });
  assert.equal(host.flags.reaReason, "new outbound host");
  const permission = analyzeChange({
    ...source,
    shipsCode: true,
    manifests: [{ path: "module.json", before: "{\"version\":\"1\"}", after: "{\"version\":\"1\",\"relationships\":{\"systems\":[\"acme\"]}}" }],
  });
  assert.equal(permission.flags.reaReason, "new permission");
  const malformed = analyzeChange({ manifests: [{ path: "package.json", before: "{", after: "not json" }] });
  assert.equal(malformed.manifestDiff[0]?.malformed, true);
  assert.deepEqual(malformed.manifestDiff[0]?.dependenciesAdded, []);
});

test("analysis drops the longest list once the text passes 64 KB", () => {
  const added = Array.from({ length: 100 }, (_, index) => `A\tsrc/${"n".repeat(800)}-${index}.ts`);
  const analysis = analyzeChange({ nameStatusText: added.join("\n"), numstatText: "", shipsCode: true });
  assert.equal(analysis.truncated, true);
  assert.equal(analysis.addedFiles.length < 100, true);
  assert.equal(Buffer.byteLength(JSON.stringify(analysis), "utf8") <= 64 * 1024, true);
});

test("new hosts, settings, and pricing lines stop at their caps", () => {
  const hostLines = Array.from({ length: 51 }, (_, index) => `+fetch("https://h${index}.example.net/a")`).join("\n");
  const diffText = ["diff --git a/src/app.ts b/src/app.ts", "--- a/src/app.ts", "+++ b/src/app.ts", "@@ -1,1 +1,51 @@", hostLines].join("\n");
  const hosts = analyzeChange({ ...files(["M|src/app.ts|51|0"]), diffText, shipsCode: true });
  assert.equal(hosts.newOutboundHosts.length, 50);
  assert.equal(hosts.newOutboundHosts[0]?.host, "h0.example.net");
  const settings = Array.from({ length: 101 }, (_, index) => `+process.env.KEY_${index}`).join("\n");
  const settingsDiff = ["diff --git a/src/app.ts b/src/app.ts", "--- a/src/app.ts", "+++ b/src/app.ts", "@@ -1 +1 @@", settings].join("\n");
  const keys = analyzeChange({ ...files(["M|src/app.ts|101|0"]), diffText: settingsDiff, shipsCode: true });
  assert.equal(keys.newSettingsKeys.length, 100);
  const prices = Array.from({ length: 41 }, (_, index) => `+plan ${index}`).join("\n");
  const priceDiff = ["diff --git a/plans.md b/plans.md", "--- a/plans.md", "+++ b/plans.md", "@@ -1 +1 @@", prices].join("\n");
  const priced = analyzeChange({ ...files(["M|plans.md|41|0"]), diffText: priceDiff, shipsCode: true });
  assert.equal(priced.pricingTermsAdded.length, 40);
});

test("analyzeChange reads the git output of a throwaway repository", () => {
  const root = mkdtempSync(join(tmpdir(), "scout-comp-analyze-"));
  try {
    const repo = join(root, "acme-tools");
    git(root, ["-c", "init.defaultBranch=main", "init", repo]);
    configure(repo);
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "app.ts"), "export const value = 1;\n");
    writeFileSync(join(repo, "package.json"), "{\"name\":\"acme-tools\",\"version\":\"1.0.0\"}\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "first"]);
    const from = git(repo, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(repo, "src", "app.ts"), "export const value = 2;\nexport const remote = \"https://cdn.example.net/lib.js\";\n");
    writeFileSync(join(repo, "CHANGELOG.md"), "## 1.1.0\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "feat: add a remote call"]);
    const to = git(repo, ["rev-parse", "HEAD"]).trim();
    const range = `${from}..${to}`;
    const analysis = analyzeChange({
      logText: git(repo, ["log", "-n", "20", "--format=%H%x1f%cI%x1f%s%x1f%b%x1e", range]),
      numstatText: git(repo, ["diff", "--numstat", range]),
      nameStatusText: git(repo, ["diff", "--name-status", range]),
      diffText: git(repo, ["diff", "--unified=3", from, to]),
      shipsCode: true,
      remoteHost: "github.com",
      manifests: [{ path: "package.json", before: "{\"name\":\"acme-tools\",\"version\":\"1.0.0\"}\n", after: "{\"name\":\"acme-tools\",\"version\":\"1.0.0\"}\n" }],
    });
    assert.equal(analysis.commitClasses.feat, 1);
    assert.equal(analysis.fileCategories.source, 1);
    assert.equal(analysis.changeSize.files >= 2, true);
    assert.equal(analysis.changeSize.score > 0, true);
    assert.equal(analysis.changelog.releaseNotesFound, true);
    assert.deepEqual(analysis.newOutboundHosts, [{ host: "cdn.example.net", file: "src/app.ts" }]);
    assert.equal(analysis.manifestDiff[0]?.version, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
