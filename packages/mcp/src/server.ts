import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/** A tool an agent can call. The handler returns plain data (stringified for the agent) or a string sent as it is. */
export interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** True when the tool changes nothing. */
  readOnly: boolean;
  run(args: Record<string, unknown>): Promise<unknown> | unknown;
}

export interface ServerInfo { name: string; version: string; instructions?: string }

const SUPPORTED = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

type Id = string | number | null;
interface Response { jsonrpc: "2.0"; id: Id; result?: unknown; error?: { code: number; message: string } }

const failure = (id: Id, code: number, message: string): Response => ({ jsonrpc: "2.0", id, error: { code, message } });
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** A minimal Model Context Protocol server over newline-delimited JSON-RPC: initialize, ping, tools/list and tools/call. */
export class McpServer {
  private tools: Map<string, Tool>;
  private info: ServerInfo;

  constructor(info: ServerInfo, tools: Tool[]) {
    this.info = info;
    this.tools = new Map(tools.map((tool) => [tool.name, tool]));
  }

  /** Answers one parsed message; returns null for a notification, which gets no reply. */
  async handle(message: unknown): Promise<Response | null> {
    if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") return failure(isRecord(message) && (typeof message.id === "string" || typeof message.id === "number") ? message.id : null, -32600, "invalid request");
    const hasId = typeof message.id === "string" || typeof message.id === "number";
    const id: Id = hasId ? message.id as string | number : null;
    const params = isRecord(message.params) ? message.params : {};
    if (!hasId) return null;
    switch (message.method) {
      case "initialize": {
        const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
        return { jsonrpc: "2.0", id, result: { protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: this.info.name, version: this.info.version }, ...(this.info.instructions ? { instructions: this.info.instructions } : {}) } };
      }
      case "ping": return { jsonrpc: "2.0", id, result: {} };
      case "tools/list": return { jsonrpc: "2.0", id, result: { tools: [...this.tools.values()].map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, annotations: { readOnlyHint: tool.readOnly, destructiveHint: false, openWorldHint: false } })) } };
      case "tools/call": {
        const tool = typeof params.name === "string" ? this.tools.get(params.name) : undefined;
        if (!tool) return failure(id, -32602, `unknown tool: ${String(params.name)}`);
        const args = isRecord(params.arguments) ? params.arguments : {};
        try {
          const out = await tool.run(args);
          return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out) }] } };
        } catch (err) {
          return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : "the tool failed" }] } };
        }
      }
      default: return failure(id, -32601, `method not found: ${message.method}`);
    }
  }

  /** Reads one JSON message per line from the input and writes each reply as one line. Nothing else is ever written to the output. */
  serve(input: Readable, output: Writable): Promise<void> {
    const lines = createInterface({ input, crlfDelay: Infinity });
    const pending = new Set<Promise<void>>();
    const send = (reply: Response): void => { output.write(`${JSON.stringify(reply)}\n`); };
    lines.on("line", (line) => {
      if (line.trim() === "") return;
      const job: Promise<void> = (async () => {
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { send(failure(null, -32700, "parse error")); return; }
        const reply = await this.handle(parsed);
        if (reply) send(reply);
      })().finally(() => { pending.delete(job); });
      pending.add(job);
    });
    return new Promise((resolve) => lines.on("close", () => { void Promise.all(pending).then(() => resolve()); }));
  }
}
