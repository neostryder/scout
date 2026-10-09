import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { createMockHub, installs, jobs } from "../dev/mock-hub.ts";

test("depui mock routes provide risk, batch plans, confirmation and detail data", async () => {
  const server = createMockHub();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async (path: string) => (await fetch(`${base}${path}`)).json() as Promise<any>;
  const post = (body: unknown) => fetch(`${base}/api/jobs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const all = await get("/api/updates?limit=500");
    assert.equal(all.rows.find((row: any) => row.installId === 7).risk.hard, 1);
    assert.equal(all.rows.find((row: any) => row.installId === 3).risk.soft, 2);
    assert.deepEqual(all.rows.find((row: any) => row.installId === 2).risk, { hard: 0, soft: 0 });
    assert.ok(installs.some((row) => row.risk === null));
    const safe = await get("/api/updates?safe=1&limit=500");
    assert.equal(safe.total, all.total - 1);
    assert.ok(safe.rows.every((row: any) => !row.risk?.hard));
    assert.ok(safe.rows.some((row: any) => row.installId === 3));
    const hard = await get("/api/updates/plan?installId=7");
    assert.equal(hard.allowed, false);
    assert.equal(hard.breaks.hard.length, 1);
    assert.ok(hard.refusal.includes(installs[10]!.name));
    assert.equal((await get("/api/updates/plan?installId=7&alsoInstallIds=2")).allowed, false);
    const batch = await get("/api/updates/plan?installId=7&alsoInstallIds=11");
    assert.equal(batch.allowed, true);
    assert.deepEqual(batch.breaks.hard, []);
    const soft = await get("/api/updates/plan?installId=3");
    assert.equal(soft.breaks.soft.length, 2);
    assert.deepEqual(soft.softConfirmation.projects, ["C:/Projects/cedar"]);
    const refused = await post({ installIds: [3], confirm: true });
    assert.equal(refused.status, 409);
    assert.match((await refused.json() as any).refused[0].reason, /^needs confirmation:/);
    const hardRefused = await post({ installIds: [7], confirm: true, confirmSoft: true });
    assert.equal(hardRefused.status, 409);
    assert.ok((await hardRefused.json() as any).refused[0].reason.includes(installs[10]!.name));
    for (const body of [{ installIds: [3], confirm: true, confirmSoft: true }, { installIds: [7, 11], confirm: true, allowDisruptive: true }]) {
      const queued = await post(body);
      assert.equal(queued.status, 202);
      const result = await queued.json() as any;
      assert.equal(result.jobs.length, body.installIds.length);
      for (const job of result.jobs) jobs.find((existing) => existing.id === job.id)!.state = "stopped";
    }
    const detail = await get("/api/installs/7");
    assert.equal(detail.dependencies.needs[0].to.name, "llhttp");
    assert.equal(detail.dependencies.needs[0].builtAgainst, "9.4.3");
    assert.equal(detail.dependencies.neededBy[0].from.id, 11);
    assert.ok(detail.supportWindows.some((window: any) => window.eolPassed));
    assert.ok(detail.supportWindows.some((window: any) => window.lts && window.eol === null));
    assert.equal(detail.changelog.model, "fixture-summary");
    assert.equal((await get("/api/installs/2")).changelog, null);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
});
