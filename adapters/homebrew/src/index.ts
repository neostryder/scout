import type { Adapter, InstallRecord, ProbeContext, ProbeOutputs, ScanResult } from "@scout/core";

// Both adapters read the same probe, `brew info --json=v2 --installed`, run against one prefix. The transport
// runs identical probes once per scan, sets HOMEBREW_NO_AUTO_UPDATE=1 and HOMEBREW_NO_ANALYTICS=1, and never
// calls a prefix that has no bin/brew.

const brewBin = (location: string) => `${location}/bin/brew`;

function probes(_ctx: ProbeContext, location: string) {
  return [{ id: "info", argv: [brewBin(location), "info", "--json=v2", "--installed"] }];
}

interface BrewJson {
  formulae?: FormulaJson[];
  casks?: CaskJson[];
}
interface FormulaJson {
  name: string;
  tap?: string;
  desc?: string | null;
  homepage?: string | null;
  installed?: { version: string; installed_on_request?: boolean; installed_as_dependency?: boolean }[];
  linked_keg?: string | null;
  pinned?: boolean;
  keg_only?: boolean;
  outdated?: boolean;
}
interface CaskJson {
  token: string;
  name?: string[];
  desc?: string | null;
  homepage?: string | null;
  tap?: string;
  installed?: string | null;
  outdated?: boolean;
  bundle_short_version?: string | null;
  artifacts?: unknown[];
}

/** The `.app` bundle names a cask installs, from its `app` artifacts. */
function appNames(artifacts: unknown[] | undefined): string[] {
  const names: string[] = [];
  for (const a of artifacts ?? []) {
    const apps = a !== null && typeof a === "object" ? (a as { app?: unknown }).app : undefined;
    if (!Array.isArray(apps)) continue;
    for (const n of apps) if (typeof n === "string") names.push(n);
  }
  return names;
}

/** Returns the parsed document, or a ScanResult that explains why there is none. */
function load(outputs: ProbeOutputs, sourceKind: string, location: string): BrewJson | ScanResult {
  const info = outputs["info"];
  if (!info) return { sourceKind, location, status: "failed", installs: [], message: "probe output missing" };
  if (info.exitCode !== 0) {
    return {
      sourceKind,
      location,
      status: "skipped",
      installs: [],
      message: `brew did not run (exit ${info.exitCode}): ${info.stderr.trim().split("\n")[0] ?? ""}`,
    };
  }
  try {
    return JSON.parse(info.stdout) as BrewJson;
  } catch {
    return { sourceKind, location, status: "failed", installs: [], message: "brew output is not valid JSON" };
  }
}

const isResult = (v: BrewJson | ScanResult): v is ScanResult => "sourceKind" in v;

export const brewAdapter: Adapter = {
  sourceKind: "brew",
  os: ["macos"],
  probes,
  parse(outputs, location) {
    const doc = load(outputs, "brew", location);
    if (isResult(doc)) return doc;
    const installs: InstallRecord[] = [];
    for (const f of doc.formulae ?? []) {
      const versions = (f.installed ?? []).map((i) => i.version);
      const version = f.linked_keg ?? versions[versions.length - 1] ?? null;
      installs.push({
        ecosystem: "brew",
        key: f.name,
        name: f.name,
        kind: "package",
        version,
        location: version ? `${location}/Cellar/${f.name}/${version}` : `${location}/Cellar/${f.name}`,
        ...(f.desc ? { description: f.desc } : {}),
        ...(f.homepage ? { homepage: f.homepage } : {}),
        details: {
          tap: f.tap ?? null,
          pinned: f.pinned ?? false,
          kegOnly: f.keg_only ?? false,
          linked: f.linked_keg != null,
          outdated: f.outdated ?? false,
          installedVersions: versions,
          onRequest: (f.installed ?? []).some((i) => i.installed_on_request === true),
        },
      });
    }
    return { sourceKind: "brew", location, status: "ok", installs };
  },
};

export const caskAdapter: Adapter = {
  sourceKind: "cask",
  os: ["macos"],
  probes,
  parse(outputs, location) {
    const doc = load(outputs, "cask", location);
    if (isResult(doc)) return doc;
    const installs: InstallRecord[] = [];
    for (const c of doc.casks ?? []) {
      installs.push({
        ecosystem: "cask",
        key: c.token,
        name: c.name?.[0] ?? c.token,
        kind: "app",
        version: c.installed ?? null,
        location: `${location}/Caskroom/${c.token}`,
        ...(c.desc ? { description: c.desc } : {}),
        ...(c.homepage ? { homepage: c.homepage } : {}),
        details: {
          tap: c.tap ?? null,
          outdated: c.outdated ?? false,
          bundleShortVersion: c.bundle_short_version ?? null,
          appNames: appNames(c.artifacts),
        },
      });
    }
    return { sourceKind: "cask", location, status: "ok", installs };
  },
};
