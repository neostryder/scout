import assert from "node:assert/strict";
import test from "node:test";

const { GATE_FIELDS, gateChange, isWatched, watchFromForm, watchText, sortCompetitors, filterCompetitors, defaultNewOnly, countLine, statusText, commitsText, runText, analyzedText, baselineSource, latestParts, checkedText, syncedText, pendingText, triggerText, updateAction, NOT_CONFIGURED, UPDATE_CONFIRM, NO_MIRROR } = await import(new URL("../public/competitors-model.js", import.meta.url).href);

const row = (over: Record<string, unknown> = {}) => ({ id: "acme-tools", name: "Acme Tools", org: "Acme", status: "current", newBasis: null, mirrorPresent: true, run: null, baseline: { version: "1.2.0", at: "2026-05-05", source: "analysis" }, latest: { version: "1.2.0", prerelease: null, error: null }, ...over });

test("rows sort new first, then by name, without changing the caller's list", () => {
  const rows = [row({ name: "Zed", status: "new" }), row({ name: "acme", status: "current" }), row({ name: "Beta", status: "unknown" }), row({ name: "alpha", status: "new" })];
  assert.deepEqual(sortCompetitors(rows).map((item: { name: string }) => item.name), ["alpha", "Zed", "acme", "Beta"]);
  assert.equal(rows[0]?.name, "Zed");
  assert.deepEqual(sortCompetitors(undefined), []);
});

test("search matches name and organization, and New only keeps new rows", () => {
  const rows = [row({ name: "Acme Tools", org: "Acme", status: "new" }), row({ name: "Other", org: "Beta Works", status: "current" }), row({ name: "Quiet", org: null, status: "unknown" })];
  assert.deepEqual(filterCompetitors(rows, { query: "acme tools" }).map((item: { name: string }) => item.name), ["Acme Tools"]);
  assert.deepEqual(filterCompetitors(rows, { query: "BETA" }).map((item: { name: string }) => item.name), ["Other"]);
  assert.deepEqual(filterCompetitors(rows, { query: "quiet" }).map((item: { name: string }) => item.name), ["Quiet"]);
  assert.deepEqual(filterCompetitors(rows, { newOnly: true }).map((item: { name: string }) => item.name), ["Acme Tools"]);
  assert.equal(filterCompetitors(rows, { query: "missing" }).length, 0);
  assert.equal(filterCompetitors(rows, {}).length, 3);
});

test("New only starts on only when some row is new, and the count line names both numbers", () => {
  assert.equal(defaultNewOnly([row({ status: "new" }), row()]), true);
  assert.equal(defaultNewOnly([row(), row({ status: "unknown" })]), false);
  assert.equal(defaultNewOnly([]), false);
  const rows = [...Array(40)].map((_, index) => row({ status: index < 3 ? "new" : "current" }));
  assert.equal(countLine(rows), "3 of 40 have a new version");
  assert.equal(countLine([]), "0 of 0 have a new version");
});

test("every status has its own words, and a commits basis adds New commits", () => {
  assert.equal(statusText(row({ status: "new", newBasis: "version" })), "New version");
  assert.equal(statusText(row({ status: "new", newBasis: "commits" })), "New version");
  assert.equal(commitsText(row({ status: "new", newBasis: "commits" })), "New commits");
  assert.equal(commitsText(row({ status: "new", newBasis: "version" })), "");
  assert.equal(statusText(row({ status: "current" })), "Up to date");
  assert.equal(statusText(row({ status: "unknown" })), "Not checked");
  assert.equal(statusText({}), "Not checked");
});

