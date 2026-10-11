# Scout architecture

Scout is a pnpm workspace of TypeScript packages that Node 24 runs directly, with no build step. `pnpm test` runs `node --test` in every package and `pnpm typecheck` runs `tsc` over the workspace. Code rules are in [CONVENTIONS.md](../CONVENTIONS.md).

## Packages

| Package | Holds |
| --- | --- |
| `packages/core` | Catalog schema and SQLite store (`node:sqlite`), the adapter contract, transports, identity rules, and the query layers the CLI and hub share. |
| `packages/ops` | Everything that acts: update planner and runner, dependency guard, service control, Cloudflare reader, health probes, secret lookup. |
| `packages/research` | Version sources and the runner that caches their answers. |
| `packages/hub` | HTTP server, schedules, event stream, Cloudflare Access verification. |
| `packages/cli` | `scan`, `report`, `list`, `research`, `enrich`, and the `main.ts` commands. |
| `packages/web` | The page as static files in `public/`, with no framework. `dev/mock-hub.ts` serves it against a mock API. |
| `adapters/*` | One package per source, each depending only on `@scout/core`. |

## Adapters and fixtures

An adapter never touches a machine. `probes(ctx, location)` returns the fixed commands for one source as argument arrays, never shell strings, and nothing in them comes from user or page input. `parse(outputs, location)` is a pure function from the recorded output of those commands to a `ScanResult`. The transport runs the probes as local processes, over ssh under `zsh -lc`, or through a running guest's CLI, and hands back exit codes and output.

`parse` never throws: bad output becomes `partial` or `failed` with a message, and a missing tool is `skipped`. Each install is identified by `(ecosystem, key)`, such as `("winget", "Git.Git")`. Adapters report versions as the source prints them and never merge across ecosystems.

Each adapter is tested against `fixtures/<sourceKind>/<case>/`, where `outputs.json` is probe output recorded from a real machine and `expected.json` is the exact parse. `tools/record-pwsh.mjs` and `tools/record-mac.mjs` record cases, and `tools/redact-fixtures.mjs` strips usernames. A new platform starts here: pacman, systemd, and `ss` adapters for Arch Linux would follow the shape of `adapters/services` and `adapters/listeners`.

## The catalog

Scans write into `.scout-data/catalog.db`, diffing each result against the last so rows are added, updated, or marked removed. Core then links installs across ecosystems by fixed rules (a winget id to its registry key, a cask to its app bundle), queues merges it cannot prove for the Review page, records version pins found in your projects as advisory constraints, and applies category rules. The schema upgrades in place on open.

## The hub and its schedules

The hub serves the page and a JSON API on 127.0.0.1, port 4870 by default, and pushes changes to the page over server-sent events. With `--live` or `--production`, it re-reads listeners and service state every 3 seconds for Windows machines and every 20 seconds for others while a Services page is open, every 2 minutes otherwise, and runs the Cloudflare reader when a token exists. The research schedule refreshes each version source when its cache lapses, and health probes run every 2 minutes.

When a language runtime owns a port, the listener reader names the program running inside it. The probe sends the command line only for node, bun, deno, python, ruby, java, php, and perl processes, and the adapter pulls out the script the runtime was started with, which for Python can be a module given with -m and for Java a jar. Every other argument is dropped there, so flags and tokens never reach the catalog. A script under node_modules is recorded as its package name, which is why a Vite dev server shows as "node: vite". A relative path is resolved against the process's working directory. On Windows the probe gets that directory from each process with a small helper it compiles at run time, and the extra step brings a listeners probe to about 1.6 seconds, 0.4 seconds more than before. The result lives in the nullable `script_path` column on listeners, which the catalog adds the first time Scout starts, and the row name takes the form "runtime: script". If Scout is not allowed to inspect a process, as with a service running as administrator, it records no script path and the row keeps the plain runtime name.

## Updates

