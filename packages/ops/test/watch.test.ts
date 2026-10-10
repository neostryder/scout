import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, Socket, type Server } from "node:net";
import { defaultWatchConfig, listOutages, openCatalog, parseWatchConfig } from "@scout/core";
import { probeMachine, runMachineChecks, watchMachines, type MachineProbe, type WatchedMachine } from "../src/index.ts";

function listen(onConnection: (socket: Socket) => void): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(onConnection);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port }));
  });
}

test("a server that greets with SSH is up, one that stays silent is hung and one that answers something else is hung", async (t) => {
  const greeting = await listen((socket) => { socket.write("SSH-2.0-OpenSSH_9.9\r\n"); });
  const silent = await listen(() => { /* accepts and says nothing, like the hung machine */ });
  const web = await listen((socket) => { socket.write("HTTP/1.1 400 Bad Request\r\n\r\n"); });
  t.after(() => { greeting.server.close(); silent.server.close(); web.server.close(); });
  const up = await probeMachine("127.0.0.1", { port: greeting.port });
  assert.equal(up.state, "up");
  const hung = await probeMachine("127.0.0.1", { port: silent.port, bannerTimeoutMs: 150 });
  assert.equal(hung.state, "hung");
  assert.match(hung.detail, /sent no SSH greeting/);
  const other = await probeMachine("127.0.0.1", { port: web.port });
  assert.equal(other.state, "hung");
  assert.match(other.detail, /something other than an SSH greeting/);
});

test("a refused port is down and a connection that never completes is down", async (t) => {
  const closed = await listen(() => {});
  const port = closed.port;
  await new Promise((resolve) => closed.server.close(resolve));
  const refused = await probeMachine("127.0.0.1", { port });
  assert.equal(refused.state, "down");
  assert.match(refused.detail, /did not accept a connection/);
  const never = await probeMachine("127.0.0.1", { port: 9, connectTimeoutMs: 100, dial: () => new Socket() });
  assert.equal(never.state, "down");
  assert.match(never.detail, /No connection to port 9 within/);
});

test("machines to watch are the ssh hosts other than the hub and guests, with the host from the address or the ssh target", () => {
  const list = watchMachines([
    { id: "desk", name: "Desk", transport: { type: "local" } },
    { id: "mac", name: "Mac", address: "192.0.2.20", transport: { type: "ssh", target: "me@mac.local" } },
    { id: "box", name: "Box", transport: { type: "ssh", target: "me@box.example.test", options: ["-p", "2222"] } },
    { id: "vm", name: "VM", transport: { type: "ssh", target: "me@mac.local", guest: ["docker", "exec"] } },
    { id: "bad", name: "Bad", transport: { type: "ssh", target: "me@bad host" } },
  ]);
  assert.deepEqual(list, [{ id: "mac", name: "Mac", host: "192.0.2.20", port: 22 }, { id: "box", name: "Box", host: "box.example.test", port: 2222 }]);
});

test("machine checks open an outage after two failures, switch off per machine and a throwing probe counts as down", async (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  const machines: WatchedMachine[] = [{ id: "mac", name: "Mac", host: "x", port: 22 }, { id: "box", name: "Box", host: "y", port: 22 }];
  let clock = Date.parse("2026-10-10T00:00:00.000Z");
  let mode: MachineProbe["state"] = "hung";
  const probe = async (machine: WatchedMachine): Promise<MachineProbe> => {
    if (machine.id === "box") throw new Error("boom");
    return { state: mode, detail: mode === "up" ? "" : "no greeting", latencyMs: null };
  };
  const run = async (config = defaultWatchConfig()) => { clock += 120_000; return runMachineChecks(db, machines, config, { probe, now: () => clock }); };
  assert.deepEqual(await run(), []);
  const confirmed = await run();
  assert.deepEqual(confirmed.map((change) => [change.outage.label, change.change, change.outage.state]).sort(), [["Box", "confirmed", "down"], ["Mac", "confirmed", "hung"]]);
  const off = parseWatchConfig({ machines: { box: false } });
  const closed = await run(off);
  assert.deepEqual(closed.map((change) => [change.outage.label, change.change]), [["Box", "recovered"]]);
  mode = "up";
  const back = await run(off);
  assert.deepEqual(back.map((change) => [change.outage.label, change.change]), [["Mac", "recovered"]]);
  assert.equal(listOutages(db, { state: "open" }).length, 0);
});
