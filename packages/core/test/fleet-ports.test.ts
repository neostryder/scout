import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadFleetConfig } from "../src/index.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("a missing fleet file is empty and a malformed or secret-bearing file is ignored", () => {
  const dir = mkdtempSync(join(root, "scout-fleet-file-"));
  try {
    const missing = loadFleetConfig(join(dir, "absent.json"));
    assert.equal(missing.fileError, null);
    assert.equal(missing.fileErrorDetail, null);
    assert.deepEqual(missing.notifiers, []);
    assert.deepEqual(missing.digestTimes, ["08:00", "18:00"]);
    missing.digestTimes.push("09:00");
    assert.deepEqual(loadFleetConfig(join(dir, "absent.json")).digestTimes, ["08:00", "18:00"]);
    assert.equal(loadFleetConfig(join(dir, "absent.json")).notifiers.length, 0);

    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{", "utf8");
    assert.match(loadFleetConfig(bad).fileError ?? "", /malformed/);
    assert.equal(loadFleetConfig(bad).fileErrorDetail, "the file is not valid JSON");
    const secret = join(dir, "secret.json");
    writeFileSync(secret, JSON.stringify({ url: "https://example.test/hook" }), "utf8");
    assert.ok(loadFleetConfig(secret).fileError);
    const extra = join(dir, "extra.json");
    writeFileSync(extra, JSON.stringify({ nickname: "hub" }), "utf8");
    assert.ok(loadFleetConfig(extra).fileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("webhook addresses are read from the environment when the notifier is used", () => {
  const dir = mkdtempSync(join(root, "scout-fleet-file-"));
  try {
    const path = join(dir, "fleet.json");
    writeFileSync(path, JSON.stringify({ notifiers: [{ type: "webhook", urlEnv: "SCOUT_FLEET_WEBHOOK_URL" }] }), "utf8");
    let value: string | undefined;
    const file = loadFleetConfig(path, (name) => name === "SCOUT_FLEET_WEBHOOK_URL" ? value : undefined);
    assert.equal(file.fileError, null);
    assert.equal(file.notifiers[0]?.url(), undefined);
    value = "https://example.test/hook";
    assert.equal(file.notifiers[0]?.url(), value);
    writeFileSync(join(dir, "open.json"), JSON.stringify({ notifiers: [{ type: "webhook" }] }), "utf8");
    assert.ok(loadFleetConfig(join(dir, "open.json")).fileError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the example fleet file loads with no embedded address", () => {
  const path = fileURLToPath(new URL("../../../fleet.example.json", import.meta.url));
  const file = loadFleetConfig(path, () => undefined);
  assert.equal(file.fileError, null);
  assert.equal(file.fileErrorDetail, null);
  assert.equal(file.policy?.quietHours?.timezone, "local");
  assert.deepEqual(file.digestTimes, ["08:00", "18:00"]);
  assert.equal(file.ingestTokenEnv, "SCOUT_FLEET_INGEST_TOKEN");
  assert.equal(file.notifiers.some((row) => row.type === "webhook" && row.urlEnv === "SCOUT_FLEET_WEBHOOK_URL"), true);
  assert.equal(file.expected[0]?.host, "desktop");
  assert.equal(file.policy?.resolveAfterCleanChecks, 3);
  assert.equal(file.policy?.maxNoticesPerDay, 6);
  assert.equal(file.components?.[0]?.component, "backup");
});

test("component notes and the clean-check and daily-cap policy are validated", () => {
  const dir = mkdtempSync(join(root, "scout-fleet-notes-"));
  try {
    const path = join(dir, "fleet.json");
    const load = (value: unknown) => {
      writeFileSync(path, JSON.stringify(value), "utf8");
      return loadFleetConfig(path);
    };
    const good = load({ policy: { resolveAfterCleanChecks: 5, maxNoticesPerDay: 2 }, components: [{ host: "eru", component: "*", description: "A service on Eru.", nextStep: "Restart it." }] });
    assert.equal(good.fileError, null);
    assert.equal(good.policy?.resolveAfterCleanChecks, 5);
    assert.equal(good.policy?.maxNoticesPerDay, 2);
    assert.deepEqual(good.components, [{ host: "eru", component: "*", description: "A service on Eru.", nextStep: "Restart it." }]);
    assert.deepEqual(loadFleetConfig(join(dir, "absent.json")).components, []);
    assert.deepEqual(load({}).components, []);
    for (const bad of [
      { components: "backup" },
      { components: [{ host: "eru", component: "x" }] },
      { components: [{ host: "eru", component: "x", description: "" }] },
      { components: [{ host: "eru", component: "x", description: "ok", color: "red" }] },
      { components: [{ host: "eru", component: "x", description: "line\nbreak" }] },
      { components: [{ host: "eru", component: "x", description: "y".repeat(601) }] },
      { components: [{ host: "eru", component: "x", description: "ok", nextStep: 4 }] },
      { components: Array.from({ length: 201 }, (_, index) => ({ host: "eru", component: `c${index}`, description: "ok" })) },
      { policy: { resolveAfterCleanChecks: 0 } },
      { policy: { resolveAfterCleanChecks: 1.5 } },
      { policy: { maxNoticesPerDay: -1 } },
    ]) {
      const broken = load(bad);
      assert.ok(broken.fileError, JSON.stringify(bad).slice(0, 80));
      assert.deepEqual(broken.components, []);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalog source config is optional and validates flags, ages, and regex lists", () => {
  const dir = mkdtempSync(join(root, "scout-fleet-file-"));
  try {
    const path = join(dir, "fleet.json");
    assert.equal(loadFleetConfig(path).sources?.catalog?.enabled, undefined);
    for (const data of [{}, { sources: {} }, { sources: { catalog: {} } }, { sources: { catalog: { enabled: false } } }, { sources: { catalog: { neverRan: { tasks: [] } } } }]) {
      writeFileSync(path, JSON.stringify(data), "utf8");
      const file = loadFleetConfig(path);
      assert.equal(file.fileError, null);
      assert.notEqual(file.sources?.catalog?.enabled, true);
    }
    const catalog = { enabled: true, staleScanMinutes: 15, tasks: { include: ["^Backup$"], exclude: [] }, launchd: { include: ["^org\\.example\\."], exclude: ["test"] }, systemd: { include: ["^backup\\.service$"], exclude: [] }, windowsServices: { include: ["^Backup$"] } };
    writeFileSync(path, JSON.stringify({ sources: { catalog } }), "utf8");
    const file = loadFleetConfig(path);
    assert.equal(file.fileError, null);
    assert.deepEqual(file.sources?.catalog, catalog);
    for (const tasks of [["^backup$", "^folder\\\\task$"], Array(50).fill("x".repeat(200))]) {
      writeFileSync(path, JSON.stringify({ sources: { catalog: { neverRan: { tasks } } } }), "utf8");
      const file = loadFleetConfig(path);
      assert.equal(file.fileError, null);
      assert.deepEqual(file.sources?.catalog?.neverRan, { tasks, graceDays: 8 });
    }
    for (const invalid of [
      { tasks: { include: ["["] } },
      { launchd: { exclude: ["("] } },
      { systemd: { include: ["*"] } },
      { windowsServices: { include: ["["] } },
      { enabled: "true" },
      { staleScanMinutes: 0 },
      { staleScanMinutes: -1 },
      { tasks: { include: "backup" } },
      { tasks: { include: [1] } },
      { windowsServices: { exclude: [] } },
      { neverRan: null },
      { neverRan: [] },
      { neverRan: "backup" },
      { neverRan: {} },
      { neverRan: { tasks: "backup" } },
      { neverRan: { tasks: ["["] } },
      { neverRan: { tasks: Array(51).fill("backup") } },
      { neverRan: { tasks: [""] } },
      { neverRan: { tasks: ["x".repeat(201)] } },
      { neverRan: { tasks: [1] } },
      { neverRan: { tasks: [], unknown: true } },
      ...[-1, 366, 1.5, "8", null, true, [], {}].map((graceDays) => ({ neverRan: { tasks: [], graceDays } })),
      { unknown: true },
    ]) {
      writeFileSync(path, JSON.stringify({ ingestTokenEnv: "FLEET_TOKEN", sources: { catalog: { enabled: true, ...invalid } } }), "utf8");
      const broken = loadFleetConfig(path);
      assert.match(broken.fileError ?? "", /malformed/);
      assert.equal(broken.sources?.catalog?.enabled, undefined);
      assert.equal(broken.ingestTokenEnv, null);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("never-run config accepts grace days from zero through 365", () => {
  const dir = mkdtempSync(join(root, "scout-fleet-file-"));
  try {
    const path = join(dir, "fleet.json");
    for (const graceDays of [0, 1, 8, 365]) {
      const neverRan = { tasks: ["^backup$"], graceDays };
      writeFileSync(path, JSON.stringify({ sources: { catalog: { neverRan } } }), "utf8");
      const file = loadFleetConfig(path);
      assert.equal(file.fileError, null);
      assert.deepEqual(file.sources?.catalog?.neverRan, neverRan);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fleet file accepts remote alongside other sources and rejects malformed remote blocks", () => {
  const dir = mkdtempSync(join(root, "scout-fleet-file-"));
  try {
    const path = join(dir, "fleet.json");
    const check = { machine: "example", component: "Example app", argv: ["example", "status"] };
    writeFileSync(path, JSON.stringify({ sources: { catalog: { enabled: true }, local: {}, remote: { enabled: true, checks: [check] } } }), "utf8");
    const file = loadFleetConfig(path);
    assert.equal(file.fileError, null);
    assert.equal(file.sources?.catalog?.enabled, true);
    assert.ok(file.sources?.local);
    assert.equal(file.sources?.remote?.enabled, true);
    assert.equal(file.sources?.remote?.checks[0]?.machine, "example");
    assert.equal(file.sources?.remote?.checks[0]?.timeoutSeconds, 20);
    for (const remote of [null, { unknown: true }, { checks: [{ ...check, pattern: "[" }] }, { checks: [check, check] }]) {
      writeFileSync(path, JSON.stringify({ ingestTokenEnv: "FLEET_TOKEN", sources: { remote } }), "utf8");
      const broken = loadFleetConfig(path);
      assert.match(broken.fileError ?? "", /malformed/);
      assert.equal(broken.sources, undefined);
      assert.equal(broken.ingestTokenEnv, null);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remote validation details identify the check and reason without command or pattern values", () => {
  const dir = mkdtempSync(join(root, "scout-fleet-detail-"));
  try {
    const path = join(dir, "fleet.json");
    const check = { machine: "example", component: "hermes cron", argv: ["private-command", "private-token", "private\nargument"] };
    writeFileSync(path, JSON.stringify({ sources: { remote: { checks: [check] } } }));
    assert.equal(loadFleetConfig(path).fileErrorDetail, 'sources.remote.checks[0] (component "hermes cron"): argv part 3 holds a control character such as a newline');
    const valid = { ...check, argv: ["private-command"] };
    const location = 'sources.remote.checks[0] (component "hermes cron")';
    const rows: [unknown, string, string][] = [
      [null, "sources.remote.checks[0]", "check must be an object"],
      [{ ...valid, unknown: "private-value" }, location, "check holds an unknown field"],
      [{ ...valid, machine: "private invalid machine" }, location, "machine must use 1 through 64 lowercase letters, digits, underscores or hyphens and start with a letter or digit"],
      [{ ...valid, component: "private\ncomponent" }, "sources.remote.checks[0]", "component must be a non-empty string of at most 180 characters without control characters"],
      ...[null, [], Array(21).fill("private-argument")].map((argv): [unknown, string, string] => [{ ...valid, argv }, location, "argv must be a list of 1 through 20 strings"]),
      ...[[null], [""], ["x".repeat(501)]].map((argv): [unknown, string, string] => [{ ...valid, argv }, location, "argv part 1 must be a string of 1 through 500 characters"]),
      [{ ...valid, argv: ["private\u007fargument"] }, location, "argv part 1 holds a control character such as a newline"],
      [{ ...valid, timeoutSeconds: 0 }, location, "timeoutSeconds must be an integer from 1 through 120"],
      [{ ...valid, failureClass: "private-value" }, location, "failureClass is not a recognized failure class"],
      [{ ...valid, severity: "private-value" }, location, "severity must be critical, warning or info"],
      [{ ...valid, unreachable: "private-value" }, location, "unreachable must be report or ignore"],
      ...["pattern", "ignore", "mustMatch"].flatMap((key): [unknown, string, string][] => [
        [{ ...valid, [key]: 1 }, location, `${key} must be a string of at most 200 characters`],
        [{ ...valid, [key]: "x".repeat(201) }, location, `${key} must be a string of at most 200 characters`],
        [{ ...valid, [key]: "[private-pattern" }, location, `${key} holds an invalid regular expression`],
      ]),
    ];
    const cases: [unknown, string][] = [
      ...rows.map(([row, where, reason]): [unknown, string] => [{ checks: [row] }, `${where}: ${reason}`]),
      [null, "sources.remote: remote must be an object"],
      [{ unknown: "private-value" }, "sources.remote: remote holds an unknown field"],
      [{ enabled: "private-value" }, "sources.remote: enabled must be a boolean"],
      [{ checks: "private-value" }, "sources.remote.checks: checks must be a list of at most 60 checks"],
      [{ checks: Array(61).fill(valid) }, "sources.remote.checks: checks must be a list of at most 60 checks"],
      [{ checks: [valid, valid] }, "sources.remote.checks[1]: duplicate machine and component"],
      [{ checks: [{ ...valid, argv: ["x".repeat(65_536)] }] }, "sources.remote: remote exceeds 65536 characters"],
    ];
    for (const [remote, detail] of cases) {
      writeFileSync(path, JSON.stringify({ sources: { remote } }));
      const file = loadFleetConfig(path);
      assert.match(file.fileError ?? "", /malformed/);
      assert.equal(file.fileErrorDetail, detail);
      assert.doesNotMatch(file.fileErrorDetail!, /private|x{10}/);
    }
    writeFileSync(path, JSON.stringify({ sources: { remote: { checks: [valid] } } }));
    assert.equal(loadFleetConfig(path).fileErrorDetail, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("task validation details and other invalid sections never include config values", () => {
  const dir = mkdtempSync(join(root, "scout-fleet-detail-"));
  try {
    const path = join(dir, "fleet.json");
    const tasks: [unknown, string][] = [
      [null, "tasks must be an object"],
      [{ unknown: "private-value" }, "tasks holds an unknown field"],
      [{ enabled: "private-value" }, "enabled must be a boolean"],
      [{ ignore: "private-pattern" }, "ignore must be a list of at most 50 regular expressions"],
      [{ ignore: Array(51).fill("private-pattern") }, "ignore must be a list of at most 50 regular expressions"],
      [{ ignore: [null] }, "ignore entries must be strings of at most 200 characters"],
      [{ ignore: ["x".repeat(201)] }, "ignore entries must be strings of at most 200 characters"],
      [{ ignore: ["[private-pattern"] }, "ignore holds an invalid regular expression"],
      [{ expected: "private-value" }, "expected must be a list of at most 50 tasks"],
      [{ failureClass: "private-value" }, "failureClass is not a recognized failure class"],
      [{ expected: [null] }, "expected[0] must be an object"],
      [{ expected: [{ unknown: "private-value" }] }, "expected[0] holds an unknown field"],
      [{ expected: [{ name: "private\nname", maxAgeHours: 1 }] }, "expected[0].name must be a non-empty string of at most 195 characters without control characters"],
      [{ expected: [{ name: "private-name", maxAgeHours: 0 }] }, "expected[0].maxAgeHours must be an integer from 1 through 8760"],
    ];
    for (const [value, reason] of tasks) {
      writeFileSync(path, JSON.stringify({ sources: { local: { tasks: value } } }));
      assert.equal(loadFleetConfig(path).fileErrorDetail, `sources.local.tasks: ${reason}`);
    }
    const sections = ["policy", "notifiers", "investigator", "triage", "healers", "expected", "ingestTokenEnv", "digestTimes", "sources"];
    for (const section of sections) {
      writeFileSync(path, JSON.stringify({ [section]: null }));
      assert.equal(loadFleetConfig(path).fileErrorDetail, `section ${section} is invalid`);
    }
    for (const section of ["catalog", "local"]) {
      writeFileSync(path, JSON.stringify({ sources: { [section]: { unknown: "private-value" } } }));
      assert.equal(loadFleetConfig(path).fileErrorDetail, `section sources.${section} is invalid`);
    }
    writeFileSync(path, JSON.stringify({ sources: { catalog: { tasks: { include: ["[private-pattern"] } } } }));
    assert.equal(loadFleetConfig(path).fileErrorDetail, "section sources.catalog is invalid");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("healers require an exact allowlist and apply bounded rate and timeout defaults", () => {
  const dir = mkdtempSync(join(root, "scout-fleet-file-"));
  try {
    const path = join(dir, "fleet.json");
    const healer = { id: "restart-backup", command: ["restart", "backup"], host: "desktop", component: "backup", failureClass: "dead" };
    const load = (healers: unknown) => {
      writeFileSync(path, JSON.stringify({ healers }), "utf8");
      return loadFleetConfig(path);
    };
    assert.equal(load([healer]).fileError, null);
    assert.deepEqual(load([healer]).healers, [{ ...healer, cooldownMinutes: 60, maxPerDay: 3, timeoutSeconds: 120 }]);
    for (const limits of [{ cooldownMinutes: 1, maxPerDay: 1, timeoutSeconds: 1 }, { cooldownMinutes: 1440, maxPerDay: 24, timeoutSeconds: 300 }]) {
      assert.deepEqual(load([{ ...healer, ...limits }]).healers, [{ ...healer, ...limits }]);
    }
    const bad: Record<string, unknown[]> = {
      id: [undefined, null, 1, "", "x".repeat(81)],
      command: [undefined, null, [], "restart", [1], [""], ["x".repeat(501)], ["a\nb"], ["a\0b"], Array(33).fill("x")],
      host: [undefined, null, 1, "", " ", "x".repeat(201), "*", "desk?", "^desktop$", "/desktop/i", "desk\ntop"],
      component: [undefined, null, 1, "", " ", "x".repeat(181), "*", "back?", "^backup$", "/backup/", "back\0up"],
      failureClass: [undefined, null, 1, "", "unknown", "*"],
      cooldownMinutes: [null, 0, -1, 1441, 1.5, "60", true],
      maxPerDay: [null, 0, -1, 25, 1.5, "3", true],
      timeoutSeconds: [null, 0, -1, 301, 1.5, "120", true],
      unknown: [true],
    };
    for (const [key, values] of Object.entries(bad)) {
      for (const value of values) assert.match(load([{ ...healer, [key]: value }]).fileError ?? "", /malformed/, `${key}: ${JSON.stringify(value)}`);
    }
    for (const healers of [null, {}, [null], [healer, healer]]) assert.match(load(healers).fileError ?? "", /malformed/);
    assert.deepEqual(load([healer, { ...healer, id: "other" }]).healers.map((row) => row.id), [healer.id, "other"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
