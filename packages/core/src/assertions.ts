import type { Db } from "./db.ts";
import { isNewer, maxVersion } from "./version.ts";
import { downloadLink } from "./download-link.ts";
import { recentJobsByInstall, type InstallJob } from "./jobs.ts";
import type { UpdateBump, UpdateStatus } from "./updates-query.ts";
import { riskCounts } from "./dependency-risk.ts";

// Version assertions: every answer a source gave about the latest version of a package, kept with where it came from.
// A researcher asks the owning package manager or the project; the scan itself also reports the latest version for
// some sources (winget lists what it can upgrade to). The updates view reads the newest answer per source and channel.

export type Channel = "stable" | "beta" | "unknown";

export interface AssertionInput {
  packageId: number;
  source: string;
  channel: Channel;
  version: string;
  /** The owning adapter can install this exact version. */
  installable: boolean;
  /** A vendor-page answer: it can flag that an update may exist, and never enables a button. */
  advisory?: boolean;
}

/**
 * Record an answer. The same (package, source, channel, version) only has its time refreshed, so the table holds one
 * row per distinct answer and a version history builds up as sources report new versions.
 */
export function recordAssertion(db: Db, a: AssertionInput, now = new Date().toISOString()): void {
  const same = db
    .prepare("SELECT id FROM assertions WHERE package_id = ? AND source = ? AND channel = ? AND version = ?")
    .get(a.packageId, a.source, a.channel, a.version) as { id: number } | undefined;
  if (same) {
    db.prepare("UPDATE assertions SET observed_at = ?, installable = ?, advisory = ? WHERE id = ?").run(now, a.installable ? 1 : 0, a.advisory ? 1 : 0, same.id);
    return;
  }
  db.prepare("INSERT INTO assertions (package_id, source, channel, version, installable, advisory, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    a.packageId,
    a.source,
    a.channel,
    a.version,
    a.installable ? 1 : 0,
    a.advisory ? 1 : 0,
    now,
  );
}

/**
 * A source's current answer for a package replaces its earlier ones for the channels it reported: the older rows stay as
 * history but only the newest row per (source, channel) counts as current (see `currentAssertions`).
 */
export function recordResearch(
  db: Db,
  packageId: number,
  source: string,
  status: "ok" | "notfound" | "failed",
  answers: Omit<AssertionInput, "packageId" | "source">[],
  message: string | null,
  now = new Date().toISOString(),
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const a of answers) recordAssertion(db, { ...a, packageId, source }, now);
    db.prepare(
      `INSERT INTO research_log (package_id, source, checked_at, status, message) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(package_id, source) DO UPDATE SET checked_at = excluded.checked_at, status = excluded.status, message = excluded.message`,
    ).run(packageId, source, now, status, message);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export interface CurrentAssertion {
  packageId: number;
  source: string;
  channel: Channel;
  version: string;
  installable: boolean;
  advisory: boolean;
  observedAt: string;
}

/** The newest row per (package, source, channel). Older rows are history. */
export function currentAssertions(db: Db): CurrentAssertion[] {
  return db
    .prepare(
      `SELECT a.package_id AS packageId, a.source, a.channel, a.version, a.installable, a.advisory, a.observed_at AS observedAt
       FROM assertions a
       WHERE a.id = (SELECT b.id FROM assertions b WHERE b.package_id = a.package_id AND b.source = a.source AND b.channel = a.channel
                     ORDER BY b.observed_at DESC, b.id DESC LIMIT 1)`,
    )
    .all()
    .map((r) => {
      const x = r as unknown as { packageId: number; source: string; channel: Channel; version: string; installable: number; advisory: number; observedAt: string };
      return { ...x, installable: x.installable === 1, advisory: x.advisory === 1 };
    });
}

