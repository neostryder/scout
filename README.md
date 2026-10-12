# Scout

Scout keeps a list of the software installed on your own computers, tells you which of it is out of date, and updates it when you ask. It reads each machine with read-only commands, stores the results in a SQLite catalog on one machine (the hub machine), checks each install against the package manager or project that publishes it, and shows everything on a web page served from the hub on loopback.

It is meant for one person or a household with a handful of machines: a Windows desktop, a Mac or two, maybe a Linux box. Scout runs entirely on your own hardware. It needs no account, installs nothing on the machines it scans, and reaches other machines over ssh with keys you already have.

## What it does

- Builds an inventory of each machine: Windows registry entries, winget packages, Store apps, Homebrew formulae and casks, macOS app bundles and pkgutil receipts, npm globals, pipx and uv tools, Go and other local binaries, Python and Node runtimes, container images, and the contents of WSL and Docker Sandboxes guests. A scan never starts a program. Guests are read only while they are already running.
- Looks up the newest version of each install from Homebrew, npm, PyPI, GitHub releases, the Go module proxy, crates.io, Sparkle appcasts, winget, and the Microsoft Store, and shows end-of-life dates from endoflife.date as advisory notes.
- Updates installs through winget, the Store, brew, brew casks, npm, pipx, and uv. Each update shows the exact command, waits for your confirmation, then runs a preflight check, the update, and a verify step, one job at a time. A dependency guard refuses an update that would break a runtime another program needs, and asks for a second confirmation when the risk is softer.
- Maps the running side of each machine: listening TCP ports, published container ports, Windows services, scheduled tasks, and launchd jobs. Each row carries a description and a label of essential, optional, or third-party. Start, stop, and restart go through a plan and a one-time confirmation, and so do disable and enable for launchd jobs and scheduled tasks. A protected list (ssh, remote access, the tunnel, Scout itself, and more) cannot be stopped or disabled from Scout.
- Raises alerts for new listeners and background jobs, stopped services, widened network exposure, unhealthy endpoints, TLS certificates within 14 days of expiry, crash loops, and port clashes.
- Flags installs, services, and listeners that look out of place, such as a program running from a temp, Downloads, or Desktop folder, a Windows uninstall entry with no publisher, or an unsigned Store app package. With an optional profile of your GitHub accounts and commit emails, it also marks what comes from your own projects. Each flag shows its evidence and changes nothing.
- Watches for outages. Every 2 minutes the hub checks that each machine answers its ssh port with an SSH greeting, and checks the public hostnames and running services it already tracks. A machine that accepts a connection but sends nothing back counts as hung. Each confirmed outage is recorded with its start and end, listed on the Services page, and sent as a desktop notification and, if you set up a webhook, a Discord post.
- Starts your own projects on a Windows hub machine. Package scripts, launch configurations, and compose files under folders you name become launch recipes that you approve once, and a stack starts several recipes and services in order.
- Puts a Scout icon in the Windows system tray or the macOS menu bar. Its dot turns amber when something changed and red when something is down, and a click opens a small panel that lists the services, listeners, stacks, and launch recipes meant to stay up on each machine. Start, stop, and restart there go through the same plan and confirmation as the page.
- Reports on your machines from a terminal and to AI agents. The `status` command shows what is down or changed, `whois` says what holds a port or matches a name, and `map` writes a markdown systems map you can keep in a notes folder. An MCP server gives agents such as Claude Desktop and Claude Code the same information and lets them start a stopped service. Stopping and restarting stay with you.

Scout never runs an update or a control action on its own. Every change to a machine starts with a click or a command from you, and every one is written to an audit table.

## Quick start

You need Node 24 or newer, pnpm, git, and an OpenSSH client. A Windows hub machine also needs PowerShell 7 (`pwsh`) on PATH.

```
git clone https://github.com/neostryder/scout.git
cd scout
pnpm install --frozen-lockfile
cp machines.example.json machines.json
```

Edit `machines.json` so it lists your machines. The one with `"transport": { "type": "local" }` is the hub machine, the computer Scout runs on. Then scan it, look up versions, and start the hub:

