import { test } from "node:test";
import assert from "node:assert/strict";
import { remoteCommand, shellQuote } from "@scout/core";

test("shellQuote wraps in single quotes and escapes embedded ones", () => {
  assert.equal(shellQuote("plain"), "'plain'");
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
});

test("remoteCommand runs the quoted argv under a login zsh", () => {
  assert.equal(remoteCommand(["npm", "root", "-g"]), `zsh -lc ''\\''npm'\\'' '\\''root'\\'' '\\''-g'\\'''`);
});

test("brew probes run with auto-update and analytics off", () => {
  const cmd = remoteCommand(["/opt/homebrew/bin/brew", "info", "--json=v2", "--installed"]);
  assert.match(cmd, /HOMEBREW_NO_AUTO_UPDATE=1/);
  assert.match(cmd, /HOMEBREW_NO_ANALYTICS=1/);
});
