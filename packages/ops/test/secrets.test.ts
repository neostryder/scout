import { test } from "node:test";
import assert from "node:assert/strict";
import { lookupCloudflareSecrets, readSecret, type SecretExec } from "../src/secrets.ts";

function execOf(stdout: unknown): SecretExec {
  return async (file, args, options) => {
    assert.equal(file, "bws");
    assert.deepEqual([...args], ["secret", "list"]);
    assert.equal(options.windowsHide, true);
    assert.equal(options.timeout, 15_000);
    return { stdout: JSON.stringify(stdout) };
  };
}

const listed = [
  { key: "CLOUDFLARE_SCOUT_READ", value: "from-bws" },
  { key: "CLOUDFLARE_ACCOUNT_ID", value: "account-from-bws" },
  { key: "CUSTOM", value: "from-custom" },
];

test("an env token wins and bws still supplies the account id", async () => {
  let calls = 0;
  const exec: SecretExec = async (file, args, options) => {
    calls += 1;
    return execOf(listed)(file, args, options);
  };
  const found = await lookupCloudflareSecrets({ env: { SCOUT_CLOUDFLARE_TOKEN: "env-token" }, exec });
  assert.deepEqual(found, { token: "env-token", accountId: "account-from-bws" });
  assert.equal(calls, 1);
});

test("a bws failure keeps the env token and drops the account id", async () => {
  const found = await lookupCloudflareSecrets({
    env: { SCOUT_CLOUDFLARE_TOKEN: "env-token" },
    exec: async () => { throw new Error("bws says env-token and the vault path"); },
  });
  assert.deepEqual(found, { token: "env-token", accountId: null });
});

test("the named secret overrides the default names", async () => {
  const found = await lookupCloudflareSecrets({ env: {}, secretName: "CUSTOM", exec: execOf(listed) });
  assert.deepEqual(found, { token: "from-custom", accountId: "account-from-bws" });
});

test("CLOUDFLARE_SCOUT_READ is the default secret name", async () => {
  const first = await lookupCloudflareSecrets({ env: {}, exec: execOf(listed) });
  assert.equal(first?.token, "from-bws");
  const second = await lookupCloudflareSecrets({ env: {}, exec: execOf([{ key: "CLOUDFLARE_SCOUT_READ", value: "" }]) });
  assert.equal(second, null);
});

test("no usable token returns null", async () => {
  const found = await lookupCloudflareSecrets({ env: {}, exec: execOf([{ key: "OTHER", value: "unused" }]) });
  assert.equal(found, null);
  const failed = await lookupCloudflareSecrets({ env: {}, exec: async () => { throw new Error("vault down"); } });
  assert.equal(failed, null);
});

test("readSecret returns the value and errors name only the failure", async () => {
  assert.equal(await readSecret("CLOUDFLARE_SCOUT_READ", execOf({ data: listed })), "from-bws");
  await assert.rejects(() => readSecret("MISSING", execOf({ secrets: listed })), (err: Error) => {
    assert.equal(err.message, "key was not found");
    assert.equal(err.message.includes("from-bws"), false);
    return true;
  });
  await assert.rejects(
    () => readSecret("CLOUDFLARE_SCOUT_READ", async () => { throw new Error("stdout held from-bws"); }),
    (err: Error) => {
      assert.equal(err.message, "bws failed");
      assert.equal(err.message.includes("from-bws"), false);
      return true;
    },
  );
  await assert.rejects(() => readSecret("CLOUDFLARE_SCOUT_READ", execOf("not-json")), /bws failed/);
});
