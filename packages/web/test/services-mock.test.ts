import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createMockHub } from "../dev/mock-hub.ts";

async function mock(run: (base: string) => Promise<void>) {
  const server = createMockHub();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}
const get = async (base: string, path: string) => {
  const response = await fetch(`${base}${path}`);
  assert.equal(response.status, 200);
  return response.json();
};

test("the mock serves service assets and seeded contract shapes for every machine", async () => mock(async (base) => {
  for (const asset of ["services.js", "services-model.js", "services-diagram.js", "outages.js", "outages-model.js", "services.css"]) {
    const response = await fetch(`${base}/${asset}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), asset.endsWith("css") ? "text/css" : "text/javascript");
    await response.text();
  }
  const services = await get(base, "/api/services?all=1");
  const listeners = await get(base, "/api/listeners?all=1");
  assert.equal(services.total, 36);
  assert.equal(listeners.total, 30);
  assert.equal((await get(base, "/api/services?all=1&gone=gone")).total, 4);
  assert.equal((await get(base, "/api/listeners?all=1&gone=gone")).total, 2);
  assert.deepEqual(new Set(services.rows.map((row: any) => row.kind)), new Set(["windows-service", "scheduled-task", "launchd"]));
  assert.deepEqual(new Set(services.rows.map((row: any) => row.state)), new Set(["running", "stopped", "disabled", "other"]));
  assert.deepEqual(new Set(services.rows.map((row: any) => row.classification.class)), new Set(["essential", "optional", "third-party"]));
  assert.deepEqual(new Set(services.rows.map((row: any) => row.exposure)), new Set(["none", "loopback", "lan", "all"]));
  for (const row of services.rows) {
    for (const key of ["id", "machineId", "machineName", "kind", "domain", "name", "displayName", "program", "state", "startMode", "enabled", "pid", "runAs", "triggers", "lastRun", "lastResult", "firstSeenAt", "lastSeenAt", "goneAt", "ports", "exposure", "classification"]) assert.ok(Object.hasOwn(row, key), key);
    assert.ok(Array.isArray(row.classification.evidence));
    assert.ok(["curated", "rule", "default"].includes(row.classification.confidence));
    assert.equal(Number.isNaN(Date.parse(row.firstSeenAt)), false);
    assert.equal(Object.hasOwn(row, "commandLine"), false);
  }
  for (const row of listeners.rows) for (const key of ["id", "machineId", "machineName", "port", "protocol", "address", "bind", "pid", "processName", "processPath", "containerName", "containerImage", "firstSeenAt", "lastSeenAt", "goneAt", "classification", "serviceName", "serviceKind"]) assert.ok(Object.hasOwn(row, key), key);
  assert.ok(listeners.rows.some((row: any) => row.containerName && row.serviceName === null));
}));

test("the alerts mock serves contract kinds, counts, filters and mutations", async () => mock(async (base) => {
  const listing = await get(base, "/api/services/alerts?state=all&limit=100&include=muted");
  assert.deepEqual(new Set(listing.alerts.map((alert: any) => alert.kind)), new Set(["new-listener", "new-daemon", "service-down", "domain-origin-down", "exposure-change", "unhealthy", "cert-expiring", "crash-loop", "port-clash"]));
  assert.deepEqual(listing.alerts.filter((alert: any) => alert.kind === "port-clash").map((alert: any) => alert.severity).sort(), ["high", "high", "warn"]);
  assert.deepEqual(new Set(listing.alerts.map((alert: any) => alert.severity)), new Set(["info", "warn", "high"]));
  assert.ok(listing.alerts.some((alert: any) => alert.state === "acknowledged"));
  assert.ok(listing.alerts.some((alert: any) => alert.state === "resolved"));
  assert.deepEqual(listing.alerts.filter((alert: any) => ["unhealthy", "cert-expiring", "crash-loop"].includes(alert.kind)).map((alert: any) => alert.title).sort(), ["Certificate expiring on Hub", "Crash loop on Laptop", "Unhealthy target on Hub"]);
  assert.deepEqual(Object.keys(await get(base, "/api/services/alerts/summary")).sort(), ["high", "latestAt", "open"]);
  assert.equal((await get(base, "/api/services/alerts?state=open&kind=new-listener")).alerts.every((alert: any) => alert.state === "open" && alert.kind === "new-listener"), true);
  const ack = await fetch(`${base}/api/services/alerts/ack`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ all: true, kind: "new-daemon" }) });
  assert.deepEqual(await ack.json(), { acknowledged: 1 });
  const badAck = await fetch(`${base}/api/services/alerts/ack`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ all: true, kind: "bogus" }) });
  assert.equal(badAck.status, 400);
  assert.equal((await fetch(`${base}/api/services/alerts/ack`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: 1, all: true }) })).status, 400);
  const beforeMute = await get(base, "/api/services/alerts/summary");
  const mute = await fetch(`${base}/api/services/alerts/mute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "new-listener:hub:*", reason: "dev ports" }) });
  assert.equal((await mute.json()).mutes.some((item: any) => item.source === "page"), true);
  assert.equal((await get(base, "/api/services/alerts/summary")).open, beforeMute.open - 1);
  const remove = await fetch(`${base}/api/services/alerts/mute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "new-listener:hub:*", remove: true }) });
  assert.equal(remove.status, 200);
  assert.equal((await get(base, "/api/services/alerts/summary")).open, beforeMute.open);
  const badMute = await fetch(`${base}/api/services/alerts/mute`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "", remove: true }) });
  assert.equal(badMute.status, 400);
}));

test("ports and stacks mock endpoints cover registry states, stack states and start plans", async () => mock(async (base) => {
  const ports = await get(base, "/api/services/ports");
  assert.match(ports.file.error, /invalid reserved entry/);
  assert.deepEqual(new Set(ports.reserved.map((row: any) => row.state)), new Set(["listening", "free", "clash"]));
  assert.deepEqual(new Set(ports.clashes.map((row: any) => row.kind)), new Set(["reserved-taken", "recipe-port-taken", "recipe-port-shared"]));
  assert.equal(ports.ranges.find((range: any) => range.name === "full").next, null);
  assert.deepEqual(await get(base, "/api/services/ports/next?range=dev"), { range: "dev", port: 4873 });
  assert.equal((await fetch(`${base}/api/services/ports/next?range=full`)).status, 409);
  assert.equal((await fetch(`${base}/api/services/ports/next?range=unknown`)).status, 404);
  const stacks = await get(base, "/api/services/stacks");
  assert.deepEqual(new Set(stacks.stacks.map((stack: any) => stack.state)), new Set(["ready", "partial", "running", "blocked"]));
  const ready = await fetch(`${base}/api/services/actions/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "stack", name: "app-dev", action: "start" }) });
  const plan = (await ready.json()).plan;
  assert.equal(plan.allowed, true); assert.equal(plan.steps.length, 2);
  const partialResponse = await fetch(`${base}/api/services/actions/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "stack", name: "app-partial", action: "start" }) });
  assert.equal((await partialResponse.json()).plan.steps[0].skipped, true);
  const refused = await fetch(`${base}/api/services/actions/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "stack", name: "app-blocked", action: "start" }) });
  assert.match((await refused.json()).plan.refusal, /needs approval/);
  const running = await fetch(`${base}/api/services/actions/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "stack", name: "app-running", action: "start" }) });
  assert.equal((await running.json()).plan.refusal, "Everything in this stack is already running.");
  const unknown = await fetch(`${base}/api/services/actions/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "stack", name: "missing", action: "start" }) });
  assert.equal((await unknown.json()).plan.refusalKind, "unknown");
  const unsupported = await fetch(`${base}/api/services/actions/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "stack", name: "app-dev", action: "stop" }) });
  assert.equal((await unsupported.json()).plan.refusalKind, "unsupported");
}));

test("stack failures stop at member two and changed plans return 409", async () => {
  const server = createMockHub({ runScenario: "failed" });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const planResponse = await fetch(`${base}/api/services/actions/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "stack", name: "app-dev", action: "start" }) });
    const plan = (await planResponse.json()).plan;
    await fetch(`${base}/api/services/actions/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ planId: plan.id, token: plan.token, confirm: true }) });
    await new Promise((resolve) => setTimeout(resolve, 750));
    const rows = (await get(base, "/api/services/actions?limit=10")).items;
    assert.ok(rows.some((item: any) => item.target === "stack" && item.state === "failed" && item.message.includes("Started 1 of 2; stopped at neo-angband dev")));
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  const changed = createMockHub({ runStatus: 409 });
  await new Promise<void>((resolve) => changed.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(changed.address() as AddressInfo).port}`;
    const planResponse = await fetch(`${base}/api/services/actions/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "stack", name: "app-dev", action: "start" }) });
    const plan = (await planResponse.json()).plan;
    const response = await fetch(`${base}/api/services/actions/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ planId: plan.id, token: plan.token, confirm: true }) });
    assert.equal(response.status, 409);
  } finally { await new Promise<void>((resolve, reject) => changed.close((error) => error ? reject(error) : resolve())); }
});

