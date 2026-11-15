import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { openCatalog, pruneShortLived, upsertMachine, type Db } from "../src/index.ts";

const NOW = "2026-11-14T12:00:00.000Z";
const ago = (hours: number): string => new Date(Date.parse(NOW) - hours * 3_600_000).toISOString();

function seed(t: TestContext): Db {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "pc", name: "PC", os: "windows", kind: "host" });
  return db;
}

function listener(db: Db, port: number, name: string, firstSeen: string, gone: string | null, container: string | null = null): number {
  return Number(db.prepare("INSERT INTO listeners (machine_id, port, protocol, address, bind, process_name, container_name, first_seen_at, last_seen_at, gone_at) VALUES ('pc', ?, 'tcp', '127.0.0.1', 'loopback', ?, ?, ?, ?, ?)").run(port, name, container, firstSeen, gone ?? NOW, gone).lastInsertRowid);
}

function service(db: Db, name: string, firstSeen: string, gone: string | null): number {
  return Number(db.prepare("INSERT INTO services (machine_id, kind, domain, name, state, first_seen_at, last_seen_at, gone_at) VALUES ('pc', 'launchd', 'system', ?, 'stopped', ?, ?, ?)").run(name, firstSeen, gone ?? NOW, gone).lastInsertRowid);
}

const ports = (db: Db): number[] => (db.prepare("SELECT port FROM listeners ORDER BY port").all() as { port: number }[]).map((row) => row.port);
const names = (db: Db): string[] => (db.prepare("SELECT name FROM services ORDER BY name").all() as { name: string }[]).map((row) => row.name);

test("pruning removes ephemeral and short-lived rows that have been gone two hours and keeps everything else", (t) => {
  const db = seed(t);
  listener(db, 50001, "claude", ago(300), ago(3));
  listener(db, 50002, "claude", ago(300), ago(1));
  listener(db, 50003, "brave", ago(300), null);
  listener(db, 50004, "docker-proxy", ago(300), ago(3), "web");
  listener(db, 8080, "web", ago(10), ago(5));
  listener(db, 8081, "web", ago(300), ago(5));
  listener(db, 8082, "tmp", ago(5.5), ago(5));
  listener(db, 8083, "tmp", ago(1.5), ago(1));
  service(db, "com.openssh.sshd.AAA", ago(5.5), ago(5));
  service(db, "com.openssh.sshd.BBB", ago(3.5), ago(3));
  service(db, "com.openssh.sshd.CCC", ago(1.5), ago(1));
  service(db, "real.daemon", ago(200), ago(10));
  service(db, "running.daemon", ago(200), null);
  assert.deepEqual(pruneShortLived(db, NOW), { listeners: 2, services: 2 });
  // Removed: 50001 (ephemeral, gone 3 h) and 8082 (lasted 30 minutes, gone 5 h). Kept: gone under two hours, present, in a container, or long-lived below the ephemeral range.
  assert.deepEqual(ports(db), [8080, 8081, 8083, 50002, 50003, 50004]);
  assert.deepEqual(names(db), ["com.openssh.sshd.CCC", "real.daemon", "running.daemon"]);
});

test("pruning keeps a row that an unresolved alert targets or that the outage watch tracks", (t) => {
  const db = seed(t);
  const alerted = listener(db, 50010, "claude", ago(300), ago(3));
  const resolved = listener(db, 50011, "claude", ago(300), ago(3));
  listener(db, 50012, "node", ago(300), ago(3));
  const insert = db.prepare("INSERT INTO alerts (at, kind, severity, key, title, detail, target_type, target_id, state) VALUES (?, 'new-listener', 'info', ?, 't', 'd', 'listener', ?, ?)");
  insert.run(NOW, "k1", alerted, "open");
  insert.run(NOW, "k2", resolved, "resolved");
  db.prepare("INSERT INTO watch_state (key, kind, label) VALUES ('listener:pc:50012:node', 'service', 'node')").run();
  const unalerted = service(db, "svc.one", ago(3.5), ago(3));
  service(db, "svc.two", ago(3.5), ago(3));
  db.prepare("INSERT INTO alerts (at, kind, severity, key, title, detail, target_type, target_id, state) VALUES (?, 'service-down', 'warn', 'k3', 't', 'd', 'service', ?, 'acknowledged')").run(NOW, unalerted);
  db.prepare("INSERT INTO watch_state (key, kind, label) VALUES ('service:pc:launchd:system:svc.two', 'service', 'two')").run();
  assert.deepEqual(pruneShortLived(db, NOW), { listeners: 1, services: 0 });
  assert.deepEqual(ports(db), [50010, 50012]);
  assert.deepEqual(names(db), ["svc.one", "svc.two"]);
});

test("pruning keeps a row that is marked expected down", (t) => {
  const db = seed(t);
  const marked = listener(db, 50020, "foundry", ago(300), ago(3));
  listener(db, 50021, "foundry", ago(300), ago(3));
  db.prepare("UPDATE listeners SET expected_down = 1 WHERE id = ?").run(marked);
  assert.deepEqual(pruneShortLived(db, NOW), { listeners: 1, services: 0 });
  assert.deepEqual(ports(db), [50020]);
});

test("pruning an empty catalog changes nothing", (t) => {
  assert.deepEqual(pruneShortLived(seed(t), NOW), { listeners: 0, services: 0 });
});
