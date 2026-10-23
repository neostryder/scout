import { test } from "node:test";
import assert from "node:assert/strict";
import { progressReader, unstaged } from "../src/progress.ts";

// Recorded from a real `winget upgrade --silent` of Obsidian run through a pipe.
const OBSIDIAN = "Found Obsidian [Obsidian.Obsidian] Version 1.14.4\nThis application is licensed to you by its owner.\nMicrosoft is not responsible for, nor does it grant any licenses to, third-party packages.\nDownloading https://github.com/obsidianmd/obsidian-releases/releases/download/v1.14.4/Obsidian-1.14.4.exe\nSuccessfully verified installer hash\nStarting package install...\nThe installer will request to run as administrator. Expect a prompt.\nSuccessfully installed\n";

test("a recorded winget run yields its stages in order and flags the administrator prompt before install ends", () => {
  const read = progressReader("winget");
  assert.deepEqual(read(OBSIDIAN), [{ phase: "download" }, { phase: "verify" }, { phase: "install" }, { uacExpected: true }, { phase: "finish" }]);
});

test("chunks may split a line, and carriage-return redraws are line breaks", () => {
  const read = progressReader("winget");
  assert.deepEqual(read("Downlo"), []);
  assert.deepEqual(read("ading https://example.test/a.exe\r  12 MB / 90 MB\r"), [{ phase: "download" }]);
  assert.deepEqual(read("Starting package"), []);
  assert.deepEqual(read(" install...\n"), [{ phase: "install" }]);
});

test("a stage is reported once and never moves backwards", () => {
  const read = progressReader("msstore");
  assert.deepEqual(read("Starting package install...\n"), [{ phase: "install" }]);
  assert.deepEqual(read("Downloading https://example.test/a.exe\nStarting package install...\n"), []);
  assert.deepEqual(read("Successfully installed\n"), [{ phase: "finish" }]);
});

test("brew stages and unstaged ecosystems", () => {
  const read = progressReader("brew");
  assert.deepEqual(read("==> Upgrading git\n==> Downloading https://ghcr.io/x\n==> Pouring git--2.0.bottle.tar.gz\n==> Summary\n"), [{ phase: "download" }, { phase: "install" }, { phase: "finish" }]);
  assert.deepEqual(progressReader("npm")("added 1 package\n"), []);
  assert.deepEqual(["winget", "msstore", "brew", "cask", "npm", "pipx", "uv-tool"].map(unstaged), [false, false, false, false, true, true, true]);
});
