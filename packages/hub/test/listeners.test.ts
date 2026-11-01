import { test } from "node:test";
import assert from "node:assert/strict";
import { openCatalog } from "@scout/core";
import { FleetService } from "../src/fleet.ts";
import { MeterSchedule } from "../src/meters.ts";
import { createHub } from "../src/server.ts";
import { HubWatch } from "../src/watch.ts";

test("the hub keeps lifecycle listener counts low with all startup services configured", (t) => {
  const db = openCatalog(":memory:");
  const server = createHub({
    db,
    webRoot: ".",
    health: { scheduled: true, cycle: async () => {} },
    watch: new HubWatch(db, { machines: () => [], configPath: "test/listeners-watch.json", heartbeatPath: "test/listeners-heartbeat.json" }),
    meters: new MeterSchedule(db, { machines: () => [], cycle: async () => [] }),
    backup: { read: () => ({ state: "not-installed" }), notifier: { send: async () => [] } },
    fleet: new FleetService(db, { configPath: "test/listeners-fleet.json" }),
    recipeProjects: () => [],
  });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
  });

  assert.ok(server.listenerCount("listening") <= 3, "the hub has at most three listening listeners");
  assert.ok(server.listenerCount("close") <= 3, "the hub has at most three close listeners");
});
