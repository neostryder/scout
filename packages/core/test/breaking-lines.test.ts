import { test } from "node:test";
import assert from "node:assert/strict";
import { breakingLines } from "../src/breaking-lines.ts";

test("breaking wording patterns return their source line and a fixed reason", () => {
  const samples = [
    ["This is a breaking change.", "breaking change"],
    ["BREAKING: old mode removed", "breaking change"],
    ["BREAKING behavior", "breaking change"],
    ["The release is backwards incompatible.", "incompatible change"],
    ["The release is backward incompatible.", "incompatible change"],
    ["This is not backward compatible.", "incompatible change"],
    ["Incompatible with version 2.", "incompatible change"],
    ["Removed support for Linux.", "support dropped"],
    ["Drops support for Python 2.", "support dropped"],
    ["Dropped support for Java 8.", "support dropped"],
    ["This is no longer supported.", "support dropped"],
    ["The upgrade requires migration.", "migration needed"],
    ["Migration required for this release.", "migration needed"],
    ["You must migrate first.", "migration needed"],
    ["API renamed from old to new.", "renamed interface"],
    ["The option is deprecated and removed.", "deprecated and removed"],
    ["This removes the old command.", "removed interface"],
    ["Now requires Node 20.", "new minimum requirement"],
    ["Now requires version 3.1.", "new minimum requirement"],
  ] as const;
  for (const [text, reason] of samples) assert.deepEqual(breakingLines(text), [{ line: 1, text, reason }]);
});

test("near misses, fenced code and empty input stay quiet", () => {
  const text = ["breaks compatibility in rare cases", "not compatible", "support for Linux", "renamed old to new", "now requires care", "```", "breaking change", "```"].join("\n");
  assert.deepEqual(breakingLines(text), []);
  assert.deepEqual(breakingLines(""), []);
});

test("a breaking section marks its heading and bullets until an equal or higher heading", () => {
  const text = ["## Breaking Changes", "Intro", "- Old API removed", "  1. Update config", "### Details", "* Nested removal", "## Notes", "- Safe note"].join("\n");
  assert.deepEqual(breakingLines(text), [
    { line: 1, text: "## Breaking Changes", reason: "breaking section" },
    { line: 3, text: "- Old API removed", reason: "under a breaking section" },
    { line: 4, text: "  1. Update config", reason: "under a breaking section" },
    { line: 6, text: "* Nested removal", reason: "under a breaking section" },
  ]);
});
