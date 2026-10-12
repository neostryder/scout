import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error the portal's modules are plain JavaScript without type declarations
import { PAGES, listenerResult, lookups, machineResults, pageResults, parseQuery, serviceResult } from "../public/palette-model.js";

test("a port is recognised however it is typed, and anything else is a name", () => {
  assert.deepEqual(parseQuery("port 4870"), { kind: "port", port: 4870, text: "port 4870" });
  assert.equal(parseQuery(":8080").port, 8080);
  assert.equal(parseQuery("  443 ").port, 443);
  assert.equal(parseQuery("PORT22").port, 22);
  for (const text of ["0", "65536", "port 99999", "port", "redis 6379"]) assert.equal(parseQuery(text).kind, "text", text);
  assert.equal(parseQuery("go to alerts").text, "alerts");
});

test("pages are found by name, by the start of a word, and by a keyword, best match first", () => {
  assert.equal(pageResults("alerts")[0].label, "Alerts");
  assert.equal(pageResults("res")[0].label, "Resources");
  assert.ok(pageResults("tunnel").some((page: { label: string }) => page.label === "Domains"));
  assert.ok(pageResults("zzzz").length === 0);
  assert.equal(pageResults("").length, 8);
});

test("every page result is a link inside the portal and none can change anything", () => {
  for (const page of PAGES) {
    assert.match(page.href, /^\/(\?|$)/, page.label);
    assert.doesNotMatch(page.href, /(start|stop|restart|run|delete)/i, page.label);
  }
});

test("machines match by name or id and open the Services page for that machine", () => {
  const hits = machineResults([{ id: "bilbo", name: "Bilbo" }, { id: "eru", name: "Eru" }], "bil");
  assert.deepEqual(hits, [{ label: "Bilbo", hint: "Machine", href: "/?view=services&machine=bilbo" }]);
  assert.deepEqual(machineResults(null, "bil"), []);
});

test("a listener and a service each link to their own filtered list", () => {
  assert.deepEqual(listenerResult({ port: 4870, machineId: "eru", serviceName: "scout-hub" }), { label: "Port 4870: scout-hub", hint: "Listener on eru", href: "/?view=services&tab=listeners&port=4870&machine=eru&all=1" });
  assert.equal(listenerResult({ port: 22, machineId: "eru", processName: "sshd" }).label, "Port 22: sshd");
  assert.deepEqual(serviceResult({ name: "my app", kind: "launchd", machineId: "bilbo" }), { label: "my app", hint: "launchd on bilbo", href: "/?view=services&q=my%20app&machine=bilbo&all=1" });
});

test("a port asks only for listeners, a name asks for services and listeners, and a single letter asks for nothing", () => {
  assert.deepEqual(lookups(parseQuery("port 4870")).map((ask: { kind: string }) => ask.kind), ["listeners"]);
  assert.match(lookups(parseQuery("port 4870"))[0].path, /port=4870/);
  assert.deepEqual(lookups(parseQuery("scout")).map((ask: { kind: string }) => ask.kind), ["services", "listeners"]);
  assert.deepEqual(lookups(parseQuery("s")), []);
  for (const ask of lookups(parseQuery("a&b=c"))) assert.ok(ask.path.includes("a%26b%3Dc"));
});
