import { healthResponse, resetHealthFailures, type Db } from "@scout/core";
import { runHealthCycle, type HealthCycleOptions } from "@scout/ops";

export async function healthCommand(db: Db, args: string[], options: { write?: (line: string) => void; cycle?: typeof runHealthCycle; probe?: HealthCycleOptions; now?: () => string } = {}): Promise<void> {
  const write = options.write ?? console.log;
  const params = new URLSearchParams();
  if (args[0] !== undefined && !args[0].startsWith("--") && args[0] !== "refresh") throw new Error("health requires refresh or list filters");
  for (const name of ["state", "kind"]) {
    const index = args.indexOf(`--${name}`);
    if (index < 0) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${name} requires a value`);
    params.set(name, value);
  }
  const now = options.now ?? (() => new Date().toISOString());
  healthResponse(db, params, now(), undefined, options.probe?.tunnelHosts);
  if (args[0] === "refresh") {
    resetHealthFailures(db);
    await (options.cycle ?? runHealthCycle)(db, options.probe);
  }
  const clip = (value: unknown, width: number): string => String(value ?? "-").replace(/\s+/g, " ").slice(0, width).padEnd(width + 2);
  write(`${clip("Label", 36)}${clip("State", 10)}${clip("Latency", 10)}${clip("Status", 8)}${clip("TLS days", 9)}Last ok`);
  const { targets } = healthResponse(db, params, now(), undefined, options.probe?.tunnelHosts);
  for (const row of targets) write(`${clip(row.label, 36)}${clip(row.state, 10)}${clip(row.latencyMs === null ? null : `${row.latencyMs} ms`, 10)}${clip(row.status, 8)}${clip(row.tlsDaysLeft, 9)}${row.lastOkAt ?? "-"}`);
  write(`\n${targets.length} target${targets.length === 1 ? "" : "s"}`);
}
