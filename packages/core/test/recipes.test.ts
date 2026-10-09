import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { actionById, createAction, decideRecipe, detectRecipes, findProjects, openCatalog, recipeById, recipesResponse, scanRecipes, SCHEMA_SQL, SCHEMA_VERSION, upsertMachine, validateRecipe, type RecipeEvent } from "../src/index.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(resolve("recipe-core-")).replace(/\\/g, "/");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = { machineId: "hub", name: "fixture", root };
  const put = (file: string, data: unknown): void => { mkdirSync(resolve(root, file, ".."), { recursive: true }); writeFileSync(`${root}/${file}`, JSON.stringify(data)); };
  return { root, project, put };
}
function catalog(t: TestContext) {
  const db = openCatalog(":memory:");
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  t.after(() => db.close());
  return db;
}

test("recipe detection reads each source in order and hashes argv and the project directory", (t) => {
  const { root, project, put } = fixture(t);
  put("package.json", { scripts: { dev: "node server.js", serve: "node web.js", start: "node app.js", test: "node test.js" } });
  put("pnpm-lock.yaml", "fixture");
  put("yarn.lock", "fixture");
  put(".claude/launch.json", { configurations: [{ name: "web:dev", runtimeExecutable: "node.exe", runtimeArgs: ["web.js", "--port=4876"], port: 4876, cwd: "C:/ignored" }] });
  put("compose.yaml", "fixture");
  put("docker-compose.yml", "fixture");
  const recipes = detectRecipes(project);
  assert.deepEqual(recipes.map((recipe) => [recipe.source, recipe.name]), [["package-json", "start"], ["package-json", "dev"], ["package-json", "serve"], ["launch-json", "web:dev"], ["compose", "compose.yaml"]]);
  assert.deepEqual(recipes[0]!.argv, ["pnpm", "run", "start"]);
  assert.equal(recipes[1]!.detail, "node server.js");
  assert.equal(recipes[3]!.port, 4876);
  assert.deepEqual(recipes[4]!.argv, ["docker", "compose", "-f", "compose.yaml", "up", "-d"]);
  assert.equal(recipes[0]!.hash, createHash("sha256").update(JSON.stringify({ argv: recipes[0]!.argv, cwd: root })).digest("hex"));
  assert.ok(recipes.every((recipe) => recipe.reason === null && recipe.root === root));
  assert.deepEqual(detectRecipes({ ...project, machineId: "mini" }), []);
  rmSync(`${root}/pnpm-lock.yaml`);
  assert.equal(detectRecipes(project)[0]!.argv[0], "yarn");
  rmSync(`${root}/yarn.lock`);
  assert.equal(detectRecipes(project)[0]!.argv[0], "npm");
});

for (const file of ["compose.yml", "docker-compose.yml", "docker-compose.yaml"]) test(`recipe detection recognizes ${file} without opening its contents`, (t) => {
  const { project, put } = fixture(t);
  put(file, "fixture");
  assert.equal(detectRecipes(project)[0]!.name, file);
  assert.equal(findProjects("hub", [project.root]).length, 1);
});

for (const [name, argv, reason] of [
  ["dev", ["cmd", "/c", "app"], /executable/], ["dev", ["C:/Tools/node.exe"], /bare name/],
  ["bad name", ["node"], /name/], ["dev", ["node", "file name.js"], /characters/],
  ["dev", ["node", "x".repeat(201)], /200/], ["dev", ["node", "../app.js"], /parent directory/],
  ["dev", ["node", "--file=lib/../app.js"], /parent directory/], ["dev", ["node", ...Array(13).fill("x")], /12 arguments/],
] as const) test(`recipe validation refuses ${name} with ${argv[0]} and ${reason.source}`, () => assert.match(validateRecipe(name, argv)!, reason));

test("recipe validation refuses every shell metacharacter and accepts supported executable suffixes", () => {
  for (const character of [" ", "\"", "'", "$", "`", ";", "&", "|", "<", ">", "%", "*", "?", "\\"]) assert.match(validateRecipe("dev", ["node", `a${character}b`])!, /characters/);
  for (const executable of ["NODE.EXE", "pnpm.cmd", "python3", "uv", "docker", "bun", "dotnet"]) assert.equal(validateRecipe("dev", [executable, "--file=src/app.js", "127.0.0.1:4876"]), null);
});

