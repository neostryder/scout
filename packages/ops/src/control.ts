import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { hubMachineId, hubMachineName, actionById, controlRow, createAction, finishAction, isProtected, listListeners, listRoutes, listServices, loadTunnelHosts, protectedFileReader, recordListeners, recordServices, rowControl, runArgv, startupEnabled, type ActionRecord, type ControlAction, type ControlMechanism, type ControlRow, type ControlTarget, type Db, type Exec, type ProtectedContext, type Transport } from "@scout/core";
import { detectRecipes, recipeById, validateRecipe } from "@scout/core";
import { resolveStack, stacksFileReader, type ResolvedStackMember } from "@scout/core";
import { windowsListenersAdapter } from "@scout/adapter-listeners";
import { windowsTasksAdapter } from "@scout/adapter-services";
import { notifyServiceRead, readLive } from "./live.ts";

export interface ControlMachine { id: string; transport: Transport; os?: "windows" | "macos" | "linux" }
export interface ControlPlan {
  allowed: boolean; refusal: string | null; refusalKind: "protected" | "unsupported" | "unavailable" | "unknown" | null;
  id: string | null; token: string | null; expiresAt: string | null;
  machineId: string; machineName: string; target: ControlTarget; rowId: number; name: string; displayName: string | null;
  action: ControlAction; hard: boolean; mechanism: ControlMechanism | null; command: string; admin: "none" | "uac" | "sudo";
  sudoCommand: string | null; graceful: boolean; waitSeconds: number; effects: string[]; whatBreaks: string | null;
  steps?: { order: number; label: string; type: "service" | "recipe"; command: string; skipped: boolean; allowed: boolean; refusal: string | null }[];
}
interface PlannedMember { member: ResolvedStackMember; row: ControlRow | null; plan: PrivateControlPlan | null; fingerprint: string | null }
export interface PrivateControlPlan extends ControlPlan { argv: string[]; env: Record<string, string>; transport: Transport | null; stackMembers?: PlannedMember[] }
export interface ControlPlanOptions { target?: ControlTarget; hard?: boolean; machine: ControlMachine | null; context?: ProtectedContext; effects?: string[]; stackMembers?: PlannedMember[] }

