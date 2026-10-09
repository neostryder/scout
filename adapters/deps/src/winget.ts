import type { DependencyAdapter, DependencyFact, DependencyResult } from "@scout/core";

// winget manifests can name other winget packages a program needs (a .NET desktop runtime, the Visual C++ runtime).
// The probe exports the installed package ids with `winget export`, then asks `winget show` about each one four at a
// time and keeps the Package Dependencies block. It runs inside node so the loop does not need a shell, and it only
// reads: nothing is installed, upgraded or changed.

export const WINGET_DEPS_SCRIPT = String.raw`import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const run = (args) => new Promise((resolve) => execFile("winget", args, { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout: 120000 }, (error, stdout) => resolve({ ok: !error, stdout })));
const dir = mkdtempSync(join(tmpdir(), "scout-winget-"));
const out = { packages: [], failed: 0 };
try {
  const file = join(dir, "export.json");
  const exported = await run(["export", "-o", file, "--source", "winget", "--accept-source-agreements", "--disable-interactivity"]);
  let ids = [];
  try { ids = JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")).Sources.flatMap((source) => source.Packages.map((entry) => entry.PackageIdentifier)); }
  catch { if (!exported.ok) { console.log(JSON.stringify({ unavailable: true })); process.exit(0); } }
  const queue = [...new Set(ids)];
  async function worker() {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      const shown = await run(["show", "--id", id, "--exact", "--accept-source-agreements", "--disable-interactivity"]);
      if (!shown.ok) { out.failed++; continue; }
      const lines = shown.stdout.split(/\r?\n/);
      const at = lines.findIndex((line) => /^\s*-\s*Package Dependencies:\s*$/.test(line));
      const dependencies = [];
      if (at >= 0) {
        const indent = lines[at].search(/\S/);
        for (const line of lines.slice(at + 1)) {
          if (line.trim() === "" || line.search(/\S/) <= indent) break;
          dependencies.push(line.trim());
        }
      }
      out.packages.push({ id, dependencies });
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(JSON.stringify(out));
`;

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const result = (status: DependencyResult["status"], facts: DependencyFact[] = [], message?: string): DependencyResult => ({ origin: "winget-deps", status, facts, ...(message === undefined ? {} : { message }) });

export const wingetDepsAdapter: DependencyAdapter = {
  origin: "winget-deps",
  os: ["windows"],
  probes() {
    return [{ id: "winget-deps", argv: ["node", "-"], stdin: WINGET_DEPS_SCRIPT, optional: true }];
  },
  parse(outputs) {
    const probe = outputs["winget-deps"];
    if (!probe) return result("failed", [], "probe output missing");
    if (probe.exitCode !== 0) return result(probe.exitCode === 127 || probe.exitCode === 9009 ? "skipped" : "failed", [], "dependency probe did not run");
    let doc: unknown;
    try { doc = JSON.parse(probe.stdout); } catch { return result("failed", [], "dependency output is not valid JSON"); }
    if (object(doc) && doc["unavailable"] === true) return result("skipped", [], "winget did not run");
    if (!object(doc) || !Array.isArray(doc["packages"])) return result("failed", [], "winget packages could not be read");
    const facts: DependencyFact[] = [];
    let partial = typeof doc["failed"] === "number" && doc["failed"] > 0;
    for (const entry of doc["packages"]) {
      if (!object(entry) || typeof entry["id"] !== "string" || !Array.isArray(entry["dependencies"])) { partial = true; continue; }
      const seen = new Set<string>();
      for (const raw of entry["dependencies"]) {
        // A dependency line is a package id, sometimes followed by a version bound in brackets such as [>= 1.8.0].
        const match = typeof raw === "string" ? /^([A-Za-z0-9][A-Za-z0-9._+-]*)\s*(?:\[\s*((?:>=|<=|>|<|=)\s*[0-9][0-9A-Za-z.+-]*)\s*\])?/.exec(raw.trim()) : null;
        const key = match?.[1];
        if (!key || seen.has(key) || key === entry["id"]) continue;
        seen.add(key);
        facts.push({ from: { ecosystem: "winget", key: entry["id"] }, to: { ecosystem: "winget", key }, kind: "runtime", constraint: match?.[2]?.replace(/\s+/g, "") ?? null, builtAgainst: null, evidence: "winget manifest lists this package dependency" });
      }
    }
    return result(partial ? "partial" : "ok", facts, partial ? "some winget manifests could not be read" : undefined);
  },
};