/** Packages a researcher could ask about: the ones with a live install in its ecosystems that it has not checked within `ttlMs`. */
export function packagesDue(db: Db, ecosystems: string[], source: string, ttlMs: number, now = new Date()): { id: number; ecosystem: string; key: string; name: string; tap: string | null }[] {
  if (ecosystems.length === 0) return [];
  const cutoff = new Date(now.getTime() - ttlMs).toISOString();
  // A failed lookup (network trouble, a 5xx) is retried within the hour rather than after the full cache window.
  const retryCutoff = new Date(now.getTime() - Math.min(ttlMs, 3_600_000)).toISOString();
  const marks = ecosystems.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT p.id, p.ecosystem, p.key, p.name,
              (SELECT json_extract(i.details_json, '$.tap') FROM installs i WHERE i.package_id = p.id AND i.removed_at IS NULL LIMIT 1) AS tap
       FROM packages p
       WHERE p.ecosystem IN (${marks})
         AND EXISTS (SELECT 1 FROM installs i WHERE i.package_id = p.id AND i.removed_at IS NULL)
         AND NOT EXISTS (SELECT 1 FROM research_log l WHERE l.package_id = p.id AND l.source = ?
                         AND l.checked_at > CASE l.status WHEN 'failed' THEN ? ELSE ? END)
       ORDER BY p.id`,
    )
    .all(...ecosystems, source, retryCutoff, cutoff) as unknown as { id: number; ecosystem: string; key: string; name: string; tap: string | null }[];
}

/**
 * Answers the scan already carries: winget and the Microsoft Store report the version each install can upgrade to, and the Arch system entry carries the time of the scan when updates are pending. These
 * are rebuilt from the catalog on every scan under their own source name, so an upgrade that has since been applied
 * does not leave a stale answer behind.
 */
export function deriveScanAssertions(db: Db, now = new Date().toISOString()): { assertions: number } {
  const rows = db
    .prepare(
      `SELECT p.id AS packageId, p.ecosystem, json_extract(i.details_json, '$.availableVersion') AS available
       FROM installs i JOIN packages p ON p.id = i.package_id
       WHERE i.removed_at IS NULL AND p.ecosystem IN ('winget', 'msstore', 'arch-system')
         AND json_extract(i.details_json, '$.availableVersion') IS NOT NULL`,
    )
    .all() as unknown as { packageId: number; ecosystem: string; available: string }[];
  const best = new Map<string, { packageId: number; source: string; version: string }>();
  for (const r of rows) {
    const source = `${r.ecosystem}-scan`;
    const key = `${r.packageId}|${source}`;
    const prior = best.get(key);
    best.set(key, { packageId: r.packageId, source, version: prior ? (maxVersion([prior.version, r.available]) ?? prior.version) : r.available });
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM assertions WHERE source IN ('winget-scan', 'msstore-scan', 'arch-system-scan')");
    for (const b of best.values()) recordAssertion(db, { packageId: b.packageId, source: b.source, channel: "stable", version: b.version, installable: true }, now);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { assertions: best.size };
}

export interface UpdateRow {
  installId: number;
  machineId: string;
  packageId: number;
  ecosystem: string;
  key: string;
  name: string;
  description: string | null;
  installed: string | null;
  /** Latest stable version the owning source can install, and where that answer came from. */
  available: string | null;
  availableSource: string | null;
  /** Latest stable version any non-installable (upstream) source reports, when it is ahead of `available`. */
  upstream: string | null;
  upstreamSource: string | null;
  beta: string | null;
  betaSource: string | null;
  /** Installed is behind `available` and nothing blocks the update. */
  updatable: boolean;
  risk: { hard: number; soft: number } | null;
  /** Why an update is not offered, or null. */
  blockedBy: string | null;
  /** Installed is behind an advisory (vendor-page) answer only: an update may exist, nothing can install it. */
  advisoryOnly: boolean;
  checkedAt: string | null;
  category: string | null;
  publisher: string | null;
  lastUsed: string | null;
  firstSeen: string;
  location: string;
  kind: string;
  /** A page for getting a newer version by hand, only when one exists that Scout cannot install. */
  downloadUrl: string | null;
  bump: UpdateBump | null;
  statuses: UpdateStatus[];
  job: InstallJob | null;
  /** Usage flags follow the readable-signal rules in query.ts. */
  usage: { known: boolean; neverUsed: boolean; running: boolean };
}

export interface UpdateFilter {
  safe?: boolean;
  machines?: string[];
  ecosystems?: string[];
  /** Only rows that are updatable or upstream-ahead. */
  onlyOutdated?: boolean;
}

/** One row per live install that has at least one answer, with the update verdict and the reason when it is blocked. */
export function updatesView(db: Db, filter: UpdateFilter = {}): UpdateRow[] {
  const answers = new Map<number, CurrentAssertion[]>();
  for (const a of currentAssertions(db)) answers.set(a.packageId, [...(answers.get(a.packageId) ?? []), a]);
  const installs = db
    .prepare(
      `SELECT i.id AS installId, i.machine_id AS machineId, p.id AS packageId, p.ecosystem, p.key, p.name, p.description, p.category, p.publisher, p.homepage,
              i.version AS installed, i.first_seen AS firstSeen, i.location, i.kind
       FROM installs i JOIN packages p ON p.id = i.package_id
       WHERE i.removed_at IS NULL AND p.id IN (SELECT DISTINCT package_id FROM assertions)
       ORDER BY p.name, i.machine_id`,
    )
    .all() as unknown as { installId: number; machineId: string; packageId: number; ecosystem: string; key: string; name: string; description: string | null; category: string | null; publisher: string | null; homepage: string | null; installed: string | null; firstSeen: string; location: string; kind: string }[];
  // These flags copy the readable-signal rules from query.ts without one SQL query per install.
  const usage = new Map<number, { lastUsed: string | null; known: boolean; hasLastUsed: boolean; running: boolean }>();
  for (const u of db.prepare("SELECT install_id AS installId, kind, value FROM usage_signals WHERE available = 1").all() as { installId: number; kind: string; value: string | null }[]) {
    const item = usage.get(u.installId) ?? { lastUsed: null, known: false, hasLastUsed: false, running: false };
    item.known = true;
    if (u.kind === "last_used") {
      item.hasLastUsed = true;
      if (u.value !== null && (item.lastUsed === null || u.value > item.lastUsed)) item.lastUsed = u.value;
    }
    if (u.kind === "running" && u.value === "1") item.running = true;
    usage.set(u.installId, item);
  }
  const constraints = db
    .prepare("SELECT install_id AS installId, package_id AS packageId, type, hard, spec, origin FROM constraints WHERE hard = 1 AND type IN ('freeze')")
    .all() as unknown as { installId: number | null; packageId: number | null; type: string; hard: number; spec: string; origin: string }[];
  const out: UpdateRow[] = [];
  const jobs = recentJobsByInstall(db);
  for (const i of installs) {
    if (filter.machines && !filter.machines.includes(i.machineId)) continue;
    if (filter.ecosystems && !filter.ecosystems.includes(i.ecosystem)) continue;
    const list = answers.get(i.packageId) ?? [];
    const stable = list.filter((a) => a.channel === "stable");
    const installable = stable.filter((a) => a.installable && !a.advisory);
    const availableVersion = maxVersion(installable.map((a) => a.version));
    const availableSource = installable.find((a) => a.version === availableVersion)?.source ?? null;
    const upstream = stable.filter((a) => !a.installable && !a.advisory);
    const upstreamVersion = maxVersion(upstream.map((a) => a.version));
    const upstreamAhead = upstreamVersion !== null && (availableVersion === null ? i.installed === null || isNewer(upstreamVersion, i.installed) : isNewer(upstreamVersion, availableVersion));
    const advisory = stable.filter((a) => a.advisory);
    const advisoryVersion = maxVersion(advisory.map((a) => a.version));
    const beta = list.filter((a) => a.channel === "beta");
    const betaVersion = maxVersion(beta.map((a) => a.version));
    const behind = availableVersion !== null && i.installed !== null && isNewer(availableVersion, i.installed);
    const freeze = constraints.find((c) => (c.installId === i.installId || (c.installId === null && c.packageId === i.packageId)) && availableVersion !== null && isNewer(availableVersion, c.spec));
    const blockedBy = behind && freeze ? `${freeze.type} at ${freeze.spec} (${freeze.origin})` : null;
    const numbers = (v: string): string[] => [...v.matchAll(/\d+/g)].map((m) => m[0]);
    const from = i.installed === null ? [] : numbers(i.installed);
    const to = availableVersion === null ? [] : numbers(availableVersion);
    let bump: UpdateBump | null = null;
    if (behind || (i.installed !== null && availableVersion !== null && i.installed !== availableVersion && (from.length === 0 || to.length === 0))) {
      bump = from.length === 0 || to.length === 0 ? "other" : "patch";
      if (from.length && to.length) {
        const changed = Array.from({ length: Math.max(from.length, to.length) }, (_, n) => BigInt(from[n] ?? "0") !== BigInt(to[n] ?? "0")).indexOf(true);
        bump = changed === 0 ? "major" : changed === 1 ? "minor" : "patch";
      }
    }
    const advisoryOnly = !behind && advisoryVersion !== null && i.installed !== null && isNewer(advisoryVersion, i.installed);
    const statuses: UpdateStatus[] = [];
    if (behind && blockedBy === null) statuses.push("updatable");
    if (blockedBy !== null) statuses.push("blocked");
    if (upstreamAhead) statuses.push("upstream");
    if (advisoryOnly) statuses.push("advisory");
    if (statuses.length === 0) statuses.push("current");
    const signal = usage.get(i.installId);
    const row: UpdateRow = {
      installId: i.installId,
      machineId: i.machineId,
      packageId: i.packageId,
      ecosystem: i.ecosystem,
      key: i.key,
      name: i.name,
      description: i.description,
      installed: i.installed,
      available: availableVersion,
      availableSource,
      upstream: upstreamAhead ? upstreamVersion : null,
      upstreamSource: upstreamAhead ? (upstream.find((a) => a.version === upstreamVersion)?.source ?? null) : null,
      beta: betaVersion !== null && (availableVersion === null || isNewer(betaVersion, availableVersion)) ? betaVersion : null,
      betaSource: betaVersion !== null ? (beta.find((a) => a.version === betaVersion)?.source ?? null) : null,
      updatable: behind && blockedBy === null,
      risk: null,
      blockedBy,
      advisoryOnly,
      checkedAt: list.map((a) => a.observedAt).sort().at(-1) ?? null,
      category: i.category,
      publisher: i.publisher,
      lastUsed: signal?.lastUsed ?? null,
      firstSeen: i.firstSeen,
      location: i.location,
      kind: i.kind,
      downloadUrl: blockedBy === null && !(behind) && (upstreamAhead || advisoryOnly) ? downloadLink(i.ecosystem, i.key, i.homepage) : null,
      bump,
      statuses,
      job: jobs.get(i.installId) ?? null,
      usage: { known: signal?.known ?? false, neverUsed: signal?.hasLastUsed === true && signal.lastUsed === null, running: signal?.running ?? false },
    };
    if (filter.onlyOutdated && !row.updatable && row.blockedBy === null && row.upstream === null && !row.advisoryOnly) continue;
    out.push(row);
  }
  riskCounts(db, out);
  return filter.safe ? out.filter((row) => (row.risk?.hard ?? 0) === 0) : out;
}
