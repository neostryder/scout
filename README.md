# Scout

Scout keeps a list of the software installed on your own computers, tells you which of it is out of date, and updates it when you ask. It reads each machine with read-only commands, stores the results in a SQLite catalog on one machine (the hub machine), checks each install against the package manager or project that publishes it, and shows everything on a web page served from the hub on loopback.

It is meant for one person or a household with a handful of machines: a Windows desktop, a Mac or two, maybe a Linux box. Scout runs entirely on your own hardware. It needs no account, installs nothing on the machines it scans, and reaches other machines over ssh with keys you already have.

## What it does

- Builds an inventory of each machine: Windows registry entries, winget packages, Store apps, Homebrew formulae and casks, macOS app bundles and pkgutil receipts, npm globals, pipx and uv tools, Go and other local binaries, Python and Node runtimes, container images, and the contents of WSL and Docker Sandboxes guests. A scan never starts a program. Guests are read only while they are already running.
- Looks up the newest version of each install from Homebrew, npm, PyPI, GitHub releases, the Go module proxy, crates.io, Sparkle appcasts, winget, and the Microsoft Store, and shows end-of-life dates from endoflife.date as advisory notes.
- Updates installs through winget, the Store, brew, brew casks, npm, pipx, and uv. Each update shows the exact command, waits for your confirmation, then runs a preflight check, the update, and a verify step, one job at a time. A dependency guard refuses an update that would break a runtime another program needs, and asks for a second confirmation when the risk is softer.
- Maps the running side of each machine: listening TCP ports, published container ports, Windows services, scheduled tasks, and launchd jobs. Each row carries a description and a label of essential, optional, or third-party. Start, stop, and restart go through a plan and a one-time confirmation, and a protected list (ssh, remote access, the tunnel, Scout itself, and more) cannot be stopped from Scout.
- Raises alerts for new listeners and background jobs, stopped services, widened network exposure, unhealthy endpoints, TLS certificates within 14 days of expiry, crash loops, and port clashes.
- Starts your own projects on a Windows hub machine. Package scripts, launch configurations, and compose files under folders you name become launch recipes that you approve once, and a stack starts several recipes and services in order.

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
| Installed software | Registry, winget, Store apps, npm, pipx, uv tools, Python and Node runtimes, WSL and Docker Sandboxes guests | Apps, Homebrew, casks, pkgutil, npm, pipx, uv tools, Go and local binaries, container images | dpkg packages only |
| Listeners and services | Listeners, services, scheduled tasks | Listeners, launchd jobs | Not yet |
| Usage signals | UserAssist, running processes | Spotlight, running processes | Running processes, file access times |
| Updates | winget, Store, npm, pipx, uv | brew, cask, npm, pipx, uv | Not yet |
| Start, stop, restart | Yes | Yes, over ssh | Not yet |
| Launch recipes and stacks | Yes, on the hub machine | No | No |
| Running the hub | Yes | Not the target platform | Not tested |

All three platforms also get AI tool use counts, project files that pin tool versions, and dependency facts. Linux support is thin: there is no pacman or AUR adapter, no systemd or Linux listener reader, and no update runner for Linux package managers. Adapters for Arch Linux (pacman, systemd, and `ss`) are the most wanted contribution.

## Optional integrations

Everything below stays off until you configure it. A read-only Cloudflare reader lists your zones, DNS records, tunnels, Access applications, and Workers routes, and joins each public hostname to the machine and port behind it. A local AI toolkit script can summarize release notes, read versions off vendor pages, and propose dependencies between installed programs, capped at 30 calls an hour, and a local OpenAI-compatible gateway can write descriptions of your projects. A GitHub token raises the rate limit for GitHub release lookups. [docs/SETUP.md](docs/SETUP.md#optional-integrations) has the details.

## More

- [docs/SETUP.md](docs/SETUP.md): installation and configuration
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the packages fit together
- [SECURITY.md](SECURITY.md): the security model and how to report a vulnerability
- [CONVENTIONS.md](CONVENTIONS.md): rules for code, adapters, and fixtures
- [skills/scout-setup](skills/scout-setup/SKILL.md): a Claude skill that walks you through installing and configuring Scout for your own machines

Run the tests with `pnpm test` and the type check with `pnpm typecheck`. CI runs both on every pull request.

## License

Scout is licensed under the GNU General Public License v3.0 only (GPL-3.0-only). See [LICENSE](LICENSE).
