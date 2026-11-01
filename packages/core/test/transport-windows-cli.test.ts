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

test("Windows resolves npm cmd names without spawning a shell", () => {
  assert.deepEqual(windowsNodeCli("npm.cmd", EXEC_PATH, "win32", (path) => path === NPM_CLI), { file: EXEC_PATH, args: [NPM_CLI] });
});

test("Windows resolves pnpm beside Node before user locations", () => {
  const script = join("C:/Program Files/nodejs", "node_modules", "pnpm", "bin", "pnpm.cjs");
  const exe = join("C:/Program Files/nodejs", "pnpm.exe");
  assert.deepEqual(windowsNodeCli("pnpm", EXEC_PATH, "win32", (path) => path === script || path === exe), { file: EXEC_PATH, args: [script] });
  assert.deepEqual(windowsNodeCli("pnpm", EXEC_PATH, "win32", (path) => path === exe), { file: exe, args: [] });
  const corepack = join("C:/Program Files/nodejs", "node_modules", "corepack", "dist", "pnpm.js");
  assert.deepEqual(windowsNodeCli("pnpm.cmd", EXEC_PATH, "win32", (path) => path === corepack), { file: EXEC_PATH, args: [corepack] });
});

test("Windows resolves user npm and pnpm installations when Node has no bundled CLI", () => {
  const npm = join("C:/Users/fixture/AppData/Roaming", "npm", "node_modules", "npm", "bin", "npm-cli.js");
  const pnpm = join("C:/tools/pnpm", "pnpm.exe");
  const env = { APPDATA: "C:/Users/fixture/AppData/Roaming", PNPM_HOME: "C:/tools/pnpm" };
  assert.deepEqual(windowsNodeCli("npm", EXEC_PATH, "win32", (path) => path === npm, env), { file: EXEC_PATH, args: [npm] });
  assert.deepEqual(windowsNodeCli("pnpm", EXEC_PATH, "win32", (path) => path === pnpm, env), { file: pnpm, args: [] });
  const defaultPnpm = join("C:/Users/fixture/AppData/Local", "pnpm", "pnpm.exe");
  assert.deepEqual(windowsNodeCli("pnpm", EXEC_PATH, "win32", (path) => path === defaultPnpm, { LOCALAPPDATA: "C:/Users/fixture/AppData/Local" }), { file: defaultPnpm, args: [] });
});
