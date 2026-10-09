import type { Db } from "./db.ts";

// Deterministic identity. Two packages become one item only through a rule that can be checked against ids or
// paths, never through name similarity. Anything less certain is left for a proposal that a person confirms.
// Relations between installs (a service that belongs to an app, a command that links into a package) come from path
// containment and symlink targets.

interface InstallRow {
  id: number;
  machine_id: string;
  package_id: number;
  ecosystem: string;
  key: string;
  name: string;
  location: string;
  source_kind: string;
  details: Record<string, unknown>;
}

export interface LinkSummary {
  items: number;
  merged: number;
  relations: number;
}

const norm = (p: string): string => p.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

function load(db: Db): InstallRow[] {
  const rows = db
    .prepare(
      `SELECT i.id, i.machine_id, i.package_id, p.ecosystem, p.key, p.name, i.location, s.kind AS source_kind, i.details_json
       FROM installs i JOIN packages p ON p.id = i.package_id JOIN sources s ON s.id = i.source_id
       WHERE i.removed_at IS NULL`,
    )
    .all() as unknown as (Omit<InstallRow, "details"> & { details_json: string })[];
  return rows.map(({ details_json, ...r }) => ({ ...r, details: JSON.parse(details_json) as Record<string, unknown> }));
}

/** winget's `ARP\<Scope>\<Arch>\<Key>` names the registry uninstall key the registry adapter reports as `<Hive>\<Key>`. */
export function wingetArpToRegistryKey(id: string): string | null {
  const m = /^ARP\\(Machine|User)\\(X64|X86)\\(.+)$/.exec(id);
  if (!m) return null;
  const [, scope, arch, key] = m as unknown as [string, string, string, string];
  if (scope === "User") return `HKCU\\${key}`;
  return arch === "X86" ? `HKLM-WOW6432\\${key}` : `HKLM\\${key}`;
}

