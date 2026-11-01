import { test } from "node:test";
import assert from "node:assert/strict";
const { riskLabel, riskLevelText, riskPartPercent, riskRingMath } = await import(new URL("../public/risk-model.js", import.meta.url).href);

test("risk labels include the score and level words", () => {
  assert.equal(riskLabel(42, "moderate"), "Update risk 42 of 100, moderate");
  assert.equal(riskLevelText("elevated"), "Elevated");
});

test("risk ring math clamps scores and returns the SVG arc", () => {
  assert.deepEqual(riskRingMath(50), { circumference: 28 * Math.PI, dashArray: `${28 * Math.PI} ${28 * Math.PI}`, dashOffset: 14 * Math.PI, radius: 14, strokeWidth: 3 });
  assert.equal(riskRingMath(150).dashOffset, 0);
  assert.equal(riskRingMath(-1).dashOffset, 28 * Math.PI);
});

test("part labels show each part's contribution to the full score", () => {
  assert.equal(riskPartPercent({ value: 0.5, weight: 0.3 }), 15);
});
