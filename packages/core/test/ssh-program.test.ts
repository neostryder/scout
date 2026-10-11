import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { sshProgram } from "../src/index.ts";

const FILES = "C:/Program Files";
const GIT_SSH = join(FILES, "Git", "usr", "bin", "ssh.exe");

test("Windows uses the ssh that ships with Git when it is installed, and plain ssh otherwise", () => {
  assert.equal(sshProgram({ ProgramFiles: FILES }, "win32", (p) => p === GIT_SSH), GIT_SSH);
  assert.equal(sshProgram({ ProgramFiles: FILES }, "win32", () => false), "ssh");
  assert.equal(sshProgram({}, "win32", () => true), "ssh");
});

test("other systems use plain ssh, and SCOUT_SSH overrides every choice", () => {
  assert.equal(sshProgram({ ProgramFiles: FILES }, "darwin", () => true), "ssh");
  assert.equal(sshProgram({ SCOUT_SSH: "/opt/bin/ssh", ProgramFiles: FILES }, "win32", () => true), "/opt/bin/ssh");
});
