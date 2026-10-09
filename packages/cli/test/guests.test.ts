import { test } from "node:test";
import assert from "node:assert/strict";
import { runningGuests } from "../src/guests.ts";

test("colima is running when limactl's hostagent process exists", () => {
  const ps = "/Users/USER/.homebrew/bin/limactl hostagent --pidfile /Users/USER/.colima/_lima/colima/ha.pid colima\n";
  assert.deepEqual(runningGuests(ps), ["colima"]);
});

test("a limactl usernet helper alone does not count as a running guest", () => {
  assert.deepEqual(runningGuests("/Users/USER/.homebrew/bin/limactl usernet -p /x.pid\n"), []);
});

test("Docker Desktop is detected from its backend process", () => {
  const ps = "/Applications/Docker.app/Contents/MacOS/com.docker.backend\n";
  assert.deepEqual(runningGuests(ps), ["docker-desktop"]);
});

test("an empty process list means no guests", () => {
  assert.deepEqual(runningGuests(""), []);
});
