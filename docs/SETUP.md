# Setting up Scout

Scout runs on one computer, the hub machine, and reads every other machine over ssh. Pick the hub machine first. The full feature set targets a Windows hub machine, so read the platform notes at the end of this page before you choose anything else.

## Prerequisites

On the hub machine:

- Node.js 24 or newer. Scout runs its TypeScript sources directly, so there is no build step.
- pnpm. The repository pins the version in the `packageManager` field of `package.json`, and `npm install -g pnpm` gets you a current one.
- git.
- An OpenSSH client (`ssh`), if you have any remote machines. Windows 10 and 11 include one.
- PowerShell 7 (`pwsh`) on PATH, if the hub machine runs Windows. The Windows probes and the hub's helper scripts call `pwsh`, never Windows PowerShell 5.1.

On each remote machine:

- An ssh server you can log in to with a key.
- zsh. Scout runs every remote command under `zsh -lc` so the login PATH is present. macOS has zsh by default. On Linux, install it from your package manager.

Check the hub machine with:

```
node --version
pnpm --version
git --version
ssh -V
pwsh --version
```

## Clone and install

```
git clone https://github.com/neostryder/scout.git
cd scout
pnpm install --frozen-lockfile
```

Run `pnpm test` if you want to confirm the install. The tests use recorded fixtures and never touch your machines.

## Describe your machines

Copy the example and edit it:

```
cp machines.example.json machines.json
```

`machines.json` is git-ignored. It holds one object with a `machines` array:

