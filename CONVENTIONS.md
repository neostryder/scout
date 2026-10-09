# Scout conventions

These apply to every package in the workspace and to every brief written for a builder.

## Layout

- `packages/core`: schema, catalog store, the adapter contract and the fixture test helper.
- `adapters/<name>`: one package per adapter (`@scout/adapter-<name>`), each exporting `adapter: Adapter`.
- `fixtures/<sourceKind>/<case>/`: recorded probe output and the expected parse.

## Language and tooling

- TypeScript, run directly by Node (type stripping). Import with the `.ts` extension. No enums, namespaces or parameter properties (`erasableSyntaxOnly`).
- Tests use `node:test`. `pnpm test` runs every package; `pnpm typecheck` runs `tsc --noEmit` over the whole workspace. Both must pass before a commit.
- No dependencies unless a package genuinely needs one. Adapters depend on `@scout/core` only.
- Plain ASCII punctuation in code, comments and docs.

## The adapter contract

An adapter never touches a machine. It implements `Adapter` (`packages/core/src/adapter.ts`):

- `probes(ctx, location)` returns the fixed probes for one source instance: argument arrays, never shell strings, with nothing built from user or page input. The transport runs them (locally, over ssh through `scout-op`, or through a guest's CLI) and returns `ProbeOutputs`.
- `parse(outputs, location)` is a pure function from those recorded outputs to a `ScanResult`. It must not throw on malformed or partial input; it returns `status: "partial"` or `"failed"` with a `message`.
- A tool that is not installed is `status: "skipped"` with a message, not a failure. A probe marked `optional` may exit non-zero on a healthy machine.
- Identity is `(ecosystem, key)`. Adapters emit exact ecosystem ids and never merge or guess across ecosystems.
- Versions are stored as the source reports them, as strings. Adapters do not compare versions.

## Fixtures

- A fixture case is a directory `fixtures/<sourceKind>/<case>/` with `outputs.json` (a `ProbeOutputs` object recorded from a real machine), `expected.json` (the exact `ScanResult`), and an optional `location.txt`.
- Fixtures are recorded from real output. Never hand-invent output the tool does not produce. Include the awkward cases that occur: empty result, a package with no version, a name with unusual characters, a tool that is missing, a non-zero exit.
- Redact home-directory usernames and anything secret-looking before committing a fixture.
- Every adapter registers its cases with `fixtureTests(adapter, dir)` from `@scout/core/testing`.

## Scan safety

- **A scan must never launch anything.** Detect a guest (colima, WSL, Docker Sandboxes) from files and processes. Call a guest's CLI only while that guest is already running. Calling a guest CLI (`orb list` on a stopped OrbStack once did) can open first-run and update windows on the desktop.
- Every process started on Windows uses `windowsHide: true`.
- Commands on macOS hosts run under `zsh -lc`.
- Probes are read-only. Nothing a probe runs may install, upgrade, start a service, write outside a temp folder, or ask for a password.

## Commits

- Commit messages say what changed and why.
- Changes land under `## [Unreleased]` in `CHANGELOG.md`.
