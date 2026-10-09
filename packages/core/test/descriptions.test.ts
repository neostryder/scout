import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { applyEnrichment, describeRow, descriptionsOverview, inheritDescriptions, listListeners, listRoutes, listServices, loadDescriptionResolver, ModelCapError, openCatalog, publicDescriptionTodo, recordCloudflare, recordListeners, recordScan, recordServices, runPublicDescriptions, SCHEMA_SQL, SCHEMA_VERSION, setHandDescription, upsertMachine, validateHandDescription, type Db, type ModelRunner, type ServiceFact } from "../src/index.ts";

const AT = "2026-10-07T17:00:00.000Z";
const service = (name = "DemoService", overrides: Partial<ServiceFact> = {}): ServiceFact => ({
  kind: "windows-service", name, displayName: "Demo background service", domain: "system", program: "C:/Tools/Demo/bin/demo.exe",
  state: "running", startMode: "auto", enabled: true, pid: 10, runAs: "PRIVATE_USER", triggers: null, lastRun: null, lastResult: null, ...overrides,
});

function seed(t: TestContext): Db {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "private-machine", name: "PRIVATE_HOST", os: "windows", kind: "host", address: "10.77.88.99" });
  upsertMachine(db, { id: "mac", name: "Mac", os: "macos", kind: "host" });
  recordServices(db, "private-machine", { origin: "services", status: "ok", facts: [service()] }, AT);
  return db;
}

function stored(db: Db, subject: string, source: "project" | "public", text: string): void {
  db.prepare("INSERT INTO descriptions (subject, source, text, generated, confidence, evidence_json, model_label, at) VALUES (?, ?, ?, 1, 0.8, ?, 'internal-label', ?)").run(subject, source, text, JSON.stringify(["verified quote"]), AT);
}

function install(db: Db, machineId: string, location: string, description: string | undefined, key = `${machineId}:${location}`): void {
  recordScan(db, machineId, { sourceKind: "test", location: key, status: "ok", installs: [{ ecosystem: "test", key, name: "DemoService", kind: "app", version: "1", location, description }] }, AT);
}

