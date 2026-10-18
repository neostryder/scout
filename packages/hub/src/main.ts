#!/usr/bin/env node
// Start the hub on loopback. Usage: node packages/hub/src/main.ts [--port 4870] [--db path] [--production] [--no-jobs] [--no-control] [--schedule] [--no-schedule] [--no-models] [--schedule-models] [--live] [--no-live] [--no-cloudflare] [--cloudflare-secret KEY] [--no-watch] [--watch-interval SECONDS]
// The outage watch runs wherever live reads run (--production or --live) and checks every machine, public hostname and service every 2 minutes; --no-watch turns it off.
// Notices go to the Discord webhook in SCOUT_DISCORD_WEBHOOK, when set, and to a desktop notification on this machine.
// Models are off unless SCOUT_AI_TOOLKIT is set (see models.ts). The discovery button and the release-note refresh route use one on request; --no-models removes it. Release-note summaries and vendor-page reading spend model quota on their own schedule only with --schedule-models.
// --production answers only the public host in access.json and only requests that carry a valid Cloudflare Access
// token. The tunnel (cloudflared on this machine) is the only thing that should reach it; it still listens on loopback.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { backupHealthSettingsReader, meterAlertsFileReader, openCatalog, readBackupHealthFile } from "@scout/core";
import { certsKeySource, type AccessConfig } from "./access.ts";
import { CloudflareSchedule } from "./cloudflare.ts";
import { createHub } from "./server.ts";
import { configureHubMachine, loadMachines, lookupCloudflareSecrets, readCloudflare, watchMachines } from "@scout/ops";
import { LiveSchedule, type LiveMachineConfig } from "./live.ts";
import { ResearchSchedule } from "./schedule.ts";
import { changelogSummarizer, createAiModelRunner, vendorVersionExtractor } from "./models.ts";
import { summarizeChangelogs } from "@scout/research";
import { DescriptionRun } from "./descriptions.ts";
import { configuredProjects, createProjectDescriptionSource } from "./descriptions-project.ts";
import { healthOptionsFromArgs } from "./health.ts";
import { HubWatch, WATCH_INTERVAL_MS } from "./watch.ts";
import { MeterSchedule } from "./meters.ts";
import { HubMeterAlerts } from "./meter-alerts.ts";
import { Notifier } from "./notify.ts";

