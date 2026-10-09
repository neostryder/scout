import { test } from "node:test";
import assert from "node:assert/strict";
import { downloadLink } from "../src/download-link.ts";

test("a GitHub homepage goes to the latest release, other https homepages are kept", () => {
  assert.equal(downloadLink("winget", "X.Y", "https://github.com/owner/repo"), "https://github.com/owner/repo/releases/latest");
  assert.equal(downloadLink("winget", "X.Y", "https://github.com/owner/repo.git"), "https://github.com/owner/repo/releases/latest");
  assert.equal(downloadLink("winget", "X.Y", "https://github.com/owner/repo/tree/main/docs"), "https://github.com/owner/repo/releases/latest");
  assert.equal(downloadLink("winget", "X.Y", "https://example.com/product"), "https://example.com/product");
});

test("only https pages are offered, with documented fallbacks for Store and Homebrew", () => {
  assert.equal(downloadLink("other", "X.Y", "http://example.com/product"), null);
  assert.equal(downloadLink("other", "X.Y", "javascript:alert(1)"), null);
  assert.equal(downloadLink("other", "X.Y", "not a url"), null);
  assert.equal(downloadLink("other", "X.Y", null), null);
  assert.equal(downloadLink("msstore", "9WZDNCRFJ3Q8", null), "https://apps.microsoft.com/detail/9WZDNCRFJ3Q8");
  assert.equal(downloadLink("brew", "fd", null), "https://formulae.brew.sh/formula/fd");
  assert.equal(downloadLink("cask", "firefox", null), "https://formulae.brew.sh/cask/firefox");
  assert.equal(downloadLink("brew", "bad name;rm", null), null);
  assert.equal(downloadLink("go-bin", "golang.org/x/tools/gopls", null), "https://pkg.go.dev/golang.org/x/tools/gopls");
  assert.equal(downloadLink("go-bin", "/bin/bash", null), null);
});

test("registry pages are the last resort when a product names no home page", () => {
  assert.equal(downloadLink("npm", "typescript", null), "https://www.npmjs.com/package/typescript");
  assert.equal(downloadLink("npm", "@scope/tool", null), "https://www.npmjs.com/package/@scope/tool");
  assert.equal(downloadLink("npm", "bad name;rm", null), null);
  assert.equal(downloadLink("pipx", "ruff", null), "https://pypi.org/project/ruff/");
  assert.equal(downloadLink("uv-tool", "../x", null), null);
  assert.equal(downloadLink("winget", "Git.Git", null), "https://winget.run/pkg/Git/Git");
  assert.equal(downloadLink("winget", "nodots", null), null);
  assert.equal(downloadLink("npm", "typescript", "https://example.com/ts"), "https://example.com/ts");
});
