import { portsFileReader, portsResponse, type Db } from "@scout/core";

export function portsCommand(db: Db, args: string[], options: { portsPath?: string; write?: (line: string) => void } = {}): void {
  const write = options.write ?? console.log;
  const response = portsResponse(db, portsFileReader(options.portsPath)());
  if (args[0] === "next") {
    if (!args[1] || args[1].startsWith("--")) throw new Error("ports next requires a range");
    const range = response.ranges.find((row) => row.name === args[1]);
    if (!range) throw new Error("unknown range");
    if (range.next === null) throw new Error("range is full");
    write(String(range.next));
    return;
  }
  if (args[0] && args[0] !== "--db") throw new Error("ports requires next or no subcommand");
  const clip = (value: unknown, width: number): string => String(value ?? "-").replace(/\s+/g, " ").slice(0, width).padEnd(width + 2);
  write(`${clip("Range", 32)}${clip("Ports", 14)}${clip("Used", 8)}Next`);
  for (const range of response.ranges) write(`${clip(range.name, 32)}${clip(`${range.from}-${range.to}`, 14)}${clip(`${range.usedCount}/${range.size}`, 8)}${range.next ?? "-"}`);
  write(`\n${clip("Port", 8)}${clip("Reserved for", 32)}${clip("State", 12)}By`);
  for (const entry of response.reserved) write(`${clip(entry.port, 8)}${clip(entry.name, 32)}${clip(entry.state, 12)}${entry.by ?? "-"}`);
  for (const clash of response.clashes) write(`${clash.kind}: ${clash.detail}`);
  if (response.file.error) write(response.file.error);
}
