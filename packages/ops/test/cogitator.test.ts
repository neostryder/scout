import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CogitatorClient, CogitatorError, loadCogitatorConfig, lookupCogitatorKey } from "../src/cogitator.ts";
import { discoveryFixture, fakeGateway } from "./cogitator-gateway.ts";

const KEY = "fixture-client-credential";
const config = { gateway: "http://127.0.0.1:8470", role: "scout-describe" };

function folder(t: TestContext): string {
  const root = mkdtempSync(join(process.cwd(), ".cogitator-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const hasKind = (kind: string) => (error: unknown): boolean => error instanceof CogitatorError && error.kind === kind && !error.message.includes(KEY);

test("config uses the default gateway and accepts optional file, gateway and role settings", (t) => {
  const root = folder(t);
  assert.deepEqual(loadCogitatorConfig(root), { gateway: "http://127.0.0.1:8470", role: "describe" });
  writeFileSync(join(root, "cogitator.json"), JSON.stringify({ discoveryFile: "discovery.json", gateway: "http://localhost:8100", role: "custom-role" }));
  assert.deepEqual(loadCogitatorConfig(root), { discoveryFile: `${root.replace(/\\/g, "/")}/discovery.json`, gateway: "http://localhost:8100", role: "custom-role" });
  writeFileSync(join(root, "cogitator.json"), "broken JSON");
  assert.throws(() => loadCogitatorConfig(root), hasKind("off"));
  writeFileSync(join(root, "cogitator.json"), '{"role":5}');
  assert.throws(() => loadCogitatorConfig(root), hasKind("off"));
});

test("discovery by file wins over the configured gateway without a discovery request", async (t) => {
  const root = folder(t);
  const discoveryFile = join(root, "discovery.json").replace(/\\/g, "/");
  const fixture = discoveryFixture("http://localhost:8100");
  writeFileSync(discoveryFile, JSON.stringify(fixture));
  const fake = fakeGateway();
  const client = new CogitatorClient({ ...config, gateway: "https://outside.example", discoveryFile }, KEY, { fetch: fake.fetch });
  assert.deepEqual(await client.discover(), fixture);
  assert.equal(fake.calls.length, 0);
  await client.probe();
  assert.equal(fake.calls[0]!.url, "http://localhost:8100/v1/cogitator/load?model=scout-describe");
});

test("discovery by configured gateway and default gateway uses only the fake fetch", async (t) => {
  const root = folder(t);
  for (const gateway of ["http://127.0.0.1:8101", loadCogitatorConfig(root).gateway]) {
    const fake = fakeGateway();
    fake.discovery = discoveryFixture(gateway);
    const client = new CogitatorClient({ ...config, gateway }, KEY, { fetch: fake.fetch });
    await client.discover();
    assert.equal(fake.calls[0]!.url, `${gateway}/v1/cogitator/discovery`);
    assert.equal(fake.calls[0]!.init.redirect, "error");
  }
});

test("the loopback guard accepts the three hosts and refuses other hosts, schemes and URL credentials", async () => {
  for (const gateway of ["http://127.0.0.1:8101", "http://localhost:8101", "http://[::1]:8101"]) {
    const fake = fakeGateway();
    fake.discovery = discoveryFixture(gateway);
    await new CogitatorClient({ ...config, gateway }, KEY, { fetch: fake.fetch }).discover();
    assert.equal(fake.calls.length, 1);
  }
  for (const gateway of ["https://outside.example", "http://192.168.1.2:8101", "file:///discovery.json", "http://user:pass@localhost:8101", "invalid URL"]) assert.throws(() => new CogitatorClient({ ...config, gateway }, KEY), hasKind("off"));
  for (const field of ["gateway", "openai_base", "health", "busy_probe"] as const) {
    const fake = fakeGateway();
    fake.discovery[field] = "https://outside.example/path";
    await assert.rejects(new CogitatorClient(config, KEY, { fetch: fake.fetch }).discover(), hasKind("off"));
    assert.equal(fake.calls.length, 1);
  }
});

test("missing files, malformed discovery and unavailable gateways turn the source off", async (t) => {
  const root = folder(t);
  await assert.rejects(new CogitatorClient({ ...config, discoveryFile: join(root, "missing.json") }, KEY, { fetch: fakeGateway().fetch }).discover(), hasKind("off"));
  writeFileSync(join(root, "discovery.json"), "{}");
  await assert.rejects(new CogitatorClient({ ...config, discoveryFile: join(root, "discovery.json") }, KEY, { fetch: fakeGateway().fetch }).discover(), hasKind("off"));
  const fake = fakeGateway();
  fake.discovery.schema = 2 as 1;
  await assert.rejects(new CogitatorClient(config, KEY, { fetch: fake.fetch }).discover(), hasKind("off"));
  await assert.rejects(new CogitatorClient(config, KEY, { fetch: async () => { throw new Error(KEY); } }).discover(), hasKind("off"));
  assert.throws(() => new CogitatorClient(config, ""), hasKind("off"));
});

test("probe uses the role, distinguishes busy and validates its response", async () => {
  const fake = fakeGateway();
  const client = new CogitatorClient(config, KEY, { fetch: fake.fetch });
  assert.deepEqual(await client.probe(), { state: "idle", serving: "fixture-model" });
  fake.probe = () => Response.json({ state: "loadable", serving: "fixture-model" });
  assert.equal((await client.probe()).state, "loadable");
  fake.probe = () => Response.json({ state: "busy", error: KEY }, { status: 503 });
  await assert.rejects(client.probe(), hasKind("busy"));
  fake.probe = () => Response.json({ state: "unknown" });
  await assert.rejects(client.probe(), hasKind("invalid"));
  assert.ok(fake.calls.filter((call) => call.url.includes("/load?")).every((call) => call.url.endsWith("model=scout-describe")));
});

test("generation sends the strict schema and returns the answer with its internal servedBy header", async () => {
  const fake = fakeGateway();
  const client = new CogitatorClient(config, KEY, { fetch: fake.fetch });
  const schema = { type: "object", additionalProperties: false };
  const result = await client.generate("scout-describe", "System text", "Project text", schema);
  assert.equal(result.servedBy, "fixture-model");
  const sent = fake.calls.at(-1)!;
  assert.equal(sent.url, "http://127.0.0.1:8470/v1/chat/completions");
  assert.equal(new Headers(sent.init.headers).get("authorization"), `Bearer ${KEY}`);
  assert.deepEqual(JSON.parse(String(sent.init.body)), { model: "scout-describe", messages: [{ role: "system", content: "System text" }, { role: "user", content: "Project text" }], temperature: 0, max_tokens: 400, chat_template_kwargs: { enable_thinking: false }, response_format: { type: "json_schema", json_schema: { name: "scout_description", strict: true, schema } } });
  assert.equal(JSON.stringify(result).includes(KEY), false);
});

test("a deferred 503, invalid JSON, a refused connection and network errors retain only the error kind", async (t) => {
  const logs: unknown[][] = [];
  t.mock.method(console, "log", (...args: unknown[]) => { logs.push(args); });
  t.mock.method(console, "error", (...args: unknown[]) => { logs.push(args); });
  const fake = fakeGateway();
  const client = new CogitatorClient(config, KEY, { fetch: fake.fetch });
  await client.discover();
  for (const [kind, respond] of [
    ["deferred", () => Response.json({ error: `deferred ${KEY}` }, { status: 503, headers: { "Retry-After": "5" } })],
    ["invalid", () => new Response(`invalid ${KEY}`)],
    ["invalid", () => Response.json({ choices: [{ message: { content: `invalid ${KEY}` } }] })],
    ["invalid", () => Response.json({ choices: [] })],
    ["network", () => Response.json({ error: KEY }, { status: 401 })],
    ["busy", () => { throw new Error(KEY); }],
    ["deferred", () => Response.json({ error: { code: "no_capacity" } }, { status: 503 })],
  ] as const) {
    fake.chat = respond;
    await assert.rejects(client.generate("scout-describe", "System", "Text", {}), hasKind(kind));
  }
  for (const header of [false, true]) {
    fake.chat = () => Response.json({ choices: [{ message: { content: JSON.stringify({ summary: header ? "Demo tracks versions." : KEY }) } }] }, { headers: { "x-cogitator-model": header ? KEY : "fixture-model" } });
    await assert.rejects(client.generate("scout-describe", "System", "Text", {}), hasKind("invalid"));
  }
  assert.deepEqual(logs, []);
});

test("probe and request timeouts finish even when an injected fetch ignores cancellation", async () => {
  for (const stage of ["probe", "generate"] as const) {
    const fake = fakeGateway();
    const client = new CogitatorClient(config, KEY, { fetch: fake.fetch, probeTimeoutMs: 5, requestTimeoutMs: 5 });
    await client.discover();
    if (stage === "probe") fake.probe = () => new Promise<Response>(() => {});
    else fake.chat = () => new Promise<Response>(() => {});
    await assert.rejects(stage === "probe" ? client.probe() : client.generate("scout-describe", "System", "Text", {}), hasKind("network"));
    assert.equal(fake.calls.at(-1)!.init.signal!.aborted, true);
  }
});

test("the key lookup uses the environment first, then the named bws value through a fake", async () => {
  let calls = 0;
  assert.equal(await lookupCogitatorKey({ env: { SCOUT_COGITATOR_KEY: KEY }, exec: async () => { calls++; throw new Error(); } }), KEY);
  assert.equal(calls, 0);
  assert.equal(await lookupCogitatorKey({ env: {}, exec: async (file, args, options) => {
    calls++;
    assert.equal(file, "bws");
    assert.deepEqual(args, ["secret", "list"]);
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 15_000);
    return { stdout: JSON.stringify([{ key: "OTHER", value: "other" }, { key: "COGITATOR_SCOUT_KEY", value: KEY }]) };
  } }), KEY);
  assert.equal(calls, 1);
  assert.equal(await lookupCogitatorKey({ env: {}, exec: async () => { throw new Error(KEY); } }), null);
  assert.equal(await lookupCogitatorKey({ env: {}, exec: async () => ({ stdout: "[]" }) }), null);
  assert.equal(await lookupCogitatorKey({ env: {}, exec: async () => ({ stdout: JSON.stringify([{ key: "COGITATOR_SCOUT_KEY", value: "   " }]) }) }), null);
});

test("an external abort finishes a pending request without exposing its reason", async () => {
  const fake = fakeGateway();
  const client = new CogitatorClient(config, KEY, { fetch: fake.fetch });
  await client.discover();
  fake.chat = () => new Promise<Response>(() => {});
  const controller = new AbortController();
  const pending = client.generate("scout-describe", "System", "Text", {}, controller.signal);
  controller.abort(KEY);
  await assert.rejects(pending, hasKind("network"));
});

test("a 502 from the gateway is retried once and a second 502 is a network error", async () => {
  const fake = fakeGateway();
  const client = new CogitatorClient(config, KEY, { fetch: fake.fetch });
  await client.discover();
  let calls = 0;
  fake.chat = () => (++calls === 1 ? Response.json({ error: "engine died" }, { status: 502 }) : Response.json({ choices: [{ message: { content: JSON.stringify({ ok: true }) } }] }, { headers: { "x-cogitator-model": "fixture-model" } }));
  const result = await client.generate("scout-describe", "System", "Text", {});
  assert.deepEqual(result.answer, { ok: true });
  assert.equal(calls, 2);
  calls = 0;
  fake.chat = () => { calls++; return Response.json({ error: "engine died" }, { status: 502 }); };
  await assert.rejects(client.generate("scout-describe", "System", "Text", {}), hasKind("network"));
  assert.equal(calls, 2);
});
