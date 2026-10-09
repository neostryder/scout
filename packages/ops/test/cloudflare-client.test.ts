import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CloudflareClient, CloudflareStatusError, cloudflareRequest } from "../src/cloudflare.ts";

const TOKEN = "token-fake";
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "../../../fixtures/cloudflare");

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(fixtures, name), "utf8"));
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

test("the client refuses every method except GET before fetch runs", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    let called = false;
    await assert.rejects(
      () => cloudflareRequest({
        method,
        path: "/zones",
        token: TOKEN,
        fetch: async () => {
          called = true;
          return jsonResponse(load("zones.json"));
        },
      }),
      (err: Error) => {
        assert.equal(err.message, "Cloudflare client is read only");
        assert.equal(err.message.includes(TOKEN), false);
        return true;
      },
    );
    assert.equal(called, false);
  }
});

test("zone pages follow result_info and ask for 100 rows", async () => {
  const urls: string[] = [];
  const client = new CloudflareClient({
    token: TOKEN,
    fetch: async (input) => {
      const url = new URL(String(input));
      urls.push(url.toString());
      assert.equal(url.searchParams.get("per_page"), "100");
      const page = url.searchParams.get("page");
      return jsonResponse(load(page === "2" ? "zones-page-2.json" : "zones-page-1.json"));
    },
  });
  const result = await client.get("/zones");
  assert.equal(urls.length, 2);
  assert.match(urls[0] ?? "", /page=1/);
  assert.match(urls[1] ?? "", /page=2/);
  assert.deepEqual((result as { name: string }[]).map((zone) => zone.name), ["example.test", "other.test"]);
});

test("a 429 waits for Retry-After and then returns the next page", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const result = await cloudflareRequest({
    method: "GET",
    path: "/zones",
    token: TOKEN,
    sleep: async (ms) => { sleeps.push(ms); },
    fetch: async () => {
      calls += 1;
      if (calls === 1) return jsonResponse(load("retry-429.json"), 429, { "retry-after": "0" });
      return jsonResponse(load("zones.json"));
    },
  });
  assert.deepEqual(sleeps, [0]);
  assert.equal((result as { name: string }[])[0]?.name, "Example.Test");
});

test("Retry-After above 30 seconds is capped", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  await cloudflareRequest({
    method: "GET",
    path: "/zones",
    token: TOKEN,
    sleep: async (ms) => { sleeps.push(ms); },
    fetch: async () => {
      calls += 1;
      if (calls === 1) return jsonResponse(load("retry-429.json"), 429, { "retry-after": "120" });
      return jsonResponse(load("zones.json"));
    },
  });
  assert.deepEqual(sleeps, [30_000]);
});

test("a 500 is tried twice more and the error omits the token and the body", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  await assert.rejects(
    () => cloudflareRequest({
      method: "GET",
      path: "/zones",
      token: TOKEN,
      sleep: async (ms) => { sleeps.push(ms); },
      fetch: async () => {
        calls += 1;
        return jsonResponse({ success: false, errors: [{ message: `${TOKEN} body-marker-rate-limit` }] }, 500);
      },
    }),
    (err: Error) => {
      assert.ok(err instanceof CloudflareStatusError);
      assert.equal(err.message, "Cloudflare request failed (HTTP 500)");
      assert.equal(err.message.includes(TOKEN), false);
      assert.equal(err.message.includes("body-marker-rate-limit"), false);
      return true;
    },
  );
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [200, 400]);
});

test("a network error and a redirect do not retry and do not quote the token", async () => {
  await assert.rejects(
    () => cloudflareRequest({
      method: "GET",
      path: "/zones",
      token: TOKEN,
      sleep: async () => { throw new Error("retried"); },
      fetch: async () => { throw new Error(`connect ${TOKEN}`); },
    }),
    (err: Error) => {
      assert.equal(err.message, "Cloudflare request failed");
      assert.equal(err.message.includes(TOKEN), false);
      return true;
    },
  );
  await assert.rejects(
    () => cloudflareRequest({
      method: "GET",
      path: "/zones",
      token: TOKEN,
      fetch: async () => new Response("", { status: 302, headers: { location: `https://example.test/${TOKEN}` } }),
    }),
    (err: Error) => {
      assert.equal(err.message, "Cloudflare request failed");
      assert.equal(err.message.includes(TOKEN), false);
      return true;
    },
  );
});

test("a timed out request is not retried", async () => {
  let calls = 0;
  await assert.rejects(
    () => cloudflareRequest({
      method: "GET",
      path: "/zones",
      token: TOKEN,
      timeoutMs: 30,
      sleep: async () => { throw new Error("retried"); },
      fetch: (_input, init) => new Promise((_resolve, reject) => {
        calls += 1;
        const fail = (): void => {
          const err = new Error(`aborted ${TOKEN}`);
          err.name = "TimeoutError";
          reject(err);
        };
        if (init?.signal?.aborted) fail();
        else init?.signal?.addEventListener("abort", fail, { once: true });
      }),
    }),
    (err: Error) => {
      assert.equal(err.message, "Cloudflare request timed out");
      assert.equal(err.message.includes(TOKEN), false);
      return true;
    },
  );
  assert.equal(calls, 1);
});
