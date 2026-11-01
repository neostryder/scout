import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { windowsNodeCli } from "../src/transport.ts";

const EXEC_PATH = "C:/Program Files/nodejs/node.exe";
const NPM_CLI = join("C:/Program Files/nodejs", "node_modules", "npm", "bin", "npm-cli.js");
const NPX_CLI = join("C:/Program Files/nodejs", "node_modules", "npm", "bin", "npx-cli.js");

test("Windows resolves npm and npx to the bundled Node CLI scripts", () => {
  assert.deepEqual(windowsNodeCli("npm", EXEC_PATH, "win32", (path) => path === NPM_CLI), { file: EXEC_PATH, args: [NPM_CLI] });
  assert.deepEqual(windowsNodeCli("npx", EXEC_PATH, "win32", (path) => path === NPX_CLI), { file: EXEC_PATH, args: [NPX_CLI] });
});

test("Windows leaves other files and missing npm scripts unchanged", () => {
  assert.equal(windowsNodeCli("node", EXEC_PATH, "win32", () => true), null);
  assert.equal(windowsNodeCli("npm", EXEC_PATH, "win32", () => false), null);
});

test("other platforms leave npm unchanged", () => {
  assert.equal(windowsNodeCli("npm", EXEC_PATH, "linux", () => true), null);
});