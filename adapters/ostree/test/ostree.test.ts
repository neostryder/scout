import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fixtureTests } from "@scout/core/testing";
import { adapter } from "../src/index.ts";

const dir = fileURLToPath(new URL("../../../fixtures/ostree", import.meta.url));
fixtureTests(adapter, dir);

test("the probe is the recorded script, run through a fixed argument array", () => {
  const script = readFileSync(new URL("../../../tools/probes/linux/ostree.sh", import.meta.url), "utf8").replaceAll("\r\n", "\n");
  assert.deepEqual(adapter.probes({ machineId: "m", os: "linux", roots: {} }, ""), [{ id: "list", argv: ["/bin/sh", "-c", script] }]);
});

const stdout = (...lines: string[]): string => `${lines.join("\n")}\n`;

const BOOTED = [
  "State: idle",
  "Deployments:",
  "* ostree-image-signed:docker://ghcr.io/ublue-os/bazzite-deck-nvidia:stable",
  "                   Digest: sha256:5c69c75f",
  "                  Version: 43.20260420 (2026-04-20T05:59:06Z)",
];

const ROLLBACK = [
  "",
  "  ostree-image-signed:docker://ghcr.io/ublue-os/bazzite-deck-nvidia:stable",
  "                   Digest: sha256:ebc0b36a",
  "                  Version: 43.20260126 (2026-01-26T05:25:19Z)",
];

const STAGED = [
  "  ostree-image-signed:docker://ghcr.io/ublue-os/bazzite-deck-nvidia:stable",
  "                   Digest: sha256:9cf93fe3",
  "                  Version: 44.20261026 (2026-10-26T20:14:43Z)",
  "",
];

const remote = (...lines: string[]): string => stdout("---SCOUT-REMOTE---", ...lines, "exit=0");

test("the booted deployment is the one with the star, and the rollback after it is ignored", () => {
  const out = stdout("---SCOUT-STATUS---", ...BOOTED, ...ROLLBACK, "exit=0", "---SCOUT-REMOTE---", "exit=127");
  const result = adapter.parse({ list: { exitCode: 0, stdout: out, stderr: "" } }, "");
  assert.equal(result.status, "ok");
  assert.deepEqual(result.installs, [
    {
      ecosystem: "ostree",
      key: "ghcr.io/ublue-os/bazzite-deck-nvidia",
      name: "bazzite-deck-nvidia",
      kind: "image",
      version: "43.20260420",
      location: "",
      details: { image: "ghcr.io/ublue-os/bazzite-deck-nvidia:stable", tag: "stable", digest: "sha256:5c69c75f", staged: false },
    },
  ]);
});

test("a deployment listed before the booted one is the staged update", () => {
  const out = stdout("---SCOUT-STATUS---", ...STAGED, ...BOOTED, "exit=0", "---SCOUT-REMOTE---", "exit=127");
  const result = adapter.parse({ list: { exitCode: 0, stdout: out, stderr: "" } }, "");
  assert.equal(result.status, "ok");
  assert.deepEqual((result.installs[0]?.details as { availableVersion?: string; staged: boolean }), { image: "ghcr.io/ublue-os/bazzite-deck-nvidia:stable", tag: "stable", digest: "sha256:5c69c75f", staged: true, availableVersion: "44.20261026" });
});

test("the image label in the registry gives the update, and the image url gives the homepage", () => {
  const config = remote('{"config": {"Labels": {"org.opencontainers.image.version": "44.20261026", "org.opencontainers.image.url": "https://bazzite.gg"}}}');
  const out = stdout("---SCOUT-STATUS---", ...BOOTED, "exit=0", config);
  const result = adapter.parse({ list: { exitCode: 0, stdout: out, stderr: "" } }, "");
  assert.equal(result.status, "ok");
  assert.equal(result.installs[0]?.homepage, "https://bazzite.gg");
  assert.equal((result.installs[0]?.details as { availableVersion?: string }).availableVersion, "44.20261026");
});

test("a label with the version of the booted deployment is no update", () => {
  const config = remote('{"config": {"Labels": {"org.opencontainers.image.version": "43.20260420"}}}');
  const out = stdout("---SCOUT-STATUS---", ...BOOTED, "exit=0", config);
  const result = adapter.parse({ list: { exitCode: 0, stdout: out, stderr: "" } }, "");
  assert.equal(result.status, "ok");
  assert.equal((result.installs[0]?.details as { availableVersion?: string }).availableVersion, undefined);
  assert.equal(result.installs[0]?.homepage, undefined);
});

test("a registry configuration that does not parse is ignored", () => {
  const out = stdout("---SCOUT-STATUS---", ...BOOTED, "exit=0", "---SCOUT-REMOTE---", "{not json", "exit=0");
  const result = adapter.parse({ list: { exitCode: 0, stdout: out, stderr: "" } }, "");
  assert.equal(result.status, "ok");
  assert.equal((result.installs[0]?.details as { availableVersion?: string }).availableVersion, undefined);
  assert.equal(result.installs[0]?.homepage, undefined);
});

test("a status text without a booted deployment is partial", () => {
  const out = stdout("---SCOUT-STATUS---", "State: idle", "Deployments:", "exit=0", "---SCOUT-REMOTE---", "exit=127");
  const result = adapter.parse({ list: { exitCode: 0, stdout: out, stderr: "" } }, "");
  assert.equal(result.status, "partial");
  assert.equal(result.message, "no booted deployment found");
  assert.deepEqual(result.installs, []);
});

test("a machine without rpm-ostree is skipped, not failed", () => {
  const result = adapter.parse({ list: { exitCode: 127, stdout: "", stderr: "rpm-ostree is not installed\n" } }, "");
  assert.equal(result.status, "skipped");
  assert.equal(result.message, "rpm-ostree did not run (exit 127): rpm-ostree is not installed");
  assert.deepEqual(result.installs, []);
});
