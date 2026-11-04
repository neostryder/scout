import type { Db } from "./db.ts";
import { globMatch, occurrencesSince, type FleetIncident, type FleetPolicy } from "./fleet-incidents.ts";
import type { FailureClass } from "./fleet-packet.ts";

/** What a person knows about one component, kept in the private fleet file and matched by host and component (`*` matches anything). */
export interface ComponentNote {
  host: string;
  component: string;
  description: string;
  falseAlarm?: string;
  nextStep?: string;
}

export interface ExplainFinding {
  cause: string | null;
  proposedFix: string | null;
  needsHuman: boolean;
}

export type ExplainKind = "incident" | "escalation" | "recovered" | "flapping" | "capped";

export interface ExplainInput {
  db: Db;
  incident: FleetIncident;
  now: string;
  notes: ComponentNote[];
  policy: Pick<FleetPolicy, "quietHours" | "resolveAfterCleanChecks">;
  kind: ExplainKind;
}

const DAY_MS = 24 * 60 * 60_000;
const FLAPPING_AT = 3;

const WHY: Record<FailureClass, string> = {
  dead: "the process stopped and was still down at the last check",
  wedged: "it is still running yet has stopped making progress",
  "never-ran": "this scheduled job has not run when it should have",
  "ran-failed": "the most recent run ended in failure",
  "degraded-output": "the run finished, but its output looks wrong",
  "slow-or-timeout": "it took longer than normal or timed out",
  resources: "the machine is close to running out of disk, memory, or a similar resource",
  "credentials-quota": "a credential stopped working or a quota limit was reached",
  "network-path": "the network path to it was unreachable",
  "ai-agent": "the AI agent run failed",
  "watcher-failure": "the watcher responsible for this check failed",
  "alert-quality": "this reports a problem in Scout's alerting rather than in a service",
};

export function findNote(notes: ComponentNote[], host: string, component: string): ComponentNote | null {
  return notes.find((note) => globMatch(note.host, host) && globMatch(note.component, component)) ?? null;
}

/** The latest investigation that produced something worth reading, or null. */
export function latestFinding(db: Db, incidentId: number): ExplainFinding | null {
  const row = db.prepare(`SELECT cause, proposed_fix AS proposedFix, needs_human AS needsHuman FROM fleet_investigations
    WHERE incident_id = ? AND status IN ('done', 'incomplete') AND (cause IS NOT NULL OR proposed_fix IS NOT NULL)
    ORDER BY started_at DESC, id DESC LIMIT 1`).get(incidentId) as { cause: string | null; proposedFix: string | null; needsHuman: number } | undefined;
  return row ? { cause: row.cause, proposedFix: row.proposedFix, needsHuman: row.needsHuman !== 0 } : null;
}

function latestTriageCause(db: Db, incidentId: number): string | null {
  const row = db.prepare("SELECT detail FROM fleet_events WHERE incident_id = ? AND kind = 'triage' ORDER BY id DESC LIMIT 1").get(incidentId) as { detail: string } | undefined;
  return row?.detail ? row.detail : null;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`;
}

function sentence(text: string): string {
  const clean = clip(text, 400);
  return /[.!?]$/.test(clean) ? clean : `${clean}.`;
}

/** A time in the policy timezone, for example `2026-11-03 01:10 -07:00`. */
export function stamp(iso: string, timezone: string): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return iso;
  const offset = timezone === "local" ? -at.getTimezoneOffset() : minutesOf(timezone);
  const zoned = new Date(at.getTime() + offset * 60_000);
  const label = timezone === "local" ? "local time" : timezone;
  return `${zoned.toISOString().slice(0, 10)} ${zoned.toISOString().slice(11, 16)} ${label}`;
}

function minutesOf(timezone: string): number {
  const match = /^([+-])(\d{2}):(\d{2})$/.exec(timezone);
  return match ? (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
}

function times(count: number): string {
  return count === 1 ? "once" : `${count} times`;
}

function judgement(incident: FleetIncident, note: ComponentNote | null, occurrences: number, triage: string | null): string {
  const parts: string[] = [];
  if (incident.failureClass === "alert-quality") parts.push(`Probably a false alarm: ${WHY["alert-quality"]}.`);
  else if (occurrences >= FLAPPING_AT) parts.push(`Real but unstable. It cleared and came back ${times(occurrences)} in the last 24 hours, so the check or the service is flapping.`);
  else parts.push(`Looks real: ${WHY[incident.failureClass]}.`);
  if (note?.falseAlarm) parts.push(`It can be a false alarm when ${clip(note.falseAlarm, 300).replace(/\.$/, "")}.`);
  if (triage) parts.push(`Triage said: ${clip(triage, 160)}.`);
  return parts.join(" ");
}

function nextStep(kind: ExplainKind, incident: FleetIncident, note: ComponentNote | null, finding: ExplainFinding | null): string {
  if (kind === "recovered") return "Nothing to do. Scout messages you again if it comes back, up to the daily limit.";
  if (finding?.proposedFix) return `The investigation proposes this fix. ${sentence(finding.proposedFix)}`;
  if (note?.nextStep) return sentence(note.nextStep);
  if (incident.runbook) return `Follow the runbook. ${sentence(incident.runbook)}`;
  if (finding?.needsHuman) return "The investigation found no clear answer, so a person needs to look.";
  return "Tap Investigate to have Scout look into it, or tap Snooze or Mute if you already know about it.";
}

/** The message body for an incident notice: what happened, real or false alarm and why, how often, who owns it, and what to do next. */
export function explainIncident(input: ExplainInput): string {
  const { db, incident, now, notes, policy, kind } = input;
  const note = findNote(notes, incident.host, incident.component);
  const since = new Date(Date.parse(now) - DAY_MS).toISOString();
  const occurrences = Math.max(1, occurrencesSince(db, incident.id, since));
  const finding = latestFinding(db, incident.id);
  const triage = latestTriageCause(db, incident.id);
  const lines: string[] = [];
  if (kind === "recovered") {
    lines.push(`What happened: it recovered after ${policy.resolveAfterCleanChecks} clean ${policy.resolveAfterCleanChecks === 1 ? "check" : "checks"} in a row. Before that it reported: ${sentence(incident.summary)}`);
  } else {
    lines.push(`What happened: ${sentence(incident.summary)}`);
  }
  if (note) lines.push(`What it is: ${sentence(note.description)}`);
  if (kind !== "recovered") lines.push(`Real or false alarm: ${judgement(incident, note, occurrences, triage)}`);
  lines.push(`How often: ${times(occurrences)} in the last 24 hours, first seen ${stamp(incident.firstSeen, policy.quietHours.timezone)}.`);
  lines.push(`Owner: ${incident.ownerChat ?? "none assigned"}.`);
  if (finding?.cause && kind !== "recovered") lines.push(`Investigation found: ${sentence(finding.cause)}`);
  lines.push(`Next step: ${nextStep(kind, incident, note, finding)}`);
  if (kind === "capped") {
    const state = incident.state === "resolved" ? "Currently recovered" : "Still open";
    lines.push(`${state}, ${times(occurrences)} in the last 24 hours. It is muted until tomorrow, and the next digest still lists it.`);
  }
  return lines.join("\n");
}

/** Whether an incident has happened often enough in a day to count as flapping. */
export function isFlapping(db: Db, incidentId: number, now: string): boolean {
  return occurrencesSince(db, incidentId, new Date(Date.parse(now) - DAY_MS).toISOString()) >= FLAPPING_AT;
}
