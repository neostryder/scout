import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSparkleDownload } from "../src/download-source.ts";

const arm = { platform: "macos", arch: "arm64" } as const;

test("a redirect script is not an exact file, but installer and archive names are", () => {
  assert.equal(resolveSparkleDownload({ url: "https://download.example.test/rotation.php?id=1", length: "10" }, arm), null);
  assert.equal(resolveSparkleDownload({ url: "https://download.example.test/download", length: "10" }, arm), null);
  assert.equal(resolveSparkleDownload({ url: "https://download.example.test/App.dmg", length: "10" }, arm)?.fileName, "App.dmg");
  assert.equal(resolveSparkleDownload({ url: "https://download.example.test/App-1.2.tar.gz", length: "10" }, arm)?.fileName, "App-1.2.tar.gz");
  assert.equal(resolveSparkleDownload({ url: "https://download.example.test/App.pkg", length: "10" }, arm)?.fileName, "App.pkg");
});