test("ports and stacks missing flags return not found", async () => {
  const server = createMockHub({ portsMissing: true, stacksMissing: true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    assert.equal((await fetch(`${base}/api/services/ports`)).status, 404);
    assert.equal((await fetch(`${base}/api/services/stacks`)).status, 404);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("ports and stacks empty flags exercise the no-file responses", async () => {
  const server = createMockHub({ portsEmpty: true, stacksEmpty: true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    assert.equal((await get(base, "/api/services/ports")).file.exists, false);
    assert.equal((await get(base, "/api/services/stacks")).file.exists, false);
    assert.deepEqual((await get(base, "/api/services/stacks")).stacks, []);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("stack run emits member actions and a final stack action", async () => mock(async (base) => {
  const response = await fetch(`${base}/api/services/actions/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "stack", name: "app-dev", action: "start" }) });
  const plan = (await response.json()).plan;
  const run = await fetch(`${base}/api/services/actions/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ planId: plan.id, token: plan.token, confirm: true }) });
  assert.equal(run.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const actions = (await get(base, "/api/services/actions?limit=10")).items;
  assert.ok(actions.some((item: any) => item.target === "stack" && item.message === "Started 2 of 2 members"));
  assert.ok(actions.some((item: any) => item.target === "service"));
  assert.ok(actions.some((item: any) => item.target === "recipe"));
}));

test("the health mock serves contract states, history, TLS, and refresh progress", async () => {
  const server = createMockHub();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(`${base}/api/services/health`);
    assert.equal(response.status, 200);
    const health = await response.json() as any;
    assert.deepEqual(new Set(health.targets.map((target: any) => target.state)), new Set(["up", "slow", "failing", "down", "not-http", "unknown"]));
    assert.ok(health.targets.every((target: any) => target.state === "unknown" ? target.history.length === 0 : target.history.length === 60));
    assert.ok(health.targets.some((target: any) => target.tlsDaysLeft === 9));
    assert.ok(health.targets.some((target: any) => target.history.some((sample: any) => !sample.ok)));
    for (const route of ["/api/listeners?all=1", "/api/services/routes"]) {
      const payload = await get(base, route);
      assert.ok(payload.rows.some((row: any) => row.health?.state === "up"));
    }
    const live = await fetch(`${base}/api/services/live`);
    assert.equal(live.status, 200);
    const reader = live.body!.getReader();
    const refresh = await fetch(`${base}/api/services/health/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(refresh.status, 202);
    assert.deepEqual(await refresh.json(), { state: "running" });
    let events = "";
    while (!events.includes('"running":false,"done":20')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      events += new TextDecoder().decode(chunk.value);
    }
    assert.match(events, /event: health-run/);
    assert.match(events, /event: health/);
    assert.match(events, /"change":"state"/);
    assert.match(events, /"done":3,"total":20/);
    await reader.cancel();
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("health mock flags cover old hubs, disabled checks, and refresh refusal", async () => {
  for (const [options, getStatus, postStatus] of [[{ healthMissing: true }, 404, 404], [{ noHealth: true }, 200, 404], [{ healthRefreshStatus: 409 }, 200, 409]] as const) {
    const server = createMockHub(options);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      assert.equal((await fetch(`${base}/api/services/health`)).status, getStatus);
      if (options.healthMissing) assert.ok((await get(base, "/api/listeners?all=1")).rows.every((row: any) => !Object.hasOwn(row, "health")));
      const response = await fetch(`${base}/api/services/health/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      assert.equal(response.status, postStatus);
      if (options.noHealth) assert.equal((await get(base, "/api/services/health")).probe.intervalSeconds, 0);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  }
});

test("the alerts mock can simulate an older hub without alert endpoints", async () => {
  const server = createMockHub({ alertsMissing: true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    assert.equal((await fetch(`${base}/api/services/alerts/summary`)).status, 404);
    assert.equal((await fetch(`${base}/api/services/alerts`)).status, 404);
  } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
});

test("the alerts mock selects zero, one and high badge states", async () => {
  for (const [alertScenario, expected] of [["zero", { open: 0, high: 0 }], ["one", { open: 1, high: 0 }], ["high", { open: 1, high: 1 }]] as const) {
    const server = createMockHub({ alertScenario });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const summary = await get(base, "/api/services/alerts/summary");
      assert.deepEqual({ open: summary.open, high: summary.high }, expected);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  }
});

test("the mock serves control plans, run events, audit rows, protected groups and uninstall instructions", async () => mock(async (base) => {
  const services = await get(base, "/api/services?all=1&limit=500");
  const listeners = await get(base, "/api/listeners?all=1&limit=500");
  assert.ok(services.rows.every((row: any) => row.control.actions.map((item: any) => item.action).join() === "start,stop,restart,disable,enable"));
  assert.ok(listeners.rows.some((row: any) => row.control.mechanism === "process"));
  assert.deepEqual(new Set([...services.rows, ...listeners.rows].map((row: any) => row.control.mechanism)), new Set(["windows-service", "scheduled-task", "launchd", "process"]));
  assert.deepEqual(new Set([...services.rows, ...listeners.rows].filter((row: any) => row.control.protected.protected).map((row: any) => row.control.protected.group)), new Set(["essential", "scout", "cloudflared", "ssh", "cogitator", "remote-access", "dns-network", "containers", "custom"]));
  assert.deepEqual(new Set((await get(base, "/api/services/protected")).groups.map((group: any) => group.id)), new Set(["essential", "scout", "cloudflared", "ssh", "cogitator", "remote-access", "dns-network", "containers", "custom"]));
  const refusal = await fetch(`${base}/api/services/actions/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "service", id: 1, action: "stop" }) });
  assert.equal((await refusal.json()).plan.allowed, false);
  const planResponse = await fetch(`${base}/api/services/actions/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "service", id: 10, action: "start" }) });
  const plan = (await planResponse.json()).plan;
  assert.equal(plan.admin, "uac");
  const sudoResponse = await fetch(`${base}/api/services/actions/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "service", id: 11, action: "stop" }) });
  assert.equal((await sudoResponse.json()).plan.admin, "sudo");
  const plainResponse = await fetch(`${base}/api/services/actions/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "listener", id: 7, action: "stop" }) });
  assert.equal((await plainResponse.json()).plan.admin, "none");
  const run = await fetch(`${base}/api/services/actions/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ planId: plan.id, token: plan.token, confirm: true }) });
  assert.equal(run.status, 202);
  assert.ok((await get(base, "/api/services/uninstall?target=service&id=10")).note.includes("Scout never runs"));
  assert.equal((await get(base, "/api/services/actions")).items[0].state, "running");
}));

test("the control-off flag disables every action and the run error flag selects contract errors", async () => {
  for (const [options, status] of [[{ controlOff: true }, 200], [{ runStatus: 404 as const }, 404], [{ runStatus: 409 as const }, 409]] as const) {
    const server = createMockHub(options);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const rows = await get(base, "/api/services?all=1&limit=500");
      if (options.controlOff) assert.ok(rows.rows.every((row: any) => row.control.actions.every((item: any) => !item.available)));
      else {
        const response = await fetch(`${base}/api/services/actions/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ planId: "p_service_start_10", token: "token", confirm: true }) });
        assert.equal(response.status, status);
      }
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  }
});

