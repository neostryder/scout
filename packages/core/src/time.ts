/** Local date and time to the second, such as "2026-10-10 15:26:03 MST", in the zone of the machine running Scout. A value that is not a timestamp comes back unchanged. */
export function formatLocal(iso: string, zone?: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const parts = new Intl.DateTimeFormat("en-US", { ...(zone ? { timeZone: zone } : {}), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "short" }).formatToParts(ms);
  const part = (type: string): string => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")} ${part("timeZoneName")}`;
}

/** The parenthetical every alert carries: whole minutes from the last successful check to the moment of the alert. */
export function sinceLastCheck(lastOkAt: string | null | undefined, at: string): string {
  const last = lastOkAt ? Date.parse(lastOkAt) : NaN;
  const now = Date.parse(at);
  if (!Number.isFinite(last) || !Number.isFinite(now)) return "(no successful check on record)";
  const minutes = Math.max(0, Math.round((now - last) / 60_000));
  return `(${minutes} ${minutes === 1 ? "minute" : "minutes"} since the last successful check)`;
}