test("recipe detection handles malformed input and invalid ports without reading other files", (t) => {
  const { root, project, put } = fixture(t);
  put(".claude/launch.json", { configurations: [{ name: "dev", runtimeExecutable: "node", runtimeArgs: ["app.js"], port: 65536 }, { name: "bad", runtimeExecutable: "node", runtimeArgs: [1] }, null] });
  put(".env", "This fixture contains no credentials.");
  put("compose.yaml", "fixture");
  put("pnpm-lock.yaml", "fixture");
  const reads: string[] = [];
  const original = fs.readFileSync;
  t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => { reads.push(String(args[0]).replace(/\\/g, "/")); assert.ok(!String(args[0]).endsWith(".env")); return original(...args); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const recipes = detectRecipes(project);
  assert.equal(recipes[0]!.port, null);
  assert.match(recipes[1]!.reason!, /must be text/);
  assert.match(recipes[2]!.reason!, /object/);
  assert.deepEqual(reads, [`${root}/.claude/launch.json`]);
});

test("recipe decisions persist until hash changes and missing sources become gone", (t) => {
  const { project, put } = fixture(t);
  const db = catalog(t);
  const events: RecipeEvent[] = [];
  const scan = (at: string) => scanRecipes(db, [project], at, (event) => events.push(event));
  const config = (arg: string) => put(".claude/launch.json", { configurations: [{ name: "dev", runtimeExecutable: "node", runtimeArgs: [arg], port: 4876 }] });
  config("one.js");
  assert.deepEqual(scan("2026-10-07T01:00:00Z"), { found: 1, proposed: 1 });
  const id = recipesResponse(db).recipes[0]!.id;
  const decide = (decision: string) => decideRecipe(db, { id, decision, hash: recipeById(db, id)!.hash, confirm: true });
  decide("approve");
  scan("2026-10-07T02:00:00Z");
  assert.equal(recipeById(db, id)!.state, "approved");
  config("two.js"); scan("2026-10-07T03:00:00Z");
  assert.equal(recipeById(db, id)!.state, "proposed");
  assert.equal(recipeById(db, id)!.decidedAt, null);
  decide("reject");
  config("three.js"); scan("2026-10-07T04:00:00Z");
  assert.equal(recipeById(db, id)!.state, "proposed");
  decide("approve");
  rmSync(`${project.root}/.claude/launch.json`); scan("2026-10-07T05:00:00Z");
  assert.equal(recipeById(db, id)!.gone, true);
  assert.equal(recipeById(db, id)!.state, "approved");
  assert.throws(() => decide("approve"), /gone/);
  assert.equal(events.at(-1)!.change, "gone");
  assert.equal(recipesResponse(db, "approved").counts.approved, 1);
  config("three.js"); scan("2026-10-07T06:00:00Z");
  assert.equal(recipeById(db, id)!.gone, false);
  assert.equal(recipeById(db, id)!.state, "approved");
});

test("unsupported recipes cannot be approved and decision validation keeps state intact", (t) => {
  const { project, put } = fixture(t);
  const db = catalog(t);
  put(".claude/launch.json", { configurations: [{ name: "bad", runtimeExecutable: "cmd", runtimeArgs: [] }] });
  scanRecipes(db, [project]);
  const recipe = recipesResponse(db).recipes[0]!;
  const body = { id: recipe.id, hash: recipe.hash, decision: "approve", confirm: true };
  assert.throws(() => decideRecipe(db, body), { status: 409 });
  assert.throws(() => decideRecipe(db, { ...body, hash: "a".repeat(64) }), { status: 409 });
  assert.throws(() => decideRecipe(db, { ...body, id: 999 }), { status: 404 });
  for (const invalid of [{ ...body, confirm: false }, { ...body, decision: "start" }, { ...body, hash: null }, { ...body, id: 0 }]) assert.throws(() => decideRecipe(db, invalid), { status: 400 });
  assert.equal(recipeById(db, recipe.id)!.state, "unsupported");
});

test("launch-only projects qualify for the shared project list", (t) => {
  const { project, put } = fixture(t);
  put(".claude/launch.json", { configurations: [] });
  assert.equal(findProjects("hub", [project.root]).length, 1);
});

test("an existing actions table gains recipe targets while preserving audit rows and schema version", (t) => {
  const { root } = fixture(t);
  const file = `${root}/fixture.db`;
  const db = openCatalog(file);
  upsertMachine(db, { id: "hub", name: "Hub", os: "windows", kind: "host" });
  const legacy = SCHEMA_SQL.match(/CREATE TABLE IF NOT EXISTS actions \([\s\S]*?\n\);/)![0].replace("'service','listener','recipe','stack'", "'service','listener'");
  db.exec("DROP TABLE actions");
  db.exec(legacy);
  const audit = createAction(db, { at: "2026-10-07T00:00:00Z", finishedAt: null, machineId: "hub", target: "service", rowId: 1, name: "fixture", action: "start", hard: false, mechanism: "windows-service", command: "Start-Service -Name fixture", admin: "none", state: "running", exitCode: null, message: null }, {});
  db.close();
  const reopened = openCatalog(file);
  try {
    assert.deepEqual(actionById(reopened, audit.id), audit);
    const recipe = createAction(reopened, { ...audit, target: "recipe", mechanism: "recipe", command: "node app.js" }, {});
    assert.equal(recipe.target, "recipe");
    assert.equal(reopened.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()!.value, String(SCHEMA_VERSION));
    assert.equal(SCHEMA_VERSION, 3);
  } finally { reopened.close(); }
});

test("an edited package script body sends an approved recipe back to proposed", (t) => {
  const { project, put } = fixture(t);
  const db = catalog(t);
  put("package.json", { scripts: { dev: "node one.js" } });
  scanRecipes(db, [project], "2026-10-07T01:00:00Z");
  const recipe = recipesResponse(db).recipes[0]!;
  decideRecipe(db, { id: recipe.id, decision: "approve", hash: recipe.hash, confirm: true });
  scanRecipes(db, [project], "2026-10-07T02:00:00Z");
  assert.equal(recipeById(db, recipe.id)!.state, "approved");
  put("package.json", { scripts: { dev: "node two.js" } });
  scanRecipes(db, [project], "2026-10-07T03:00:00Z");
  assert.equal(recipeById(db, recipe.id)!.state, "proposed");
  assert.equal(recipeById(db, recipe.id)!.detail, "node two.js");
});