test("every run state has its own words, and a stale run says how old the queue is", () => {
  assert.equal(runText(null), "None");
  assert.equal(runText({ state: "pulling", stale: false }), "Pulling");
  assert.equal(runText({ state: "queued", stale: false }), "Research queued");
  assert.equal(runText({ state: "claimed", stale: false, claimedBy: "Ada" }), "Research in progress (claimed by Ada)");
  assert.equal(runText({ state: "claimed", stale: false, claimedBy: null }), "Research in progress");
  assert.equal(runText({ state: "done", stale: false }), "Done");
  assert.equal(runText({ state: "failed", stale: false, error: "mirror missing" }), "Failed: mirror missing");
  assert.equal(runText({ state: "failed", stale: false, error: null }), "Failed");
  assert.equal(runText({ state: "queued", stale: true }), "Stale, queued over 14 days ago");
  assert.equal(runText({ state: "claimed", stale: true, claimedBy: "Ada" }), "Stale, queued over 14 days ago");
});

test("the last analysis, its source, the latest version, and the check time read as plain text", () => {
  assert.equal(analyzedText({ version: "1.2.0", at: "2026-05-05", source: "analysis" }), "1.2.0, 2026-05-05");
  assert.equal(analyzedText({ version: "1.2.0", at: null, source: "mirror" }), "1.2.0");
  assert.equal(analyzedText({ version: null, at: null, source: "none" }), "not analyzed");
  assert.equal(analyzedText(null), "not analyzed");
  assert.equal(baselineSource({ source: "mirror" }), "mirror");
  assert.equal(baselineSource({ source: "analysis" }), "analysis");
  assert.equal(baselineSource({ source: null }), "none");
  assert.equal(baselineSource({ source: "other" }), "none");
  assert.deepEqual(latestParts({ version: "1.3.0", prerelease: "1.4.0-rc.1", error: null }), { version: "1.3.0", prerelease: "1.4.0-rc.1", error: "" });
  assert.deepEqual(latestParts({ version: "1.3.0", prerelease: "1.3.0", error: "timed out" }), { version: "1.3.0", prerelease: "", error: "timed out" });
  assert.equal(checkedText("2026-10-19T12:04:00.000Z"), "Last check 2026-10-19 12:04");
  assert.equal(checkedText(null), "No check yet");
});

test("Update is ready, hidden while a run is active, or disabled with the reason when there is no mirror", () => {
  assert.deepEqual(updateAction(row()), { kind: "ready" });
  assert.deepEqual(updateAction(row({ run: { state: "done" } })), { kind: "ready" });
  assert.deepEqual(updateAction(row({ run: { state: "failed" } })), { kind: "ready" });
  for (const state of ["pulling", "queued", "claimed"]) assert.equal(updateAction(row({ run: { state } })).kind, "hidden", state);
  assert.deepEqual(updateAction(row({ mirrorPresent: false, run: null })), { kind: "disabled", reason: NO_MIRROR });
  assert.equal(updateAction(row({ mirrorPresent: false, run: { state: "queued" } })).kind, "hidden");
});

test("the setup sentence and the update confirmation stay the words the page shows", () => {
  assert.equal(NOT_CONFIGURED, "Competitor watch is not set up. Run the seed command described in the setup guide.");
  assert.equal(UPDATE_CONFIRM, "Pull the mirror and queue research now, ignoring the usual wait. Nothing is installed and no research runs until a Claude session picks it up.");
  assert.equal(NO_MIRROR, "No local mirror");
});

