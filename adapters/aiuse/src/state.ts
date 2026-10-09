export interface DayCount { tool: string; date: string; count: number; lastSeen: string }
export interface FileState {
  pathHash: string;
  size: number;
  offset: number;
  prefixLength: number;
  prefixHash: string;
  days: DayCount[];
}
export interface Checkpoint { files: Record<string, FileState> }

export function cleanCheckpoint(input: unknown): Checkpoint {
  const result: Checkpoint = { files: {} };
  if (!input || typeof input !== "object" || !("files" in input) || !input.files || typeof input.files !== "object") return result;
  for (const [id, raw] of Object.entries(input.files)) {
    if (!/^[a-f0-9]{24}$/.test(id) || !raw || typeof raw !== "object") continue;
    const file = raw as FileState;
    if (!/^[a-f0-9]{24}$/.test(file.pathHash) || !/^[a-f0-9]{64}$/.test(file.prefixHash) || ![file.size, file.offset, file.prefixLength].every((n) => Number.isSafeInteger(n) && n >= 0) || file.offset > file.size || file.prefixLength > 64 || file.prefixLength > file.size || !Array.isArray(file.days)) continue;
    const days = file.days.filter((day) => day && typeof day.tool === "string" && /^[a-zA-Z0-9_][a-zA-Z0-9_.+-]*$/.test(day.tool) && typeof day.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day.date) && Number.isSafeInteger(day.count) && day.count > 0 && typeof day.lastSeen === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(day.lastSeen) && Number.isFinite(Date.parse(day.lastSeen)) && day.lastSeen.slice(0, 10) === day.date).map(({ tool, date, count, lastSeen }) => ({ tool, date, count, lastSeen }));
    result.files[id] = { pathHash: file.pathHash, size: file.size, offset: file.offset, prefixLength: file.prefixLength, prefixHash: file.prefixHash, days };
  }
  return result;
}

export function aggregateDays(state: Checkpoint, now: string): { tool: string; count7: number; count30: number; lastSeen: string; days: DayCount[] }[] {
  const today = now.slice(0, 10);
  const cutoff = (days: number) => new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const tools = new Map<string, DayCount[]>();
  for (const file of Object.values(state.files)) {
    for (const day of file.days) {
      if (day.date > today) continue;
      const name = day.tool.toLowerCase();
      const days = tools.get(name) ?? [];
      days.push({ ...day, tool: name });
      tools.set(name, days);
    }
  }
  return [...tools].sort(([a], [b]) => a.localeCompare(b)).map(([tool, readings]) => {
    const dates = new Map<string, DayCount>();
    for (const reading of readings) {
      const old = dates.get(reading.date);
      dates.set(reading.date, { ...reading, count: reading.count + (old?.count ?? 0), lastSeen: old && old.lastSeen > reading.lastSeen ? old.lastSeen : reading.lastSeen });
    }
    const days = [...dates.values()].sort((a, b) => a.date.localeCompare(b.date));
    return { tool, count7: days.filter((d) => d.date >= cutoff(7)).reduce((n, d) => n + d.count, 0), count30: days.filter((d) => d.date >= cutoff(30)).reduce((n, d) => n + d.count, 0), lastSeen: days.at(-1)!.lastSeen, days };
  });
}
