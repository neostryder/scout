import type { CogitatorDiscovery } from "../src/cogitator.ts";

export const discoveryFixture = (gateway = "http://127.0.0.1:8470"): CogitatorDiscovery => ({
  schema: 1, name: "Cogitator", version: "1.0.0", gateway, openai_base: `${gateway}/v1`, health: `${gateway}/health`,
  busy_probe: `${gateway}/v1/cogitator/load?model={model}`, auth: { type: "bearer", header: "Authorization", scheme: "Bearer" },
  models: [{ id: "fixture-model", memory_mb: 1024, priority: 1 }], roles: [{ name: "describe", chain: ["fixture-model"] }, { name: "scout-describe", chain: ["fixture-model"] }],
});

export function fakeGateway() {
  const calls: { url: string; init: RequestInit }[] = [];
  const gateway = {
    calls,
    discovery: discoveryFixture(),
    probe: (): Response | Promise<Response> => Response.json({ state: "idle", serving: "fixture-model" }),
    chat: (): Response | Promise<Response> => Response.json({ choices: [{ message: { content: JSON.stringify({ summary: "Demo tracks installed versions.", evidence: ["tracks installed versions"], kind: "tool" }) } }] }, { headers: { "x-cogitator-model": "fixture-model" } }),
    fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith("/discovery")) return Response.json(gateway.discovery);
      if (url.includes("/load?")) return gateway.probe();
      if (url.endsWith("/chat/completions")) return gateway.chat();
      throw new Error("Unexpected fake request");
    }) as typeof fetch,
  };
  return gateway;
}
