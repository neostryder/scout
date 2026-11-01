import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));

test("fleet check-config prints enabled probe counts and rejects invalid files without values", (t) => {
  const dir = mkdtempSync(join(root, "scout-fleet-cli-"));
  const path = join(dir, "fleet.json");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = () => spawnSync(process.execPath, [entry, "fleet", "check-config", path], { windowsHide: true, encoding: "utf8", cwd: dir });
  const check = { machine: "example", component: "Example", argv: ["private-command"] };
  const sources = {
    remote: { enabled: true, checks: [check, { ...check, component: "Other" }] },
    local: { enabled: true, disk: { paths: ["C:/", "D:/"] }, tasks: { enabled: true }, wsl: { enabled: true }, windowsEvents: [{ component: "Events", log: "Example" }], logs: [{ component: "Log", path: "C:/private-path", pattern: "private-pattern" }] },
  };
  writeFileSync(path, JSON.stringify({ sources }));
  const valid = run();
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.stdout.trim(), "fleet config ok: 2 remote checks, 6 local probes enabled");
  writeFileSync(path, JSON.stringify({ sources: { remote: { ...sources.remote, enabled: false }, local: { ...sources.local, enabled: false } } }));
  const disabled = run();
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.equal(disabled.stdout.trim(), "fleet config ok: 0 remote checks, 0 local probes enabled");
  writeFileSync(path, JSON.stringify({ sources: { remote: { checks: [{ ...check, argv: ["private\nargument"] }] } } }));
  const invalid = run();
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /fleet config invalid: sources\.remote\.checks\[0\] \(component "Example"\): argv part 1 holds a control character such as a newline/);
  assert.doesNotMatch(invalid.stderr, /private/);
  writeFileSync(path, "{");
  const badJson = run();
  assert.equal(badJson.status, 1);
  assert.match(badJson.stderr, /fleet config invalid: the file is not valid JSON/);
});
