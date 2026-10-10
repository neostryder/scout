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

## Updates

`planUpdate` turns an install and its newer version into an exact winget, Store, brew, cask, npm, pipx, or uv command. The dependency guard refuses an update that would break a runtime requirement or a library other programs use, and asks for an extra confirmation on softer risks. A confirmed batch runs preflight, update, and verify one job at a time per machine and stops at the first failure.

## Control: plan, token, audit

Start, stop, and restart for Windows services, scheduled tasks, launchd jobs, and listening processes go through `packages/ops/src/control.ts`. A plan names the exact action, or refuses it when the row is in a protected group (essential, Scout itself, cloudflared, ssh, the local AI gateway, remote access, DNS and network, containers). An allowed plan carries a random one-time token that expires after two minutes. Running it re-checks the target against the plan, writes an audit row, and records the result there. Uninstall produces text instructions only.

## Recipes and stacks

On a Windows hub machine, package scripts, launch configurations, and compose files under `projectRoots` become proposed launch recipes. Each is approved once for its exact command. Only node, npm, npx, pnpm, yarn, python, python3, py, uv, docker, deno, bun, and dotnet can launch, values reach the shell through environment variables, and arguments must match a strict character set. A stack in `.scout-data/stacks.json` lists up to 12 recipes and services in order, with optional ports to wait for, and each member runs through the control pipeline.

## Alerts and health

Alerts cover new listeners and daemons, stopped services, domain origins that are down, widened exposure, unhealthy endpoints, certificates expiring within 14 days, crash loops, and port clashes against `.scout-data/ports.json`. They have stable keys, resolve when the condition clears, and can be acknowledged or muted. Health checks probe public hostnames from the Cloudflare reader and web ports on the hub machine, read certificate expiry from the TLS handshake, and keep 7 days of samples.

## Outage watch

With `--live` or `--production`, the hub runs an outage watch every 2 minutes. The machine probe opens a TCP connection to each machine's ssh port and waits up to 8 seconds for the SSH greeting, which separates up, hung (connected but silent), and down. The watch also takes the health results for public hostnames that are health targets and the live reads for services and ports seen running. Counters for each target confirm an outage after 2 consecutive failures and date its start from the first one. A target with 3 separate failures within 30 minutes is marked flapping, service checks count once per 2-minute window, and incomplete reads never count. Outages are rows in the catalog's `outages` table, beside a `watch_state` table, and each confirmed one also raises a `machine-outage` or `service-outage` alert. The notifier sends a desktop notification and, when `SCOUT_DISCORD_WEBHOOK` is set, a Discord post for each outage and recovery. The hub writes `.scout-data/heartbeat.json` every 30 seconds. A separate process, `packages/hub/src/watchdog.ts`, sends a notice when that file goes stale, and at startup the hub records a `monitor-gap` outage when the previous heartbeat is more than 5 minutes old.

## The hub machine

`configureHubMachine` makes the one machine with the `local` transport in `machines.json` the hub machine. Health probes, launch recipes, stacks, and Scout's own protected entry all ask core for its id instead of assuming a name.
