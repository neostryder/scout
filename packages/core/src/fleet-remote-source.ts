import { defaultSeverity, fingerprint, type FailureClass, type IncidentEvidence, type IncidentPacket, type Severity } from "./fleet-packet.ts";
import type { FleetRemoteConfig } from "./fleet-ports.ts";
import { redactPacket } from "./fleet-redact.ts";

export interface RemoteCommandResult { code: number | null; stdout: string; stderr: string; error: string | null }

export type RemoteObservation =
  | { kind: "result"; index: number; result: RemoteCommandResult }
  | { kind: "missing-machine"; index: number };

function packet(machine: string, component: string, failureClass: FailureClass, summary: string, evidence: IncidentEvidence, now: string, severity?: Severity): IncidentPacket {
  const safe = redactPacket({
    version: 1,
    host: machine,
    component,
    failureClass,
    severity: defaultSeverity(failureClass, severity ? { severity } : {}),
    firstSeen: now,
    lastSeen: now,
    count: 1,
    fingerprint: fingerprint(machine, component, failureClass),
    summary,
    evidence,
    redaction: { applied: false, rules: [] },
    ownerChat: null,
    runbook: null,
  });
  safe.summary = safe.summary.slice(0, 299);
  if (safe.evidence.journalTail !== undefined) safe.evidence.journalTail = safe.evidence.journalTail.slice(0, 1500);
  if (safe.evidence.stderrTail !== undefined) safe.evidence.stderrTail = safe.evidence.stderrTail.slice(0, 1500);
  return safe;
}

function journal(lines: string[]): string {
  return lines.slice(-5).map((line) => line.slice(0, 300)).join("\n").slice(0, 1500);
}

/** SSH reserves 255 for transport errors, so a remote command exiting 255 is also treated as unreachable. */
export function remoteUnreachable(result: RemoteCommandResult): boolean {
  return result.code === 255 || result.error === "timeout";
}

export function remotePackets(config: FleetRemoteConfig, observations: readonly RemoteObservation[], now: string): IncidentPacket[] {
  if (!Number.isFinite(Date.parse(now))) return [];
  const packets: IncidentPacket[] = [];
  for (const observation of observations) {
    const entry = config.checks[observation.index];
    if (!entry) continue;
    if (observation.kind === "missing-machine") {
      packets.push(packet(entry.machine, `remote:${entry.machine}`, "watcher-failure", "machine is not in the machine list", {}, now));
      continue;
    }
    const { result } = observation;
    if (remoteUnreachable(result)) {
      if (entry.unreachable === "report") packets.push(packet(entry.machine, `remote:${entry.machine}`, "watcher-failure", "remote checks could not reach the machine", { stderrTail: (result.error ?? result.stderr).slice(-1500) }, now));
      continue;
    }
    const lines = result.stdout.split(/\r?\n/);
    if (result.code !== 0) {
      packets.push(packet(entry.machine, entry.component, entry.failureClass, `command failed (exit ${result.code})`, { ...(result.code !== null ? { exitCode: result.code } : {}), stderrTail: (result.stderr || result.error || "").slice(-1500), journalTail: journal(lines) }, now, entry.severity));
      continue;
    }
    const pattern = entry.pattern === undefined ? null : new RegExp(entry.pattern, "i");
    const ignore = entry.ignore === undefined ? null : new RegExp(entry.ignore, "i");
    const mustMatch = entry.mustMatch === undefined ? null : new RegExp(entry.mustMatch, "i");
    const hits = pattern ? lines.filter((line) => pattern.test(line) && !ignore?.test(line)) : [];
    if (hits.length > 0) {
      packets.push(packet(entry.machine, entry.component, entry.failureClass, `${hits.length} matching lines`, { journalTail: journal(hits) }, now, entry.severity));
    } else if (mustMatch && !lines.some((line) => mustMatch.test(line))) {
      packets.push(packet(entry.machine, entry.component, entry.failureClass, "expected output missing", { journalTail: journal(lines) }, now, entry.severity));
    }
  }
  return [...new Map(packets.map((item) => [item.fingerprint, item])).values()];
}