test("mirror sync, waiting, and trigger stay in words", () => {
  const now = "2026-05-20T12:00:00.000Z";
  assert.equal(syncedText(null, now), "Mirror not synced yet");
  assert.equal(syncedText({ at: null, error: null }, now), "Mirror not synced yet");
  assert.equal(syncedText({ at: "2026-05-20T11:59:40.000Z", error: null }, now), "Mirror synced just now");
  assert.equal(syncedText({ at: "2026-05-20T11:58:00.000Z", error: null }, now), "Mirror synced 2 minutes ago");
  assert.equal(syncedText({ at: "2026-05-20T11:00:00.000Z", error: null }, now), "Mirror synced 1 hour ago");
  assert.equal(syncedText({ at: "2026-05-20T09:00:00.000Z", error: null }, now), "Mirror synced 3 hours ago");
  assert.equal(syncedText({ at: "2026-05-17T12:00:00.000Z", error: null }, now), "Mirror synced 3 days ago");
  assert.equal(syncedText({ at: "2026-05-20T11:00:00.000Z", error: "mirror has uncommitted changes" }, now), "Mirror synced 1 hour ago. mirror has uncommitted changes");
  assert.equal(syncedText({ at: null, error: "mirror has no origin" }, now), "Mirror sync failed. mirror has no origin");
  assert.equal(pendingText(null), "");
  assert.equal(pendingText({ commits: 3, sourceFilesChanged: 1, reason: "3 commits, below the threshold of 5" }), "Waiting: 3 commits below the threshold");
  assert.equal(triggerText(null), "");
  assert.equal(triggerText({ trigger: "auto" }), "Auto-queued");
  assert.equal(triggerText({ trigger: "manual" }), "Manual");
  assert.equal(triggerText({ state: "queued" }), "");
});

test("a watched row can be updated without a mirror, and its words name the page", () => {
  const watch = { kind: "json", url: "https://example.test/v.json" };
  assert.deepEqual(updateAction(row({ mirrorPresent: false, watch })), { kind: "ready" });
  assert.equal(isWatched(row({ mirrorPresent: false, watch })), true);
  assert.equal(isWatched(row({ mirrorPresent: true, watch })), false);
  assert.equal(watchText({ kind: "hash", url: "https://example.test" }), "Watching: Page, any change");
  assert.equal(watchText(null), "");
  assert.equal(baselineSource({ source: "watch" }), "watch");
  assert.equal(analyzedText({ version: null, at: "2026-10-01T00:00:00.000Z", source: "watch" }), "page seen 2026-10-01");
  assert.equal(analyzedText({ version: null, at: null, source: "watch" }), "not analyzed");
  assert.equal(pendingText({ commits: 0, sourceFilesChanged: 0, reason: "the watched page changed and shows no new version" }), "Waiting: the page changed and shows no new version");
});

test("rule edits send only what changed and refuse a bad number", () => {
  const blank = Object.fromEntries(GATE_FIELDS.map((field: { key: string }) => [field.key, ""]));
  assert.deepEqual(gateChange({}, blank), { set: {}, clear: [] });
  assert.deepEqual(gateChange({ minCommits: 8 }, { ...blank, minCommits: "8" }), { set: {}, clear: [] });
  assert.deepEqual(gateChange({ minCommits: 8 }, { ...blank, minCommits: "9", onNewTag: "false" }), { set: { minCommits: 9, onNewTag: false }, clear: [] });
  assert.deepEqual(gateChange({ quietHours: 0, enabled: false }, blank), { set: {}, clear: ["enabled", "quietHours"] });
  assert.throws(() => gateChange({}, { ...blank, minCommits: "many" }), /whole number/);
  assert.throws(() => gateChange({}, { ...blank, maxQueued: "0" }), /1 or more/);
});

test("the watch form builds the stored object or says what is missing", () => {
  assert.deepEqual(watchFromForm({ kind: "json", url: " https://example.test/v.json ", versionPath: "latest.version" }), { kind: "json", url: "https://example.test/v.json", versionPath: "latest.version" });
  assert.deepEqual(watchFromForm({ kind: "page", url: "https://example.test/p", versionPattern: "v(\\d+)" }), { kind: "page", url: "https://example.test/p", versionPattern: "v(\\d+)" });
  assert.deepEqual(watchFromForm({ kind: "hash", url: "https://example.test/p", versionPath: "ignored" }), { kind: "hash", url: "https://example.test/p" });
  assert.throws(() => watchFromForm({ kind: "json", url: "https://example.test/v.json", versionPath: "" }), /path to the version/);
  assert.throws(() => watchFromForm({ kind: "hash", url: "" }), /address/);
  assert.throws(() => watchFromForm({ kind: "nope", url: "https://example.test" }), /Choose what to watch/);
});
