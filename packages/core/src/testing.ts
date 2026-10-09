import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Adapter, ProbeOutputs, ScanResult } from "./adapter.ts";
import type { UsageAdapter, UsageResult } from "./usage.ts";

/**
 * Register one test per fixture case under `fixturesDir/<case>/`. A case holds `outputs.json` (ProbeOutputs, as
 * recorded from a real machine) and `expected.<sourceKind>.json` or, when that is absent, `expected.json` (the
 * ScanResult the adapter must produce). Adapters that read the same probe output share one case directory. An
 * optional `location.txt` holds the source location passed to parse (default "").
 */
export function fixtureTests(adapter: Adapter, fixturesDir: string): void {
  const cases = existsSync(fixturesDir) ? readdirSync(fixturesDir, { withFileTypes: true }).filter((d) => d.isDirectory()) : [];
  test(`${adapter.sourceKind}: has at least one fixture`, () => {
    assert.ok(cases.length > 0, `no fixtures under ${fixturesDir}`);
  });
  for (const c of cases) {
    test(`${adapter.sourceKind}: fixture ${c.name}`, () => {
      const dir = join(fixturesDir, c.name);
      const outputs = JSON.parse(readFileSync(join(dir, "outputs.json"), "utf8")) as ProbeOutputs;
      const specific = join(dir, `expected.${adapter.sourceKind}.json`);
      const expected = JSON.parse(readFileSync(existsSync(specific) ? specific : join(dir, "expected.json"), "utf8")) as ScanResult;
      const locFile = join(dir, "location.txt");
      const location = existsSync(locFile) ? readFileSync(locFile, "utf8").trim() : "";
      assert.deepEqual(adapter.parse(outputs, location), expected);
    });
  }
}

/**
 * Register one test per fixture case under `fixturesDir/<case>/` for a usage adapter. A case holds `outputs.json`
 * (ProbeOutputs, recorded from a real machine) and `expected.json` (the UsageResult `parse` must produce).
 */
export function usageFixtureTests(adapter: UsageAdapter, fixturesDir: string): void {
  const cases = existsSync(fixturesDir) ? readdirSync(fixturesDir, { withFileTypes: true }).filter((d) => d.isDirectory()) : [];
  test(`${adapter.origin}: has at least one fixture`, () => {
    assert.ok(cases.length > 0, `no fixtures under ${fixturesDir}`);
  });
  for (const c of cases) {
    test(`${adapter.origin}: fixture ${c.name}`, () => {
      const dir = join(fixturesDir, c.name);
      const outputs = JSON.parse(readFileSync(join(dir, "outputs.json"), "utf8")) as ProbeOutputs;
      const expected = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8")) as UsageResult;
      assert.deepEqual(adapter.parse(outputs), expected);
    });
  }
}