test("action mock scenarios stream the result and sudo waiting sequence", async () => {
  for (const scenario of ["done", "failed", "graceful-not-stopped", "declined"] as const) {
    const server = createMockHub({ runScenario: scenario });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const abort = new AbortController();
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const stream = await fetch(`${base}/api/services/live`, { signal: abort.signal });
      const reader = stream.body!.getReader(); const decoder = new TextDecoder(); let buffer = ""; const states: string[] = [];
      const planned = await fetch(`${base}/api/services/actions/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "service", id: 9, action: "stop" }) });
      const plan = (await planned.json()).plan;
      const run = await fetch(`${base}/api/services/actions/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ planId: plan.id, token: plan.token, confirm: true }) });
      assert.equal(run.status, 202, scenario);
      const expected = scenario === "done" ? "done" : scenario === "failed" || scenario === "graceful-not-stopped" ? "failed" : "declined";
      while (!states.includes(expected)) {
        const { value } = await reader.read(); buffer += decoder.decode(value, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const packet = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          if (packet.startsWith("event: action")) states.push(JSON.parse(packet.match(/^data: (.+)$/m)![1]!).state);
        }
      }
      assert.equal(states.at(-1), expected, scenario);
      assert.ok(states.includes("running"), scenario);
    } finally { abort.abort(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  }
  const server = createMockHub();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const abort = new AbortController();
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const stream = await fetch(`${base}/api/services/live`, { signal: abort.signal });
    const reader = stream.body!.getReader(); const decoder = new TextDecoder(); let buffer = ""; const states: string[] = [];
    const planned = await fetch(`${base}/api/services/actions/plan`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "service", id: 11, action: "stop" }) });
    const plan = (await planned.json()).plan;
    assert.equal(plan.admin, "sudo");
    const run = await fetch(`${base}/api/services/actions/run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ planId: plan.id, token: plan.token, confirm: true }) });
    assert.equal(run.status, 200);
    while (!states.includes("confirmed")) {
      const { value } = await reader.read(); buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const packet = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (packet.startsWith("event: action")) states.push(JSON.parse(packet.match(/^data: (.+)$/m)![1]!).state);
      }
    }
    assert.deepEqual(states, ["waiting", "confirmed"]);
  } finally { abort.abort(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});

test("description APIs filter and facet rows, validate hand edits, and revert to their source", async () => mock(async (base) => {
  const all = await get(base, "/api/services?all=1&limit=500");
  assert.ok(["hand", "project", "install", "public", "os", null].every((source) => all.rows.some((row: any) => (row.description?.source || null) === source)));
  assert.deepEqual(all.facets.description.map((facet: any) => facet.value).sort(), ["hand", "install", "none", "os", "project", "public"].sort());
  const row = all.rows.find((entry: any) => entry.description?.source === "project");
  const filtered = await get(base, "/api/services?desc=project&q=project&all=1");
  assert.ok(filtered.rows.some((entry: any) => entry.id === row.id));
  const edited = await fetch(`${base}/api/services/description`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "service", id: row.id, text: "A clear manual description." }) });
  assert.equal(edited.status, 200);
  assert.equal((await edited.json()).description.source, "hand");
  const invalid = await fetch(`${base}/api/services/description`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "service", id: row.id, text: "short" }) });
  assert.equal(invalid.status, 400);
  const reverted = await fetch(`${base}/api/services/description`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ target: "service", id: row.id, text: null }) });
  assert.equal((await reverted.json()).description.source, "project");
  const overview = await get(base, "/api/services/descriptions/overview");
  assert.equal(overview.total, Object.values(overview.bySource as Record<string, number>).reduce((sum, value) => sum + value, 0));
}));

test("the public pass streams progress and the no-model flag returns the off response", async () => {
  const server = createMockHub();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}`;
  const abort = new AbortController();
  try {
    const stream = await fetch(`${base}/api/services/live`, { signal: abort.signal });
    const reader = stream.body!.getReader(); const decoder = new TextDecoder(); let buffer = ""; const states: string[] = [];
    const started = await fetch(`${base}/api/services/descriptions/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "public" }) });
    assert.equal(started.status, 202);
    while (!states.includes("done")) {
      const { value } = await reader.read(); buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const packet = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (packet.startsWith("event: describe")) states.push(JSON.parse(packet.match(/^data: (.+)$/m)![1]!).state);
      }
    }
    assert.deepEqual(states, ["running", "done"]);
  } finally { abort.abort(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  const off = createMockHub({ noModels: true });
  await new Promise<void>((resolve) => off.listen(0, "127.0.0.1", resolve));
  try {
    const port = (off.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/api/services/descriptions/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "public" }) });
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "descriptions model is off");
  } finally { await new Promise<void>((resolve) => off.close(() => resolve())); }
});

test("the mock route endpoints follow the Cloudflare routes contract and apply filters and paging", async () => mock(async (base) => {
  const overview = await get(base, "/api/services/routes/overview");
  assert.deepEqual(Object.keys(overview.totals), ["domains", "ok", "originDown", "dnsDangling", "noOrigin", "unknown"]);
  assert.equal(overview.reader.state, "fresh");
  const result = await get(base, "/api/services/routes?limit=50&offset=0");
  assert.equal(result.total, 14);
  assert.deepEqual(result.facets.state.map((item: any) => item.value).sort(), ["dns-dangling", "no-origin", "ok", "origin-down", "unknown"].sort());
  assert.deepEqual(new Set(result.rows.map((row: any) => row.via)), new Set(["tunnel", "worker", "proxied-origin", "dns-only"]));
  for (const row of result.rows) {
    for (const key of ["hostname", "path", "zone", "via", "dns", "tunnel", "worker", "access", "origin", "machineId", "machineName", "machineConfidence", "listener", "state", "stateText"]) assert.ok(key in row, `missing ${key}`);
  }
  assert.equal((await get(base, "/api/services/routes?state=origin-down")).rows.every((row: any) => row.state === "origin-down"), true);
  assert.equal((await get(base, "/api/services/routes?q=service-1.example.test")).rows.length, 1);
  assert.equal((await get(base, "/api/services/routes?limit=2&offset=3")).rows.length, 2);
}));

test("the mock stream includes edge reader state and refresh completion", { timeout: 12000 }, async () => mock(async (base) => {
  const abort = new AbortController();
  const response = await fetch(`${base}/api/services/live`, { signal: abort.signal });
  const reader = response.body!.getReader(); const decoder = new TextDecoder(); let buffer = ""; let hello: any; const edgeEvents: any[] = [];
  const refresh = fetch(`${base}/api/services/routes/refresh`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: "{}" });
  assert.equal((await refresh).status, 202);
  try {
    while (!hello || !edgeEvents.some((edge) => edge.changed === false)) {
      const { value } = await reader.read(); buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const packet = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const name = packet.match(/^event: (.+)$/m)?.[1]; const data = packet.match(/^data: (.+)$/m)?.[1];
        if (name === "hello") hello = JSON.parse(data!);
        if (name === "edge") edgeEvents.push(JSON.parse(data!));
      }
    }
    assert.equal(hello.edge.state, "fresh");
    assert.equal(edgeEvents.at(-1).state, "fresh"); assert.equal(edgeEvents.at(-1).changed, false);
  } finally { abort.abort(); await reader.cancel().catch(() => {}); }
}));

test("every hidden row is absent from default service and listener responses", async () => mock(async (base) => {
  for (const route of ["services", "listeners"]) {
    const visible = await get(base, `/api/${route}`);
    const all = await get(base, `/api/${route}?all=1`);
    const hidden = all.rows.filter((row: any) => row.classification.hidden);
    assert.ok(hidden.length > 0);
    assert.equal(visible.hiddenCount, hidden.length);
    assert.equal(all.hiddenCount, hidden.length);
    for (const row of hidden) assert.equal(visible.rows.some((candidate: any) => candidate.id === row.id), false);
    assert.ok(visible.rows.every((row: any) => !row.classification.hidden));
    assert.equal(all.total, visible.total + hidden.length);
  }
}));

test("service filters use literal substrings, joined ports, visibility and gone state", async () => mock(async (base) => {
  for (const [query, predicate] of [
    ["machine=hub&kind=scheduled-task", (row: any) => row.machineId === "hub" && row.kind === "scheduled-task"],
    ["state=running&class=optional&official=1", (row: any) => row.state === "running" && row.classification.class === "optional" && row.classification.official],
    ["official=0&hasPort=1", (row: any) => !row.classification.official && row.ports.length > 0],
    ["q=mediaanalysisd", (row: any) => row.displayName === "mediaanalysisd"],
    ["q=4870", (row: any) => row.ports.some((port: any) => port.port === 4870)],
    ["gone=gone", (row: any) => row.goneAt !== null],
  ] as const) {
    const data = await get(base, `/api/services?${query}`);
    assert.ok(data.total > 0, query);
    assert.ok(data.rows.every(predicate), query);
  }
  assert.equal((await get(base, "/api/services?q=%25")).total, 0);
  assert.equal((await get(base, "/api/services?machine=hub&all=1")).hiddenCount, 2);
  assert.equal((await get(base, "/api/services?machine=hub&hasPort=1")).hiddenCount, 1);
  const row = (await get(base, "/api/services?q=mediaanalysisd&machine=hub")).rows[0];
  assert.equal(row.ports.length, 2);
  assert.equal(row.exposure, "lan");
}));

test("service sorts reverse every contract column and paging preserves the filtered total", async () => mock(async (base) => {
  for (const sort of ["name", "machine", "kind", "state", "class", "lastSeen", "ports"]) {
    const asc = await get(base, `/api/services?sort=${sort}&dir=asc`);
    const desc = await get(base, `/api/services?sort=${sort}&dir=desc`);
    const value = (row: any) => sort === "machine" ? row.machineName : sort === "class" ? row.classification.class : sort === "lastSeen" ? row.lastSeenAt : sort === "ports" ? Math.min(...row.ports.map((port: any) => port.port), Infinity) : row[sort];
    assert.equal(value(asc.rows[0]), value(desc.rows.at(-1)), sort);
    assert.equal(value(desc.rows[0]), value(asc.rows.at(-1)), sort);
  }
  const all = await get(base, "/api/services?sort=name");
  const page = await get(base, "/api/services?sort=name&limit=3&offset=2");
  assert.equal(page.total, all.total);
  assert.deepEqual(page.rows, all.rows.slice(2, 5));
  assert.deepEqual((await get(base, "/api/services?offset=9999")).rows, []);
}));

test("facet counts omit their own dimension and retain the other filters", async () => mock(async (base) => {
  const filtered = await get(base, "/api/services?machine=hub&class=optional&state=running");
  assert.ok(filtered.facets.machine.some((facet: any) => facet.value !== "hub"));
  assert.ok(filtered.facets.class.some((facet: any) => facet.value === "third-party"));
  for (const [dimension, ownFilter] of [["machine", "class=optional&state=running"], ["class", "machine=hub&state=running"], ["state", "machine=hub&class=optional"]]) {
    const without = await get(base, `/api/services?${ownFilter}`);
    assert.deepEqual(filtered.facets[dimension!], without.facets[dimension!]);
  }
  assert.deepEqual(Object.keys(filtered.facets), ["machine", "kind", "class", "state", "exposure", "description"]);
}));

test("listener filters, facets and paging match their joined service labels", async () => mock(async (base) => {
  const rows = await get(base, "/api/listeners?machine=hub&bind=lan&class=optional&official=1");
  assert.ok(rows.total > 0);
  assert.ok(rows.rows.every((row: any) => row.machineId === "hub" && row.bind === "lan" && row.classification.class === "optional" && row.classification.official));
  assert.ok(rows.facets.machine.some((facet: any) => facet.value !== "hub"));
  assert.deepEqual(Object.keys(rows.facets), ["machine", "bind", "class", "description"]);
  const port = await get(base, "/api/listeners?port=41641&q=tailscale&limit=1&offset=1");
  assert.equal(port.total, 4);
  assert.equal(port.rows.length, 1);
  assert.equal(port.rows[0].serviceKind, "launchd");
}));

test("overview excludes hidden and gone rows and events are newest first with machine filtering", async () => mock(async (base) => {
  const overview = await get(base, "/api/services/overview");
  assert.equal(overview.machines.length, 4);
  assert.equal(Number.isNaN(Date.parse(overview.generatedAt)), false);
  for (const machine of overview.machines) {
    const services = await get(base, `/api/services?machine=${machine.id}`);
    const listeners = await get(base, `/api/listeners?machine=${machine.id}`);
    assert.equal(machine.services.total, services.total);
    assert.equal(machine.services.running, services.rows.filter((row: any) => row.state === "running").length);
    assert.equal(machine.services.optionalRunning, services.rows.filter((row: any) => row.state === "running" && row.classification.class === "optional").length);
    assert.equal(machine.listeners.total, listeners.total);
    assert.equal(machine.listeners.total, machine.listeners.loopback + machine.listeners.lan + machine.listeners.all);
    assert.equal(machine.live.cadenceMs, machine.id === "hub" ? 3000 : 20000);
  }
  const events = (await get(base, "/api/services/events?limit=4")).events;
  assert.equal(events.length, 4);
  assert.deepEqual(events.map((event: any) => event.at), events.map((event: any) => event.at).sort().reverse());
  assert.ok((await get(base, "/api/services/events?machine=hub")).events.every((event: any) => event.machineId === "hub"));
}));

test("refresh validates origin and JSON and refuses a duplicate slow probe", async () => mock(async (base) => {
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/services/refresh`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({}, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post({}, { origin: `${base}0` })).status, 403);
  assert.equal((await post({}, { "content-type": "text/plain" })).status, 415);
  for (const body of [null, [], { machineId: "unknown" }, { slow: "yes" }, { extra: true }]) assert.equal((await post(body)).status, 400);
  const first = await post({ machineId: "hub", slow: true }, { origin: base });
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), { started: true, machines: ["hub"] });
  const repeat = await post({ machineId: "hub", slow: true });
  assert.equal(repeat.status, 200);
  assert.deepEqual(await repeat.json(), { started: false, reason: "running" });
}));

