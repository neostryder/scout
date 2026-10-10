import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";

class Element {
  tag: string;
  attrs: Record<string, any>;
  children: any[];
  constructor(tag: string, attrs: Record<string, any>, children: any[]) { this.tag = tag; this.attrs = attrs; this.children = children.flat(Infinity); }
}

// lib.js builds elements from the document, so only the flagRow function is loaded, with a stand-in for h.
function flagRow(flags: unknown): Element[] {
  const source = readFileSync(new URL("../public/lib.js", import.meta.url), "utf8");
  const start = source.indexOf("export function flagRow");
  const end = source.indexOf("export function marked");
  assert.ok(start >= 0 && end > start);
  const context = createContext({ h: (tag: string, attrs: Record<string, any>, ...children: any[]) => new Element(tag, attrs, children) });
  runInContext(source.slice(start, end).replace(/^export /, ""), context);
  return (context as any).flagRow(flags);
}

test("flags render as one row of tags that carry their evidence as the tooltip", () => {
  const rows = flagRow([{ kind: "odd-location", label: "Odd location", evidence: "Installed in the downloads folder." }, { kind: "mine", label: "Mine", evidence: "Inside scout, a project of yours." }]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.attrs.class, "flags");
  assert.deepEqual(rows[0]!.children.map((tag) => [tag.attrs.class, tag.attrs.title, tag.children[0]]), [
    ["tag flag flag-odd-location", "Installed in the downloads folder.", "Odd location"],
    ["tag flag flag-mine", "Inside scout, a project of yours.", "Mine"],
  ]);
});

test("rows with no flags, or an older API without them, render nothing", () => {
  assert.equal(flagRow([]).length, 0);
  assert.equal(flagRow(undefined).length, 0);
});
