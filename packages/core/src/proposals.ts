import type { Db } from "./db.ts";

// Merge proposals for the review queue. Packages from different ecosystems whose names are equal after normalizing
// are candidates for one item. The rule is exact, so proposals are cheap to check, but a match is never applied
// without a person's confirmation: two products can share a name.

const PROPOSE_FROM = new Set(["brew", "cask", "bundle", "arp", "winget", "winget-local", "msstore", "appx", "npm", "uv-tool", "pipx", "go-bin"]);

/** Lower case, letters and digits only, so "Git", "git" and "GIT" match and "Node.js" equals "nodejs". */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * Windows registry names carry the version and architecture ("7-Zip 26.01 (x64)"), which the winget catalog name
 * ("7-Zip") does not. Remove the install's own version and any trailing architecture note before comparing.
 */
export function baseName(name: string, versions: string[]): string {
  let out = name.replace(/\s*[([](?:x64|x86|64-bit|32-bit|arm64|amd64|win64|win32)[)\]]\s*$/i, "");
  for (const v of versions) if (v) out = out.split(v).join(" ");
  return out.replace(/\s*[([](?:x64|x86|64-bit|32-bit|arm64|amd64|win64|win32)[)\]]\s*$/i, "").trim();
}

export interface Proposal {
  id: number;
  rule: string;
  packageIds: number[];
  names: string[];
  ecosystems: string[];
}

export function proposeMerges(db: Db, now = new Date().toISOString()): { proposed: number } {
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.ecosystem, l.item_id, (SELECT group_concat(DISTINCT i.version) FROM installs i WHERE i.package_id = p.id AND i.removed_at IS NULL) AS versions
       FROM packages p JOIN item_links l ON l.package_id = p.id
       WHERE EXISTS (SELECT 1 FROM installs i WHERE i.package_id = p.id AND i.removed_at IS NULL)`,
    )
    .all() as unknown as { id: number; name: string; ecosystem: string; item_id: number; versions: string | null }[];
  const groups = new Map<string, ((typeof rows)[number] & { cleaned: boolean })[]>();
  for (const r of rows) {
    if (!PROPOSE_FROM.has(r.ecosystem)) continue;
    const n = normalizeName(baseName(r.name, (r.versions ?? "").split(",")));
    if (n.length < 3) continue;
    groups.set(n, [...(groups.get(n) ?? []), { ...r, cleaned: n !== normalizeName(r.name) }]);
  }
  const decided = new Set(
    (db.prepare("SELECT subject_json FROM findings WHERE kind = 'merge_proposal' AND state IN ('rejected', 'confirmed')").all() as { subject_json: string }[]).map((f) => f.subject_json),
  );
  let proposed = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM findings WHERE kind = 'merge_proposal' AND state = 'open'");
    const insert = db.prepare("INSERT INTO findings (kind, subject_json, state, created_at) VALUES ('merge_proposal', ?, 'open', ?)");
    for (const [norm, list] of groups) {
      const items = new Set(list.map((r) => r.item_id));
      const ecosystems = new Set(list.map((r) => r.ecosystem));
      if (items.size < 2 || ecosystems.size < 2) continue; // already one item, or one ecosystem
      const rule = list.some((r) => r.cleaned) ? "equal name after removing version and architecture" : "equal normalized name";
      const subject = JSON.stringify({ rule, name: norm, packageIds: list.map((r) => r.id).sort((a, b) => a - b), names: [...new Set(list.map((r) => r.name))], ecosystems: [...ecosystems].sort() });
      if (decided.has(subject)) continue;
      insert.run(subject, now);
      proposed++;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { proposed };
}

export function openProposals(db: Db): Proposal[] {
  return (db.prepare("SELECT id, subject_json FROM findings WHERE kind = 'merge_proposal' AND state = 'open' ORDER BY id").all() as { id: number; subject_json: string }[]).map((f) => {
    const s = JSON.parse(f.subject_json) as { rule: string; packageIds: number[]; names: string[]; ecosystems: string[] };
    return { id: f.id, rule: s.rule, packageIds: s.packageIds, names: s.names, ecosystems: s.ecosystems };
  });
}

/** Join the proposal's packages into one item as confirmed links, or record the rejection so it is not proposed again. */
export function decideProposal(db: Db, findingId: number, accept: boolean, now = new Date().toISOString()): void {
  const f = db.prepare("SELECT subject_json FROM findings WHERE id = ? AND kind = 'merge_proposal' AND state = 'open'").get(findingId) as { subject_json: string } | undefined;
  if (!f) throw new Error(`no open merge proposal ${findingId}`);
  const subject = JSON.parse(f.subject_json) as { packageIds: number[] };
  db.exec("BEGIN IMMEDIATE");
  try {
    if (accept) {
      const first = db.prepare("SELECT item_id FROM item_links WHERE package_id = ?").get(subject.packageIds[0] ?? -1) as { item_id: number };
      const upsert = db.prepare(
        `INSERT INTO item_links (package_id, item_id, basis, evidence_json) VALUES (?, ?, 'confirmed', ?)
         ON CONFLICT(package_id) DO UPDATE SET item_id = excluded.item_id, basis = 'confirmed', evidence_json = excluded.evidence_json`,
      );
      for (const id of subject.packageIds) upsert.run(id, first.item_id, JSON.stringify({ confirmedAt: now, finding: findingId }));
      db.exec("DELETE FROM items WHERE id NOT IN (SELECT item_id FROM item_links) AND manual = 0");
    }
    db.prepare("UPDATE findings SET state = ? WHERE id = ?").run(accept ? "confirmed" : "rejected", findingId);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
