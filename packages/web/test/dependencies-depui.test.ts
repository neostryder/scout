import { test } from "node:test";
import assert from "node:assert/strict";

const { riskBadge, updateDialogModel, updatePlanQuery } = await import(new URL("../public/lib.js", import.meta.url).href);
const { filterQuery, matchesFilter, FILTER_PARAMS } = await import(new URL("../public/filters.js", import.meta.url).href);

test("depui badges explain hard and soft risks and omit empty risk", () => {
  for (const risk of [null, undefined, { hard: 0, soft: 0 }]) assert.equal(riskBadge(risk), null);
  assert.deepEqual(riskBadge({ hard: 2, soft: 4 }), { text: "Breaks 2", title: "Updating would break 2 installs that depend on this", className: "risk hard" });
  assert.equal(riskBadge({ hard: 1, soft: 0 }).title, "Updating would break 1 install that depends on this");
  assert.deepEqual(riskBadge({ hard: 0, soft: 2 }), { text: "Check 2", title: "2 installs or projects may be affected", className: "risk soft" });
  assert.equal(riskBadge({ hard: 0, soft: 1 }).title, "1 install or project may be affected");
});

test("depui dialog model names each affected project and dependent once", () => {
  assert.deepEqual(updateDialogModel([{ allowed: true }, { softConfirmation: null }]), { requiresSoftConfirmation: false, projects: [], dependents: [] });
  assert.deepEqual(updateDialogModel([
    { softConfirmation: { projects: ["C:/Projects/one"], dependents: ["Tool"] } },
    { allowed: false, softConfirmation: { projects: ["C:/Projects/one", "C:/Projects/two"], dependents: ["Tool", "Other"] } },
  ]), { requiresSoftConfirmation: true, projects: ["C:/Projects/one", "C:/Projects/two"], dependents: ["Tool", "Other"] });
});

test("depui batch plans include only other installs on the same machine", () => {
  const selected = [{ installId: 1, machineId: "mini" }, { installId: 2, machineId: "hub" }, { installId: 3, machineId: "mini" }, { installId: 4, machineId: "mini" }];
  assert.equal(updatePlanQuery(1, selected).get("alsoInstallIds"), "3,4");
  assert.equal(updatePlanQuery(2, selected).toString(), "installId=2");
  assert.equal(updatePlanQuery(5, selected).toString(), "installId=5");
});

test("depui safe filter joins the saved spec and leaves older specs unchanged", () => {
  assert.ok(FILTER_PARAMS.updates.includes("safe"));
  assert.equal(FILTER_PARAMS.catalog.includes("safe"), false);
  const spec = filterQuery("updates", new URLSearchParams("machine=mini&safe=1&limit=100&view=updates"));
  assert.deepEqual(spec, { machine: "mini", safe: "1" });
  assert.equal(matchesFilter({ view: "updates", spec }, "updates", new URLSearchParams(spec)), true);
  assert.equal(matchesFilter({ view: "updates", spec }, "updates", new URLSearchParams("machine=mini")), false);
  assert.equal(matchesFilter({ view: "updates", spec: { machine: "mini" } }, "updates", new URLSearchParams("machine=mini")), true);
  assert.equal(Object.hasOwn(filterQuery("updates", new URLSearchParams()), "safe"), false);
});