class Groups {
  private parent = new Map<number, number>();
  find(x: number): number {
    let r = x;
    while ((this.parent.get(r) ?? r) !== r) r = this.parent.get(r) as number;
    this.parent.set(x, r);
    return r;
  }
  add(x: number): void {
    if (!this.parent.has(x)) this.parent.set(x, x);
  }
  union(a: number, b: number): void {
    this.add(a);
    this.add(b);
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

interface Pair {
  a: InstallRow;
  b: InstallRow;
  rule: string;
}

function sameSoftwarePairs(rows: InstallRow[]): Pair[] {
  const pairs: Pair[] = [];
  const byMachine = new Map<string, InstallRow[]>();
  for (const r of rows) byMachine.set(r.machine_id, [...(byMachine.get(r.machine_id) ?? []), r]);
  for (const list of byMachine.values()) {
    const arp = new Map(list.filter((r) => r.ecosystem === "arp").map((r) => [r.key, r]));
    const appx = new Map(list.filter((r) => r.ecosystem === "appx").map((r) => [String(r.details["packageFullName"] ?? ""), r]));
    const bundles = list.filter((r) => r.ecosystem === "bundle");
    for (const r of list) {
      if (r.ecosystem === "winget-local") {
        const regKey = wingetArpToRegistryKey(r.key);
        const reg = regKey ? arp.get(regKey) : undefined;
        if (reg) pairs.push({ a: r, b: reg, rule: "winget ARP id is the registry uninstall key" });
        const full = /^MSIX\\(.+)$/.exec(r.key)?.[1];
        const pkg = full ? appx.get(full) : undefined;
        if (pkg) pairs.push({ a: r, b: pkg, rule: "winget MSIX id is the Store package full name" });
      }
      if (r.ecosystem === "cask") {
        const names = (r.details["appNames"] as string[] | undefined) ?? [];
        for (const n of names) {
          const app = bundles.find((b) => {
            const loc = norm(b.location);
            return loc.endsWith(`/${n.toLowerCase()}`) && (loc.startsWith("/applications/") || loc.includes("/applications/"));
          });
          if (app) pairs.push({ a: r, b: app, rule: "cask declares this app bundle" });
        }
      }
    }
  }
  return pairs;
}

function relations(rows: InstallRow[]): { install: InstallRow; related: InstallRow; relation: string; rule: string }[] {
  const out: { install: InstallRow; related: InstallRow; relation: string; rule: string }[] = [];
  const byMachine = new Map<string, InstallRow[]>();
  for (const r of rows) byMachine.set(r.machine_id, [...(byMachine.get(r.machine_id) ?? []), r]);
  for (const list of byMachine.values()) {
    // Containers: installs that own a directory tree.
    const owners = list
      .filter((r) => ["arp", "appx", "bundle", "pkgutil", "brew", "cask", "npm", "go-bin"].includes(r.ecosystem) && r.location.length > 3)
      .map((r) => ({ r, loc: norm(r.location) }))
      .sort((x, y) => y.loc.length - x.loc.length); // the deepest owner wins
    const owner = (path: string, self: number): InstallRow | undefined => {
      const p = norm(path);
      return owners.find((o) => o.r.id !== self && (p === o.loc || p.startsWith(`${o.loc}/`)))?.r;
    };
    for (const r of list) {
      if (r.ecosystem === "service") {
        const o = owner(r.location, r.id);
        if (o) out.push({ install: r, related: o, relation: "part_of", rule: "service binary lies inside the install's folder" });
      } else if (r.ecosystem === "launchd") {
        const program = r.details["program"];
        const o = typeof program === "string" ? owner(program, r.id) : undefined;
        if (o) out.push({ install: r, related: o, relation: "part_of", rule: "launchd program lies inside the install's folder" });
      } else if (r.ecosystem === "binary") {
        const target = r.details["linkTarget"];
        if (typeof target === "string" && target.startsWith("/")) {
          const o = owner(target, r.id);
          if (o) out.push({ install: r, related: o, relation: "links_to", rule: "symlink target lies inside the install's folder" });
        }
      }
    }
  }
  return out;
}

/**
 * Rebuild the deterministic grouping and the install relations. Confirmed links and manual items are kept. Every
 * package ends up in an item, alone unless a rule joined it to others.
 */
export function linkIdentity(db: Db, now = new Date().toISOString()): LinkSummary {
  const rows = load(db);
  const groups = new Groups();
  for (const r of rows) groups.add(r.package_id);
  const pairs = sameSoftwarePairs(rows);
  const evidence = new Map<number, string[]>();
  for (const p of pairs) {
    groups.union(p.a.package_id, p.b.package_id);
    evidence.set(p.a.package_id, [...(evidence.get(p.a.package_id) ?? []), p.rule]);
  }

  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM item_links WHERE basis = 'deterministic'");
    db.exec("DELETE FROM install_relations");
    const confirmed = new Set((db.prepare("SELECT package_id FROM item_links WHERE basis = 'confirmed'").all() as { package_id: number }[]).map((x) => x.package_id));
    const packages = db.prepare("SELECT id, ecosystem, name, description FROM packages").all() as unknown as { id: number; ecosystem: string; name: string; description: string | null }[];
    const info = new Map(packages.map((p) => [p.id, p]));
    const members = new Map<number, number[]>();
    for (const p of packages) {
      if (confirmed.has(p.id)) continue;
      groups.add(p.id);
      const root = groups.find(p.id);
      members.set(root, [...(members.get(root) ?? []), p.id]);
    }
    let merged = 0;
    let items = 0;
    const insertItem = db.prepare("INSERT INTO items (name, created_at) VALUES (?, ?)");
    const link = db.prepare("INSERT INTO item_links (package_id, item_id, basis, evidence_json) VALUES (?, ?, 'deterministic', ?)");
    for (const ids of members.values()) {
      // Name the item after the member a person would recognize: one with a source description, else the shortest name.
      const best = ids.map((id) => info.get(id)).filter((p): p is NonNullable<typeof p> => p !== undefined).sort((a, b) => Number(!!b.description) - Number(!!a.description) || a.name.length - b.name.length)[0];
      const { lastInsertRowid } = insertItem.run(best?.name ?? "unknown", now);
      items++;
      if (ids.length > 1) merged++;
      for (const id of ids) link.run(id, Number(lastInsertRowid), JSON.stringify({ rules: evidence.get(id) ?? [] }));
    }
    db.exec("DELETE FROM items WHERE id NOT IN (SELECT item_id FROM item_links) AND manual = 0");
    let count = 0;
    const rel = db.prepare("INSERT OR IGNORE INTO install_relations (install_id, related_id, relation, rule) VALUES (?, ?, ?, ?)");
    for (const r of relations(rows)) {
      rel.run(r.install.id, r.related.id, r.relation, r.rule);
      count++;
    }
    db.exec("COMMIT");
    return { items, merged, relations: count };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
