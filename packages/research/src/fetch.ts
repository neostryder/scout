import { downloadHttps } from "@scout/core";
import type { Fetcher } from "./runner.ts";

const MAX_BYTES = 1_048_576;

export async function fetchPublicPage(fetcher: Fetcher, url: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  const signal = AbortSignal.timeout(timeoutMs);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const destination = new URL(url);
    // A page address is public only: https, no credentials, no IP literal and no local name, on the first request and on every redirect.
    if (downloadHttps(destination.href) === null) throw new Error("request requires https and a public address");
    const res = await fetcher(url, { headers: { "user-agent": "Scout", ...headers }, signal, redirect: "manual" });
    if (res.url && new URL(res.url).protocol !== "https:") {
      await res.body?.cancel();
      throw new Error("redirect requires https");
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      await res.body?.cancel();
      const location = res.headers?.get("location");
      if (!location) throw new Error("redirect has no location");
      url = new URL(location, url).href;
      continue;
    }
    if (Number(res.headers?.get("content-length")) > MAX_BYTES) {
      await res.body?.cancel();
      throw new Error("response is too large");
    }
    if (!res.body) {
      const body = await res.text();
      if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("response is too large");
      return { status: res.status, body };
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) throw new Error("response is too large");
        chunks.push(value);
      }
      return { status: res.status, body: Buffer.concat(chunks).toString("utf8") };
    } catch (err) {
      await reader.cancel();
      throw err;
    } finally {
      reader.releaseLock();
    }
  }
  throw new Error("too many redirects");
}
