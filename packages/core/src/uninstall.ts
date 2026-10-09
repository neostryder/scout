import type { Db } from "./db.ts";
import type { ControlRow } from "./control.ts";
import { broadLocation } from "./descriptions.ts";

export interface UninstallInstall { ecosystem: string; key: string; location: string }
export interface UninstallInstructions { available: boolean; title: string; steps: string[]; leftovers: string[]; note: string; command: string | null }

export function joinedInstall(db: Db, row: ControlRow): UninstallInstall | null {
  const windows = row.kind !== "launchd" && /^[a-z]:[/\\]/i.test(row.program ?? "");
  const normalize = (path: string): string => { const v = path.replace(/\\/g, "/").replace(/\/+$/, ""); return windows ? v.toLowerCase() : v; };
  const program = normalize(row.program ?? "");
  const installs = db.prepare("SELECT p.ecosystem, p.key, i.location FROM installs i JOIN packages p ON p.id = i.package_id WHERE i.machine_id = ? AND i.removed_at IS NULL").all(row.machineId) as unknown as UninstallInstall[];
  return installs.filter((i) => { const root = normalize(i.location); return !broadLocation(root) && (program === root || program.startsWith(`${root}/`)); }).sort((a, b) => b.location.length - a.location.length)[0] ??
    installs.find((i) => row.kind === "launchd" && i.ecosystem === "launchd" && i.key === row.name && i.location === row.plist) ?? null;
}

export function uninstallInstructions(row: ControlRow, install: UninstallInstall | null = null): UninstallInstructions {
  const label = row.displayName ?? row.name;
  const result: UninstallInstructions = { available: true, title: `How to remove ${label}`, steps: [], leftovers: [], note: "Scout never runs an uninstall.", command: null };
  const key = install?.key ?? "";
  if (install && /^(?:@?[A-Za-z0-9][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9][A-Za-z0-9._+-]*)?)$/.test(key) && !key.includes("..")) {
    switch (install.ecosystem) {
      case "winget": result.command = `winget uninstall --id ${key}`; break;
      case "msstore": result.command = `winget uninstall --id ${key} --source msstore`; break;
      case "brew": result.command = `brew uninstall ${key}`; break;
      case "cask": result.command = `brew uninstall --cask ${key}`; result.leftovers.push(`Homebrew keeps application data; brew uninstall --cask --zap ${key} also removes the cask's listed data.`); break;
      case "npm": result.command = `npm uninstall -g ${key}`; break;
      case "pipx": result.command = `pipx uninstall ${key}`; break;
      case "uv-tool": result.command = `uv tool uninstall ${key}`; break;
    }
  }
  if (result.command) result.steps.push(`You can quit ${label}.`, `You can run ${result.command} in a terminal.`);
  else if (row.kind === "launchd" && row.plist) result.steps.push(`You can quit ${label}.`, `You can remove the launchd plist at ${row.plist}.`, `You can remove the program at ${row.program ?? "the path named in the plist"}.`);
  else if (row.kind === "windows-service" && /^[A-Za-z0-9._-]+$/.test(row.name) && !row.name.includes("..")) {
    result.command = `sc.exe delete ${row.name}`;
    result.steps.push(`You can stop ${label} using its installer or administrator tools.`, `An administrator can run ${result.command} only after checking the vendor's removal instructions.`);
    result.leftovers.push("Deleting a service registration leaves its program and data files in place and can break its installer.");
  } else if (install) result.steps.push(`You can quit ${label}.`, `You can use the vendor's uninstaller for the install at ${install.location}.`);
  else { result.available = false; result.steps = []; }
  if (row.kind === "launchd") result.leftovers.push(`Application data can remain in ~/Library/Application Support/${label} and preferences in ~/Library/Preferences/${row.name}.plist; system installs can also use /Library.`);
  else if (install) result.leftovers.push(`The uninstaller can leave settings and application data outside ${install.location}.`);
  return result;
}
