import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openCatalog, upsertMachine } from "@scout/core";
import { recipesCommand } from "../src/recipes.ts";

test("recipes CLI lists, scans, prints approval commands, requires --yes and rejects recipes", (t) => {
  const root = mkdtempSync(resolve("recipe-cli-")).replace(/\\/g, "/");
  writeFileSync(`${root}/package.json`, JSON.stringify({ scripts: { dev: "node app.js" } }));
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  const lines: string[] = [];
  const options = { write: (line: string) => { lines.push(line); }, projects: () => [{ machineId: "hub", root, name: "fixture" }] };
  recipesCommand(db, ["scan"], options);
  assert.deepEqual(JSON.parse(lines.pop()!), { found: 1, proposed: 1 });
  recipesCommand(db, [], options);
  const recipe = JSON.parse(lines.pop()!).recipes[0];
  assert.throws(() => recipesCommand(db, ["approve", String(recipe.id)], options), /requires --yes/);
  assert.equal(lines.pop(), "npm run dev");
  recipesCommand(db, ["approve", String(recipe.id), "--yes"], options);
  assert.equal(JSON.parse(lines.pop()!).recipe.state, "approved");
  assert.equal(lines.pop(), "npm run dev");
  recipesCommand(db, ["--state", "proposed"], options);
  assert.equal(JSON.parse(lines.pop()!).recipes.length, 0);
  recipesCommand(db, ["reject", String(recipe.id)], options);
  assert.equal(JSON.parse(lines.pop()!).recipe.state, "rejected");
  for (const args of [["unknown"], ["--state"], ["--state", "bad"], ["approve", "bad", "--yes"], ["reject", "999"]]) assert.throws(() => recipesCommand(db, args, options));
});

test("the CLI entry lists recipes from an in-memory catalog", () => {
  const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const result = spawnSync(process.execPath, [entry, "recipes", "--state", "proposed", "--db", ":memory:"], { windowsHide: true, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).recipes, []);
});
