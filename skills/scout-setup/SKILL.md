---
name: scout-setup
description: Install, configure, and troubleshoot Scout, the self-hosted tool that inventories the software on your own computers and updates it on request. Use when someone wants to set Scout up for their machines, add a machine to machines.json, get ssh access to a remote working, choose between local mode and production mode behind Cloudflare Access, run the hub at login, or work out why a scan or the hub page is failing.
---

# Setting up Scout

You are helping someone get Scout running on their own machines. Scout scans each machine with read-only commands, keeps a SQLite catalog on one machine (the hub machine), and serves a page on loopback where they can see what is installed, what is out of date, and what is listening. The full reference is `docs/SETUP.md` in the repository. Read it when a detail here is not enough, and read the code before you state anything that neither covers.

Work through the steps below in order, one at a time, and check each result before moving on. Most people need steps 1 through 8. The rest are for when they ask.

## Ground rules

- Ask before anything that changes the machine: installing Node, pnpm, git, or PowerShell; turning on an ssh server; writing to `authorized_keys` or `~/.ssh/config`; registering a scheduled task, launch agent, or systemd unit; creating a Cloudflare tunnel; opening a port. Say what you will run and why, and wait for a yes.
- Never print, echo, log, or store a secret. That covers API tokens, `BWS_ACCESS_TOKEN`, `SCOUT_COGITATOR_KEY`, the Discord webhook address in `SCOUT_DISCORD_WEBHOOK`, private keys, and anything in a secrets manager. Do not ask the user to paste a token into the chat. Have them set it in their own environment. Confirm a token works by its effect (the Cloudflare reader printing counts), never by showing it.
- Never start an update job, a start, stop, or restart, a recipe approval, or a stack from the page, the API, or the CLI unless the user asks for that specific action. Setting Scout up never requires one.
- Scans are read-only and safe to run, but they take time and open ssh connections, so tell the user what is about to happen before you start one.

## 1. Learn the machines

Ask the user, in one round of questions:

- Which machines they want to track, and for each one the operating system (Windows, macOS, or Linux) and CPU (x64 or arm64).
- How the machines reach each other: the same home network, a VPN, hostnames or IP addresses, and the ssh user name on each remote.
- Which machine will be the hub machine, the one that runs Scout.
- Whether they want to open the page only on the hub machine (local mode) or from anywhere through a public hostname behind Cloudflare Access (production mode).

Be straight about platform support before they pick the hub machine. The hub and the full feature set target Windows. Remote Macs are well supported over ssh. Windows machines are read through the local transport, so a Windows machine should be the hub, and a second Windows machine cannot be scanned over ssh today because remote commands run under zsh. Linux support is limited to dpkg packages, usage readers, AI tool use counts, project files, and dependency facts: there is no pacman or AUR adapter, no systemd or Linux listener reader, no Linux update runner, and launch recipes run only on a Windows hub. Running the hub itself on Linux has not been tested. If they run Arch, say so plainly and mention that pacman, systemd, and `ss` adapters are the contributions the project most wants.

## 2. Check prerequisites

On the hub machine, run:

```
node --version
pnpm --version
git --version
ssh -V
```

On a Windows hub machine, also run `pwsh --version`. The Windows probes call PowerShell 7 and will mark the machine unreachable without it. Node must be 24 or newer. If something is missing or too old, tell them what to install and offer to do it, but ask first.

On each remote, zsh must exist, because Scout runs every remote command under `zsh -lc`. Macs have it already. A Linux remote may need it installed.

## 3. Clone and install

```
git clone https://github.com/neostryder/scout.git
cd scout
pnpm install --frozen-lockfile
```

Ask where they keep their projects before cloning, and use that folder. `pnpm test` is a good optional check: it runs against recorded fixtures and touches nothing.

## 4. Build machines.json