test("the live stream sends hello, probe progress, a changed row and a heartbeat", { timeout: 25000 }, async () => mock(async (base) => {
  const before = (await get(base, "/api/services?machine=hub&q=scout-hub")).rows[0];
  const abort = new AbortController();
  const response = await fetch(`${base}/api/services/live`, { signal: abort.signal });
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const reader = response.body!.getReader(); const decoder = new TextDecoder();
  const seen = new Map<string, any[]>(); let buffer = ""; let heartbeat = false;
  try {
    while (!heartbeat || !seen.has("changed") || !seen.get("probe")?.some((probe) => probe.phase === "done")) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const packet = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (packet.startsWith(":")) { heartbeat = true; continue; }
        const name = packet.match(/^event: (.+)$/m)?.[1];
        const data = packet.match(/^data: (.+)$/m)?.[1];
        if (name && data) { if (!seen.has(name)) seen.set(name, []); seen.get(name)!.push(JSON.parse(data)); }
        if (name === "changed" && seen.get("changed")!.length === 1) {
          const after = (await get(base, "/api/services?machine=hub&q=scout-hub")).rows[0];
          assert.notEqual(after.state, before.state);
          assert.notDeepEqual(after.ports, before.ports);
        }
      }
    }
    assert.equal(seen.get("hello")![0].machines.length, 4);
    assert.ok(seen.get("hello")![0].alerts.open > 0);
    assert.deepEqual(new Set(seen.get("alert")!.map((event) => event.change)), new Set(["created", "acknowledged", "resolved"]));
    assert.equal(seen.get("probe")![0].phase, "start");
    assert.ok(seen.get("probe")!.some((probe) => probe.phase === "start" && probe.elapsedMs >= 2000));
    assert.deepEqual(seen.get("changed")![0].tables, ["services", "listeners"]);
    assert.equal(seen.get("probe")!.at(-1).phase, "done");
  } finally { abort.abort(); await reader.cancel().catch(() => {}); }
}));

test("the outages mock lists outages, edits the watch config and reports a test notice", async () => mock(async (base) => {
  const listing = await get(base, "/api/services/outages");
  assert.equal(listing.open, 1);
  assert.deepEqual(listing.outages.map((outage: any) => outage.state), ["not-running", "hung", "monitor-gap"]);
  const post = async (path: string, body: unknown) => (await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  assert.equal((await post("/api/services/outages/watch", { check: "service", watched: false })).config.checks.service, false);
  assert.deepEqual((await post("/api/services/outages/test", {})).results.map((row: any) => row.channel), ["discord", "desktop"]);
  await post("/api/services/outages/watch", { check: "service", watched: true });
}));