```
pnpm --filter @scout/cli scan desktop
pnpm --filter @scout/cli research
pnpm --filter @scout/hub start -- --live
```

Open http://127.0.0.1:4870/ in a browser on the same machine. The hub listens on 127.0.0.1 only, so nothing else on your network can reach it. A full scan of a Windows machine takes about two and a half minutes. The first scan of any machine can take several minutes longer, because it reads every AI tool log once.

[docs/SETUP.md](docs/SETUP.md) covers every field of `machines.json`, ssh access to other machines, production mode behind Cloudflare Access, and running the hub at login.

## Platform support

The hub and the full feature set target a Windows hub machine. Other machines are reached over ssh, and remote commands run under `zsh -lc`, so a remote machine needs zsh (the default shell on macOS).

| | Windows | macOS | Linux |
| --- | --- | --- | --- |
| How Scout reaches it | As the local hub machine | ssh | ssh (with zsh installed) or local |
| Installed software | Registry, winget, Store apps, npm, pipx, uv tools, Python and Node runtimes, WSL and Docker Sandboxes guests | Apps, Homebrew, casks, pkgutil, npm, pipx, uv tools, Go and local binaries, container images | dpkg, pacman, and AUR packages |
| Listeners and services | Listeners, services, scheduled tasks | Listeners, launchd jobs | Listeners, published container ports, systemd services (read-only) |
| Usage signals | UserAssist, running processes | Spotlight, running processes | Running processes, file access times |
| Updates | winget, Store, npm, pipx, uv | brew, cask, npm, pipx, uv | Not yet |
| Start, stop, restart | Yes | Yes, over ssh | Not yet |
| Disable, enable | Scheduled tasks only | Launchd jobs, over ssh | Not yet |
| Launch recipes and stacks | Yes, on the hub machine | No | No |
| Running the hub | Yes | Not the target platform | Not tested |

Every platform also gets AI tool use counts, project files that pin tool versions, and dependency facts. On Linux, Scout reads listening TCP sockets with `ss` and also picks up the ports that Docker containers publish. Service units come from `systemctl show` and `systemctl list-unit-files`, so units that are installed but not loaded show up as well. The systemd reader does not need root. Scout lists packages from both dpkg and pacman, and it files any package that no sync database carries under the "aur" ecosystem. If a host has only one of the two package managers, Scout reports the missing one as skipped. Some gaps remain. Scout has no start, stop, restart, or disable control for systemd services on Linux. It also does not check for or run updates of pacman and AUR packages. The lookup of their newest upstream version is not wired up yet, even though the GitHub release lookup already accepts both ecosystems. The most wanted contributions are update runners for pacman and the AUR, and control of systemd services.

## Optional integrations

Everything below stays off until you configure it. A read-only Cloudflare reader lists your zones, DNS records, tunnels, Access applications, and Workers routes, and joins each public hostname to the machine and port behind it. A local AI toolkit script can summarize release notes, read versions off vendor pages, and propose dependencies between installed programs, capped at 30 calls an hour, and a local OpenAI-compatible gateway can write descriptions of your projects. A GitHub token raises the rate limit for GitHub release lookups. A Discord webhook in `SCOUT_DISCORD_WEBHOOK` adds a Discord post to each outage notice. [docs/SETUP.md](docs/SETUP.md#optional-integrations) has the details.

## More

- [docs/SETUP.md](docs/SETUP.md): installation and configuration
- [docs/SETUP.md#outage-alerts](docs/SETUP.md#outage-alerts): what the outage watch checks and how its notices reach you
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the packages fit together
- [SECURITY.md](SECURITY.md): the security model and how to report a vulnerability
- [CONVENTIONS.md](CONVENTIONS.md): rules for code, adapters, and fixtures
- [skills/scout-setup](skills/scout-setup/SKILL.md): a Claude skill that walks you through installing and configuring Scout for your own machines

Run the tests with `pnpm test` and the type check with `pnpm typecheck`. CI runs both on every pull request.

## License

Scout is licensed under the GNU General Public License v3.0 only (GPL-3.0-only). See [LICENSE](LICENSE).
