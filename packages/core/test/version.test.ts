import { test } from "node:test";
import assert from "node:assert/strict";
import { compareVersions, isNewer, maxVersion } from "../src/index.ts";

const c = compareVersions;

test("dotted numbers compare by value, not text", () => {
  assert.equal(c("1.10.0", "1.9.9"), 1);
  assert.equal(c("2.0", "2.0.0"), 0);
  assert.equal(c("v3.4.3", "3.4.3"), 0);
  assert.equal(c("26.01", "26.03"), -1);
  assert.equal(c("0.4.25+1", "0.4.25"), 1);
});

test("a pre-release sorts below its release and above the previous one", () => {
  assert.equal(c("7.0.0-rc1", "7.0.0"), -1);
  assert.equal(c("7.0.0-rc1", "6.9.9"), 1);
  assert.equal(c("7.1.0-dev.20260929.1", "7.0.2"), 1);
  assert.equal(c("1.0beta2", "1.0beta10"), -1);
  assert.equal(c("2.1.0-beta", "2.1.0-rc"), -1);
});

test("a packaging revision sorts above the bare version", () => {
  assert.equal(c("5.3.9_1", "5.3.9"), 1);
  assert.equal(c("5.3.9", "5.3.9_1"), -1);
  assert.equal(c("5.3.9_1", "5.3.10"), -1);
});

test("a string with no digits is not comparable", () => {
  assert.equal(c("unknown", "1.0"), null);
  assert.equal(c("1.0", ""), null);
  assert.equal(isNewer("unknown", "1.0"), false);
});

test("isNewer and maxVersion", () => {
  assert.equal(isNewer("2.56.0", "2.55.9"), true);
  assert.equal(isNewer("2.55.9", "2.55.9"), false);
  assert.equal(maxVersion(["1.2", "1.10", "1.9", "1.10-rc1"]), "1.10");
  assert.equal(maxVersion([]), null);
});
