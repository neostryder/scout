// The machine that runs the hub and the cli. Other machines are reached through a transport; this one is read directly.
// The hub and the cli set it at startup from machines.json (the machine with a local transport); tests use the default.
let hubId = "hub";
let hubName = "Hub";

export function hubMachineId(): string { return hubId; }
export function hubMachineName(): string { return hubName; }
export function setHubMachine(id: string, name?: string): void { hubId = id; hubName = name ?? id; }

/** The machine whose transport is local, or null when machines.json has none. */
export function findHubMachine<T extends { id: string; transport: { type: string } }>(machines: readonly T[]): T | null {
  return machines.find((machine) => machine.transport.type === "local") ?? null;
}
