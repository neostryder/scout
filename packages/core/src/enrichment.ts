import type { Db } from "./db.ts";
import { CATEGORIES } from "./categorize.ts";

// Enrichment: descriptions and categories for packages whose source supplied none. The model sees only what is public
// about the software (its name, ecosystem, publisher and homepage). Its answers are validated here, stored as
// generated with a confidence, and never replace text from the source or a hand edit.

export interface TodoItem {
  /** Lower-cased name; one answer is applied to every package with this name. */
  name: string;
  display: string;
  ecosystems: string[];
  publisher: string | null;
  homepage: string | null;
}

export interface Answer {
  name: string;
  description: string | null;
  category: string | null;
  confidence: number;
}

const SKIP_CATEGORIES = ["library dependency", "system component", "container image", "virtual machine", "runtime library", "driver"];

/** Distinct names that still need a description or a category, most installs first. */
export function todoList(db: Db): TodoItem[] {
  const placeholders = SKIP_CATEGORIES.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT lower(p.name) AS name, MIN(p.name) AS display, group_concat(DISTINCT p.ecosystem) AS ecosystems,
              MAX(p.publisher) AS publisher, MAX(p.homepage) AS homepage, COUNT(*) AS n
       FROM packages p
       WHERE (p.description IS NULL OR p.category IS NULL)
         AND (p.category IS NULL OR p.category NOT IN (${placeholders}))
         AND EXISTS (SELECT 1 FROM installs i WHERE i.package_id = p.id AND i.removed_at IS NULL)
       GROUP BY lower(p.name) ORDER BY n DESC, name`,
    )
    .all(...SKIP_CATEGORIES) as unknown as { name: string; display: string; ecosystems: string; publisher: string | null; homepage: string | null }[];
  return rows.map((r) => ({ name: r.name, display: r.display, ecosystems: r.ecosystems.split(","), publisher: r.publisher, homepage: r.homepage }));
}

export interface Rejection {
  name: string;
  reason: string;
}

const NON_ASCII = /[^\x20-\x7E]/;

/** Why an answer cannot be stored, or null when it can. */
export function validateAnswer(a: Answer): string | null {
  if (typeof a.name !== "string" || a.name === "") return "missing name";
  if (a.description !== null) {
    if (typeof a.description !== "string") return "description is not text";
    if (a.description.length < 8 || a.description.length > 200) return "description length outside 8 to 200";
    if (NON_ASCII.test(a.description)) return "description has non-ASCII characters";
    if (/\n/.test(a.description)) return "description has a line break";
  }
  if (a.category !== null && !(CATEGORIES as readonly string[]).includes(a.category)) return `unknown category "${a.category}"`;
  if (typeof a.confidence !== "number" || a.confidence < 0 || a.confidence > 1) return "confidence outside 0 to 1";
  return null;
}

/**
 * Apply validated answers. A description fills a package only when it has none or its description is generated; a
 * category only when there is none or it is generated. Returns what was stored and what was refused.
 */
export function applyEnrichment(db: Db, answers: Answer[], now = new Date().toISOString(), minConfidence = 0.5): { applied: number; rejected: Rejection[] } {
  const rejected: Rejection[] = [];
  let applied = 0;
  db.exec("BEGIN");
  try {
    const desc = db.prepare(
      `UPDATE packages SET description = ?1, description_source = 'generated', description_confidence = ?2, description_at = ?3
       WHERE lower(name) = ?4 AND (description IS NULL OR description_source = 'generated')`,
    );
    const cat = db.prepare("UPDATE packages SET category = ?1, category_source = 'generated' WHERE lower(name) = ?2 AND (category IS NULL OR category_source = 'generated')");
    for (const a of answers) {
      const problem = validateAnswer(a);
      if (problem) {
        rejected.push({ name: String(a.name), reason: problem });
        continue;
      }
      if (a.confidence < minConfidence) {
        rejected.push({ name: a.name, reason: `confidence ${a.confidence} below ${minConfidence}` });
        continue;
      }
      const key = a.name.toLowerCase();
      if (a.description !== null) desc.run(a.description, a.confidence, now, key);
      if (a.category !== null) cat.run(a.category, key);
      applied++;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { applied, rejected };
}

/**
 * Give a package the source description of a sibling: another package in the same item, or one with the same name.
 * Siblings are stored with `description_source = 'sibling'` so they can be told apart from the source's own words.
 */
export function inheritDescriptions(db: Db, now = new Date().toISOString()): { inherited: number } {
  let inherited = 0;
  db.exec("BEGIN");
  try {
    db.exec("UPDATE packages SET description = NULL, description_source = NULL, description_at = NULL WHERE description_source = 'sibling'");
    const byItem = db.prepare(
      `UPDATE packages SET description = ?1, description_source = 'sibling', description_at = ?2
       WHERE id = ?3 AND description IS NULL`,
    );
    const pairs = db
      .prepare(
        `SELECT t.id AS target, s.description AS description, s.homepage AS homepage
         FROM packages t
         JOIN item_links lt ON lt.package_id = t.id
         JOIN item_links ls ON ls.item_id = lt.item_id AND ls.package_id != t.id
         JOIN packages s ON s.id = ls.package_id AND s.description_source = 'source'
         WHERE t.description IS NULL GROUP BY t.id`,
      )
      .all() as unknown as { target: number; description: string }[];
    for (const p of pairs) {
      byItem.run(p.description, now, p.target);
      inherited++;
    }
    const byName = db
      .prepare(
        `SELECT t.id AS target, (SELECT s.description FROM packages s WHERE lower(s.name) = lower(t.name) AND s.description_source = 'source' ORDER BY s.id LIMIT 1) AS description
         FROM packages t WHERE t.description IS NULL`,
      )
      .all() as unknown as { target: number; description: string | null }[];
    for (const p of byName) {
      if (p.description === null) continue;
      byItem.run(p.description, now, p.target);
      inherited++;
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return { inherited };
}

/**
 * The first JSON array in a model's reply, found by matching brackets outside strings, so text before it (a preamble)
 * or after it (a tool banner that contains brackets) does not matter. Returns null when there is no complete array.
 */
export function extractJsonArray(text: string): unknown[] | null {
  for (let start = text.indexOf("["); start >= 0; start = text.indexOf("[", start + 1)) {
    let depth = 0;
    let inString = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "[") depth++;
      else if (c === "]" && --depth === 0) {
        try {
          const value: unknown = JSON.parse(text.slice(start, i + 1));
          if (Array.isArray(value)) return value;
        } catch {
          /* not JSON; try the next opening bracket */
        }
        break;
      }
    }
  }
  return null;
}