Copy `machines.example.json` to `machines.json` (the copy is git-ignored) and fill it in from what they told you. Each entry needs `id` (short, stable, used on the command line), `name`, `os` (`windows`, `macos`, or `linux`), `arch` (`x64` or `arm64`), and `transport`. The hub machine gets `{ "type": "local" }`, and each remote gets `{ "type": "ssh", "target": "user@host", "options": ["-i", "~/.ssh/id_ed25519"] }`. `address` is optional and only recorded. `projectRoots` is optional: folders that hold projects, where a trailing `/*` means every child folder not starting with `_` or `.`. That form expands only on the local machine, so list remote folders individually. Use forward slashes in Windows paths.

Show them the finished file and read it back to check:

- It parses as JSON and has a top-level `machines` array.
- Every `id` is unique.
- Exactly one machine uses the `local` transport. That one is the hub machine.
- No Windows machine uses ssh.
- Every ssh entry has a `target`.

## 5. SSH access to each remote

Scout runs ssh with `BatchMode=yes` and an eight-second timeout, so a key has to work with no prompt of any kind. For each remote:

1. Make sure an ssh server is running there. On a Mac the user turns on Remote Login in System Settings, General, Sharing. Walk them through it rather than doing it yourself.
2. If they have no key on the hub machine, offer to run `ssh-keygen -t ed25519`.
3. Get the public key into the remote's `~/.ssh/authorized_keys`, with their permission.
4. Have them connect once by hand (`ssh user@host`) to accept the host key, since batch mode refuses unknown hosts.
5. Confirm, with the same options as in `machines.json`:

```
ssh -o BatchMode=yes -i ~/.ssh/id_ed25519 user@host true
ssh -o BatchMode=yes -i ~/.ssh/id_ed25519 user@host 'zsh -lc true'
```

Both must exit 0 with no output. If the key has a passphrase, it needs to be loaded in an ssh agent, and the agent has to be running for a hub started at login too.

## 6. The first scan

Scan one machine at a time, the hub machine first:

```
pnpm --filter @scout/cli scan <machine-id>
```

A full scan of a Windows machine takes about two and a half minutes. The first scan of any machine runs several minutes longer, because it reads every AI tool log once. Run it in the background if your environment allows, and tell the user what to expect.

Read the output with them. Each source prints a status and counts. `skipped` is normal for a tool that is not installed or a guest that is not running, because Scout never starts a guest. `partial` or `failed` carries a message worth reading. `unreachable` means the transport failed, so go back to step 5 (or, on Windows, check `pwsh`). When every machine is done, `pnpm --filter @scout/cli report` shows the latest result per source.

## 7. Look up versions

```
pnpm --filter @scout/cli research
```

This asks public registries for the newest versions, sending package names only, and fills the Updates view.

## 8. Start the hub in local mode

```
pnpm --filter @scout/hub start -- --live
```

Run it in the background. It listens on 127.0.0.1 port 4870 only. Confirm the page answers, for example with `curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:4870/` (expect 200), then have the user open http://127.0.0.1:4870/ in a browser on the hub machine. Add `--schedule` if they want version lookups to refresh on their own, and `--port N` if 4870 is taken.

Show them around briefly: Catalog, Updates, Review, Jobs, and Services. Point out that update buttons and service controls always show a plan and ask for confirmation, and that you will not press them on their behalf.

Show them the Outages tab on the Services page. The hub checks every machine, tracked hostname, and running service every 2 minutes, records each outage, and shows a desktop notification on the hub machine. Ask whether they also want outage notices posted to Discord. If they do, they create a webhook in the channel's settings and set its address as `SCOUT_DISCORD_WEBHOOK` in the hub's environment themselves. After a hub restart, have them press Send a test notice on the Outages tab and confirm the post arrived. Mention that the tab can pause the watch for 1 or 8 hours before maintenance.

## 9. Production mode, only if they want it

Production mode puts the page on a public hostname such as `scout.example.com` behind Cloudflare Access. The hub still listens on loopback and a `cloudflared` tunnel on the hub machine carries traffic to it. The hub checks the Access token on every request itself and answers only the configured hostname.