`planUpdate` turns an install and its newer version into an exact winget, Store, brew, cask, npm, pipx, or uv command. The dependency guard refuses an update that would break a runtime requirement or a library other programs use, and asks for an extra confirmation on softer risks. A confirmed batch runs preflight, update, and verify one job at a time per machine and stops at the first failure.

## Control: plan, token, audit

Start, stop, and restart for Windows services, scheduled tasks, launchd jobs, and listening processes go through `packages/ops/src/control.ts`. A plan names the exact action, or refuses it when the row is in a protected group (essential, Scout itself, cloudflared, ssh, the local AI gateway, remote access, DNS and network, containers). An allowed plan carries a random one-time token that expires after two minutes. Running it re-checks the target against the plan, writes an audit row, and records the result there. Uninstall produces text instructions only.

Disable and Enable are two more actions on the same plan and audit path, for launchd jobs and scheduled tasks only: on launchd a disable runs `launchctl disable` then `launchctl bootout` and an enable runs `launchctl enable`, then `launchctl bootstrap` when the plist path is known, while a scheduled task gets `Disable-ScheduledTask` (which also stops a running instance) or `Enable-ScheduledTask`. A row's enabled state decides which of the two is offered, and a launchd job that `launchctl print-disabled` does not list counts as enabled. The run is confirmed by reading the row back until its enabled state matches. Protection blocks Disable but never Enable, Start is refused while a row is disabled, and the audit table's CHECK on the action column accepts both actions (an older catalog's audit table is upgraded in place on first start, keeping its rows).

## Recipes and stacks

On a Windows hub machine, package scripts, launch configurations, and compose files under `projectRoots` become proposed launch recipes. Each is approved once for its exact command. Only node, npm, npx, pnpm, yarn, python, python3, py, uv, docker, deno, bun, and dotnet can launch, values reach the shell through environment variables, and arguments must match a strict character set. A stack in `.scout-data/stacks.json` lists up to 12 recipes and services in order, with optional ports to wait for, and each member runs through the control pipeline. The launcher resolves each program name to an `.exe`, `.cmd`, `.bat`, or `.com` file on PATH and never starts a `.ps1` script, so a program that exists only as a script is not launched. A recipe with no port to confirm is checked about 3 and 8 seconds after launch, and Scout stops watching the process after the second check.

## Alerts and health

Alerts cover new listeners and daemons, stopped services, domain origins that are down, widened exposure, unhealthy endpoints, certificates expiring within 14 days, crash loops, and port clashes against `.scout-data/ports.json`. They have stable keys, resolve when the condition clears, and can be acknowledged or muted. Health checks probe public hostnames from the Cloudflare reader and web ports on the hub machine, read certificate expiry from the TLS handshake, and keep 7 days of samples.

## Outage watch

With `--live` or `--production`, the hub runs an outage watch every 2 minutes. The machine probe opens a TCP connection to each machine's ssh port and waits up to 8 seconds for the SSH greeting, which separates up, hung (connected but silent), and down. The watch also takes the health results for public hostnames that are health targets and the live reads for services and ports seen running that are meant to stay up (automatic and boot-start Windows services, KeepAlive launchd jobs, ports those services own by process id or program path, container ports, and ports behind a published Cloudflare route) or are set to `true` in `.scout-data/watch.json`. Counters for each target confirm an outage after 2 consecutive failures and date its start from the first one. A target with 3 separate failures within 30 minutes is marked flapping, service checks count once per 2-minute window, and incomplete reads never count. Outages are rows in the catalog's `outages` table, beside a `watch_state` table, and each confirmed one also raises a `machine-outage` or `service-outage` alert. The notifier sends a desktop notification and, when `SCOUT_DISCORD_WEBHOOK` is set, a Discord post for each outage and recovery. The hub writes `.scout-data/heartbeat.json` every 30 seconds. A separate process, `packages/hub/src/watchdog.ts`, sends a notice when that file goes stale, and at startup the hub records a `monitor-gap` outage when the previous heartbeat is more than 5 minutes old.

## Provenance flags

Flags are computed each time the API reads installs, services, and listeners, by pure functions over rows the catalog already holds plus the `project_git` table, and the flags themselves are never stored. Each one is a `{kind, label, evidence}` entry in the `flags` array of rows from `/api/installs`, `/api/installs/:id`, `/api/services`, and `/api/listeners`. Odd location matches install and executable paths against temp, Downloads, Desktop, the shared Public folder, and the Recycle Bin, and skips macOS package receipts because their path is a build prefix. No publisher applies to Windows uninstall entries that are not system components, and Not signed applies to appx packages with no signature. Mine matches a path under one of your projects, a homepage under one of your GitHub owners, or, for listeners and services, a port used by an approved or proposed launch recipe from one of your projects. At startup and every 6 hours the hub runs git with fixed arguments in each project folder on the hub machine (the same folders the recipe scanner reads) to get `remote.origin.url` and the last commit's author email and date. `project_git` stores the remote as host, owner, and repository only, with any credentials stripped from the URL first. A project is yours when its remote owner matches an owner in `.scout-data/mine.json`, ignoring case, or its last author email matches one of the emails there. `GET /api/provenance` returns that profile and each project with its remote, its author, and the reason it counts as yours, or null.

## The tray panel

`packages/tray` is a Tauri 2 app with a Rust shell and a UI of plain web components. It puts the Scout icon in the Windows system tray or the macOS menu bar, keeps the service token's secret in the system keychain, allows one running instance, and polls the hub every 30 seconds while the panel is closed and every 5 seconds while it is open. Every request carries a Cloudflare Access service token, and the hub admits one only when its Client ID is in `allowedServiceTokens` in `access.json` and the request is for `/api/tray` or a path under it, `GET /api/services/actions`, or `POST /api/services/actions/plan` or `/run`. Anything else gets 403.

`GET /api/tray` returns the rows the panel lists: the services and listeners the outage watch covers, plus stacks and approved launch recipes, with the hide rules and pins from `.scout-data/tray.json` applied. It sends an ETag and answers 304 when nothing changed. `GET` and `PUT /api/tray/rules` read and replace the rules, and `POST /api/tray/hide` adds one. The rules shape only this list and never what the outage watch checks. Start, stop, and restart from the panel go through the same plan, one-time token, and audit row as the page (see [Control: plan, token, audit](#control-plan-token-audit)).

## The MCP server and the command line

The `status`, `whois`, and `map` commands in `packages/cli/src/insight.ts` and the tools in `packages/mcp` read the catalog directly instead of calling the hub. `packages/ops/src/local.ts` builds the tray panel's read model from the local catalog and the rules files in `.scout-data` (`localTray`, `localStatus`, and `localMapInput`), so the CLI and the MCP server see the same rows as the panel. `packages/core/src/systems-map.ts` holds three pure functions over that data: `whoIs`, `statusSummary`, and `systemsMapMarkdown`.

`@scout/mcp` has no external dependencies and does not use the official MCP SDK, which keeps the repository's runtime dependency count at zero. `server.ts` is a small JSON-RPC 2.0 layer over standard input and output that handles `initialize`, `ping`, `tools/list`, and `tools/call`, and `tools.ts` defines the tools. Each tool call opens the catalog, answers, and closes it. `scout_start_service` goes through `ControlRunner` (plan, one-time token, run, wait) the same way the hub's action endpoints do (see [Control: plan, token, audit](#control-plan-token-audit)). `scout_plan_action` returns a plan without its token, and no tool runs a stop or a restart.

## The hub machine

`configureHubMachine` makes the one machine with the `local` transport in `machines.json` the hub machine. Health probes, launch recipes, stacks, and Scout's own protected entry all ask core for its id instead of assuming a name.