test("the resolver follows hand, project, install, public and os order", (t) => {
  const db = seed(t);
  const row = listServices(db)[0]!;
  const subject = "service:windows-service:DemoService";
  assert.equal(describeRow(db, row)?.source, "os");
  stored(db, subject, "public", "The service publishes data for other programs.");
  assert.equal(describeRow(db, row)?.source, "public");
  install(db, row.machineId, "C:/Tools/Demo", "The service supplies a background data service.");
  assert.equal(describeRow(db, row)?.source, "install");
  stored(db, subject, "project", "The service runs the local project's background work.");
  assert.deepEqual(describeRow(db, row)?.evidence, ["verified quote"]);
  setHandDescription(db, subject, "The service keeps the shared cache up to date.");
  assert.deepEqual(describeRow(db, row), {
    text: "The service keeps the shared cache up to date.", source: "hand", generated: false, confidence: null,
    at: describeRow(db, row)!.at, subject, hasHandEdit: true, evidence: [],
  });
  setHandDescription(db, subject, null);
  assert.equal(describeRow(db, row)?.source, "project");
  db.prepare("DELETE FROM descriptions WHERE source = 'project'").run();
  assert.equal(describeRow(db, row)?.source, "install");
  db.prepare("UPDATE installs SET removed_at = ?").run(AT);
  assert.equal(describeRow(db, row)?.source, "public");
  db.prepare("DELETE FROM descriptions WHERE source = 'public'").run();
  assert.equal(describeRow(db, { ...row, displayName: row.name }), null);
  assert.equal(describeRow(db, { ...row, displayName: "   " }), null);
  assert.equal(SCHEMA_VERSION, 3);
  db.exec(SCHEMA_SQL);
  assert.equal((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value, "3");
});

test("the prefix join uses the machine, longest location, slash normalization and path boundaries", (t) => {
  const db = seed(t);
  const row = listServices(db)[0]!;
  install(db, row.machineId, "C:/Tools", "The service describes the parent installation.");
  install(db, row.machineId, "c:/tools/demo", "The service describes the closest installation.");
  install(db, "mac", "C:/Tools/Demo/bin", "The service describes an installation on another machine.");
  assert.equal(describeRow(db, { ...row, program: "C:\\TOOLS\\Demo\\bin\\demo.exe" })?.text, "The service describes the closest installation.");
  assert.equal(describeRow(db, { ...row, program: "C:/Tools/Demolition/bin/demo.exe" })?.text, "The service describes the parent installation.");
  install(db, row.machineId, "C:/Tools/Demo/bin", undefined);
  assert.equal(describeRow(db, row)?.source, "os");
  install(db, "mac", "/opt/Demo", "The service describes a case-sensitive installation.");
  assert.equal(describeRow(db, { machineId: "mac", kind: "launchd", name: "demo", program: "/opt/demo/run" }), null);
  assert.equal(describeRow(db, { machineId: "mac", kind: "launchd", name: "demo", program: "/opt/Demo/run" })?.source, "install");
});

test("generated package text belongs to public while source, sibling and manual text belong to install", (t) => {
  const db = seed(t);
  const row = listServices(db)[0]!;
  install(db, row.machineId, "C:/Tools/Demo", "The service describes the installed background program.");
  for (const source of ["source", "sibling", "manual", "generated"]) {
    db.prepare("UPDATE packages SET description_source = ?, description_confidence = 0.7, description_at = ?").run(source, AT);
    const description = describeRow(db, row)!;
    assert.equal(description.source, source === "generated" ? "public" : "install");
    assert.equal(description.generated, source === "generated");
  }
  assert.equal(publicDescriptionTodo(db).length, 0);
});

test("listener subjects join present services by machine and pid or normalized path", (t) => {
  const db = seed(t);
  recordListeners(db, "private-machine", { origin: "listeners", status: "ok", facts: [
    { port: 8181, protocol: "tcp", address: "127.0.0.1", bind: "loopback", pid: 10, processName: "demo", processPath: "C:/Tools/Demo/bin/demo.exe", container: null },
    { port: 8182, protocol: "tcp", address: "127.0.0.1", bind: "loopback", pid: 11, processName: "other", processPath: "C:/Tools/Other.exe", container: null },
  ] }, AT);
  const resolver = loadDescriptionResolver(db);
  const rows = listListeners(db, {}, resolver);
  assert.equal(resolver.subject(rows[0]!), "service:windows-service:DemoService");
  assert.equal(resolver.subject(rows[1]!), "process:private-machine:c:/tools/other.exe");
  assert.equal(resolver.subject({ machineId: "mac", pid: 10, processName: "Demo" }), "process:mac:demo");
  setHandDescription(db, resolver.subject(rows[0]!), "The service keeps the shared cache up to date.");
  assert.equal(listServices(db)[0]!.description?.source, "hand");
  assert.equal(listListeners(db)[0]!.description?.source, "hand");
  recordServices(db, "private-machine", { origin: "services", status: "ok", facts: [service("DemoService", { pid: null })] }, AT);
  assert.equal(loadDescriptionResolver(db).subject({ ...rows[0]!, pid: 99, processPath: "c:\\tools\\demo\\bin\\DEMO.exe" }), "service:windows-service:DemoService");
  recordServices(db, "private-machine", { origin: "services", status: "ok", facts: [] }, AT);
  assert.equal(loadDescriptionResolver(db).subject(rows[0]!), "process:private-machine:c:/tools/demo/bin/demo.exe");
});

test("project roots resolve for an unjoined listener on a machine with no services", (t) => {
  const db = seed(t);
  stored(db, "project:mac:/work/demo", "project", "The service runs the project's background server.");
  const description = describeRow(db, { machineId: "mac", processName: "node", processPath: "/work/demo/server.js" });
  assert.equal(description?.source, "project");
  assert.equal(description?.subject, "process:mac:/work/demo/server.js");
  assert.deepEqual(description?.evidence, ["verified quote"]);
});

test("hand text validation accepts boundaries and deletion and rejects controls", (t) => {
  const db = seed(t);
  const subject = "service:windows-service:DemoService";
  for (const text of ["12345678", "x".repeat(400), "caf\u00e9 service", null, ""]) assert.equal(validateHandDescription(text), null);
  for (const text of [undefined, 12, "short", "x".repeat(401), "line one\nline two", "line one\rline two", "text\twith tab", "text\u007fcontrol", "text\u0085control", "text\u2028break"]) assert.ok(validateHandDescription(text));
  assert.throws(() => setHandDescription(db, subject, "short"), /length/);
  setHandDescription(db, subject, "12345678");
  setHandDescription(db, subject, "");
  assert.equal(listServices(db)[0]!.description?.source, "os");
});

test("scans, inheritance, enrichment and the public pass preserve hand rows", async (t) => {
  const db = seed(t);
  const subject = "service:windows-service:DemoService";
  stored(db, subject, "public", "The service supplies the default background service.");
  setHandDescription(db, subject, "The service keeps my shared cache up to date.");
  const before = db.prepare("SELECT * FROM descriptions WHERE source = 'hand'").get();
  install(db, "private-machine", "C:/Tools/Demo", undefined);
  applyEnrichment(db, [{ name: "DemoService", description: "The service publishes a background data cache.", category: null, confidence: 0.8 }], AT);
  inheritDescriptions(db, AT);
  recordServices(db, "private-machine", { origin: "services", status: "ok", facts: [service("DemoService", { state: "stopped" }), service("OtherService", { program: "C:/Other/run.exe", pid: 20 })] }, AT);
  const result = await runPublicDescriptions(db, async () => JSON.stringify([{ id: 0, description: "The service supplies a different background service.", confidence: 0.9 }]));
  assert.equal(result.applied, 1);
  assert.deepEqual(db.prepare("SELECT * FROM descriptions WHERE source = 'hand'").get(), before);
  assert.equal(listServices(db).find((row) => row.name === "DemoService")!.description?.text, "The service keeps my shared cache up to date.");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM descriptions WHERE subject = ?").get(subject) as { n: number }).n, 2);
});

test("a hand edit made during a public request wins and prevents applying that answer", async (t) => {
  const db = seed(t);
  const result = await runPublicDescriptions(db, async () => {
    setHandDescription(db, "service:windows-service:DemoService", "The service keeps my shared cache up to date.");
    return JSON.stringify([{ id: 0, description: "The service supplies the default background service.", confidence: 0.8 }]);
  });
  assert.equal(result.applied, 0);
  assert.equal(listServices(db)[0]!.description?.source, "hand");
});

test("the public prompt sends names only and keeps subjects and private row fields local", async (t) => {
  const db = seed(t);
  recordServices(db, "private-machine", { origin: "services", status: "ok", facts: [service("DemoService", { program: "C:/Users/PRIVATE_USER/PRIVATE_PATH/demo.exe", triggers: ["PRIVATE_COMMAND --flag"], runAs: "PRIVATE_USER" })] }, AT);
  recordListeners(db, "private-machine", { origin: "listeners", status: "ok", facts: [{ port: 54321, protocol: "tcp", address: "10.77.88.99", bind: "lan", pid: 20, processName: null, processPath: "C:/Users/PRIVATE_USER/PRIVATE_PATH/other.exe", container: null }] }, AT);
  const progress: string[] = [];
  const result = await runPublicDescriptions(db, async (request) => {
    assert.equal(request.dataClass, "public");
    assert.equal(request.failOnCap, true);
    for (const privateValue of ["PRIVATE_PATH", "PRIVATE_USER", "PRIVATE_COMMAND", "PRIVATE_HOST", "private-machine", "10.77.88.99", "54321", "C:/Users", "service:", "process:"]) assert.equal(request.prompt.includes(privateValue), false, privateValue);
    const names = JSON.parse(request.prompt.split("\n").at(-1)!) as Record<string, unknown>[];
    assert.deepEqual(Object.keys(names[0]!), ["id", "name", "displayName", "kind", "vendor", "class", "executable"]);
    assert.equal(names[1]!.name, "other.exe");
    return JSON.stringify(names.map((item) => ({ id: item.id, description: "The service publishes data for other local programs.", confidence: 0.8 })));
  }, { modelLabel: "private-model-label", onProgress: (event) => progress.push(event.state) });
  assert.equal(result.applied, 2);
  assert.deepEqual(progress, ["running", "running", "done"]);
  assert.equal(JSON.stringify(listServices(db)).includes("private-model-label"), false);
  assert.equal((db.prepare("SELECT model_label AS label FROM descriptions LIMIT 1").get() as { label: string }).label, "private-model-label");
});

test("the public pass rejects invalid, low-confidence and name-only answers", async (t) => {
  const db = seed(t);
  const values: unknown[] = [null, {}, { id: 99, description: "The service runs a background server.", confidence: 0.8 }];
  for (const value of values) {
    const result = await runPublicDescriptions(db, async () => JSON.stringify([value]));
    assert.equal(result.rejected, 1);
    assert.equal(result.applied, 0);
  }
  for (const [description, confidence] of [["DemoService.", 0.9], ["The service runs a background server.", 0.49], ["short", 0.8], ["x".repeat(201), 0.8], ["The service runs a\nbackground server.", 0.8], ["The service runs a caf\u00e9 server.", 0.8], ["The service runs a background server.", 2]] as const) {
    const result = await runPublicDescriptions(db, async () => JSON.stringify([{ id: 0, description, confidence }]));
    assert.equal(result.applied, 0);
    assert.equal(result.rejected, 1);
  }
  const valid = await runPublicDescriptions(db, async () => `prefix ${JSON.stringify([{ id: 0, description: "The service runs a background server.", confidence: 0.5 }])} suffix`);
  assert.equal(valid.applied, 1);
  assert.equal(publicDescriptionTodo(db).length, 0);
});

test("malformed and failed batches are counted while later batches continue", async (t) => {
  const db = seed(t);
  recordServices(db, "private-machine", { origin: "services", status: "ok", facts: Array.from({ length: 76 }, (_, i) => service(`Demo${String(i).padStart(3, "0")}`, { pid: i + 1 })) }, AT);
  let calls = 0;
  const sizes: number[] = [];
  const runner: ModelRunner = async (request) => {
    const names = JSON.parse(request.prompt.split("\n").at(-1)!) as { id: number }[];
    sizes.push(names.length);
    calls++;
    if (calls === 1) return "no complete JSON array";
    if (calls === 2) throw new Error("unavailable");
    if (calls === 3) return null;
    return JSON.stringify(names.map((item) => ({ id: item.id, description: "The service runs a background data server.", confidence: 0.8 })));
  };
  const result = await runPublicDescriptions(db, runner);
  assert.deepEqual(sizes, [25, 25, 25, 1]);
  assert.equal(result.state, "done");
  assert.equal(result.done, 76);
  assert.equal(result.skipped, 3);
  assert.equal(result.applied, 1);
});

test("the runner cap stops the public pass with a failed state and preserves applied counts", async (t) => {
  const db = seed(t);
  recordServices(db, "private-machine", { origin: "services", status: "ok", facts: Array.from({ length: 60 }, (_, i) => service(`Demo${i}`, { pid: i + 1 })) }, AT);
  let calls = 0;
  const result = await runPublicDescriptions(db, async () => {
    if (++calls === 2) throw new ModelCapError(1);
    return JSON.stringify([{ id: 0, description: "The service runs a background data server.", confidence: 0.8 }]);
  });
  assert.equal(result.state, "failed");
  assert.equal(result.done, 25);
  assert.equal(result.applied, 1);
  assert.equal(calls, 2);
  assert.match(result.error!, /hourly cap of 1/);
});

test("the overview counts distinct visible subjects and hidden rows still resolve descriptions", (t) => {
  const db = seed(t);
  recordServices(db, "mac", { origin: "services", status: "ok", facts: [service()] }, AT);
  recordServices(db, "private-machine", { origin: "services", status: "ok", facts: [service(), service("Appinfo", { program: "C:/Windows/System32/svchost.exe", pid: 30 })] }, AT);
  setHandDescription(db, "service:windows-service:Appinfo", "The service supports elevated application launches.");
  assert.equal(listServices(db).find((row) => row.name === "Appinfo")!.description?.source, "hand");
  const overview = descriptionsOverview(db);
  assert.equal(overview.total, 1);
  assert.equal(overview.bySource.os, 1);
  assert.equal(overview.public.todo, 1);
  assert.deepEqual(overview.project, { state: "off", todo: 0, reason: "not configured", roots: 0, lastRunAt: null });
  assert.equal(overview.public.lastRunAt, null);
});

test("route descriptions reuse the joined listener description and unjoined routes carry null", (t) => {
  const db = seed(t);
  recordListeners(db, "private-machine", { origin: "listeners", status: "ok", facts: [{ port: 8181, protocol: "tcp", address: "127.0.0.1", bind: "loopback", pid: 10, processName: "demo", processPath: "C:/Tools/Demo/bin/demo.exe", container: null }] }, AT);
  setHandDescription(db, "service:windows-service:DemoService", "The service keeps the shared cache up to date.");
  recordCloudflare(db, { zones: [{ id: "zone", name: "example.test" }], tunnels: [{ id: "tunnel", name: "demo", status: "healthy", connections: 1, remoteManaged: true }], ingress: [{ tunnelId: "tunnel", position: 0, hostname: "demo.example.test", path: null, service: "http://localhost:8181" }], dns: [{ zone: "example.test", name: "other.example.test", type: "A", content: "203.0.113.1", proxied: false }] }, AT, null);
  const routes = listRoutes(db, { tunnelHosts: { demo: "private-machine" } });
  assert.deepEqual(routes.find((row) => row.hostname === "demo.example.test")!.description, listListeners(db)[0]!.description);
  assert.equal(routes.find((row) => row.hostname === "other.example.test")!.description, null);
});

test("list resolvers load descriptions and install prefixes once regardless of row count", (t) => {
  const db = seed(t);
  recordServices(db, "private-machine", { origin: "services", status: "ok", facts: Array.from({ length: 50 }, (_, i) => service(`Demo${i}`, { pid: i + 1 })) }, AT);
  recordListeners(db, "private-machine", { origin: "listeners", status: "ok", facts: Array.from({ length: 50 }, (_, i) => ({ port: 8000 + i, protocol: "tcp" as const, address: "127.0.0.1", bind: "loopback" as const, pid: i + 1, processName: `demo${i}`, processPath: "C:/Tools/Demo/bin/demo.exe", container: null })) }, AT);
  const prepare = db.prepare.bind(db);
  let descriptionReads = 0;
  let prefixReads = 0;
  db.prepare = ((sql: string) => {
    if (sql.includes("FROM descriptions")) descriptionReads++;
    if (sql.includes("FROM installs i JOIN packages p")) prefixReads++;
    return prepare(sql);
  }) as typeof db.prepare;
  assert.equal(listServices(db, { gone: "present" }).length, 50);
  assert.equal(descriptionReads, 1);
  assert.equal(prefixReads, 1);
  assert.equal(listListeners(db).length, 50);
  assert.equal(descriptionReads, 2);
  assert.equal(prefixReads, 2);
  const resolver = loadDescriptionResolver(db);
  for (let i = 0; i < 50; i++) resolver.describe({ machineId: "private-machine", kind: "windows-service", name: `Demo${i}` });
  assert.equal(descriptionReads, 3);
  assert.equal(prefixReads, 3);
});

test("public candidates exclude stronger sources and hidden rows and deduplicate joined listeners", (t) => {
  const db = seed(t);
  const names = ["HandService", "ProjectService", "InstallService", "PublicService", "OsService", "MissingService"];
  recordServices(db, "private-machine", { origin: "services", status: "ok", facts: [
    ...names.map((name, index) => service(name, { program: `C:/Tools/${name}/run.exe`, pid: index + 1, displayName: name === "OsService" ? "OS background feature" : null })),
    service("Appinfo", { program: "C:/Windows/System32/svchost.exe", pid: 100 }),
  ] }, AT);
  setHandDescription(db, "service:windows-service:HandService", "The service keeps the shared cache current.");
  stored(db, "service:windows-service:ProjectService", "project", "The service runs the project's background work.");
  stored(db, "service:windows-service:PublicService", "public", "The service runs a public background server.");
  install(db, "private-machine", "C:/Tools/InstallService", "The service supplies an installed background server.");
  recordListeners(db, "private-machine", { origin: "listeners", status: "ok", facts: [{ port: 8181, protocol: "tcp", address: "127.0.0.1", bind: "loopback", pid: 5, processName: "demo", processPath: "C:/Tools/OsService/run.exe", container: null }] }, AT);
  assert.deepEqual(publicDescriptionTodo(db).map((item) => item.name).sort(), ["MissingService", "OsService"]);
  const overview = descriptionsOverview(db);
  assert.equal(overview.total, 6);
  assert.equal(overview.public.todo, 2);
  assert.deepEqual(overview.bySource, { hand: 1, project: 1, install: 1, public: 1, os: 1, none: 1 });
});

test("a broad install location such as the filesystem root describes nothing", (t) => {
  const db = seed(t);
  const row = listServices(db)[0]!;
  install(db, row.machineId, "/", "The package describes every file on the machine.");
  install(db, row.machineId, "C:/Program Files", "The package describes every installed program.");
  assert.equal(describeRow(db, { ...row, program: "C:/Program Files/Demo/demo.exe" })?.source, "os");
  assert.equal(describeRow(db, { ...row, program: "/usr/bin/demo" })?.source, "os");
});
