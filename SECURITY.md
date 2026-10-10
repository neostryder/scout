# Security

Scout reads a great deal about your machines and can change some of them. Every change needs a request from you, and the gates on each kind of change are listed below.

## What listens

The hub is the only listener, and it binds to 127.0.0.1 (port 4870 by default) in every mode. Nothing on your network can reach it directly. The outage watch and its watchdog add no listener.

In local mode there is no sign-in. The hub answers only requests whose Host is `127.0.0.1`, `localhost`, or `[::1]`, which blocks DNS rebinding. Requests that change anything must carry a JSON content type, which a cross-site form cannot send, and any Origin they carry must be a loopback one. The page is served with a strict Content-Security-Policy that allows only the hub's own scripts and styles and forbids framing.

In production mode the page sits behind Cloudflare Access on a public hostname, reached through a `cloudflared` tunnel on the same machine. The hub answers only the hostname in `access.json` and checks the `Cf-Access-Jwt-Assertion` token on every request itself, without trusting any header Cloudflare adds: the RS256 signature against the team's published keys, the issuer, the audience, the time window, and, when `allowedEmails` is set, the email. A request that reaches the loopback port any other way is refused.

## What is read-only

Scanning is read-only. Every probe is a fixed argument array defined by its adapter, never a shell string, and nothing in it comes from page or user input. Probes never install, upgrade, start a service, ask for a password, or write outside a temp folder, and a scan never starts a program or a guest VM. Remote machines are read over ssh with your own keys in batch mode, and Scout installs nothing on them.

The Cloudflare reader uses GET requests only. Its token is read from an environment variable or Bitwarden Secrets Manager at startup, kept in memory, and never written to the catalog or the logs. Version research asks public registries and project sites about each package by name, and sends nothing else about your machines.

The outage watch opens a TCP connection to each machine's ssh port, reads the SSH greeting, and closes the connection. It sends no credentials, never logs in, and runs no command on any machine. Its notices go to the hub machine's desktop and, when configured, to a Discord webhook. Only `discord.com` and `discordapp.com` webhook addresses are accepted, and a post never mentions anyone.

Every process Scout starts on Windows runs with a hidden window.

## What can change a machine

Nothing changes on its own. Every change below starts from a click on the page or a CLI command, and the CLI's `control run` and `stacks start` refuse to run without `--yes`.

- Updates. A plan shows the exact package-manager command first. The hub accepts a batch only with an explicit confirmation, a disruptive update (an app, or anything that is running) needs a second one, and a soft dependency risk needs another. The dependency guard refuses updates that would break other installed programs. Jobs run one at a time per machine and record every step. An update that needs administrator rights is refused, because Scout does not request administrator rights.
- Installer downloads. For apps with no package manager, a download job saves an installer from an HTTPS URL to that machine's Downloads folder after checking its size (at most 2 GiB) and checksum. Scout never runs the installer.
- Start, stop, and restart. A plan names the exact action. Allowed plans carry a random one-time token that expires after two minutes, the run re-checks the target against the plan, and every run writes an audit row. Rows in a protected group (operating-system essentials, Scout itself, cloudflared, ssh, the local AI gateway, remote access, DNS and network, and containers) cannot be stopped. Actions that need administrator rights go through the Windows UAC prompt, or on macOS show a `sudo` command for you to run yourself.
- Launch recipes and stacks. These run only on a Windows hub machine, through the same plan, token, and audit pipeline. A recipe must be approved once for its exact command, and a changed command needs approval again. Only node, npm, npx, pnpm, yarn, python, python3, py, uv, docker, deno, bun, and dotnet can be launched. Values reach the shell through environment variables, never as command text, and arguments must match a strict character set.
- Uninstall. Scout only shows instructions as text.

## AI features

The AI toolkit and the local AI gateway are off unless you configure them. Scout calls the toolkit as a local script and never calls a model API itself. Release notes, vendor pages, and service names go to the public route. Dependency discovery sends a stripped copy of the inventory to the internal route. All model calls are capped at 30 in any rolling hour. The gateway URL must be a loopback address, or Scout refuses it.

## Local state

`machines.json`, `access.json`, and the `.scout-data` folder are git-ignored. They hold your machine list, your Access settings, the catalog, and your edits and approvals. No token or key is written to any of them. Secrets come from environment variables or Bitwarden Secrets Manager, and lookup errors name the failure without the value. The outage watch keeps its switches in `.scout-data/watch.json` and the hub's heartbeat in `.scout-data/heartbeat.json`. The Discord webhook address is a secret: Scout reads it from `SCOUT_DISCORD_WEBHOOK` only, never writes it to a file, and never shows it on the page.

## Reporting a vulnerability

Please report security problems privately through GitHub's private vulnerability reporting: open https://github.com/neostryder/scout/security and choose "Report a vulnerability". Include the version or commit, the platform, and the steps to reproduce. Do not open a public issue for a security problem.