If they want it, walk them through: a tunnel routing the hostname to `http://127.0.0.1:4870`; a self-hosted Access application for that hostname with a policy that admits only them; and `access.json` copied from `access.example.json` with `host`, `teamDomain`, `aud` (the application's audience tag), and optionally `allowedEmails`. They do the Cloudflare dashboard steps themselves, and you ask before you create or change a tunnel from the command line. Start it with `pnpm --filter @scout/hub start:production`. Afterward, `http://127.0.0.1:4870/` answers 421, which is expected, and the public hostname should show the Access login and then the page.

## 10. Optional integrations, only on request

`docs/SETUP.md` has the details. In short:

- Cloudflare reader: a read-only API token in `SCOUT_CLOUDFLARE_TOKEN`, or a Bitwarden Secrets Manager secret named `CLOUDFLARE_SCOUT_READ` read through `bws`. Check it with `node packages/cli/src/main.ts cloudflare read`, which prints counts and never the token.
- GitHub token in `SCOUT_GITHUB_TOKEN` for GitHub release lookups.
- Discord outage notices: a webhook address in `SCOUT_DISCORD_WEBHOOK`. Only `discord.com` and `discordapp.com` addresses work. Check it with Send a test notice on the Outages tab.
- AI toolkit: `SCOUT_AI_TOOLKIT` pointing at a PowerShell script, plus `SCOUT_MODEL_ROUTE_PUBLIC` and `SCOUT_MODEL_ROUTE_INTERNAL`. Capped at 30 calls an hour.
- A local OpenAI-compatible gateway for project descriptions, configured in `.scout-data/cogitator.json` with its key in `SCOUT_COGITATOR_KEY`.

The user sets every token and key in their own environment.

## 11. Run the hub at login, only on request

On Windows, `tools/run-hub.ps1` runs the production command and restarts the hub 10 seconds after any exit, logging to `.scout-data/hub.log`. For local mode they need a copy that runs `pnpm --filter @scout/hub start -- --live` instead. Registering a logon task changes the machine, so show the `Register-ScheduledTask` command from `docs/SETUP.md` and get a yes first. The task needs the full path to `pwsh.exe` and a zero execution time limit, and any optional environment variables belong in the script. On macOS or Linux, offer a launchd agent or a systemd user unit that runs the same command from the repository folder.

On Windows, also offer the outage watchdog, `tools/watch-hub.ps1`, as a second logon task. It sends a notice when the hub stops writing its heartbeat. It needs the same environment variables as the hub and the same zero time limit. Registering it is another machine change, so show the command from `docs/SETUP.md` and get a yes first.

## Troubleshooting

- `machines.json not found`: the copy is missing from the repository root.
- A machine is `unreachable`: run the batch-mode ssh test from step 5 with the exact options in `machines.json`. On a Windows hub machine, check `pwsh --version`.
- Homebrew is `skipped` on a Mac: `ssh <target> 'zsh -lc "command -v brew"'` should print a path. Scout looks under `/opt/homebrew`, `/usr/local`, and `~/.homebrew`.
- A guest such as WSL or colima is missing from the catalog: it was not running during the scan. The user starts it, then scan again.
- The Updates view is empty: run `research`, or restart the hub with `--schedule`.
- The page answers 421: the browser used a hostname the hub does not accept. Local mode wants `127.0.0.1` or `localhost`, and production mode wants the hostname in `access.json`.
- Production mode refuses everything: the hub's output has an `[access] refused` line with the reason. Compare `access.json` with the Access application.
- `cloudflare reader off` at startup: no token reached the hub process.
- No Discord post for an outage: `SCOUT_DISCORD_WEBHOOK` did not reach the hub process or the watchdog task, or it is not a `discord.com` or `discordapp.com` webhook address. The Outages tab shows each channel's status and can send a test notice.

When you finish, tell the user what is configured, which machines scanned cleanly, which mode the hub runs in, and anything left for them to do.
