import type { Db } from "./db.ts";

/** A row that was present for less than this long before it went away was short-lived: an ephemeral socket, a per-connection launchd job. */
export const SHORT_LIVED_MS = 60 * 60 * 1000;
/** A short-lived row is kept this long after it goes away; the events table keeps the history after that. */
export const SHORT_LIVED_KEEP_MS = 2 * 60 * 60 * 1000;

export interface Pruned { listeners: number; services: number }

const WATCH_LISTENER = "'listener:' || machine_id || ':' || port || ':' || COALESCE(process_name, container_name, 'unknown')";
const WATCH_SERVICE = "'service:' || machine_id || ':' || kind || ':' || domain || ':' || name";

/** Ephemeral ports are reused, so one row is revived again and again and its first_seen_at ends up days old. The port range marks them where the row's lifetime cannot. */
export const EPHEMERAL_PORT_MIN = 49152;

function gate(table: "listeners" | "services", targetType: "listener" | "service", watchKey: string, ephemeral: string): string {
  return `DELETE FROM ${table}
     WHERE gone_at IS NOT NULL AND gone_at < ? AND expected_down = 0
       AND ((julianday(gone_at) - julianday(first_seen_at)) * 86400000 < ?${ephemeral})
       AND id NOT IN (SELECT target_id FROM alerts WHERE state <> 'resolved' AND target_type = '${targetType}' AND target_id IS NOT NULL)
       AND (${watchKey}) NOT IN (SELECT key FROM watch_state)`;
}

/**
 * Deletes listener and service rows that were present for under an hour, or that sat on an ephemeral port without a container, and have been gone for two hours. Ephemeral sockets and per-connection launchd jobs
 * otherwise pile up by the tens of thousands, and every live read, tray response and outage pass loads all of them. A row marked expected down, one that an unresolved alert targets, or one that
 * the outage watch tracks is kept, and so is any other row that lasted an hour or more: a real service that was removed stays in the catalog.
 */
export function pruneShortLived(db: Db, now: string = new Date().toISOString()): Pruned {
  const cutoff = new Date(Date.parse(now) - SHORT_LIVED_KEEP_MS).toISOString();
  db.exec("BEGIN IMMEDIATE");
  try {
    const listeners = Number(db.prepare(gate("listeners", "listener", WATCH_LISTENER, ` OR (port >= ${EPHEMERAL_PORT_MIN} AND container_name IS NULL)`)).run(cutoff, SHORT_LIVED_MS).changes);
    const services = Number(db.prepare(gate("services", "service", WATCH_SERVICE, "")).run(cutoff, SHORT_LIVED_MS).changes);
    db.exec("COMMIT");
    return { listeners, services };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
