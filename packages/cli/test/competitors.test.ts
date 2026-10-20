import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCompetitorsFile } from "@scout/core";
import { parseDossierMarkdown, remoteKey, seedCompetitors } from "../src/competitors.ts";

const DOSSIER = [
  "# Acme Tools",
  "",
  "- Organization / creator: `Acme`",
  "- Repo: `git@github.com:Example/Acme-Tools.git`",
  "- Package: `https://example.test/packages/acme`",
  "- Last reviewed: 2026-05-05",
  "- Flags: Forge, vault, made-up",
  "tags: quill",
  "",
  "junk line without a colon",
].join("\n");

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

test("the dossier parser tolerates missing lines, CRLF, bad dates, and junk", () => {
  const parsed = parseDossierMarkdown(DOSSIER);
  assert.equal(parsed.title, "Acme Tools");
  assert.equal(parsed.org, "Acme");
  assert.equal(parsed.repo, "git@github.com:Example/Acme-Tools.git");
  assert.equal(parsed.packageUrl, "https://example.test/packages/acme");
  assert.equal(parsed.reviewed, "2026-05-05");
  assert.deepEqual(parsed.flags, ["forge", "vault", "quill"]);
  const crlf = parseDossierMarkdown(DOSSIER.replaceAll("\n", "\r\n").replace("2026-05-05", "2026-13-40"));
  assert.equal(crlf.reviewed, null);
  assert.equal(crlf.title, "Acme Tools");
  const bare = parseDossierMarkdown("# Only A Title\n\nLast reviewed: yesterday\nRepo: https://github.com/example/only-title\n");
  assert.equal(bare.reviewed, null);
  assert.equal(bare.repo, "https://github.com/example/only-title");
  assert.deepEqual(parseDossierMarkdown("not markdown\n```\n# Hidden\n```\n"), { title: null, repo: null, packageUrl: null, reviewed: null, org: null, flags: [] });
  assert.equal(remoteKey("https://github.com/example/acme-tools.git"), remoteKey("git@github.com:Example/Acme-Tools.git"));
  assert.equal(remoteKey("https://user:secret@github.com/example/acme-tools.git"), "github.com/example/acme-tools");
});

test("seed matches a mirror, keeps an existing baseline, and reports the rows it could not pair", async () => {
  const root = mkdtempSync(join(tmpdir(), "scout-comp-seed-"));
  try {
    const dossiers = join(root, "dossiers");
    const mirrors = join(root, "mirrors");
    const matched = join(dossiers, "Acme - Acme Tools");
    const lonely = join(dossiers, "Solo");
    const skipped = join(dossiers, "Notes");
    mkdirSync(matched, { recursive: true });
    mkdirSync(lonely, { recursive: true });
    mkdirSync(skipped, { recursive: true });
    mkdirSync(mirrors, { recursive: true });
    writeFileSync(join(matched, "00_Overview.md"), "# Overview\n");
    writeFileSync(join(matched, "01_tool.md"), DOSSIER);
    writeFileSync(join(lonely, "01_solo.md"), "# Solo Tool\n\n- Repo: `https://github.com/example/solo-tool.git`\n- Organization / creator: `Solo`\n");
    writeFileSync(join(skipped, "readme.txt"), "no numbered markdown\n");
    const mirror = join(mirrors, "acme-tools");
    const other = join(mirrors, "other-tool");
    for (const folder of [mirror, other]) {
      git(root, ["-c", "init.defaultBranch=main", "init", folder]);
      git(folder, ["config", "user.email", "dev@example.test"]);
      git(folder, ["config", "user.name", "Dev"]);
      git(folder, ["config", "commit.gpgsign", "false"]);
      writeFileSync(join(folder, "README.md"), "one\n");
      git(folder, ["add", "."]);
      git(folder, ["commit", "-m", "first"]);
      git(folder, ["tag", "v1.2.0"]);
    }
    git(mirror, ["remote", "add", "origin", "https://github.com/example/acme-tools.git"]);
    git(other, ["remote", "add", "origin", "https://gitlab.com/example/other-tool.git"]);
    const before = readFileSync(join(matched, "01_tool.md"), "utf8");
    const out = join(root, "competitors.json");
    const summary = await seedCompetitors({ dossiers, mirrors, out, today: "2026-05-20" });
    assert.equal(summary.matched, 1);
    assert.equal(summary.unmatchedMirrors, 1);
    assert.equal(summary.dossiersWithoutMirror, 1);
    assert.equal(readFileSync(join(matched, "01_tool.md"), "utf8"), before);
    const file = parseCompetitorsFile(readFileSync(out, "utf8"));
    const acme = file.entries.find((entry) => entry.id === "acme-tools");
    const solo = file.entries.find((entry) => entry.id === "solo-tool");
    const extra = file.entries.find((entry) => entry.id === "other-tool");
    assert.ok(acme);
    assert.equal(acme?.baseline?.version, "1.2.0");
    assert.equal(acme?.baseline?.source, "mirror");
    assert.equal(acme?.baseline?.at, "2026-05-05");
    assert.equal(acme?.org, "Acme");
    assert.equal(acme?.remoteUrl?.includes("secret"), false);
    assert.match(acme?.mirrorPath ?? "", /acme-tools$/);
    assert.equal(solo?.mirrorPath, null);
    assert.equal(solo?.baseline?.source, "none");
    assert.equal(extra?.dossierDir, null);
    assert.equal(extra?.name, "other-tool");
    acme!.baseline = { version: "9.9.9", commit: "kept", at: "2026-01-01", source: "analysis" };
    writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`);
    git(mirror, ["tag", "v9.0.0"]);
    const again = await seedCompetitors({ dossiers, mirrors, out, today: "2026-05-21" });
    assert.equal(again.entries, summary.entries);
    const kept = parseCompetitorsFile(readFileSync(out, "utf8")).entries.find((entry) => entry.id === "acme-tools");
    assert.equal(kept?.baseline?.version, "9.9.9");
    assert.equal(kept?.baseline?.commit, "kept");
    assert.equal(kept?.name, "Acme Tools");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