```json
{
  "machines": [
    {
      "id": "desktop",
      "name": "Desktop",
      "os": "windows",
      "arch": "x64",
      "transport": { "type": "local" },
      "projectRoots": ["C:/Projects/*"]
    },
    {
      "id": "mac-mini",
      "name": "Mac mini",
      "os": "macos",
      "arch": "arm64",
      "address": "192.168.1.20",
      "transport": { "type": "ssh", "target": "user@192.168.1.20", "options": ["-i", "~/.ssh/id_ed25519"] }
    }
  ]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | A short key such as `desktop` or `mac-mini`. You pass it to the scan command, and the catalog files every row under it, so keep it stable. |
| `name` | yes | The display name on the page and in CLI output. |
| `os` | yes | `windows`, `macos`, or `linux`. It decides which adapters run. |
| `arch` | yes | `x64` or `arm64`. Installer downloads use it to pick the right file. |
| `address` | no | The machine's network address, stored in the catalog for reference. Scout connects through `transport`, not this field. |
| `transport` | yes | `{ "type": "local" }` for the machine Scout runs on, or `{ "type": "ssh", "target": "user@host", "options": [...] }` for a remote. `options` holds extra ssh arguments, such as `["-i", "~/.ssh/id_ed25519"]` or `["-p", "2222"]`. |
| `projectRoots` | no | Folders that hold your projects. A path ending in `/*` means each child folder whose name does not start with `_` or `.`. Scout reads pinned tool versions from these projects, and on the hub machine it also finds launch recipes in them. The `/*` form expands only on the local machine, so list remote project folders one by one. |

Exactly one machine should use the `local` transport. That machine is the hub machine: the hub runs there, health checks probe its ports, and launch recipes and stacks start there. Write Windows paths with forward slashes (`C:/Projects/*`) so the JSON needs no escaping.

A Windows machine is read through the local transport, because remote commands run under zsh. In practice the Windows machine is your hub machine, and a second Windows machine cannot be scanned over ssh today.

## SSH access for remote machines

Scout calls ssh with `BatchMode=yes` and an eight-second connect timeout, so a remote must accept your key without any prompt. It installs nothing on the remote side, and every probe is a read-only command.

1. Turn on the ssh server on the remote. On macOS that is System Settings, General, Sharing, Remote Login. On Linux, install and start `openssh-server` or your distribution's equivalent.
2. Make a key on the hub machine if you do not have one: `ssh-keygen -t ed25519`.
3. Add the public key (`~/.ssh/id_ed25519.pub`) to `~/.ssh/authorized_keys` on the remote. `ssh-copy-id user@host` does this from macOS or Linux. From Windows, copy the file's contents and append them on the remote by hand.
4. Connect once interactively (`ssh user@host`) and accept the host key. Batch mode refuses unknown host keys.
5. Confirm the non-interactive path works:

```
ssh -o BatchMode=yes -i ~/.ssh/id_ed25519 user@host true
ssh -o BatchMode=yes -i ~/.ssh/id_ed25519 user@host 'zsh -lc "command -v brew"'
```

The first command must exit with no output and no prompt. The second shows whether the login shell can find Homebrew on a Mac. If your key has a passphrase, load it into an ssh agent first. A hub started at login needs the agent running with the key loaded.

## The first scan

Scan one machine at a time at first, so a problem on one does not hide in the output of another:

```
pnpm --filter @scout/cli scan desktop
pnpm --filter @scout/cli scan mac-mini
```

With no machine ids, the scan covers every machine in `machines.json`. `--only` limits it to some sources, for example `--only brew,cask` or `--only listeners,services`, and `--db path` points it at a different catalog file. The catalog lives at `.scout-data/catalog.db`, and the whole `.scout-data` folder is git-ignored local state.

A full scan of a Windows machine takes about two and a half minutes. The first scan of any machine takes longer, because it reads every Claude Code and Codex session log once to count which tools AI agents run. Later scans start from a stored checkpoint.

Each source prints one line: what it found and how many rows it added, changed, or removed. `skipped` means the tool is not installed or a guest is not running. Scout never starts a guest or a service to scan it. `unreachable` means the transport failed, and the troubleshooting section covers the usual causes.

`pnpm --filter @scout/cli report` prints the latest result of every source on every machine, and `pnpm --filter @scout/cli list` queries the catalog from the command line.

## Look up versions

```
pnpm --filter @scout/cli research
```

This asks each package's source for its newest version and prints the updates it finds. Only package names leave the machine, and only to public endpoints. A hub started with `--schedule` (or in production mode) refreshes these lookups by itself when each source's cache lapses.

## Start the hub

```
pnpm --filter @scout/hub start -- --live
```

Then open http://127.0.0.1:4870/. The page has Catalog, Updates, Review, Jobs, and Services views. The hub always listens on 127.0.0.1, whatever the mode.

| Flag | Effect |
| --- | --- |
| `--port N` | Listen on another port (default 4870). |
| `--live` | Turn on live reads: listeners and service state every 3 seconds for Windows machines and every 20 seconds for others while a Services page is open, every 2 minutes otherwise, plus the Cloudflare reader if a token is set. |
| `--schedule` | Refresh version lookups on a schedule. Production mode turns this on. |
| `--production` | Require Cloudflare Access on every request (see below). |
| `--no-jobs` | Turn off update jobs. |
| `--no-control` | Turn off start, stop, restart, disable, and enable. |
| `--no-models` | Turn off the AI toolkit even when it is configured. |
| `--schedule-models` | Let release-note summaries and vendor-page reading use the AI toolkit on their own schedule. |
| `--no-cloudflare` | Skip the Cloudflare reader. |
| `--no-health` | Turn off health checks. `--health-interval N` sets their period in seconds (default 120, at least 30). |
| `--no-watch` | Turn off the outage watch. |
| `--watch-interval N` | Set the outage watch period in seconds (default 120, at least 30). |
| `--db path` | Use another catalog file. |
| `--access path` | Use another Access configuration file in production mode. |

Without `--live` or `--production` the hub opens no ssh connections by itself, which suits a quick look at the catalog.

## Local mode and production mode

Local mode (`--live`) has no sign-in. It answers only requests whose Host is `127.0.0.1`, `localhost`, or `[::1]`, and requests that change anything must carry a JSON content type and, when they carry an Origin, a loopback one. A web page in another browser tab cannot drive it. Use it when you only open Scout on the hub machine itself.

Production mode puts the page on a public hostname behind Cloudflare Access, for example `scout.example.com`. The hub still listens on loopback, and a `cloudflared` tunnel on the same machine carries traffic to it. In this mode the hub answers only the hostname in `access.json`, and every request must carry a valid Access token. The hub checks the token itself: the RS256 signature against your team's published keys, the issuer, the audience, the time window, and the email.

To set it up:

1. In Cloudflare Zero Trust, create a tunnel on the hub machine and route `scout.example.com` to `http://127.0.0.1:4870`.
2. Create a self-hosted Access application for `scout.example.com` with a policy that admits only you. Copy its Application Audience (AUD) tag.
3. Copy `access.example.json` to `access.json` (git-ignored) and fill it in:

```json
{
  "host": "scout.example.com",
  "teamDomain": "your-team.cloudflareaccess.com",
  "aud": "the-application-audience-tag-from-cloudflare-access",
  "allowedEmails": ["you@example.com"]
}
```

`allowedEmails` is optional. When it is set, the token's email must be one of them in addition to passing the Access policy.

4. Start the hub with `pnpm --filter @scout/hub start:production`. That runs `--production --schedule-models`, and production mode turns on the live reads and scheduled lookups as well.

In production mode, http://127.0.0.1:4870/ answers `421 misdirected request`. Use the public hostname.

## Optional integrations

All of these stay off until configured, and the page works without any of them.

### Cloudflare reader

The reader lists your zones, DNS records, tunnels and their ingress rules, Access applications, and Workers routes with GET requests only, and joins each public hostname to the machine and port behind it. It needs a Cloudflare API token with read permission for those areas. A missing permission leaves that part out and marks the read as degraded.

Scout looks for the token in this order: the `SCOUT_CLOUDFLARE_TOKEN` environment variable, then a secret named `CLOUDFLARE_SCOUT_READ` in Bitwarden Secrets Manager through the `bws` CLI (which needs `BWS_ACCESS_TOKEN` in the hub's environment). `--cloudflare-secret NAME` reads a differently named secret. The account comes from a `CLOUDFLARE_ACCOUNT_ID` secret if `bws` has one, otherwise from the first account the token can see. The token stays in memory and is never written to the catalog.

The reader runs with `--live` or `--production`. To run it once from the command line:

```
node packages/cli/src/main.ts cloudflare read
node packages/cli/src/main.ts routes
```

If a tunnel's name does not identify its machine, map it in `.scout-data/tunnel-hosts.json`, a JSON object of tunnel name to machine id.

### GitHub token

Version lookups against GitHub releases work without a token but hit GitHub's anonymous rate limit quickly. Set `SCOUT_GITHUB_TOKEN` to a token with no scopes to raise it.

### AI toolkit

Scout never calls a model API itself. Set `SCOUT_AI_TOOLKIT` to the path of a PowerShell script that runs a model for it. Scout calls it as:

```
pwsh -NoProfile -NonInteractive -File <toolkit> <route> <instruction> -Cwd <folder> -Tools read -NoCharter
```

The prompt is in `prompt.txt` inside that folder, and the instruction tells the model to read it. The script prints the answer, and lines that start with `[ai]` are ignored. `SCOUT_MODEL_ROUTE_PUBLIC` names the route for public text (release notes, vendor pages, and service names), and `SCOUT_MODEL_ROUTE_INTERNAL` names the route for dependency discovery, which sends a stripped copy of your inventory. They default to `public` and `internal`, so point them at a local model if you want your inventory to stay on your own hardware.

With a toolkit set, the page can summarize release notes, describe services from their public names, and propose dependencies between installed programs, each on request. With `--schedule-models`, release-note summaries and vendor-page version reading also run on a schedule. All model use is capped at 30 calls in any rolling hour.

The `enrich` script is separate from the toolkit. `pnpm --filter @scout/cli enrich export` writes batches of package names (no paths or hostnames) to `.scout-data/enrich` for whatever model you choose, and `enrich apply <file>` validates the answers and stores them as descriptions and categories.

### Local AI gateway for project descriptions

Project descriptions can come from an OpenAI-compatible gateway running on the hub machine that publishes a discovery document. Configure it in `.scout-data/cogitator.json` with `gateway` (a loopback URL, `http://127.0.0.1:8470` by default), `role` (default `describe`), and optionally `discoveryFile`, and put its key in `SCOUT_COGITATOR_KEY`. Scout refuses a gateway URL that is not on loopback. This path also needs the AI toolkit to be configured.

## Outage alerts

With `--live` or `--production`, the hub checks for outages every 2 minutes. A machine can hang in a way that still answers ping and accepts TCP connections but sends no data, so the machine check opens a TCP connection to the ssh port and waits up to 8 seconds for the SSH greeting. It never logs in. A machine that sends the greeting is up, one that accepts the connection but sends no greeting is hung, and one that refuses or fails the connection is down.

Everything below is watched by default:

- Every machine in `machines.json`, through its ssh port.
- Every public hostname from the Cloudflare reader that is already a health target and has answered a probe at least once. A hostname that has never answered, such as one used only through Tailscale that returns HTTP 530 from outside, is not watched until its first answer, and any outage already open for it is closed without a notice.
- Every service and listening port seen running that is meant to stay up at all times: Windows services that start automatically or at boot, launchd jobs with KeepAlive set, the ports those services listen on, ports served by a container, and ports that a published Cloudflare hostname points to. An item that stops qualifying has its open outage closed without a notice.

Scheduled tasks, services you start by hand, system plumbing, essential system services, browser debug ports, and ports opened by dev servers and other apps are not watched, so closing an app on purpose raises no alert. To watch one of them anyway, set it to `true` under `items` in `.scout-data/watch.json`.

An outage is confirmed after 2 failed checks in a row, and its start time is the first failed check, so a quick restart or update raises nothing. One recovery notice follows, with how long the outage lasted. A machine or address that fails 3 separate times within 30 minutes is marked flapping. Service checks count at most once per 2-minute window, even while an open Services page refreshes them more often, and an incomplete read never counts as a failure.

Each outage is stored in the `outages` table of `.scout-data/catalog.db` with what failed, its kind, its state, its start and end, and a detail line. The Outages tab of the Services page lists open and past outages, and each one also appears on the Alerts tab as a high-severity `machine-outage` or `service-outage` alert.

### Notices

Each confirmed outage and each recovery shows a desktop notification on the hub machine: a tray balloon on Windows, an `osascript` notification on macOS, and `notify-send` on Linux. For a Discord post as well, create a webhook in the Discord channel's settings (Integrations, Webhooks, New Webhook), copy its URL, and set it as `SCOUT_DISCORD_WEBHOOK` in the hub's environment. Scout accepts only `discord.com` and `discordapp.com` webhook addresses, and its posts never mention anyone. Scout reads the address from the environment, and on Windows it also reads `.scout-data/discord-webhook.dpapi` when the variable is unset, a file encrypted for your Windows account that you create yourself (`ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString`). Scout never writes the address to a file or shows it on the page.

To check the setup, press Send a test notice on the Outages tab. The same tab shows the status of each notice channel.

### Switches and maintenance

The Outages tab has an on/off switch for each kind of check, each machine, and each item. Turning an item off closes its open outage without a notice. The switches are saved in `.scout-data/watch.json` on the hub machine. Before planned work, pause the watch for 1 or 8 hours from the same tab.

The CLI covers the same ground:

```
node packages/cli/src/main.ts outages --state open
node packages/cli/src/main.ts outages --state all --limit 50 --machine mac-mini
node packages/cli/src/main.ts outages pause 60
node packages/cli/src/main.ts outages resume
node packages/cli/src/main.ts outages unwatch machine mac-mini
node packages/cli/src/main.ts outages watch machine mac-mini
```

`--state` takes `open`, `closed`, or `all`, and `--machine` takes a machine id. `outages pause` takes a number of minutes. `watch` and `unwatch` take `machine`, `check`, or `item`, followed by its name.

`--no-watch` turns the watch off, and `--watch-interval N` sets its period in seconds (default 120, at least 30).

### When the hub itself stops

The hub writes `.scout-data/heartbeat.json` every 30 seconds. The watchdog (`pnpm --filter @scout/hub watchdog`) reads it every 60 seconds, and when it is more than 180 seconds old it sends the Discord post and the desktop notification, then a recovery notice with the duration once the heartbeat moves again. It never touches the catalog and runs the same way on Windows, macOS, and Linux. Run it as a second login service (see [Run the hub at login](#run-the-hub-at-login)). `--stale <seconds>` and `--interval <seconds>` change the two thresholds.

When the hub starts and finds its last heartbeat more than 5 minutes old, it records a `monitor-gap` outage, "Scout was not running", that covers the silence. An outage of the hub machine itself shows up this way once the machine is back. While the whole hub machine is down, nothing can send a notice: the watchdog covers a hub process that hangs or stops.

## Provenance flags

The page shows small flags beside installs, services, and listeners. Hover over a flag to see the evidence behind it, or open the detail panel, where the Provenance list shows the same evidence. There are four kinds:

- Odd location: installed in or running from a temp folder, a Downloads or Desktop folder, the shared Public folder, or the Recycle Bin. macOS package receipts are skipped because they record a build prefix instead of where the files live.
- No publisher: a Windows uninstall entry that names no publisher. System components are left out.
- Not signed: a Store-format app package (appx) with no signature at all. Packages signed by their developer are not flagged.
- Mine: the item lives under one of your projects or has a homepage under your GitHub account, or it is a listener or service on a port used by an approved or proposed launch recipe from one of your projects.

A flag is information only. It never starts, stops, disables, or removes anything.

The Mine flag needs a profile. Create `.scout-data/mine.json` with your GitHub account and organization names and the email addresses you commit with:

```json
{
  "owners": ["your-github-account", "your-org"],
  "emails": ["you@example.com"]
}
```

A project counts as yours when the owner of its git remote matches one of the owners, ignoring case, or when its last commit's author email matches one of the emails. Without the file nothing is marked Mine, and the other three flags still work. If the file is malformed, Scout reports the problem and ignores it.

The hub reads each project's git remote and last commit at startup and every 6 hours, in the project folders on the hub machine that launch recipes come from. It keeps only the host, owner, and repository name of the remote, and strips any credentials in the remote URL before anything is stored.

The CLI shows the same information:

```
node packages/cli/src/main.ts provenance
node packages/cli/src/main.ts provenance scan
node packages/cli/src/main.ts provenance flags --machine mac-mini --kind odd-location
```

`provenance` lists your projects with their remote, last author, and whether each one counts as yours, and explains how to add a profile when there is none. `provenance scan` reads the git facts again right away and prints counts. `provenance flags` prints a table of flagged installs with their evidence and a count. `--machine` takes a machine id, and `--kind` takes `odd-location`, `no-publisher`, `unsigned`, or `mine`.

## The tray panel

The tray panel is a small desktop app in `packages/tray` that puts a Scout icon in the Windows system tray or the macOS menu bar. It reaches the hub through its public hostname, so it needs the hub in production mode (see [Local mode and production mode](#local-mode-and-production-mode)) and a Cloudflare Access service token on each device that runs it.

The icon is a compass ring and needle with a status dot. The dot is green when everything meant to stay up is up, amber when something changed, and red when something is down. A grey cross takes its place when the hub cannot be reached or the panel is not connected yet. The icon follows the light or dark taskbar.

### What the panel shows

Click the icon to open a 420 by 600 panel. It has a tab for each machine, each with a count badge that turns red or amber when something needs attention, and a Stacks tab. Each row has a state dot, a name, a port, a response-time sparkline when Scout has samples, and a shield when the row is protected. Header pills count what is down and what changed, and the search box and the All, Down, and Mine chips narrow the list.

By default the panel lists the services and listeners that are meant to stay up, by the same rule as the outage watch (Windows services that start automatically, launchd jobs with KeepAlive set, their ports, and container and routed ports), plus stacks and approved launch recipes. A stopped service shows as down only if Scout has seen it running, and as stopped otherwise.

Hover over a row to see Start when it is stopped, or Restart and Stop when it is running. Right-click a launchd job or scheduled task to disable or enable it. Start and Enable run at once, and Stop, Restart, and Disable ask on the row first. Each action goes through the same plan, one-time confirmation, and audit log as the page, so protected rows (ssh, remote access, the tunnel, Scout itself, and DNS and network software) never offer Stop, Restart, or Disable, and the panel shows why. A disabled row does not start; enable it first. When an action needs admin rights, the panel asks you to approve the UAC prompt on the Windows machine, or shows a sudo command to run on the Mac.

Right-click a row for Hide this row, Hide all of its kind, Hide everything from its vendor, Pin to top, and Open in Scout. The footer has Open Scout, a count of rows hidden by rules, and a theme toggle that cycles through system, dark, and light. Right-click the tray icon for Open Scout, Connection settings, and Quit. Only one copy of the panel runs at a time.

The panel checks the hub every 30 seconds while it is closed and every 5 seconds while it is open.

### Hide rules and pins

The rules live on the hub machine in `.scout-data/tray.json`. A rule hides rows by kind (`windows-service`, `launchd`, `scheduled-task`, `listener`, `container`, `recipe`, or `stack`), by class (`essential`, `optional`, or `third-party`), by machine, by vendor (`apple`, `microsoft`, or `other`), or by name with an optional machine. Pins keep chosen rows at the top of their tab. Edit the rules from the panel's right-click menu or on the portal's Settings page, which also imports and exports them as JSON.

Hide rules change only what the panel shows. The outage watch checks and alerts on the same items whether they are hidden or not.

### Create a service token

The hub answers its public hostname only to requests that carry an Access token, so each device that runs the panel needs a service token. One token can serve several devices, and a separate token for each device lets you revoke one without touching the others.

1. In Cloudflare Zero Trust, open Access, Service Auth, Service Tokens, and create a token. Copy the Client ID and the Client Secret. Cloudflare shows the secret only once.
2. Open the self-hosted Access application for Scout and add a policy with the action Service Auth that includes the new token.
3. On the hub machine, add the token's Client ID to the `allowedServiceTokens` list in `access.json`, then restart the hub.

```json
{
  "host": "scout.example.com",
  "teamDomain": "your-team.cloudflareaccess.com",
  "aud": "the-application-audience-tag-from-cloudflare-access",
  "allowedEmails": ["you@example.com"],
  "allowedServiceTokens": ["your-client-id.access"]
}
```

A service token reaches only `/api/tray` and the paths under it, `GET /api/services/actions`, `POST /api/services/actions/plan`, and `POST /api/services/actions/run`. Any other request answers 403, and the hub refuses a token whose Client ID is not in `allowedServiceTokens`.

### Connect the panel

Open the connection screen from the settings button in the panel, or from Connection settings on the tray icon's right-click menu. Enter the hub address (`https://` and the hostname, with no path), the Client ID, and the Client Secret, then save. The panel keeps the secret in the system keychain (Windows Credential Manager or the macOS Keychain) and never writes it to a file.

### Build and run

Install Rust and pnpm, plus the Xcode command line tools on macOS. Build each platform on its own machine. There is no Linux build yet.

```
pnpm install
pnpm --filter @scout/tray build
pnpm --filter @scout/tray exec tauri build --no-bundle
pnpm --filter @scout/tray dev
```

`build` makes an installer, `exec tauri build --no-bundle` makes only the executable (`src-tauri/target/release/scout-tray.exe` on Windows), and `dev` runs the panel from source. The macOS app is not notarized, so the first time you open it, right-click it and choose Open.

To work on the panel's UI in a plain browser, serve `packages/tray` and open `ui/index.html`. It runs against the mock hub in `packages/tray/dev`.

### Start the panel at login

On Windows, add the panel to the Startup folder. On macOS, add it to Login Items in System Settings.

### Troubleshooting the panel

- The icon shows a grey cross: the panel is not connected yet, cannot reach the hub, or had its token refused by Cloudflare Access. The banner in the panel says which.
- The panel says "Cloudflare Access turned down the service token": check the Client ID and secret on the connection screen, the Service Auth policy on the Access application, and `allowedServiceTokens` in `access.json` on the hub machine.

## Agents and the command line

You can check on your machines from a terminal, or let an AI agent do it, without opening the Scout page. The commands and the MCP server below read the hub machine's catalog directly (`.scout-data/catalog.db`, or another file with `--db`), so they work even when the hub is stopped. Run them from the Scout folder on the hub machine.

### Check status, ports, and the systems map

```
node packages/cli/src/main.ts status
node packages/cli/src/main.ts whois 5432
node packages/cli/src/main.ts whois postgres
node packages/cli/src/main.ts map --out ~/notes/systems-map.md
```

`status` shows whether everything is up, how many outages are open, and how many rows on each machine are up, changed, down, or stopped, then lists each open outage and everything that is down or changed. It shows the same rows as the tray panel and follows your hide rules, and it also shows open outages for things that have since disappeared from a machine. Add `--json` to get JSON.

`whois` takes a port number or part of a service, process, container, or image name, and shows what matches on every machine and which program is behind it. It searches everything that is present, including rows you have hidden from the tray panel.

`map` writes a markdown document with a table for each machine (name, kind, state, port, whether the row is protected or yours, and a detail), then your stacks and your port registry. The registry part shows each range with how many ports are used and the next free one, each reserved port and what holds it, and any clashes. Without `--out`, it prints to the terminal.

### Keep the map in your notes

With `--out`, `map` saves the file, creates any missing folders, and replaces the old copy in one step. Save it to a notes folder or vault and rerun it from a scheduled task, or by hand, to keep it current.

### Connect an agent

Any agent that supports the Model Context Protocol, such as Claude Desktop or Claude Code, can use Scout's MCP server. Add it to the agent's MCP configuration with the path to your Scout folder:

```json
{
  "mcpServers": {
    "scout": {
      "command": "node",
      "args": ["C:/path/to/scout/packages/mcp/src/main.ts"]
    }
  }
}
```

The agent starts the server on the hub machine and talks to it over standard input and output (JSON-RPC 2.0, one message per line), so the server opens no network port and only that agent can reach it. Add `--db <file>` to the args to use a different catalog. The server needs nothing outside the Scout repository and supports MCP protocol versions 2025-11-25, 2025-06-18, 2025-03-26, and 2024-11-05.

### What an agent can do

An agent can read what the commands above show, plus your services with their ids, ports, protection, and available actions, filtered by machine, state, or name. It can also read outages, alerts, the port registry, and the log of every start, stop, restart, disable, and enable. The tools are `scout_status`, `scout_whois`, `scout_services`, `scout_outages`, `scout_alerts`, `scout_ports`, `scout_systems_map`, and `scout_action_log`.

`scout_start_service` starts a stopped service or listener. Scout plans the start, runs it if the plan is allowed, and reports the result, with the same checks, one-time token, and audit log as the page and the tray panel. It refuses a service that is already running or protected and says why. If the start needs admin rights, the agent gets the sudo command to run, or a note to approve the prompt on that machine.

An agent cannot stop, restart, disable, or enable anything, and `scout_start_service` only starts. With `scout_plan_action` it can ask what a start, stop, restart, disable, or enable would do, whether it is allowed, and what would break, but it never gets the token needed to run it. To stop, restart, disable, or enable, use the Scout page, the tray panel, or the CLI:

```
node packages/cli/src/main.ts control run <service|listener> <id> <stop|restart|disable|enable> --yes
```

Protected services (ssh, remote access, the tunnel, Scout itself, and DNS and network software) never offer Stop, Restart, or Disable anywhere. Enable is always allowed, and a disabled service has to be enabled before it can start. On the Services page, Disable and Enable sit in the row's Actions section next to the other buttons.

### Who can use it

The MCP server has no sign-in. Anyone who can run it on the hub machine can read the catalog and start services, just as they could with the CLI, so connect it only to agents you would trust with the CLI.

## Local state

Everything Scout writes lives in `.scout-data/`:

| File | Contents |
| --- | --- |
| `catalog.db` | The SQLite catalog. |
| `protected.json` | Optional. Turns off the remote access, DNS and network, or containers protection groups (`"disable": [...]`), and adds your own protected entries (`"names": [{ "machine", "match", "reason" }]`). |
| `ports.json` | Optional port registry: named `ranges` and `reserved` ports. Port-clash alerts come from it. |
| `stacks.json` | Optional stacks: ordered lists of recipes and services with wait-for-port steps. |
| `alerts.json` | Alert mutes. |
| `watch.json` | Outage watch switches, set from the Outages tab or the `outages watch` and `unwatch` commands. Everything is watched until a switch is turned off. |
| `mine.json` | Optional profile for the Mine flag: your GitHub account and organization names (`owners`) and git author emails (`emails`). Git ignores it. |
| `heartbeat.json` | The hub's heartbeat, rewritten every 30 seconds. The watchdog reads it, and the hub reads it at startup to record a monitor gap. |
| `tunnel-hosts.json` | Optional tunnel name to machine id map. |
| `cogitator.json` | Optional local AI gateway settings. |
| `hub.log` | Output of the Windows supervisor script. |

The page and the CLI write most of these for you. Back up `.scout-data` to keep your descriptions and recipe approvals.

## Run the hub at login

On Windows, `tools/run-hub.ps1` runs the hub in production mode, appends its output to `.scout-data/hub.log`, and restarts it 10 seconds after any exit. Extra arguments are passed to the hub. Register it as a logon task from a `pwsh` window run as administrator, using the full path to `pwsh.exe` (a scheduled task does not see your shell's PATH):

```powershell
$pwsh = "C:\Program Files\PowerShell\7\pwsh.exe"
$action = New-ScheduledTaskAction -Execute $pwsh -Argument '-NoProfile -WindowStyle Hidden -File "C:\Projects\scout\tools\run-hub.ps1"'
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName "Scout hub" -Action $action -Trigger $trigger -Settings $settings
```

The zero time limit matters: the supervisor never exits, and the default limit would stop it after three days. Set any optional environment variables (`SCOUT_AI_TOOLKIT`, `BWS_ACCESS_TOKEN`, and so on) at the top of the script, since a logon task does not run your shell profile. For local mode at login, make a copy of the script that runs `pnpm --filter @scout/hub start -- --live` instead.

`pnpm --filter @scout/hub watchdog` is the outage watchdog, and `tools/run-watchdog.ps1` runs it and restarts it after any exit. On Windows, register that script as a second logon task beside the hub, with the same environment variables as the hub (or the `.scout-data/discord-webhook.dpapi` file) so it can send the Discord post. It runs until logoff too, so it needs the same zero time limit:

```powershell
$pwsh = "C:\Program Files\PowerShell\7\pwsh.exe"
$action = New-ScheduledTaskAction -Execute "conhost.exe" -Argument "--headless `"$pwsh`" -NoProfile -NonInteractive -File C:\Projects\scout\tools\run-watchdog.ps1"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName "Scout watchdog" -Action $action -Trigger $trigger -Settings $settings
```

On macOS or Linux, any service manager works (a launchd agent, a systemd user unit). Run the same command from the repository folder and restart it when it exits.

## Updating Scout

```
git pull
pnpm install --frozen-lockfile
```

Then restart the hub. Under the supervisor, stopping the `node` process is enough, and it comes back within 10 seconds. The catalog upgrades its schema in place the next time it opens.

## Troubleshooting

- `machines.json not found`: copy `machines.example.json` to `machines.json` in the repository root.
- A machine prints `unreachable`: run `ssh -o BatchMode=yes <target> true` with the same options as in `machines.json`. A password prompt, an unknown host key, or a locked key all fail in batch mode. On Windows, an `unreachable` hub machine usually means `pwsh` is not on PATH.
- Homebrew sources are `skipped` on a Mac: Scout looks for `brew` under `/opt/homebrew`, `/usr/local`, and `~/.homebrew`. Check that `ssh <target> 'zsh -lc "command -v brew"'` prints a path.
- A guest such as WSL or colima is missing: start it yourself and scan again. Scout reads guests only while they run.
- The Updates view is empty: run `pnpm --filter @scout/cli research`, or start the hub with `--schedule`.
- The page shows `421 misdirected request`: local mode accepts `127.0.0.1` or `localhost`, and production mode accepts only the hostname in `access.json`.
- Production mode refuses every request: the hub log has an `[access] refused` line with the reason, such as `wrong audience` or `email is not allowed`. Compare `access.json` with the Access application.
- The hub prints `cloudflare reader off`: no token was found. Set `SCOUT_CLOUDFLARE_TOKEN`, or make `bws` and `BWS_ACCESS_TOKEN` available to the hub process.
- No Discord post arrives: press Send a test notice on the Outages tab and read the channel status there. `SCOUT_DISCORD_WEBHOOK` must reach the hub process (and the watchdog task), and it must be a `discord.com` or `discordapp.com` webhook address.
- Port 4870 is taken: start the hub with `--port` and another port, and point the tunnel there in production mode.

## Platform notes

The hub and the full feature set target a Windows hub machine. Remote macOS machines are fully supported over ssh: apps, Homebrew, casks, pkgutil, launchd, npm, pipx, uv tools, Go and local binaries, container images, listeners, and usage signals. On Windows, Scout reads the registry, winget, Store apps, services, scheduled tasks, WSL, Docker Sandboxes, Python and Node runtimes, listeners, and usage.

Linux support is limited to dpkg packages, process and file-access usage readers, AI tool use counts, project files, and dependency facts. There is no pacman or AUR adapter, no systemd or Linux listener reader, and no update runner for Linux package managers. Launch recipes run only on a Windows hub machine, and running the hub itself on Linux has not been tested. Adapters for Arch Linux (pacman, systemd, and `ss`) are the most wanted contribution, and [ARCHITECTURE.md](ARCHITECTURE.md) explains how an adapter is built.
