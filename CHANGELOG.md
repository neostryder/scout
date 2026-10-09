# Changelog

## [Unreleased]

### Added

- [Visible] [Inventory] **Scout scans your machines and lists the software on each one.** It reads Windows (registry, winget, Store apps, WSL, Docker Sandboxes), macOS (apps, Homebrew, casks, pkgutil, launchd), npm, pipx, and uv tools, Go and local binaries, language runtimes, container images, and dpkg packages on Linux. Remote machines are read over ssh, and a scan never starts a program or a guest.
- [Visible] [UI] **A page on the hub machine shows the whole catalog.** It has Catalog, Updates, Review, Jobs, and Services views with live search, filters you can save, and a detail panel for each install. The Review view lets you confirm or reject installs that Scout thinks are the same program.
- [Visible] [Research] **Scout finds the newest version of each install.** It asks Homebrew, npm, PyPI, GitHub releases, the Go module proxy, crates.io, Sparkle appcasts, winget, and the Store, and shows end-of-life dates from endoflife.date as notes.
- [Visible] [Updates] **You can update installs from the page.** Scout shows the exact winget, Store, brew, cask, npm, pipx, or uv command, waits for you to confirm, and then runs a check, the update, and a verify step for one job at a time on each machine. The Updates list is sorted by a priority score by default.
- [Visible] [Updates] **Updates that would break other software are refused.** If an update would break a runtime another program needs, Scout refuses it, and smaller risks ask for a second confirmation. Version pins in your project files show up as notes.
- [Visible] [Updates] **Apps with no package manager can get their installer downloaded.** Scout saves it to that machine's Downloads folder after checking its size and checksum, and leaves running it to you.
- [Visible] [Services] **The Services view shows what is running and listening on each machine.** It lists open ports, Windows services, scheduled tasks, and launchd jobs, marks each as essential, optional, or third-party, and gives each a short description you can edit.
- [Visible] [Services] **You can start, stop, and restart services from Scout.** Each action shows a plan first, needs a one-time confirmation, and is logged. Scout will not stop anything on its protected list, such as ssh, remote access, the tunnel, or Scout itself, and it gives uninstall steps as text only.
- [Visible] [Services] **A Windows hub machine can start your own projects.** Scout finds package scripts, launch configurations, and compose files in your project folders and runs each one only after you approve its exact command. Stacks start several of them in order and wait for each port to open.
- [Visible] [Services] **Alerts tell you when something changes.** They cover new listeners and background jobs, stopped services, sites that are down, ports that became reachable from more places, failing health checks, certificates that expire within 14 days, crash loops, and port clashes with your ports registry. You can acknowledge or mute each one.
- [Visible] [Cloudflare] **An optional Cloudflare reader connects your public hostnames to your machines.** It reads zones, DNS, tunnels, Access applications, and Workers routes without changing anything, and it never saves the token.
- [Visible] [Security] **Production mode puts the page behind Cloudflare Access.** The hub checks every Access token itself and answers only the hostname you configure.
- [Visible] [AI] **Optional AI helpers summarize release notes and describe projects.** They run through a toolkit script and a local gateway that you supply, stay off until you set them up, and make at most 30 calls an hour.
- [Visible] [Docs] **New guides cover setup, the hub machine, and platform support.** The README, setup guide, architecture notes, security policy, and a scout-setup skill explain how to install Scout, why one machine in machines.json is the hub, and what works on Windows, macOS, and Linux today.
