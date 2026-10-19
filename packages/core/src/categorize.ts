import type { Db } from "./db.ts";

// Deterministic categories. A rule assigns a category only when the ecosystem, the kind, the path or a precise name
// pattern makes it certain. Everything else stays uncategorized until the enrichment pass (a model) proposes one.

export const CATEGORIES = [
  "browser",
  "editor or IDE",
  "terminal or shell",
  "language runtime",
  "developer tool",
  "build or package tool",
  "database",
  "container or VM tool",
  "virtual machine",
  "container image",
  "media",
  "game",
  "communication",
  "productivity",
  "security",
  "networking",
  "storage or backup",
  "AI tool",
  "system utility",
  "driver",
  "runtime library",
  "library dependency",
  "system component",
  "other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export interface RuleInput {
  ecosystem: string;
  kind: string;
  name: string;
  key: string;
  location: string;
  details: Record<string, unknown>;
}

interface Rule {
  id: string;
  category: Category;
  test: (i: RuleInput) => boolean;
}

const RUNTIME_LIBRARY = /(Visual C\+\+ .*(Redistributable|Runtime)|\.NET .*(Runtime|Framework|Host)|Windows Desktop Runtime|WebView2 Runtime|Windows SDK|Microsoft Update Health|vs_)/i;
const LANGUAGE_RUNTIME = /^(node|nodejs|python(@[\d.]+)?|go|golang|rust|ruby|openjdk(@[\d.]+)?|php|deno|bun|dotnet|lua|perl)$/i;
const WINGET_RUNTIME = /^(OpenJS\.NodeJS.*|Python\.Python\.[\d.]+|GoLang\.Go.*|Rustlang\.Rust.*|Microsoft\.DotNet\.(SDK|Runtime|DesktopRuntime|AspNetCore).*|Oracle\.JDK.*|EclipseAdoptium\..*|Microsoft\.OpenJDK.*)$/;

/** First match wins, so the most certain rules come first. */
const RULES: Rule[] = [
  { id: "guest machine", category: "virtual machine", test: (i) => i.kind === "vm" || i.ecosystem === "wsl-distro" || i.ecosystem === "sbx" },
  { id: "container image", category: "container image", test: (i) => i.ecosystem === "image" },
  { id: "system component flag", category: "system component", test: (i) => i.details["systemComponent"] === true },
  { id: "apple launchd job", category: "system component", test: (i) => i.ecosystem === "launchd" && /^com\.apple\./.test(i.key) },
  { id: "windows folder service", category: "system component", test: (i) => i.ecosystem === "service" && /^[a-z]:\/windows\//i.test(i.location.replaceAll("\\", "/")) },
  { id: "runtime library name", category: "runtime library", test: (i) => ["arp", "winget-local", "winget"].includes(i.ecosystem) && RUNTIME_LIBRARY.test(i.name) },
  { id: "language runtime", category: "language runtime", test: (i) => i.ecosystem === "python" || (i.ecosystem === "brew" && LANGUAGE_RUNTIME.test(i.key)) || (i.ecosystem === "winget" && WINGET_RUNTIME.test(i.key)) },
  { id: "unrequested brew dependency", category: "library dependency", test: (i) => i.ecosystem === "brew" && i.details["onRequest"] === false },
  { id: "debian library package", category: "library dependency", test: (i) => i.ecosystem === "dpkg" && /^(lib[\w.+-]+|[\w.+-]+-(dev|data|common|doc|dbg))$/.test(i.key) },
  { id: "driver name", category: "driver", test: (i) => ["arp", "winget-local", "winget", "service"].includes(i.ecosystem) && /\b(driver|chipset|firmware)\b/i.test(i.name) },
  { id: "developer command", category: "developer tool", test: (i) => ["go-bin", "pipx", "uv-tool", "npm"].includes(i.ecosystem) },
];

/** The category a deterministic rule assigns, and the rule's id, or null when no rule is certain. */
export function categorize(input: RuleInput): { category: Category; rule: string } | null {
  for (const r of RULES) if (r.test(input)) return { category: r.category, rule: r.id };
  return null;
}

/** Set `category` from the rules for every package without one, or whose category came from an earlier rule pass. */
export function applyCategoryRules(db: Db): { assigned: number } {
  const rows = db
    .prepare(
      `SELECT p.id AS pid, p.ecosystem, p.key, p.name, i.kind, i.location, i.details_json
       FROM packages p JOIN installs i ON i.package_id = p.id AND i.removed_at IS NULL
       WHERE p.category IS NULL OR p.category_source = 'rule' GROUP BY p.id`,
    )
    .all() as unknown as { pid: number; ecosystem: string; key: string; name: string; kind: string; location: string; details_json: string }[];
  let assigned = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const set = db.prepare("UPDATE packages SET category = ?, category_source = 'rule' WHERE id = ?");
    const clear = db.prepare("UPDATE packages SET category = NULL, category_source = NULL WHERE id = ? AND category_source = 'rule'");
    for (const r of rows) {
      const hit = categorize({ ecosystem: r.ecosystem, kind: r.kind, name: r.name, key: r.key, location: r.location, details: JSON.parse(r.details_json) as Record<string, unknown> });
      if (hit) {
        set.run(hit.category, r.pid);
        assigned++;
      } else {
        clear.run(r.pid);
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { assigned };
}
