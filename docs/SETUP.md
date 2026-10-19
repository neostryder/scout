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

## Catalog scan schedule and machine pause

A hub started with `--production` or `--schedule` scans your machines into the catalog every 6 hours, so you no longer need to run `node packages/cli/src/scan.ts` yourself. The first scans start 3 minutes after the hub starts. From then on, each enabled host is scanned once its last scan is older than the interval, one host at a time and at below-normal priority, so a slow scan does not hold up the hub. Hosts that have never been scanned go first. Running guests such as colima are scanned along with their host. Restarting the hub does not rescan a host that was scanned recently, because the schedule reads the last scan time from the catalog.

To change the interval, start the hub with `--scan-interval HOURS`, using a whole number from 1 to 168. To turn off automatic scans and keep the rest of the scheduled work, add `--no-scan-schedule`. `--no-schedule` turns off all scheduled work, scans included.

A scan counts as failed if it does not exit cleanly or if the host's `last_scan` in the catalog did not move past the scan's start time. An unreachable host fails this way, since its scan finishes without updating `last_scan`. A failed scan is retried after 1 hour, or after the interval if you set it shorter than that. A scan that runs for 45 minutes is stopped.

To see where things stand, call `GET /api/scans`. It returns `intervalSeconds` and, for each machine in `machines`, its `machineId`, `lastScanAt`, `lastRunAt`, `lastOk`, `lastError`, `nextDueAt`, and `running`. To scan right away, send `POST /api/scans/run` with `{}` for every enabled host or `{ "machineId": "mac-mini" }` for one. It answers 202 with the status list, 409 if a scan is already running, and 400 if the machine is unknown or paused. Manual scans work even with automatic scans turned off. The request needs a JSON body and must come from the same origin, and in production it also has to pass Cloudflare Access.

To stop Scout from contacting a remote machine, add `"paused": true` to its entry in `machines.json`. Scout then makes no connection to it at all: no scans, live reads, meters, outage checks, jobs, or control actions. The machine keeps its catalog rows and history. The Services page shows it as Paused, and the Resources page hides its saved meter card. To resume it, remove the flag or set it to false. Its state shows as `unknown` until the next probe. You do not need to restart the hub. Scans pick up the change within a minute, live reads on their next cycle, and jobs and control actions on the next request. Anything already running when you pause a machine can finish. The flag has no effect on the machine that runs the hub.

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

Scout calls ssh with `BatchMode=yes` and an eight-second connect timeout, so a remote must accept your key without any prompt. On a Windows hub machine it uses the ssh that comes with Git for Windows when that is installed, because the ssh bundled with Windows often exits with a crash code after finishing. Set the `SCOUT_SSH` environment variable to the full path of another ssh program to override that choice. It installs nothing on the remote side, and every probe is a read-only command.

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

5. To let a phone or an installer save the page as an app with its icon, add a second self-hosted Access application for the same hostname with the action Bypass and these paths as its destinations: `/manifest.webmanifest`, `/icon.svg`, `/icon-192.png`, `/icon-512.png`, `/icon-maskable-512.png`, `/apple-touch-icon.png`, and `/favicon-32.png`. Installers fetch those files without your sign-in. The hub serves exactly those paths to a GET without a token, and every other path still needs one.

In production mode, http://127.0.0.1:4870/ answers `421 misdirected request`. Use the public hostname.

## Using the portal on a phone and offline

The portal works in a phone's browser and as an app saved to the home screen. To save it with its icon, add the Bypass application from step 5 of [Local mode and production mode](#local-mode-and-production-mode).

### On a narrow screen

When the window is narrower than 720 pixels, the top navigation moves to a tab bar along the bottom of the screen. The tabs are Services, Resources, Alerts, Outages, and More, and More opens a sheet with Updates, Catalog, Review queue, Jobs, and Settings. The Alerts tab carries the number of open alerts. The Catalog and Updates tables show each row as a card, and the detail panel takes the whole screen when it opens.

On a narrow screen, Services opens filtered to the hub machine when the link does not name a machine. Choose All machines in the machine menu to see the rest. A link that names a machine opens on that machine.

