import { connect, type Socket } from "node:net";
import { findHubMachine, isWatched, recordObservations, settleUnwatched, type Db, type Observation, type OutageChange, type Transport, type WatchConfig } from "@scout/core";

export interface MachineConfigLike { id: string; name?: string; address?: string; transport: Transport }

// A machine can answer ping and accept a connection and still be hung: on 2026-10-09 a machine took TCP connections on every port for two hours and
// sent nothing back. So the check connects to the ssh port and waits for the greeting the ssh server sends first. It never logs in.

export const CONNECT_TIMEOUT_MS = 8_000;
export const BANNER_TIMEOUT_MS = 8_000;

export type MachineState = "up" | "hung" | "down";
export interface MachineProbe { state: MachineState; detail: string; latencyMs: number | null }
export interface MachineProbeOptions {
  port?: number;
  connectTimeoutMs?: number;
  bannerTimeoutMs?: number;
  dial?: (port: number, host: string) => Socket;
  now?: () => number;
}

export function probeMachine(host: string, options: MachineProbeOptions = {}): Promise<MachineProbe> {
  const port = options.port ?? 22;
  const now = options.now ?? Date.now;
  const started = now();
  return new Promise((resolve) => {
    let socket: Socket;
    let connected = false;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (probe: MachineProbe): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch { /* already closed */ }
      resolve(probe);
    };
    const latency = (): number => Math.max(0, now() - started);
    try {
      socket = (options.dial ?? ((p, h) => connect({ port: p, host: h })))(port, host);
    } catch {
      return finish({ state: "down", detail: `Could not start a connection to ${host}:${port}.`, latencyMs: null });
    }
    timer = setTimeout(() => finish(connected
      ? { state: "hung", detail: `Port ${port} accepted a connection but sent no SSH greeting within ${(options.bannerTimeoutMs ?? BANNER_TIMEOUT_MS) / 1000} s.`, latencyMs: latency() }
      : { state: "down", detail: `No connection to port ${port} within ${(options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS) / 1000} s.`, latencyMs: null }), options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS);
    socket.once("connect", () => {
      connected = true;
      clearTimeout(timer);
      timer = setTimeout(() => finish({ state: "hung", detail: `Port ${port} accepted a connection but sent no SSH greeting within ${(options.bannerTimeoutMs ?? BANNER_TIMEOUT_MS) / 1000} s.`, latencyMs: latency() }), options.bannerTimeoutMs ?? BANNER_TIMEOUT_MS);
    });
    let seen = "";
    socket.on("data", (chunk: Buffer) => {
      seen += chunk.toString("latin1");
      if (seen.length < 4 && "SSH-".startsWith(seen)) return;
      if (seen.startsWith("SSH-")) finish({ state: "up", detail: "", latencyMs: latency() });
      else finish({ state: "hung", detail: `Port ${port} answered with something other than an SSH greeting.`, latencyMs: latency() });
    });
    socket.once("error", (error: NodeJS.ErrnoException) => finish(connected
      ? { state: "hung", detail: `The connection to port ${port} broke before a greeting (${error.code ?? "error"}).`, latencyMs: latency() }
      : { state: "down", detail: `Port ${port} did not accept a connection (${error.code ?? "error"}).`, latencyMs: null }));
    socket.once("close", () => finish(connected
      ? { state: "hung", detail: `Port ${port} closed the connection without a greeting.`, latencyMs: latency() }
      : { state: "down", detail: `Port ${port} did not accept a connection.`, latencyMs: null }));
  });
}

export interface WatchedMachine { id: string; name: string; host: string; port: number }

/** The machines to check over ssh: every machine with an ssh transport except guests that share a host. The hub machine does the checking and is not one of them. */
export function watchMachines(machines: readonly MachineConfigLike[]): WatchedMachine[] {
  const hub = findHubMachine(machines);
  const out: WatchedMachine[] = [];
  for (const machine of machines) {
    if (machine === hub || machine.transport.type !== "ssh" || machine.transport.guest) continue;
    const options = machine.transport.options ?? [];
    const flag = options.indexOf("-p");
    const port = flag >= 0 ? Number(options[flag + 1]) : 22;
    const target = machine.transport.target;
    const host = (machine.address ?? target.slice(target.lastIndexOf("@") + 1)).trim();
    // The host is dialed directly and never placed in a command line, but a malformed value would only produce a confusing failure.
    if (!/^[A-Za-z0-9._:-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) continue;
    out.push({ id: machine.id, name: machine.name ?? machine.id, host, port });
  }
  return out;
}

export interface MachineCheckOptions extends MachineProbeOptions {
  probe?: (machine: WatchedMachine, options: MachineProbeOptions) => Promise<MachineProbe>;
}

/** One round of machine checks: probes every machine at once, records the results and closes outages for machines that are switched off. */
export async function runMachineChecks(db: Db, machines: readonly WatchedMachine[], config: WatchConfig, options: MachineCheckOptions = {}): Promise<OutageChange[]> {
  const now = options.now ?? Date.now;
  const probe = options.probe ?? ((machine, probeOptions) => probeMachine(machine.host, { ...probeOptions, port: machine.port }));
  const results = await Promise.all(machines.map(async (machine) => ({ machine, result: await probe(machine, options).catch((): MachineProbe => ({ state: "down", detail: "The check failed to run.", latencyMs: null })) })));
  const at = new Date(now()).toISOString();
  const changes: OutageChange[] = [];
  const observations: Observation[] = [];
  for (const { machine, result } of results) {
    const key = `machine:${machine.id}`;
    if (!isWatched(config, "machine", machine.id, key, at)) {
      changes.push(...settleUnwatched(db, { kind: "machine", machineId: machine.id }, new Set(), at));
      continue;
    }
    observations.push({ key, kind: "machine", machineId: machine.id, label: machine.name, ok: result.state === "up", state: result.state, detail: result.detail, at });
  }
  changes.push(...recordObservations(db, observations));
  return changes;
}
