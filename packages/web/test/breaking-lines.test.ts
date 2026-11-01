import { test } from "node:test";
import assert from "node:assert/strict";
import { breakingLines as core } from "../../core/src/breaking-lines.ts";
const { breakingLines: web } = await import("../public/breaking-lines.js" as string) as { breakingLines: typeof core };

test("browser and core breaking-line matchers agree", () => {
  const fixtures = [
    "This is a breaking change.",
    "BREAKING: behavior changed",
    "The API is backwards incompatible.",
    "Not backward compatible with the prior version.",
    "Removed support for Java 8.",
    "This is no longer supported.",
    "Migration required before upgrading.",
    "The command was renamed old to new.",
    "The old option is deprecated and removed.",
    "Now requires Node 20.",
    "## Breaking Changes\n- Update your config\n## Notes\n- Safe change",
    "~~~\nbreaking change\n~~~\nNo issue",
  ];
  for (const fixture of fixtures) assert.deepEqual(web(fixture), core(fixture));
});