The density button in the header cycles through Auto, Comfortable, and Compact. Auto gives taller rows and 44-pixel touch targets on a touch screen and the tight desktop rows with a mouse, and each browser remembers its own setting.

### Find a port, machine, or service

Press Ctrl+K (Cmd+K on a Mac), or tap the magnifier in the header, and start typing. The palette matches ports, machines, services, and page names, and a port can be typed as `port 4870`, `:4870`, or `4870`. Choosing a result opens that page or item. Every result is a link, and nothing in the palette starts, stops, or changes anything.

### When the hub is out of reach

As you browse, the service worker keeps a copy of each page file and each successful answer from the hub. If the hub cannot be reached, for example because the hub machine is off or the phone has no signal, the portal shows those saved copies instead. A gold strip then reads "Offline, as of" and a time, which is when the oldest answer on the screen was saved. Buttons that would change something, such as Start and Stop, are dimmed, and the hub refuses the request if one is sent anyway. When the hub answers again, the strip offers a reload.

A page has a saved copy only if you opened it in that browser while the hub was reachable, so open the pages you want on hand before you leave home. Each browser keeps at most 200 saved answers.

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

Scheduled tasks, services you start by hand, updater services, system plumbing, essential system services, browser debug ports, and ports opened by dev servers and other apps are not watched, so closing an app on purpose raises no alert. To watch one of them anyway, set it to `true` under `items` in `.scout-data/watch.json`.

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

## Resource meters

The Resources view sits beside Services in the page's top navigation and shows how busy each machine is. Each machine gets a card titled with its name, showing its operating system, how old the reading is ("Updated 8 s ago"), and a one-line summary such as "Processor 12%, Memory 38%, Video memory 44%".

Each card lists its meters as rows: Processor, Memory, one row per disk, Video memory and Graphics for each graphics card (NVIDIA cards only), and Network, which shows the download and upload rate. A row has a name, a detail line such as "24.0 GB of 64.0 GB", a bar, a large number, and a line chart of the last half hour. Disk and video memory rows have no chart.

### Reading a meter

Each bar has a tick at 85 percent. At 70 percent and above, the bar and the number turn amber and the row says "High". At 85 percent and above they turn red, the bar is striped, and the row says "Very high". The number and the word are always shown, so color is never the only signal.

Select the Processor or Memory row to list the five processes using the most of that meter on that machine, by process name. When a process belongs to a running service or an open listener in the catalog, the list shows the service's display name or the listener's script and port instead, with the word "service" or "listener" beside it. Select the row again to close the list. Memory use is the private working set on Windows and resident memory on macOS and Linux.

On a phone-width screen each row shows its name and number with the bar below, and the chart is hidden. Rows are buttons you can reach with the keyboard, and focus stays where it is when the readings refresh.

### How often readings arrive

The hub reads every machine over the connection Scout already uses for it: locally on the hub machine and over ssh for the others. It reads every 60 seconds, and every 10 seconds while the Resources page has asked for data in the last 30 seconds. An open page asks every 10 seconds and stops asking while its browser tab is hidden. A reading older than 150 seconds is marked "Stale".

Network rates come from the byte counters in two readings in a row, so after a reboot or a counter reset the rate is blank for one reading.

`--no-meters` on the hub command line turns metering off. Metering is also off when live reads are off.

### What each system reports

Every machine reports processor, memory, disks, and network. Video memory and Graphics rows come from `nvidia-smi` on Windows and Linux machines that have it. On macOS the volume that holds your data shows as `/`, and system and recovery volumes are left out. On Linux, loop, snap, boot/efi, and container mounts are left out, and loopback, container, bridge, and virtual interfaces do not count toward network.

### If a machine shows Stale

A machine that cannot be read keeps its last reading, the page marks that reading "Stale" once it is older than 150 seconds, and the other machines keep updating. Each failed read adds a line like this to the hub log:

```
meters bilbo       failed  (The meter read failed (exit 255).)
```

Each read has a 45 second limit. The usual causes are that ssh cannot reach the machine, the machine is asleep, or the read ran past that limit. Windows OpenSSH sometimes exits with a crash status such as 3221226356 (0xC0000374) after printing a full reading, and that reading still counts. Only empty or cut-off output counts as a failed read.

