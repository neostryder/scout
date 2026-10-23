import { test } from "node:test";
import assert from "node:assert/strict";
const { attentionText, elapsedText, isLive, jobProgress, jobSummary, stagesFor } = await import(new URL("../public/jobs-model.js", import.meta.url).href);

const NOW = Date.parse("2026-10-22T12:01:23.000Z");
const base = { id: 1, state: "running", action: "update", ecosystem: "winget", machineId: "eru", startedAt: "2026-10-22T12:00:00.000Z", steps: [{ seq: 1, name: "preflight", state: "done" }], phase: null, attention: null };

test("winget has four stages, brew three, and anything else one", () => {
  assert.deepEqual(stagesFor("winget"), ["download", "verify", "install", "finish"]);
  assert.equal(stagesFor("brew").length, 3);
  assert.equal(stagesFor("npm").length, 1);
});

test("elapsed time reads as minutes and seconds", () => {
  assert.equal(elapsedText(0), "0:00");
  assert.equal(elapsedText(83_000), "1:23");
  assert.equal(elapsedText(-5), "0:00");
});

test("a running winget job reports its stage out of four, with the time since it started", () => {
  assert.deepEqual(jobProgress({ ...base, phase: "verify" }, NOW), { label: "Checking the download", stage: 2, stages: 4, elapsed: "1:23", attention: null });
  assert.equal(jobProgress({ ...base, phase: "install" }, NOW)?.stage, 3);
  assert.equal(jobProgress({ ...base, phase: null }, NOW)?.label, "Starting the update");
  assert.equal(jobProgress({ ...base, phase: null }, NOW)?.stage, 0);
});

test("a command with no stages shows one stage, which the page draws as a sweep", () => {
  const progress = jobProgress({ ...base, ecosystem: "npm", phase: "install" }, NOW);
  assert.equal(progress?.stages, 1);
  assert.equal(progress?.label, "Installing");
  assert.equal(jobProgress({ ...base, ecosystem: "npm", phase: null }, NOW)?.label, "Updating");
});

test("after the update command ends the job reads the new version back", () => {
  const steps = [...base.steps, { seq: 2, name: "update", state: "done" }];
  assert.equal(jobProgress({ ...base, phase: "finish", steps }, NOW)?.label, "Confirming the new version");
});

test("queued, checking, and download jobs have their own words", () => {
  assert.equal(jobProgress({ ...base, state: "queued", startedAt: null }, NOW)?.label, "Waiting for its turn");
  assert.equal(jobProgress({ ...base, state: "preflight" }, NOW)?.label, "Checking the install");
  assert.equal(jobProgress({ ...base, action: "download" }, NOW)?.label, "Downloading");
});

test("finished jobs have no progress and keep their plain summary", () => {
  assert.equal(jobProgress({ ...base, state: "done" }, NOW), null);
  assert.equal(isLive({ state: "failed" }), false);
  assert.equal(jobSummary({ ...base, state: "done" }), "done");
  assert.equal(jobSummary({ ...base, state: "failed", message: "the app is running; close it and try again" }), "failed: the app is running; close it and try again");
  assert.equal(jobSummary(null), "");
});

test("a job waiting on a person says so, by machine, and the summary leads with it", () => {
  const uac = { ...base, phase: "install", attention: { kind: "uac", detail: null, since: "2026-10-22T12:01:00.000Z" } };
  assert.equal(attentionText(uac), "Windows is asking for permission on eru. Approve the prompt to continue.");
  assert.equal(jobProgress(uac, NOW)?.attention, attentionText(uac));
  assert.equal(jobSummary(uac, NOW), "waiting for the Windows prompt");
  const window = { ...base, attention: { kind: "window", detail: "Setup Wizard (setup)", since: "2026-10-22T12:01:00.000Z" } };
  assert.equal(attentionText(window), "The installer opened a window on eru: Setup Wizard (setup). It may be waiting for you.");
  assert.equal(jobSummary(window, NOW), "installer window open");
  assert.equal(attentionText(base), null);
});
