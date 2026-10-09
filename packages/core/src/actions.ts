import type { Db } from "./db.ts";
import type { ControlAction, ControlMechanism, ControlTarget } from "./control.ts";

export type ActionState = "running" | "done" | "failed" | "waiting" | "confirmed" | "expired" | "declined";
export interface ActionRecord {
  id: number; at: string; finishedAt: string | null; machineId: string; target: ControlTarget; rowId: number; name: string;
  action: ControlAction; hard: boolean; mechanism: ControlMechanism; command: string; admin: "none" | "uac" | "sudo";
  state: ActionState; exitCode: number | null; message: string | null;
}
const SELECT = `SELECT id, at, finished_at AS finishedAt, machine_id AS machineId, target, row_id AS rowId, name, action, hard, mechanism, command, admin, state, exit_code AS exitCode, message FROM actions`;
const record = (row: Omit<ActionRecord, "hard"> & { hard: number }): ActionRecord => ({ ...row, hard: row.hard !== 0 });

export function actionById(db: Db, id: number): ActionRecord | null {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as (Omit<ActionRecord, "hard"> & { hard: number }) | undefined;
  return row ? record(row) : null;
}

export function listActions(db: Db, options: { machine?: string; limit?: number } = {}): ActionRecord[] {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Math.min(200, Math.floor(options.limit!))) : 50;
  return (db.prepare(`${SELECT} WHERE (? IS NULL OR machine_id = ?) ORDER BY id DESC LIMIT ?`).all(options.machine ?? null, options.machine ?? null, limit) as (Omit<ActionRecord, "hard"> & { hard: number })[]).map(record);
}

export function createAction(db: Db, row: Omit<ActionRecord, "id">, plan: unknown): ActionRecord {
  const id = Number(db.prepare(`INSERT INTO actions (at, finished_at, machine_id, target, row_id, name, action, hard, mechanism, command, admin, state, exit_code, message, plan_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.at, row.finishedAt, row.machineId, row.target, row.rowId, row.name, row.action, row.hard ? 1 : 0, row.mechanism, row.command, row.admin, row.state, row.exitCode, row.message, JSON.stringify(plan)).lastInsertRowid);
  return actionById(db, id)!;
}

export function finishAction(db: Db, id: number, state: ActionState, at: string, exitCode: number | null, message: string): ActionRecord {
  db.prepare("UPDATE actions SET state = ?, finished_at = ?, exit_code = ?, message = ? WHERE id = ?").run(state, at, exitCode, message.slice(0, 500), id);
  return actionById(db, id)!;
}
