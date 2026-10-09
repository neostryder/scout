import { acknowledgeAlerts, alertMutes, alertsFileReader, alertsResponse, loadTunnelHosts, refreshAlertMutes, setAlertMute, type AlertOptions, type Db } from "@scout/core";

export function alertsCommand(db: Db, args: string[], options: { write?: (line: string) => void; alerts?: AlertOptions } = {}): void {
  const write = options.write ?? console.log;
  const config = options.alerts ?? { loadMutes: alertsFileReader(".scout-data/alerts.json"), tunnelHosts: loadTunnelHosts(".scout-data/tunnel-hosts.json") };
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    const result = args[index + 1];
    if (!result || result.startsWith("--")) throw new Error(`${name} requires a value`);
    return result;
  };
  const command = args[0];
  refreshAlertMutes(db, config);
  if (command === "ack") {
    const id = args[1];
    if (args.includes("--all") && id !== "--all") throw new Error("ack requires an id or --all");
    const changes = acknowledgeAlerts(db, args.includes("--all") ? { all: true, ...(value("--kind") ? { kind: value("--kind") } : {}) } : { id: Number(id) });
    if (changes === null) throw new Error("not found");
    write(JSON.stringify({ acknowledged: changes.length }));
    return;
  }
  if (command === "mute" || command === "unmute") {
    setAlertMute(db, { key: args[1], ...(command === "unmute" ? { remove: true } : { reason: value("--reason") ?? "" }) });
    refreshAlertMutes(db, config);
    write(JSON.stringify({ mutes: alertMutes(db, config.loadMutes?.()) }));
    return;
  }
  if (command !== undefined && !command.startsWith("--")) throw new Error("alerts requires ack, mute, unmute or list filters");
  const params = new URLSearchParams();
  for (const name of ["state", "kind", "machine"]) {
    const filter = value(`--${name}`);
    if (filter !== undefined) params.set(name, filter);
  }
  write(JSON.stringify(alertsResponse(db, params, new Date().toISOString(), config)));
}
