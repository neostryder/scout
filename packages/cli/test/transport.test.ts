import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { remoteCommand, shellQuote } from "@scout/core";

test("shellQuote wraps in single quotes and escapes embedded ones", () => {
  assert.equal(shellQuote("plain"), "'plain'");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
});

test("remoteCommand runs the quoted argv under a login shell through sh", () => {
  assert.equal(remoteCommand(["npm", "root", "-g"]), `sh -c 'if command -v zsh >/dev/null 2>&1; then exec zsh -lc "$1"; else exec bash -lc "$1"; fi' sh ''\\''npm'\\'' '\\''root'\\'' '\\''-g'\\'''`);
});

test("remoteCommand includes login zsh and bash branches", () => {
  const cmd = remoteCommand(["npm", "root", "-g"]);
  assert.match(cmd, /zsh -lc/);
  assert.match(cmd, /bash -lc/);
});

const hasShells = spawnSync("sh", ["-c", "command -v sh >/dev/null 2>&1 && command -v bash >/dev/null 2>&1"], { windowsHide: true, timeout: 10_000 }).status === 0;

test("remoteCommand preserves quotes, spaces and literal shell syntax", { skip: !hasShells }, () => {
  const argument = "it's a space with $HOME and $(printf expanded)";
  const result = spawnSync("sh", ["-c", remoteCommand(["printf", "%s", argument])], { windowsHide: true, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, argument);
});

test("remoteCommand preserves the command exit status", { skip: !hasShells }, () => {
  const result = spawnSync("sh", ["-c", remoteCommand(["sh", "-c", "exit 7"])], { windowsHide: true, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 7, result.stderr);
});

test("brew probes run with auto-update and analytics off", () => {
  const cmd = remoteCommand(["/opt/homebrew/bin/brew", "info", "--json=v2", "--installed"]);
  assert.match(cmd, /HOMEBREW_NO_AUTO_UPDATE=1/);
  assert.match(cmd, /HOMEBREW_NO_ANALYTICS=1/);
});