function liveMachineList(path: string): LiveMachineConfig[] {
  return loadMachines(path).map((machine) => {
    const row = machine as typeof machine & { name?: unknown; os?: unknown };
    const os = row.os;
    if (typeof row.name !== "string" || (os !== "windows" && os !== "macos" && os !== "linux")) throw new Error(`machines.json entry ${machine.id} needs a name and an os`);
    return { id: machine.id, name: row.name, os, transport: machine.transport };
  });
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
configureHubMachine(resolve(root, "machines.json"));
const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const port = Number(opt("--port") ?? 4870);
const health = healthOptionsFromArgs(args);
const db = openCatalog(resolve(opt("--db") ?? `${root}/.scout-data/catalog.db`));
let access: Parameters<typeof createHub>[0]["access"];
if (args.includes("--production")) {
  const config = JSON.parse(readFileSync(resolve(opt("--access") ?? `${root}/access.json`), "utf8")) as AccessConfig;
  access = { config, keys: certsKeySource(config.teamDomain), log: (line) => console.error(`[access] ${line}`) };
}
const jobs = args.includes("--no-jobs") ? undefined : { machines: loadMachines(resolve(root, "machines.json")) };
const protectedPath = resolve(root, ".scout-data/protected.json");
const control = args.includes("--no-control") ? false : { machines: liveMachineList(resolve(root, "machines.json")), protectedPath };
// Live reads run with --production or --live. --no-live leaves them off. A development hub stays off so it does not open ssh by itself.
const liveOn = !args.includes("--no-live") && (args.includes("--production") || args.includes("--live"));
const live = liveOn ? new LiveSchedule(db, { machines: liveMachineList(resolve(root, "machines.json")) }) : undefined;
// Resource meters are sampled wherever live reads run, over the same transports; --no-meters turns them off.
const meterAlertsPath = resolve(root, ".scout-data/meter-alerts.json");
const meterAlerts = liveOn && !args.includes("--no-meters") ? new HubMeterAlerts(db, { settings: meterAlertsFileReader(meterAlertsPath), path: meterAlertsPath, notifier: new Notifier(), log: (line) => console.error(line) }) : undefined;
const meters = liveOn && !args.includes("--no-meters") ? new MeterSchedule(db, { machines: () => liveMachineList(resolve(root, "machines.json")).map(({ id, os, transport }) => ({ id, os, transport })), log: (line) => console.error(line), ...(meterAlerts ? { afterCycle: () => meterAlerts.check() } : {}) }) : undefined;
// The Galadriel backup writes a health file on the hub machine; a missing file means it is not installed and raises nothing. Alerts need live reads, like the outage watch.
const backupSettings = backupHealthSettingsReader(resolve(root, ".scout-data/backup-health.json"));
const backup = liveOn ? { read: () => readBackupHealthFile(backupSettings()), notifier: new Notifier(), log: (line: string) => console.error(line) } : undefined;
const watchSeconds = Number(opt("--watch-interval") ?? WATCH_INTERVAL_MS / 1000);
if (!Number.isInteger(watchSeconds) || watchSeconds < 30) throw new Error("watch interval must be an integer of at least 30 seconds");
const watch = liveOn && !args.includes("--no-watch") ? new HubWatch(db, { intervalMs: watchSeconds * 1000, machines: () => watchMachines(loadMachines(resolve(root, "machines.json"))), configPath: resolve(root, ".scout-data/watch.json"), heartbeatPath: resolve(root, ".scout-data/heartbeat.json") }) : undefined;
const cloudflareOn = liveOn && !args.includes("--no-cloudflare");
const cloudflareSecret = opt("--cloudflare-secret");
// The lookup errors name the failure and never a value, so the reason is safe to print.
const cloudflare = cloudflareOn ? await lookupCloudflareSecrets({ env: process.env, ...(cloudflareSecret ? { secretName: cloudflareSecret } : {}) }).catch((err: unknown) => { console.log(`cloudflare reader off: ${err instanceof Error ? err.message : "lookup failed"}`); return null; }) : null;
if (cloudflareOn && !cloudflare) console.log(`cloudflare reader off: no token found (bws login ${process.env.BWS_ACCESS_TOKEN ? "is" : "is not"} in this process environment)`);
const cloudflareSchedule = cloudflare ? new CloudflareSchedule(db, { read: () => readCloudflare(db, { token: cloudflare.token, accountId: cloudflare.accountId }) }) : undefined;
const model = args.includes("--no-models") || !process.env["SCOUT_AI_TOOLKIT"] ? null : createAiModelRunner();
const project = model ? await createProjectDescriptionSource({ dataDir: resolve(root, ".scout-data"), machinesPath: resolve(root, "machines.json") }) : undefined;
const descriptions = model ? new DescriptionRun(db, { model, modelLabel: model.labels.public, project }) : undefined;
const modelsOnSchedule = model !== null && args.includes("--schedule-models");
const research = new ResearchSchedule(db, model && modelsOnSchedule ? { runOptions: { extractVersion: vendorVersionExtractor(model) } } : {});
const scheduled = !args.includes("--no-schedule") && (access || args.includes("--schedule"));
if (scheduled) research.start();
// Release-note summaries run a few minutes after start and then daily, a small batch each time, only where the schedule runs.
const summaries = model && scheduled && modelsOnSchedule ? [setTimeout(() => void summarizeChangelogs(db, { summarize: changelogSummarizer(model) }).catch(() => {}), 600_000), setInterval(() => void summarizeChangelogs(db, { summarize: changelogSummarizer(model) }).catch(() => {}), 86_400_000)] : [];
const server = createHub({ db, recipeProjects: () => configuredProjects(resolve(root, "machines.json")), ...(meters ? { meters } : {}), ...(meterAlerts ? { meterAlerts } : {}), ...(backup ? { backup } : {}), webRoot: resolve(root, "packages/web/public"), research, control, protectedPath, minePath: resolve(root, ".scout-data/mine.json"), trayPath: resolve(root, ".scout-data/tray.json"), portsPath: resolve(root, ".scout-data/ports.json"), stacksPath: resolve(root, ".scout-data/stacks.json"), health, ...(watch ? { watch } : {}), alerts: { alertsPath: resolve(root, ".scout-data/alerts.json"), coalesceMs: 2000 }, ...(model ? { changelog: { summarize: changelogSummarizer(model) }, discoverModel: model } : {}), ...(descriptions ? { descriptions } : {}), ...(access ? { access } : {}), ...(jobs ? { jobs } : {}), ...(live ? { live } : {}), ...(cloudflareSchedule ? { cloudflare: cloudflareSchedule } : {}), tunnelHostsPath: resolve(root, ".scout-data/tunnel-hosts.json") });
live?.start();
cloudflareSchedule?.start();
server.once("close", () => { research.stop(); live?.stop(); cloudflareSchedule?.stop(); for (const timer of summaries) clearTimeout(timer); });
server.listen(port, "127.0.0.1", () => console.log(`scout hub listening on http://127.0.0.1:${port}/${access ? ` (production, host ${access.config.host})` : ""}`));
