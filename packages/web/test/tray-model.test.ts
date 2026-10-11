import { test } from "node:test";
import assert from "node:assert/strict";

const m = await import(new URL("../public/tray-model.js", import.meta.url).href);
const { TEXT } = await import(new URL("../public/tray-text.js", import.meta.url).href);

test("a partial rules document fills every list and drops malformed entries", () => {
  assert.deepEqual(m.normalizeRules(undefined), m.emptyRules());
  const rules = m.normalizeRules({ hide: { kinds: ["listener", 3], names: [{ match: "a*" }, { machine: "gm", match: "b" }, { match: 4 }] }, pins: [{ machine: "gm", key: "k" }, { machine: "gm" }] });
  assert.deepEqual(rules.hide.kinds, ["listener"]);
  assert.deepEqual(rules.hide.names, [{ match: "a*" }, { machine: "gm", match: "b" }]);
  assert.deepEqual(rules.pins, [{ machine: "gm", key: "k" }]);
});

test("edits return new documents and ignore blank or repeated name rules", () => {
  const base = m.emptyRules();
  const on = m.toggleHide(base, "kinds", "listener", true);
  assert.deepEqual(on.hide.kinds, ["listener"]);
  assert.deepEqual(base.hide.kinds, []);
  assert.deepEqual(m.toggleHide(on, "kinds", "listener", false).hide.kinds, []);
  assert.equal(m.addNameRule(base, "", "  "), base);
  const named = m.addNameRule(base, "gm", " OneDrive* ");
  assert.deepEqual(named.hide.names, [{ machine: "gm", match: "OneDrive*" }]);
  assert.equal(m.addNameRule(named, "gm", "OneDrive*"), named);
  assert.deepEqual(m.removeNameRule(named, 0).hide.names, []);
  assert.deepEqual(m.removePin({ ...base, pins: [{ machine: "a", key: "b" }] }, 0).pins, []);
});

test("import accepts a bare or wrapped document and names the problem otherwise", () => {
  assert.deepEqual(m.parseImport(m.exportText(m.toggleHide(m.emptyRules(), "vendors", "apple", true))).hide.vendors, ["apple"]);
  assert.deepEqual(m.parseImport(JSON.stringify({ rules: { hide: { classes: ["optional"] } } })).hide.classes, ["optional"]);
  assert.throws(() => m.parseImport("{ no"), /not valid JSON/);
  assert.throws(() => m.parseImport("[]"), /one JSON object/);
  assert.throws(() => m.parseImport(JSON.stringify({ hide: { kinds: ["bogus"] } })), /"bogus" is not a known value/);
});

test("a pin reads as its machine and the row's own name, and every checkbox has text", () => {
  assert.equal(m.pinLabel({ machine: "gm", key: "service:gm:launchd:system:com.x.y" }, [{ id: "gm", name: "Gamemaster" }]), "Gamemaster: com.x.y");
  for (const kind of m.KINDS) assert.ok(TEXT[`kind_${kind}`], kind);
  for (const cls of m.CLASSES) assert.ok(TEXT[`class_${cls}`], cls);
  for (const vendor of m.VENDORS) assert.ok(TEXT[`vendor_${vendor}`], vendor);
});