### Meter alerts

The hub sends a notice when a disk is nearly full, memory is under pressure, or video memory is nearly used up. Each of the three rules has an on/off switch, a percentage, and a number of minutes, and a notice goes out once a meter has stayed at or over that percentage for that many minutes. The defaults are:

- Disk: 90 percent for 5 minutes, for every disk on every machine, with each disk as its own alert.
- Memory: 92 percent for 10 minutes, for each machine.
- Video memory: 95 percent for 10 minutes, for each graphics card with a video memory reading.

Each episode sends one notice, with no repeats while the meter stays high, and a reading under the threshold before the minutes pass starts the count again. The alert clears when the meter falls to 5 points under the threshold or lower, and one "back to normal" notice follows. A dip that stays inside that 5-point margin neither clears the alert nor restarts the count. Turning a rule off while one of its alerts is up sends one closing notice. Notices go to the same channels as outage notices (see [Notices](#notices)): a desktop notification on the hub machine, and a Discord post when the webhook is set up. A raised alert is a high-severity notice, and a clearing notice is info.

To change the rules, open the Alerts section under the machine cards on the Resources page. It is closed by default, and its title shows how many alerts are up, as in "Alerts (2 up)". Each rule has a row with a checkbox, an "At or over" percent from 50 to 100, and a "For" time in whole minutes from 0 to 1440, where 0 alerts on the first reading. Below the rows are the alerts that are up ("No meter is over its threshold." when there are none), the Save alerts button, and a line saying where notices go. The same settings live in `.scout-data/meter-alerts.json` on the hub machine, which you can edit by hand. It holds `disk`, `memory`, and `vram`, each with `enabled`, `pct`, and `minutes`. Without the file the defaults apply, and when the file is malformed the defaults apply and the Alerts section shows a warning.

A machine whose reading is older than 150 seconds is skipped, so a machine that cannot be read raises and clears nothing. The hub keeps alert state in memory, so after a restart the count starts over, and a meter still over its threshold alerts again after its minutes. Turning metering off with `--no-meters`, or turning live reads off, turns the alerts off too.

### Backup alert

When Galadriel runs on the hub machine, Scout reads the health file it rewrites every minute and raises a "Backup unhealthy" alert on the Alerts tab in two cases. While the file reports a critical level, the alert reads "Backup is critical on <machine>" and repeats Galadriel's reasons, along with how long ago the last complete pass finished. When the file has gone 3 minutes without a rewrite, or cannot be read and has not changed in 3 minutes, the alert reads "Backup service is not running on <machine>". Galadriel's own settings decide what counts as critical. A warn level raises nothing, and a machine without the health file, which means Galadriel is not installed, never sees the alert.

The alert clears when the file reports ok or warn again, and a file caught partway through a rewrite neither raises nor clears it. The hub checks the file every minute while live reads are on (`--live` or `--production`). It sends one high-severity notice to the usual channels (see [Notices](#notices)) when the alert is raised and one "Backup is healthy again" notice when it clears, and a hub that starts while the backup is already critical sends the notice once.

The optional file `.scout-data/backup-health.json` on the hub machine holds `enabled` (true by default), `path` (`C:/ProgramData/Galadriel/health.json` by default), and `staleMinutes`, the number of minutes without a rewrite before the service counts as stopped (1 to 1440, 3 by default). A malformed file falls back to the defaults.

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

The icon is a small gold-and-amber watchtower with a status dot. The dot is green when everything meant to stay up is up, amber when something changed, and red when something is down. A grey cross takes its place when the hub cannot be reached or the panel is not connected yet. The icon follows the light or dark taskbar.

### What the panel shows

Click the icon to open a 420 by 600 panel. It has a tab for each machine, each with a count badge that turns red or amber when something needs attention, and a Stacks tab. Each row has a state dot, a name, a port, a response-time sparkline when Scout has samples, and a shield when the row is protected. Header pills count what is down and what changed, and the search box and the All, Down, and Mine chips narrow the list.

By default the panel lists the services and listeners that are meant to stay up, by the same rule as the outage watch (Windows services that start automatically, launchd jobs with KeepAlive set, their ports, and container and routed ports), plus stacks and approved launch recipes. A stopped service shows as down only if Scout has seen it running, and as stopped otherwise.

Hover over a row to see Start when it is stopped, or Restart and Stop when it is running. Right-click a launchd job or scheduled task to disable or enable it. Start and Enable run at once, and Stop, Restart, and Disable ask on the row first. Each action goes through the same plan, one-time confirmation, and audit log as the page, so protected rows (ssh, remote access, the tunnel, Scout itself, and DNS and network software) never offer Stop, Restart, or Disable, and the panel shows why. A disabled row does not start; enable it first. When an action needs admin rights, the panel asks you to approve the UAC prompt on the Windows machine, or shows a sudo command to run on the Mac.

Right-click a row for Hide this row, Hide all of its kind, Hide everything from its vendor, Pin to top, and Open in Scout. The footer has Open Scout, a count of rows hidden by rules, and a theme toggle that cycles through system, dark, and light. Right-click the tray icon for Open Scout, Connection settings, Start at login, and Quit. Only one copy of the panel runs at a time.

The panel checks the hub every 30 seconds while it is closed and every 5 seconds while it is open.

The panel first opens on the tab for the computer it runs on, found by matching this computer's short host name against each machine's id or name, and keeps whichever tab you pick after that. When no machine matches, it opens on the tab that most needs a look.

On a Mac, the Keychain asks for permission once after each update to the tray app, since every build has its own signature. Choose Always Allow and it stays quiet until the next update. The panel opens the connection screen by itself when no credentials are saved or when Cloudflare Access refuses the token, and the refusal message appears at the top of that screen. If the saved secret cannot be read, for example while the keychain is locked, the panel tries again every two minutes and writes each result to `panel.log` in the config folder.

Under the machine tabs, a strip shows how busy the selected machine is in up to four small rows: Processor, Memory, Disk, and Video memory. Disk is the busiest disk, labeled with its mount (for example "Disk C:"), and Video memory is the highest of the machine's graphics cards. Each row has a name, a bar, and a percentage, colored as on the Resources page (see [Reading a meter](#reading-a-meter)): amber with the word "High" at 70 percent and above, and red with "Very high" at 85 percent and above. A reading older than 150 seconds is dimmed, and the strip is labeled as out of date for screen readers. The strip is hidden for a machine the hub has not read yet.

When the pointer rests on the tray icon, the tooltip adds one line for each machine that has a reading, for example "Eru 12% CPU 38% RAM 20% VRAM". The VRAM figure appears only for a machine with a graphics card that reports video memory. A Windows tooltip holds at most 127 characters, so a line that would not fit is left out whole. These lines appear only while the hub is reachable.

### Start at login and Quit

The installed panel starts when you sign in and starts again if it crashes. On Windows it registers a per-user scheduled task named "Scout Tray" that runs at logon without admin rights, never starts a second copy, and restarts the panel every minute after a failed exit, up to 999 times. On macOS it writes the LaunchAgent `~/Library/LaunchAgents/dev.neostryder.scout-tray.plist`, which runs at login and restarts the panel after any exit that is not clean, waiting at least 10 seconds between starts. macOS loads the agent at the next login. The panel registers itself each time the installed app starts, and a development build (a cargo debug build or `pnpm --filter @scout/tray dev`) never registers anything.

"Start at login" on the tray icon's right-click menu carries a check mark and is on by default. Uncheck it to remove the scheduled task or LaunchAgent, and the panel saves `autostartDisabled: true` in `config.json` in its config folder. Check it again to register the entry again.

Quit on the same menu opens the panel and asks "Quit Scout?", with the note "The tray stays closed until the next time you sign in." Keep it running has the focus, and Escape does the same thing. Quit Scout exits cleanly, and neither the scheduled task nor the LaunchAgent restarts after a clean exit, so the panel stays closed until your next login or until you start it yourself.

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

If you build the tray yourself on a Mac, run `packages/tray/tools/make-mac-signing-identity.sh` once. It creates a code-signing identity named "Scout Local Signing" in a keychain of its own, with an empty password. Build from the repository root with the two commands below, which open that keychain and sign with the identity. Every build signed this way has the same designated requirement, so Always Allow for the saved hub secret still holds after a rebuild. A build without the identity is signed ad hoc, and the Keychain asks again after each one.

```
security unlock-keychain -p "" ~/Library/Keychains/scout-signing.keychain-db
APPLE_SIGNING_IDENTITY="Scout Local Signing" pnpm --filter @scout/tray exec tauri build
```

To work on the panel's UI in a plain browser, serve `packages/tray` and open `ui/index.html`. It runs against the mock hub in `packages/tray/dev`.

### Troubleshooting the panel

- The icon shows a grey cross: the panel is not connected yet, cannot reach the hub, or had its token refused by Cloudflare Access. The banner in the panel says which.
- The panel says "Cloudflare Access turned down the service token": check the Client ID and secret on the connection screen, the Service Auth policy on the Access application, and `allowedServiceTokens` in `access.json` on the hub machine.

## Agents and the command line

You can check on your machines from a terminal, or let an AI agent do it, without opening the Scout page. The commands and the MCP server below read the hub machine's catalog directly (`.scout-data/catalog.db`, or another file with `--db`), so they work even when the hub is stopped. Run them from the Scout install folder on the hub machine, or from the checkout when it holds the live data.

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

An agent can read everything the commands above show. It can also list your services with their ids, ports, protection, and available actions, filtered by machine, state, or name, and it can read outages, alerts, the port registry, and the log of every start, stop, restart, disable, and enable. The tools are `scout_status`, `scout_whois`, `scout_services`, `scout_outages`, `scout_alerts`, `scout_ports`, `scout_systems_map`, and `scout_action_log`.

The one thing an agent can change is starting a stopped service or listener, with `scout_start_service`. Scout plans the start, runs it if the plan allows it, and reports back, using the same checks, one-time token, and audit log as the Scout page and the tray panel. If the service is already running or is protected, Scout refuses and gives the reason. When the start needs admin rights, the agent gets back the sudo command to run, or a note to approve the prompt on that machine.

An agent cannot stop, restart, disable, or enable anything. It can call `scout_plan_action` to learn what a start, stop, restart, disable, or enable would do, whether that action is allowed, and what it would break, but the agent never gets the token needed to run it. For those actions, use the Scout page, the tray panel, or the CLI:

```
node packages/cli/src/main.ts control run <service|listener> <id> <stop|restart|disable|enable> --yes
```

Protected services never offer Stop, Restart, or Disable anywhere in Scout. They include ssh, remote access, the tunnel, Scout itself, and DNS and network software. Enable is always allowed, and a disabled service has to be enabled before it can start. On the Services page, Disable and Enable are in the row's Actions section with the other buttons.

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
| `backup-health.json` | Optional backup alert settings: whether the alert is `enabled`, the `path` to Galadriel's health file, and `staleMinutes`, how long the file can go without a rewrite before the backup service counts as stopped. |
| `mine.json` | Optional profile for the Mine flag: your GitHub account and organization names (`owners`) and git author emails (`emails`). Git ignores it. |
| `heartbeat.json` | The hub's heartbeat, rewritten every 30 seconds. The watchdog reads it, and the hub reads it at startup to record a monitor gap. |
| `tunnel-hosts.json` | Optional tunnel name to machine id map. |
| `cogitator.json` | Optional local AI gateway settings. |
| `hub.log` | Output of the Windows supervisor script. |
| `hub-settings.json` | Optional settings for `tools/run-hub.ps1`: `aiToolkit`, `modelRoutePublic`, and `modelRouteInternal`. |

The page and the CLI write most of these for you. Back up `.scout-data` to keep your descriptions and recipe approvals.

## Run the hub at login

On Windows, `tools/install-app.ps1` installs Scout as a per-user app that starts at logon. Run it from the repository:

```powershell
pwsh -NoProfile -File tools/install-app.ps1
```

The installer stops the Scout tasks and their `node` processes, copies the code to `%LOCALAPPDATA%\Scout` (skipping `node_modules`, `.git`, `.scout-data`, build output, `machines.json`, and `access.json`), and runs `pnpm install --prod --frozen-lockfile` there. On the first install it copies `.scout-data` from the repository, leaving out names that start with an underscore, profiling leftovers, and backup copies, and it copies `machines.json` and `access.json` only when the install folder has none. The repository's `.scout-data` is left as it is.

It then registers and starts two logon tasks, "Scout Hub" for `tools\run-hub.ps1` and "Scout Watchdog" for `tools\run-watchdog.ps1`. Each runs the full `pwsh.exe` path through `conhost.exe --headless`, has no time limit, never runs a second instance, and restarts after a failure, up to 999 times for the hub and 3 for the watchdog. A reinstall keeps the task names an earlier install chose. `.scout-data\install.json` records the source, target, and task names.

`-Target` installs to another folder, `-NoTasks` builds the copy without touching any process or task, `-NoStart` registers the tasks but leaves them stopped, and `-NoData` never copies `.scout-data`.

The install folder owns the live data: the catalog, settings, logs, `machines.json`, and `access.json`. Nothing running from it refers to the repository, so the repository can be moved or deleted. The CLI and the MCP server read the catalog of the folder they run from, so run them from the install folder to see live data.

`tools/run-hub.ps1` finds its folder from its own location, runs the hub in production mode with scheduled models, appends its output to `.scout-data/hub.log`, and restarts the hub 10 seconds after any exit. Each optional setting comes from its environment variable, then `.scout-data/hub-settings.json`, then the default:

```json
{
  "aiToolkit": "C:\\Users\\you\\AppData\\Local\\AiCliToolkit\\ai.ps1",
  "modelRoutePublic": "m3",
  "modelRouteInternal": "luna"
}
```

`aiToolkit` (`SCOUT_AI_TOOLKIT`) is the path to `ai.ps1`, by default `%LOCALAPPDATA%\AiCliToolkit\ai.ps1`. When that file is missing, models stay off and `hub.log` says so. `modelRoutePublic` (`SCOUT_MODEL_ROUTE_PUBLIC`) defaults to `m3`, and `modelRouteInternal` (`SCOUT_MODEL_ROUTE_INTERNAL`) defaults to `luna`.

A logon task does not run your shell profile. The watchdog needs the Discord address to send its post, from `SCOUT_DISCORD_WEBHOOK` or the `.scout-data/discord-webhook.dpapi` file.

On macOS or Linux, have a service manager such as launchd or systemd run `pnpm --filter @scout/hub start:production` and `pnpm --filter @scout/hub watchdog` from the Scout folder and restart them when they exit.

## Updating Scout

On Windows, update the repository and run the installer again:

```
git pull
pnpm install --frozen-lockfile
pwsh -NoProfile -File tools/install-app.ps1
```

The installer replaces the code, keeps the data and settings in the install folder, and restarts both tasks. The catalog upgrades its schema in place the next time it opens.

Without the installer, on macOS, Linux, or a development checkout, run `git pull` and `pnpm install --frozen-lockfile` in the folder the hub runs from, then restart the hub. Under `tools/run-hub.ps1`, stopping the `node` process is enough, and the hub comes back within 10 seconds.

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

On Linux, Scout reads dpkg and pacman packages, listening TCP sockets through `ss`, published Docker container ports, process and file-access usage, AI tool use counts, project files, and dependency facts. The `ss` reader tries `sudo -n` first, which works only with passwordless sudo and never prompts for a password, and falls back to the plain command if that fails. A socket held by another account, or by a root service read without sudo, is named after the systemd service that owns it, and its PID is left blank. Scout reads systemd service units read-only and lists them in the Services view. Packages that no sync database carries, usually ones built from the AUR or locally, are listed under the "aur" ecosystem. A host with only one of dpkg and pacman reports the other as skipped. Linux has no update checks or update runs for pacman and AUR packages, and it has no start, stop, restart, or disable control for systemd services. The newest-version lookup from the upstream project is not wired for pacman and AUR packages yet. Launch recipes run only on a Windows hub machine, and running the hub itself on Linux has not been tested. Update runners for pacman and the AUR and control of systemd services are the most wanted contributions, and [ARCHITECTURE.md](ARCHITECTURE.md) explains how an adapter is built.