const ERROR = "$ErrorActionPreference = 'Stop'; ";
// The inventory replaces the profile name with USER, so identity checks resolve only the current account's profile.
const WINDOWS_PATH = "$expected = [string]$env:SCOUT_PATH; $expected = $expected.Replace([char]92, [char]47); if ($expected -imatch '^[A-Za-z]:/Users/USER/') { $scoutProfile = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile).Replace([char]92, [char]47); $expected = $scoutProfile + '/' + ($expected -replace '^[A-Za-z]:/Users/USER/', '') }; ";
export const WINDOWS_CONTROL = {
  start: `${ERROR}Start-Service -Name $env:SCOUT_NAME -ErrorAction Stop`,
  stop: `${ERROR}Stop-Service -Name $env:SCOUT_NAME -ErrorAction Stop`,
  restart: `${ERROR}Restart-Service -Name $env:SCOUT_NAME -ErrorAction Stop`,
  hard: `${ERROR}${WINDOWS_PATH}$before = Get-CimInstance Win32_Service | Where-Object { $_.Name -eq $env:SCOUT_NAME }; if ($env:SCOUT_PID -and (!$before -or $before.ProcessId -ne [int]$env:SCOUT_PID)) { exit 3 }; Stop-Service -Name $env:SCOUT_NAME -Force -NoWait -ErrorAction Stop; if ($env:SCOUT_PID) { $after = Get-CimInstance Win32_Service | Where-Object { $_.Name -eq $env:SCOUT_NAME }; if ($after.ProcessId -eq [int]$env:SCOUT_PID -and $after.State -ne 'Stopped') { $proc = Get-Process -Id ([int]$env:SCOUT_PID) -ErrorAction SilentlyContinue; if ($proc -and $proc.Path -and $proc.Path.Replace([char]92, [char]47) -ieq $expected) { Stop-Process -Id ([int]$env:SCOUT_PID) -Force -ErrorAction Stop } else { exit 3 } } }`,
};
export const TASK_CONTROL = {
  start: `${ERROR}Start-ScheduledTask -TaskPath $env:SCOUT_TASK_PATH -TaskName $env:SCOUT_NAME -ErrorAction Stop`,
  stop: `${ERROR}Stop-ScheduledTask -TaskPath $env:SCOUT_TASK_PATH -TaskName $env:SCOUT_NAME -ErrorAction Stop`,
  restart: `${ERROR}Stop-ScheduledTask -TaskPath $env:SCOUT_TASK_PATH -TaskName $env:SCOUT_NAME -ErrorAction Stop; Start-ScheduledTask -TaskPath $env:SCOUT_TASK_PATH -TaskName $env:SCOUT_NAME -ErrorAction Stop`,
  disable: `${ERROR}Disable-ScheduledTask -TaskPath $env:SCOUT_TASK_PATH -TaskName $env:SCOUT_NAME -ErrorAction Stop | Out-Null; Stop-ScheduledTask -TaskPath $env:SCOUT_TASK_PATH -TaskName $env:SCOUT_NAME -ErrorAction SilentlyContinue`,
  enable: `${ERROR}Enable-ScheduledTask -TaskPath $env:SCOUT_TASK_PATH -TaskName $env:SCOUT_NAME -ErrorAction Stop | Out-Null`,
};
// Disable turns the job off for good and unloads it now; a job that is not loaded makes bootout fail, which is fine. Enable loads the job again when its plist is known.
export const LAUNCHD_STARTUP = {
  disable: `launchctl disable "$1" || exit $?\nlaunchctl bootout "$1" 2>/dev/null\nexit 0`,
  enable: `plist="$3"\ncase "$plist" in /Users/USER/*) plist="$HOME/\${plist#/Users/USER/}" ;; esac\nlaunchctl enable "$1" || exit $?\n[ -z "$plist" ] || launchctl bootstrap "$2" "$plist" 2>/dev/null\nexit 0`,
};
const WINDOWS_IDENTITY = `${ERROR}${WINDOWS_PATH}$proc = Get-Process -Id ([int]$env:SCOUT_PID) -ErrorAction SilentlyContinue; if (!$proc) { exit 0 }; if (!$proc.Path -or $proc.Path.Replace([char]92, [char]47) -ine $expected) { exit 3 }; `;
export const WINDOWS_PROCESS = {
  stop: `${WINDOWS_IDENTITY}if (!$proc.CloseMainWindow()) { 'The process has no main window to close.' }`,
  hard: `${WINDOWS_IDENTITY}Stop-Process -Id ([int]$env:SCOUT_PID) -Force -ErrorAction Stop`,
};
export const MAC_PROCESS = {
  stop: `expected="$2"\ncase "$expected" in /Users/USER/*) expected="$HOME/\${expected#/Users/USER/}" ;; esac\npath=$(/bin/ps -ww -p "$1" -o comm=) || exit 0\n[ "$path" = "$expected" ] || exit 3\n/bin/kill -TERM "$1"`,
  hard: `expected="$2"\ncase "$expected" in /Users/USER/*) expected="$HOME/\${expected#/Users/USER/}" ;; esac\npath=$(/bin/ps -ww -p "$1" -o comm=) || exit 0\n[ "$path" = "$expected" ] || exit 3\n/bin/kill -KILL "$1"`,
};
// RunAs does not reliably inherit custom environment variables, so the fixed child reads data beside its script.
export const UAC_CONTROL = `${ERROR}
$dir = Join-Path ([IO.Path]::GetTempPath()) ([IO.Path]::GetRandomFileName()); [IO.Directory]::CreateDirectory($dir) | Out-Null;
$file = Join-Path $dir 'control.ps1';
$bootstrap = '$ErrorActionPreference = ''Stop''; $data = Get-Content -LiteralPath (Join-Path $PSScriptRoot ''data.json'') -Raw | ConvertFrom-Json -AsHashtable; foreach ($key in $data.Keys) { [Environment]::SetEnvironmentVariable($key, [string]$data[$key], ''Process'') }; ';
$elevated = '$ErrorActionPreference = ''Stop''; [IO.File]::WriteAllText((Join-Path $PSScriptRoot ''accepted''), ''1''); $operation = Join-Path $PSScriptRoot ''operation.ps1''; $p = Start-Process -FilePath ''pwsh'' -NoNewWindow -PassThru -ArgumentList @(''-NoProfile'', ''-NonInteractive'', ''-File'', (''"'' + $operation + ''"'')); if (!$p.WaitForExit(60000)) { $p.Kill(); exit 124 }; exit [int]$p.ExitCode';
try {
  $data = @{ SCOUT_NAME = $env:SCOUT_NAME; SCOUT_TASK_PATH = $env:SCOUT_TASK_PATH; SCOUT_PID = $env:SCOUT_PID; SCOUT_PATH = $env:SCOUT_PATH };
  [IO.File]::WriteAllText((Join-Path $dir 'data.json'), ($data | ConvertTo-Json -Compress));
  [IO.File]::WriteAllText((Join-Path $dir 'operation.ps1'), ($bootstrap + $env:SCOUT_SCRIPT));
  [IO.File]::WriteAllText($file, $elevated);
  $job = Start-Job -ScriptBlock { param($file) try { $p = Start-Process -FilePath 'pwsh' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList @('-NoProfile', '-NonInteractive', '-File', ('"' + $file + '"')); [int]$p.ExitCode } catch { 1223 } } -ArgumentList $file;
  $watch = [Diagnostics.Stopwatch]::StartNew();
  while (!(Wait-Job -Job $job -Timeout 1)) { if (Test-Path -LiteralPath (Join-Path $dir 'accepted')) { break }; if ($watch.Elapsed.TotalSeconds -ge 120) { Stop-Job -Job $job; exit 1223 } };
  if (!(Wait-Job -Job $job -Timeout 65)) { Stop-Job -Job $job; exit 124 };
  $code = Receive-Job -Job $job; if ($null -eq $code) { exit 1223 }; exit [int]$code;
} finally { if ($job) { Remove-Job -Job $job -Force }; Remove-Item -LiteralPath $dir -Recurse -Force }
`;
export const WINDOWS_RECIPE = `${ERROR}$exe = [string]$env:SCOUT_RECIPE_EXE; $found = Get-Command -Name $exe -All -CommandType Application -ErrorAction SilentlyContinue | Where-Object { $_.Extension -match '^\\.(exe|cmd|bat|com)$' } | Select-Object -First 1; if (-not $found) { exit 2 }; $exe = $found.Source; $args = @(ConvertFrom-Json -InputObject $env:SCOUT_RECIPE_ARGS); $cwd = [string]$env:SCOUT_RECIPE_CWD; $proc = if ($args.Count) { Start-Process -FilePath $exe -ArgumentList $args -WorkingDirectory $cwd -WindowStyle Hidden -PassThru } else { Start-Process -FilePath $exe -WorkingDirectory $cwd -WindowStyle Hidden -PassThru }; $proc.Id`;
export const WINDOWS_RECIPE_PID = `${ERROR}$proc = Get-Process -Id ([int]$env:SCOUT_RECIPE_PID) -ErrorAction SilentlyContinue; if ($proc) { 'alive' }`;
const TASK_READ = `${ERROR}$task = Get-ScheduledTask -TaskPath $env:SCOUT_TASK_PATH -TaskName $env:SCOUT_NAME -ErrorAction Stop; $info = $task | Get-ScheduledTaskInfo; $row = [pscustomobject]@{ TaskName = $task.TaskName; TaskPath = $task.TaskPath; State = [string]$task.State; Execute = ($task.Actions | Select-Object -First 1).Execute; Triggers = @(); RunAs = $task.Principal.UserId; LastRun = $info.LastRunTime.ToString('o'); LastResult = $info.LastTaskResult }; ConvertTo-Json -InputObject @($row) -Compress -Depth 3`;
const NAME = /^[A-Za-z0-9._-]+$/;
const validName = (value: string): boolean => NAME.test(value) && !value.includes("..");
const validPid = (value: number | null): boolean => value !== null && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647;
const validPath = (value: string | null): boolean => value === null || value.length <= 4096 && /^(?:[A-Za-z]:[/\\]|\/)/.test(value) && !/[\x00-\x1f\x7f"'`;\$<>|]/.test(value) && !value.replace(/\\/g, "/").split("/").includes("..");
const pwsh = (script: string): string[] => ["pwsh", "-NoProfile", "-NonInteractive", "-Command", script];

// Task names carry spaces and brackets, so they get their own check; wildcard characters are refused because the task cmdlets expand them.
const validTaskSegment = (value: string): boolean => value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f*?[\]"'`;$<>|:\\/]/.test(value) && value.trim() === value && !value.includes("..");

function taskIdentity(name: string): { name: string; path: string } | null {
  const segments = name.replace(/\\/g, "/").replace(/^\//, "").split("/");
  if (!segments.every(validTaskSegment)) return null;
  const task = segments.pop()!;
  return { name: task, path: String.fromCharCode(92) + (segments.length ? segments.join(String.fromCharCode(92)) + String.fromCharCode(92) : "") };
}

export function planControl(row: ControlRow, action: ControlAction, options: ControlPlanOptions): PrivateControlPlan {
  const hard = options.hard === true;
  const machine = options.machine;
  const windows = machine?.os === "windows" || row.kind === "windows-service" || row.kind === "scheduled-task" || /^[a-z]:[/\\]/i.test(row.program ?? "");
  const context = { ...options.context, windows };
  const control = rowControl(row, context);
  const plan: PrivateControlPlan = {
    allowed: true, refusal: null, refusalKind: null, id: null, token: null, expiresAt: null,
    machineId: row.machineId, machineName: row.machineName, target: options.target ?? "service", rowId: row.id, name: row.name, displayName: row.displayName,
    action, hard, mechanism: control.mechanism, command: "", admin: control.needsAdmin ? windows ? "uac" : "sudo" : "none", sudoCommand: null,
    graceful: !hard, waitSeconds: 20, effects: options.effects ?? [], whatBreaks: row.classification.whatBreaks, argv: [], env: {}, transport: machine ? row.machineId === hubMachineId() ? { type: "local" } : machine.transport : null,
  };
  const refuse = (kind: PrivateControlPlan["refusalKind"], reason: string): PrivateControlPlan => ({ ...plan, allowed: false, refusalKind: kind, refusal: reason });
  if (row.stack) {
    const members = options.stackMembers ?? [];
    plan.mechanism = "stack"; plan.admin = members.some((item) => item.plan?.admin === "uac") ? "uac" : "none"; plan.graceful = true;
    plan.stackMembers = members;
    plan.steps = members.map(({ member, plan: own }) => ({ order: member.order, label: member.label, type: member.type, command: own?.command ?? member.detail, skipped: member.running === true, allowed: member.running === true || own?.allowed === true, refusal: member.running === true ? "Already running" : own?.refusal ?? member.reason }));
    plan.command = plan.steps.map((step) => step.command).join("\n");
    plan.effects = members.map(({ member, row: own }) => `${member.order}. ${member.running === true ? "Skip" : "Start"} ${member.label} (${member.type === "recipe" ? own?.recipe?.command ?? member.detail : own?.kind === "scheduled-task" ? "scheduled task" : own?.kind === "windows-service" ? "Windows service" : "launchd job"})${member.waitPort !== null && member.running !== true ? `, then wait for port ${member.waitPort}` : ""}`);
    if (action !== "start" || hard) return refuse("unsupported", "A stack supports Start only.");
    if (!members.length) return refuse("unknown", "No such stack.");
    if (new Set(row.stack.members.map((member) => member.machineId)).size > 1) return refuse("unsupported", "Every member in a stack must be on the same machine.");
    const refused = plan.steps.find((step) => !step.skipped && !step.allowed);
    if (refused) return refuse(members.find((item) => item.member.order === refused.order)?.plan?.refusalKind ?? "unavailable", `${refused.label}: ${refused.refusal}`);
    if (plan.steps.every((step) => step.skipped)) return refuse("unavailable", "Everything in this stack is already running.");
    return plan;
  }
  if (row.recipe) {
    const recipe = row.recipe;
    plan.mechanism = "recipe"; plan.command = recipe.command; plan.admin = "none"; plan.graceful = true;
    plan.effects = [`Runs in ${recipe.cwd}`];
    if (action !== "start" || hard) return refuse("unavailable", "A launch recipe supports Start only.");
    if (!machine || machine.id !== hubMachineId() || machine.transport.type !== "local" || machine.os !== "windows") return refuse("unavailable", "Launch recipes run only on the hub machine, and only when it runs Windows.");
    if (recipe.state !== "approved" || recipe.gone) return refuse("unavailable", recipe.gone ? "The recipe source is gone." : "The recipe needs approval.");
    const detected = detectRecipes({ machineId: recipe.machineId, root: recipe.root, name: recipe.project }).find((item) => item.source === recipe.source && item.name === recipe.name);
    if (!detected || detected.hash !== recipe.hash || detected.port !== recipe.port || detected.detail !== recipe.detail || detected.reason || validateRecipe(recipe.name, recipe.argv)) return refuse("unavailable", "The recipe changed since approval. Scan and review it again.");
    plan.argv = pwsh(WINDOWS_RECIPE);
    plan.env = { SCOUT_RECIPE_EXE: recipe.argv[0]!, SCOUT_RECIPE_ARGS: JSON.stringify(recipe.argv.slice(1)), SCOUT_RECIPE_CWD: recipe.cwd };
    return plan;
  }
  if (!["start", "stop", "restart", "disable", "enable"].includes(action) || hard && action !== "stop") return refuse("unknown", "The action or hard-stop option is invalid.");
  if (action !== "start" && action !== "enable" && isProtected(row, context).protected) return refuse("protected", `${control.actions.find((a) => a.action === action)?.reason}. ${control.protected.reason}`);
  if (!machine || machine.id !== row.machineId) return refuse("unavailable", "The machine is not configured.");
  if (!windows && (machine.os === "linux" || machine.transport.type !== "ssh")) return refuse("unsupported", "This machine has no supported control transport.");
  if (!validPath(row.program) || row.pid !== null && !validPid(row.pid)) return refuse("unknown", "The program path or pid is invalid.");
  if (row.kind === "scheduled-task" ? !taskIdentity(row.name) : !validName(row.name)) return refuse("unknown", "The service name or label is invalid.");
  if (control.mechanism === null) return refuse("unknown", "The process identity is unknown.");
  if (control.mechanism === "process" && action !== "stop") return refuse("unsupported", action === "disable" || action === "enable" ? "Only launchd jobs and scheduled tasks can be disabled or enabled." : "A bare process has no start command.");
  if (row.kind === "launchd" && row.domain === "gui" && (!Number.isSafeInteger(row.uid) || row.uid! < 0)) return refuse("unknown", "The launchd uid is unknown or invalid.");
  const unavailable = control.actions.find((a) => a.action === action)?.reason;
  if (unavailable) return refuse("unavailable", unavailable);
  if (row.kind === "windows-service" && (action === "disable" || action === "enable")) return refuse("unsupported", "Scout cannot disable or enable Windows services yet.");
  if (action === "enable" && row.kind === "launchd" && !validPath(row.plist ?? null)) return refuse("unknown", "The plist path is invalid.");
  if (row.kind === "windows-service") {
    plan.env = { SCOUT_NAME: row.name, SCOUT_PID: row.pid === null ? "" : String(row.pid), SCOUT_PATH: row.program ?? "" };
    plan.argv = pwsh(WINDOWS_CONTROL[hard ? "hard" : action as "start" | "stop" | "restart"]);
    plan.command = `${action === "start" ? "Start" : action === "stop" ? "Stop" : "Restart"}-Service -Name ${row.name}${hard ? " -Force -NoWait" : ""}`;
    if (hard && row.pid !== null) plan.command += `; Stop-Process -Id ${row.pid} -Force only if the service and path still match`;
  } else if (row.kind === "scheduled-task") {
    if (hard) return refuse("unsupported", "Scheduled tasks have no hard-stop command.");
    const task = taskIdentity(row.name)!;
    plan.env = { SCOUT_NAME: task.name, SCOUT_TASK_PATH: task.path };
    plan.argv = pwsh(TASK_CONTROL[action]);
    const command = (verb: string): string => `${verb}-ScheduledTask -TaskPath ${task.path} -TaskName ${task.name}`;
    plan.command = action === "restart" ? `${command("Stop")}; ${command("Start")}` : action === "disable" ? `${command("Disable")}; ${command("Stop")}` : command(action === "start" ? "Start" : action === "enable" ? "Enable" : "Stop");
    if (action === "disable") plan.effects = [...plan.effects, "Its schedule and other triggers are ignored while it is disabled."];
  } else if (row.kind === "launchd") {
    const label = `${row.domain === "system" ? "system" : `gui/${row.uid}`}/${row.name}`;
    const domainTarget = row.domain === "system" ? "system" : `gui/${row.uid}`;
    if (action === "disable" || action === "enable") {
      const plist = action === "enable" && row.plist ? row.plist : "";
      plan.argv = ["zsh", "-c", LAUNCHD_STARTUP[action], "scout-control", label, domainTarget, plist];
      plan.command = action === "disable" ? `launchctl disable ${label}; launchctl bootout ${label}` : `launchctl enable ${label}${plist ? `; launchctl bootstrap ${domainTarget} "${plist}"` : ""}`;
      plan.effects = [...plan.effects, ...action === "disable" ? ["It stays off after you log in or restart, and comes back only when you enable it."] : plist ? ["Scout loads the job right away, and if it is set to run at load, it starts now too."] : ["Scout cannot find this job's plist, so the job will not load until your next login or restart."]];
      if (plan.admin === "sudo") plan.sudoCommand = plan.command.split("; ").map((part) => `sudo ${part}`).join(" && ");
    } else {
      plan.argv = action === "stop" ? ["launchctl", "kill", hard ? "SIGKILL" : "SIGTERM", label] : ["launchctl", "kickstart", ...(action === "restart" ? ["-k"] : []), label];
      plan.command = plan.argv.join(" ");
      if (action === "stop" && row.keepAlive) plan.effects = [...plan.effects, "KeepAlive will start this launchd job again."];
      if (plan.admin === "sudo") plan.sudoCommand = `sudo ${plan.command}`;
    }
  } else {
    if (!validPid(row.pid) || row.program === null) return refuse("unknown", "The process identity is unknown.");
    if (windows) {
      plan.env = { SCOUT_PID: String(row.pid), SCOUT_PATH: row.program };
      plan.argv = pwsh(WINDOWS_PROCESS[hard ? "hard" : "stop"]);
      plan.command = hard ? `Stop-Process -Id ${row.pid} -Force (path checked)` : `CloseMainWindow for pid ${row.pid} (path checked)`;
    } else {
      plan.argv = ["zsh", "-c", MAC_PROCESS[hard ? "hard" : "stop"], "scout-control", String(row.pid), row.program];
      plan.command = `kill -${hard ? "KILL" : "TERM"} ${row.pid} (path checked)`;
    }
  }
  if (plan.admin === "uac") { plan.env.SCOUT_SCRIPT = plan.argv[4]!; plan.argv = pwsh(UAC_CONTROL); }
  return plan;
}

export function publicControlPlan(plan: PrivateControlPlan): ControlPlan {
  const { argv, env, transport, stackMembers, ...publicPlan } = plan;
  return publicPlan;
}

export function resolveControlRow(db: Db, target: ControlTarget, id: number): ControlRow | null {
  if (target === "stack") return null;
  if (target === "recipe") {
    const recipe = recipeById(db, id);
    return recipe ? { id, machineId: recipe.machineId, machineName: hubMachineName(), name: recipe.name, displayName: recipe.project, program: null, pid: null, state: recipe.state, goneAt: recipe.gone ? recipe.lastSeenAt : null, kind: null, domain: "gui", ports: recipe.port === null ? [] : [{ port: recipe.port }], classification: { class: "third-party", vendor: "other", official: false, hidden: false, evidence: [], confidence: "default", whatBreaks: null }, recipe } : null;
  }
  const services = listServices(db);
  const row = target === "service" ? services.find((r) => r.id === id) : listListeners(db).find((r) => r.id === id);
  return row ? controlRow(row, services) : null;
}

function effectsFor(db: Db, row: ControlRow, tunnelHosts?: Record<string, string>): string[] {
  const ports = new Set(row.ports.map((p) => p.port));
  const listeners = listListeners(db, { machine: row.machineId, state: "present" }).filter((l) => row.pid !== null ? l.pid === row.pid : l.processPath !== null && row.program !== null && l.processPath === row.program);
  const ids = new Set(listeners.map((l) => l.id));
  const effects = [...ports].sort((a, b) => a - b).map((port) => `Stops the listener on port ${port}`);
  for (const route of listRoutes(db, tunnelHosts ? { tunnelHosts } : {})) if (route.machineId === row.machineId && route.listener && ids.has(route.listener.id)) effects.push(`The domain ${route.hostname} is served by it`);
  return [...new Set(effects)];
}

export interface ControlClock { now(): number; sleep(ms: number): Promise<void> }
export interface ControlRunnerDeps {
  machines: ControlMachine[];
  exec?: Exec;
  reader?: (machine: ControlMachine, row: ControlRow, timeoutMs: number) => Promise<ControlRow | null>;
  clock?: ControlClock;
  recipeReader?: (machine: ControlMachine, port: number | null, pid: number, timeoutMs: number) => Promise<boolean>;
  portReader?: (machine: ControlMachine, port: number, timeoutMs: number) => Promise<boolean>;
  stacksPath?: string;
  protectedPath?: string;
  context?: ProtectedContext;
  tunnelHosts?: Record<string, string>;
  tunnelHostsPath?: string;
}
interface StoredPlan { plan: PrivateControlPlan; fingerprint: string; row: ControlRow; until: number; token: Buffer }
export type ControlRunResult = { status: 202 | 200; actionId: number; state: "running" | "waiting"; sudoCommand?: string };
export class ControlError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }

const fingerprint = (row: ControlRow, plan: PrivateControlPlan): string => createHash("sha256").update(JSON.stringify({
  row: [row.machineId, row.serviceId, row.name, row.program, row.pid, row.state, row.goneAt, row.kind, row.domain, row.uid, row.keepAlive, row.enabled, row.plist, row.classification, row.ports],
  recipe: row.recipe ? [row.recipe.hash, row.recipe.state, row.recipe.gone, row.recipe.port, row.recipe.decidedAt] : null,
  stack: row.stack ? [row.stack, plan.stackMembers?.map((item) => item.fingerprint)] : null,
  argv: plan.argv, env: plan.env, transport: plan.transport, admin: plan.admin, allowed: plan.allowed, effects: plan.effects,
})).digest("hex");

export class ControlRunner extends EventEmitter {
  private db: Db;
  private deps: ControlRunnerDeps;
  private clock: ControlClock;
  private exec: Exec;
  private plans = new Map<string, StoredPlan>();
  private locks = new Set<string>();
  private pending = new Map<number, Promise<void>>();
  private closed = false;
  protectedFile: ReturnType<typeof protectedFileReader>;
  stacksFile: ReturnType<typeof stacksFileReader>;

  constructor(db: Db, deps: ControlRunnerDeps) {
    super();
    this.db = db;
    this.deps = deps;
    this.exec = deps.exec ?? runArgv;
    this.clock = deps.clock ?? { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
    this.protectedFile = protectedFileReader(deps.protectedPath ?? ".scout-data/protected.json");
    this.stacksFile = stacksFileReader(deps.stacksPath);
  }

  context(): ProtectedContext { return { ...this.deps.context, config: this.protectedFile().config }; }
  setContext(context: ProtectedContext): void { this.deps.context = { ...this.deps.context, ...context }; }
  running(): number { return this.locks.size; }
  close(): void { this.closed = true; this.plans.clear(); }
  async wait(id: number): Promise<ActionRecord | null> { await this.pending.get(id); return actionById(this.db, id); }

  private emitAction(row: ActionRecord): void {
    for (const listener of this.rawListeners("action")) {
      try { listener.call(this, row); } catch { /* A stream subscriber must not interrupt an action. */ }
    }
  }

  private make(row: ControlRow, target: ControlTarget, action: ControlAction, hard: boolean): PrivateControlPlan {
    return planControl(row, action, { target, hard, machine: this.deps.machines.find((m) => m.id === row.machineId) ?? null, context: this.context(), effects: effectsFor(this.db, row, this.deps.tunnelHostsPath ? loadTunnelHosts(this.deps.tunnelHostsPath) : this.deps.tunnelHosts) });
  }

  private async prepare(row: ControlRow, target: ControlTarget, action: ControlAction, hard: boolean, recheckRunning = false): Promise<{ row: ControlRow; plan: PrivateControlPlan }> {
    const initial = this.make(row, target, action, hard);
    if (initial.allowed || recheckRunning && initial.refusal === "Already running" || row.kind === "launchd" && row.domain === "gui" && row.uid == null && initial.refusal === "The launchd uid is unknown or invalid.") {
      let fresh: ControlRow | null;
      try { fresh = await this.read(row, target, 30_000); }
      catch { return { row, plan: { ...initial, allowed: false, refusalKind: "unavailable", refusal: "The machine state could not be read." } }; }
      if (!fresh) return { row, plan: { ...initial, allowed: false, refusalKind: "unavailable", refusal: "The row is no longer present." } };
      row = fresh;
    }
    return { row, plan: this.make(row, target, action, hard) };
  }

  private async prepareStack(name: string, action: ControlAction, hard: boolean): Promise<{ row: ControlRow; plan: PrivateControlPlan }> {
    const stack = this.stacksFile().config.find((item) => item.name === name);
    const resolved = stack ? resolveStack(this.db, stack) : { name, label: name, state: "blocked" as const, members: [] as ResolvedStackMember[] };
    const members: PlannedMember[] = [];
    for (const member of resolved.members) {
      const stored = member.rowId === null ? null : resolveControlRow(this.db, member.type, member.rowId);
      const prepared = stored ? await this.prepare(stored, member.type, "start", false, true) : null;
      const running = prepared ? member.type === "recipe" ? prepared.row.recipe!.running : prepared.row.state === "running" && prepared.row.goneAt === null : member.running;
      members.push({ member: { ...member, running }, row: prepared?.row ?? null, plan: prepared?.plan ?? null, fingerprint: prepared ? fingerprint(prepared.row, prepared.plan) : null });
    }
    resolved.members = members.map((item) => item.member);
    resolved.state = resolved.members.some((member) => !member.available) ? "blocked" : resolved.members.every((member) => member.running === true) ? "running" : resolved.members.some((member) => member.running === true) ? "partial" : "ready";
    const machineId = resolved.members[0]?.machineId ?? hubMachineId();
    const row: ControlRow = { id: 0, machineId, machineName: members[0]?.row?.machineName ?? machineId, name, displayName: resolved.label, program: null, pid: null, state: resolved.state, goneAt: null, kind: null, domain: "gui", classification: { class: "third-party", vendor: "other", official: false, hidden: false, evidence: [], confidence: "default", whatBreaks: null }, ports: [], stack: resolved };
    return { row, plan: planControl(row, action, { target: "stack", hard, machine: this.deps.machines.find((machine) => machine.id === machineId) ?? null, stackMembers: members }) };
  }

  async plan(target: ControlTarget, id: number | string, action: ControlAction, hard = false): Promise<ControlPlan | null> {
    if (this.closed) throw new ControlError(404, "control is off");
    const stored = target === "stack" ? null : resolveControlRow(this.db, target, Number(id));
    const prepared = target === "stack" ? await this.prepareStack(String(id), action, hard) : stored ? await this.prepare(stored, target, action, hard) : null;
    if (!prepared) return null;
    const { row, plan } = prepared;
    const now = this.clock.now();
    for (const [key, entry] of this.plans) if (entry.until <= now) this.plans.delete(key);
    if (plan.allowed) {
      plan.id = `p_${randomBytes(16).toString("hex")}`;
      plan.token = randomBytes(32).toString("hex");
      plan.expiresAt = new Date(now + 120_000).toISOString();
      this.plans.set(plan.id, { plan, row, fingerprint: fingerprint(row, plan), until: now + 120_000, token: Buffer.from(plan.token, "hex") });
    }
    return publicControlPlan(plan);
  }

  async run(planId: string, token: string): Promise<ControlRunResult> {
    const stored = this.plans.get(planId);
    if (this.closed || !stored || stored.until <= this.clock.now()) { this.plans.delete(planId); throw new ControlError(404, "unknown or expired plan"); }
    const supplied = /^[a-f0-9]{64}$/i.test(token) ? Buffer.from(token, "hex") : Buffer.alloc(0);
    if (supplied.length !== stored.token.length || !timingSafeEqual(supplied, stored.token)) throw new ControlError(404, "unknown or expired plan");
    this.plans.delete(planId);
    if (stored.plan.target === "stack") return this.runStack(stored);
    const key = `${stored.row.machineId}:${stored.row.serviceId !== undefined ? `service:${stored.row.serviceId}` : stored.plan.mechanism === "process" ? `pid:${stored.row.pid}` : `${stored.plan.target}:${stored.plan.rowId}`}`;
    if (this.locks.has(key)) throw new ControlError(409, "an action is already running for this row");
    this.locks.add(key);
    try {
      let row = resolveControlRow(this.db, stored.plan.target, stored.plan.rowId);
      if (!row) throw new ControlError(409, "changed since the plan");
      try { row = await this.read(row, stored.plan.target, 30_000); }
      catch { throw new ControlError(409, "changed since the plan"); }
      if (!row) throw new ControlError(409, "changed since the plan");
      const fresh = this.make(row, stored.plan.target, stored.plan.action, stored.plan.hard);
      if (this.closed || stored.until <= this.clock.now()) throw new ControlError(404, "unknown or expired plan");
      if (!fresh.allowed || fingerprint(row, fresh) !== stored.fingerprint) throw new ControlError(409, "changed since the plan");
      const state = fresh.admin === "sudo" ? "waiting" : "running";
      const { token: discardedToken, ...auditPlan } = publicControlPlan(stored.plan);
      const audit = createAction(this.db, { at: new Date(this.clock.now()).toISOString(), finishedAt: null, machineId: fresh.machineId, target: fresh.target, rowId: fresh.rowId, name: fresh.name, action: fresh.action, hard: fresh.hard, mechanism: fresh.mechanism!, command: fresh.command, admin: fresh.admin, state, exitCode: null, message: null }, auditPlan);
      this.emitAction(audit);
      const pending = Promise.resolve().then(() => this.execute(audit.id, fresh, row!)).finally(() => { this.locks.delete(key); this.pending.delete(audit.id); });
      this.pending.set(audit.id, pending);
      return state === "waiting" ? { status: 200, actionId: audit.id, state, sudoCommand: fresh.sudoCommand! } : { status: 202, actionId: audit.id, state };
    } catch (err) { this.locks.delete(key); throw err; }
  }

  private async runStack(stored: StoredPlan): Promise<ControlRunResult> {
    const key = `${stored.row.machineId}:stack:${stored.row.name}`;
    if (this.locks.has(key)) throw new ControlError(409, "an action is already running for this row");
    this.locks.add(key);
    try {
      const fresh = await this.prepareStack(stored.row.name, stored.plan.action, stored.plan.hard);
      if (this.closed || stored.until <= this.clock.now()) throw new ControlError(404, "unknown or expired plan");
      if (!fresh || !fresh.plan.allowed || fingerprint(fresh.row, fresh.plan) !== stored.fingerprint) throw new ControlError(409, "changed since the plan");
      const { token, ...auditPlan } = publicControlPlan(stored.plan);
      const plan = fresh.plan;
      const audit = createAction(this.db, { at: new Date(this.clock.now()).toISOString(), finishedAt: null, machineId: plan.machineId, target: "stack", rowId: 0, name: plan.name, action: "start", hard: false, mechanism: "stack", command: plan.command, admin: plan.admin, state: "running", exitCode: null, message: null }, auditPlan);
      this.emitAction(audit);
      const pending = Promise.resolve().then(() => this.executeStack(audit.id, plan)).finally(() => { this.locks.delete(key); this.pending.delete(audit.id); });
      this.pending.set(audit.id, pending);
      return { status: 202, actionId: audit.id, state: "running" };
    } catch (error) { this.locks.delete(key); throw error; }
  }

  private async stackPort(machineId: string, port: number, timeoutMs: number): Promise<boolean> {
    const configured = this.deps.machines.find((machine) => machine.id === machineId)!;
    const machine = machineId === hubMachineId() ? { ...configured, transport: { type: "local" as const } } : configured;
    if (this.deps.portReader) return this.deps.portReader(machine, port, timeoutMs);
    if (machine.os === "windows" || machine.id === hubMachineId()) return this.listenPort(machine, port, timeoutMs);
    const result = await readLive(this.db, { ...machine, os: machine.os ?? "macos" }, { cheapTimeoutMs: timeoutMs, run: (transport, probe, remaining) => this.exec(transport, probe.argv, remaining ?? timeoutMs) });
    if (result.status !== "ok") throw new Error("The listeners could not be checked.");
    return listListeners(this.db, { machine: machineId, state: "present" }).some((listener) => listener.port === port);
  }

  private async executeStack(id: number, plan: PrivateControlPlan): Promise<void> {
    const members = plan.stackMembers!;
    const started: string[] = [];
    let completed = 0;
    const finish = (state: "done" | "failed", message: string): void => { this.emitAction(finishAction(this.db, id, state, new Date(this.clock.now()).toISOString(), state === "done" ? 0 : null, message)); };
    for (const item of members) {
      const member = item.member;
      if (member.running === true) { completed++; continue; }
      try {
        if (this.closed) throw new Error("The control runner closed before confirmation.");
        const own = await this.plan(member.type, member.rowId!, "start");
        if (!own?.allowed) throw new Error(own?.refusal ?? "The row is no longer present.");
        if (this.plans.get(own.id!)!.fingerprint !== item.fingerprint) { this.plans.delete(own.id!); throw new Error("The member changed since the plan."); }
        const run = await this.run(own.id!, own.token!);
        const result = await this.wait(run.actionId);
        if (!result || result.state !== "done" && result.state !== "confirmed") throw new Error(result?.message ?? "The member could not be confirmed.");
        started.push(member.label);
        if (member.waitPort !== null) {
          const until = this.clock.now() + member.waitSeconds * 1000;
          let listening = false;
          while (!this.closed && this.clock.now() < until) {
            try { listening = await this.stackPort(member.machineId, member.waitPort, until - this.clock.now()); } catch { listening = false; }
            if (listening && this.clock.now() <= until) break;
            listening = false;
            const remaining = until - this.clock.now();
            if (remaining <= 0) break;
            await this.clock.sleep(Math.min(2000, remaining));
          }
          if (!listening) throw new Error(`Port ${member.waitPort} did not open within ${member.waitSeconds} s`);
        }
        completed++;
      } catch (error) {
        finish("failed", `Started ${completed} of ${members.length}; stopped at ${member.label}: ${(error as Error).message}${started.length ? `; members left running: ${started.join(", ")}` : ""}`);
        return;
      }
    }
    finish("done", `Started ${completed} of ${members.length} members`);
  }

  private async read(row: ControlRow, target: ControlTarget, timeoutMs: number): Promise<ControlRow | null> {
    const configured = this.deps.machines.find((m) => m.id === row.machineId);
    if (!configured) return null;
    if (target === "recipe") return resolveControlRow(this.db, target, row.id);
    const machine: ControlMachine = configured.id === hubMachineId() ? { ...configured, transport: { type: "local" } } : configured;
    if (this.deps.reader) return this.deps.reader(machine, row, timeoutMs);
    const until = this.clock.now() + timeoutMs;
    const remaining = (): number => {
      const ms = until - this.clock.now();
      if (ms <= 0) throw new Error("The live read timed out.");
      return ms;
    };
    if (row.kind === "scheduled-task") {
      const task = taskIdentity(row.name);
      if (!task) throw new Error("The scheduled task identity is invalid.");
      const output = await this.exec(machine.transport, pwsh(TASK_READ), remaining(), undefined, { SCOUT_NAME: task.name, SCOUT_TASK_PATH: task.path });
      const result = windowsTasksAdapter.parse({ tasks: output });
      if (result.status !== "ok") throw new Error("The scheduled task state could not be read.");
      recordServices(this.db, machine.id, { ...result, status: "partial" }, new Date(this.clock.now()).toISOString());
      notifyServiceRead(this.db, machine.id, new Date(this.clock.now()).toISOString());
    } else {
      const os = machine.os ?? (row.kind === "windows-service" || row.machineId === hubMachineId() ? "windows" : "macos");
      const readOnce = (): Promise<Awaited<ReturnType<typeof readLive>>> => readLive(this.db, { ...machine, os }, { cheapTimeoutMs: timeoutMs, run: (transport, probe) => this.exec(transport, probe.argv, remaining()) });
      let result = await readOnce();
      // A single slow or dropped probe makes the read partial; one more pass separates that from a machine that is really unreachable.
      if (result.status !== "ok" && until - this.clock.now() > 5_000) result = await readOnce();
      if (result.status !== "ok") throw new Error("The machine state could not be read.");
      if (row.kind === "launchd" && row.domain === "gui" && row.uid == null) {
        const uid = await this.exec(machine.transport, ["id", "-u"], remaining());
        if (uid.exitCode !== 0 || !/^\d+$/.test(uid.stdout.trim()) || !Number.isSafeInteger(Number(uid.stdout.trim()))) throw new Error("The launchd uid could not be read.");
        this.db.prepare("UPDATE services SET uid = ? WHERE machine_id = ? AND kind = 'launchd' AND domain = 'gui'").run(Number(uid.stdout.trim()), machine.id);
      }
    }
    return resolveControlRow(this.db, target, row.id);
  }

  private async confirmRecipe(machine: ControlMachine, port: number | null, pid: number, timeoutMs: number): Promise<boolean> {
    if (this.deps.recipeReader) return this.deps.recipeReader(machine, port, pid, timeoutMs);
    if (port === null) {
      const result = await this.exec(machine.transport, pwsh(WINDOWS_RECIPE_PID), timeoutMs, undefined, { SCOUT_RECIPE_PID: String(pid) });
      if (result.exitCode !== 0) throw new Error("The launched process could not be checked.");
      return result.stdout.trim() === "alive";
    }
    return this.listenPort(machine, port, timeoutMs);
  }

  private async listenPort(machine: ControlMachine, port: number, timeoutMs: number): Promise<boolean> {
    const probes = windowsListenersAdapter.probes({ machineId: machine.id, os: "windows", roots: {} });
    const outputs: Record<string, Awaited<ReturnType<Exec>>> = {};
    const until = this.clock.now() + timeoutMs;
    for (const probe of probes) outputs[probe.id] = await this.exec(machine.transport, probe.argv, Math.max(1, until - this.clock.now()));
    const result = windowsListenersAdapter.parse(outputs);
    if (result.status !== "ok") throw new Error("The listeners could not be checked.");
    const at = new Date(this.clock.now()).toISOString();
    recordListeners(this.db, machine.id, result, at);
    notifyServiceRead(this.db, machine.id, at);
    return result.facts.some((listener) => listener.port === port);
  }

  private async executeRecipe(id: number, plan: PrivateControlPlan, row: ControlRow): Promise<void> {
    let exitCode: number | null = null;
    const finish = (state: "done" | "failed", message: string): void => { this.emitAction(finishAction(this.db, id, state, new Date(this.clock.now()).toISOString(), exitCode, message)); };
    try {
      const result = await this.exec(plan.transport!, plan.argv, 20_000, undefined, plan.env);
      exitCode = result.exitCode;
      if (exitCode === 2) { finish("failed", "The program was not found as an .exe, .cmd, or .bat file on this machine, so nothing was started."); return; }
      if (exitCode !== 0) { finish("failed", `The launch command exited with code ${exitCode}.`); return; }
      const pid = Number(result.stdout.trim());
      if (!validPid(pid)) { finish("failed", "The launch command did not return a process id."); return; }
      const port = row.recipe!.port;
      const start = this.clock.now();
      const machine = this.deps.machines.find((item) => item.id === row.machineId)!;
      if (port === null) {
        // A recipe with no port can only be confirmed by its process id, so it is checked twice: a dev server that dies on a bad config usually does so within a few seconds.
        const seconds = (): number => Math.ceil((this.clock.now() - start) / 1000);
        for (const wait of [3000, 5000]) {
          await this.clock.sleep(wait);
          let alive = false;
          try { alive = await this.confirmRecipe(machine, port, pid, 15_000); } catch { finish("failed", "The launched process could not be checked."); return; }
          if (!alive) { finish("failed", `The launched process exited within ${seconds()} s of launch.`); return; }
        }
        finish("done", `The launched process was still running ${seconds()} s after launch. Scout does not watch it after this check.`);
        return;
      }
      while (!this.closed && this.clock.now() - start < 20_000) {
        const remaining = 20_000 - (this.clock.now() - start);
        try {
          const running = await this.confirmRecipe(machine, port, pid, remaining);
          if (running && this.clock.now() - start <= 20_000) { finish("done", `The recipe started and port ${port} is listening.`); return; }
        } catch { /* A temporary live read failure can recover before the deadline. */ }
        const wait = 20_000 - (this.clock.now() - start);
        if (wait <= 0) break;
        await this.clock.sleep(Math.min(2000, wait));
      }
      finish("failed", this.closed ? "The control runner closed before confirmation." : `Port ${port} did not open within 20 s.`);
    } catch { finish("failed", "The recipe could not be launched or confirmed."); }
  }

  private async execute(id: number, plan: PrivateControlPlan, before: ControlRow): Promise<void> {
    if (plan.mechanism === "recipe") return this.executeRecipe(id, plan, before);
    const sudo = plan.admin === "sudo";
    let exitCode: number | null = null;
    const finish = (state: ActionRecord["state"], message: string): void => { this.emitAction(finishAction(this.db, id, state, new Date(this.clock.now()).toISOString(), exitCode, message)); };
    try {
      if (!sudo) {
        const result = await this.exec(plan.transport!, plan.argv, plan.admin === "uac" ? 185_000 : 60_000, undefined, plan.env);
        exitCode = result.exitCode;
        if (plan.admin === "uac" && exitCode === 1223) { finish("declined", "The administrator prompt was refused or timed out after 120 s."); return; }
        if (exitCode === 124 || exitCode === -1) { finish("failed", "The command timed out before Scout could confirm its result."); return; }
        if (exitCode !== 0) { finish("failed", exitCode === 3 ? "The process identity changed; Scout did not act on it." : `The command exited with code ${exitCode}.`); return; }
      }
      const start = this.clock.now();
      const duration = sudo ? 600_000 : plan.waitSeconds * 1000;
      const subject = plan.mechanism === "process" ? "The process" : plan.mechanism === "scheduled-task" ? "The task" : plan.mechanism === "launchd" ? "The launchd job" : "The service";
      let unreadable = false;
      while (!this.closed) {
        const elapsed = this.clock.now() - start;
        if (elapsed > duration) break;
        let row: ControlRow | null = null;
        unreadable = false;
        try { row = await this.read(before, plan.target, Math.max(1, Math.min(30_000, duration - elapsed))); }
        catch { unreadable = true; }
        const stopped = !unreadable && (row === null || row.goneAt !== null || row.state === "stopped" || row.state === "disabled");
        const running = !unreadable && row !== null && row.goneAt === null && row.state === "running";
        const matched = plan.action === "disable" ? !unreadable && row !== null && startupEnabled(row) === false && (stopped || row.state === "disabled") : plan.action === "enable" ? !unreadable && row !== null && row.goneAt === null && startupEnabled(row) === true : plan.action === "stop" ? stopped : running && (!sudo || plan.action !== "restart" || row!.pid !== before.pid);
        if (matched && this.clock.now() - start <= duration) { finish(sudo ? "confirmed" : "done", `${subject} ${plan.action === "stop" ? "stopped" : plan.action === "start" ? "started" : plan.action === "disable" ? "disabled" : plan.action === "enable" ? "enabled" : "restarted"} after ${Math.ceil((this.clock.now() - start) / 1000)} s.`); return; }
        const remaining = duration - (this.clock.now() - start);
        if (remaining <= 0) break;
        await this.clock.sleep(Math.min(sudo ? 10_000 : 2000, remaining));
      }
      finish(sudo ? "expired" : "failed", this.closed ? "The control runner closed before confirmation." : unreadable ? `Scout could not read live state within ${duration / 1000} s.` : plan.action === "stop" ? `${subject} is still running after ${duration / 1000} s.` : plan.action === "disable" || plan.action === "enable" ? `${subject} did not show as ${plan.action}d after ${duration / 1000} s.` : `The expected running state did not appear after ${duration / 1000} s.`);
    } catch { finish(sudo ? "expired" : "failed", "Scout could not read or confirm the action result."); }
  }
}
