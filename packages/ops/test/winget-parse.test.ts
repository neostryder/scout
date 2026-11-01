import { test } from "node:test";
import assert from "node:assert/strict";
import { planUpdate } from "../src/plan.ts";

const machine = { transport: { type: "local" } } as const;
const parse = (key: string, out: string): string | null => planUpdate({ ecosystem: "winget", key, kind: "package" }, "2.0", machine).verify.parse(out);

test("winget list is read when a value fills its column and only one space separates the columns", () => {
  const out = "Name          Id                      Version Available Source\n--------------------------------------------------------------\n1Password CLI AgileBits.1Password.CLI 2.34.1  2.39.0    winget\n\n";
  assert.equal(parse("AgileBits.1Password.CLI", out), "2.34.1");
});

test("winget list is read with wide gaps, with no Available column, and with a truncated-version marker", () => {
  assert.equal(parse("Git.Git", "Name  Id  Version\nGit  Git.Git  2.0\n"), "2.0");
  assert.equal(parse("Git.Git", "Name Id Version Source\n---\nGit for Windows Git.Git 2.47.1 winget\n"), "2.47.1");
  assert.equal(parse("Some.App", "Name Id Version\n---\nSome App Some.App < 1.2.3\n"), "1.2.3");
});

test("winget list returns null when the id is absent or another id only contains it", () => {
  assert.equal(parse("Git.Git", "Name Id Version\n---\nGit LFS Git.Git.LFS 3.0\n"), null);
  assert.equal(parse("Git.Git", "No installed package found matching input criteria.\n"), null);
});

test("winget and Store plans preserve Zoom versions with parenthesized builds", () => {
  for (const ecosystem of ["winget", "msstore"]) {
    const plan = planUpdate({ ecosystem, key: "Zoom.Zoom", kind: "app" }, "7.2.5 (51704)", machine);
    assert.equal(plan.allowed, true);
    assert.equal(plan.argv[plan.argv.indexOf("--version") + 1], "7.2.5 (51704)");
    assert.equal(plan.verify.parse("Zoom  Zoom.Zoom  7.2.1 (48556)  7.2.5 (51704)  winget\n"), "7.2.1 (48556)");
    assert.equal(plan.verify.parse("Zoom Zoom.Zoom 7.2.5 (51704) winget\n"), "7.2.5 (51704)");
  }
});

test("fixed winget columns preserve internal version spaces without taking the available version", () => {
  const output = "Name  Id         Version                Available              Source\nZoom  Zoom.Zoom  7.2.1 build (48556)     7.2.5 build (51704)     winget\n";
  assert.equal(parse("Zoom.Zoom", output), "7.2.1 build (48556)");
});

test("only winget and Store accept single spaces and one balanced version suffix", () => {
  for (const ecosystem of ["winget", "msstore"]) {
    for (const target of ["7.2.5 (51704)", "7.2.5 build (51704)"]) {
      assert.equal(planUpdate({ ecosystem, key: "Zoom.Zoom", kind: "app" }, target, machine).allowed, true, target);
    }
    for (const target of [" 7.2.5", "7.2.5 ", "7.2.5  (51704)", "7.2.5 (51704", "7.2.5 51704)", "7.2.5 ()", "7.2.5 ((51704))", "7.2.5 (1) (2)", "7.2.5\t(51704)", "7.2.5;whoami", "7.2.5 $(whoami)", "7.2.5 & whoami", "7.2.5\nwhoami", "7.2.5 | whoami", '7.2.5 "51704"']) {
      assert.equal(planUpdate({ ecosystem, key: "Zoom.Zoom", kind: "app" }, target, machine).allowed, false, target);
    }
    assert.equal(planUpdate({ ecosystem, key: "Zoom.Zoom;whoami", kind: "app" }, "7.2.5 (51704)", machine).allowed, false);
  }
  for (const ecosystem of ["brew", "cask", "npm", "pipx", "uv-tool", "pacman", "aur"]) {
    assert.equal(planUpdate({ ecosystem, key: "zoom", kind: "app" }, "7.2.5 (51704)", machine).allowed, false, ecosystem);
  }
});
