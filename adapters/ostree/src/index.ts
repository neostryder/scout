import type { Adapter, InstallRecord, ProbeContext, ProbeOutputs, ScanResult } from "@scout/core";

// Read-only: `rpm-ostree status` lists the deployments of an ostree system, the booted one marked with a star, and
// `skopeo inspect --no-tags --config` reads the configuration of the image in the registry. The script text is
// byte-identical to tools/probes/linux/ostree.sh. LC_ALL=C keeps the output in English. A machine without rpm-ostree
// exits 127 with one line on stderr, and a machine without skopeo leaves the registry section with exit 127 only.

const OSTREE_SH = "command -v rpm-ostree >/dev/null 2>&1 || { echo \"rpm-ostree is not installed\" >&2; exit 127; }\nexport LC_ALL=C\nstatus=$(rpm-ostree status 2>/dev/null)\nrc=$?\necho \"---SCOUT-STATUS---\"\nprintf '%s\\n' \"$status\"\necho \"exit=$rc\"\necho \"---SCOUT-REMOTE---\"\nref=$(printf '%s\\n' \"$status\" | sed -n 's/^[ *]*ostree[^:]*:docker:\\/\\/\\([^ ]*\\).*/\\1/p' | head -1)\nif [ -n \"$ref\" ] && command -v skopeo >/dev/null 2>&1 && command -v timeout >/dev/null 2>&1; then\n  timeout 60 skopeo inspect --no-tags --config \"docker://$ref\" 2>/dev/null\n  echo \"exit=$?\"\nelse\n  echo \"exit=127\"\nfi\n";

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

export interface Deployment {
  /** rpm-ostree marks the booted deployment with a star. */
  booted: boolean;
  /** The image reference with its tag, as the status line names it. */
  ref: string;
  digest: string;
  version: string;
}

/** The deployment blocks of a status text: a line naming the image, then the lines with its digest and its version. */
export function deployments(status: string): Deployment[] {
  const found: Deployment[] = [];
  let current: Deployment | null = null;
  for (const line of status.split("\n")) {
    const head = /^(\*)?\s*ostree[^:\s]*:docker:\/\/(\S+)\s*$/.exec(line);
    if (head) {
      current = { booted: head[1] === "*", ref: head[2] ?? "", digest: "", version: "" };
      found.push(current);
      continue;
    }
    const digest = /^\s*Digest:\s*(\S+)/.exec(line);
    if (digest && current) {
      current.digest = digest[1] ?? "";
      continue;
    }
    const version = /^\s*Version:\s*(\S+)/.exec(line);
    if (version && current) {
      current.version = version[1] ?? "";
      continue;
    }
  }
  return found;
}

export interface RemoteLabels {
  version: string | null;
  url: string | null;
}

/** The image labels in the registry configuration, when that section ran and the configuration parses. */
export function remoteLabels(body: string | null): RemoteLabels | null {
  if (body === null) return null;
  const lines = body.split("\n").filter((line) => line.trim() !== "");
  const exit = /^exit=(\d+)$/.exec((lines.at(-1) ?? "").trim());
  if (!exit || Number(exit[1]) !== 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines.slice(0, -1).join("\n"));
  } catch {
    return null;
  }
  const config = (parsed as { config?: unknown }).config;
  const labels = (config as { Labels?: unknown } | undefined)?.Labels;
  const read = (name: string): string | null => {
    const value = (labels as Record<string, unknown> | undefined)?.[name];
    return typeof value === "string" && value !== "" ? value : null;
  };
  return { version: read("org.opencontainers.image.version"), url: read("org.opencontainers.image.url") };
}

// A section is the text after its marker line up to the next marker. The "exit=N" line the script prints after a tool says whether that tool ran.
function section(text: string, marker: string): string | null {
  const match = new RegExp(`^---SCOUT-${marker}---\\n([\\s\\S]*?)(?=^---SCOUT-|(?![\\s\\S]))`, "m").exec(text);
  return match ? match[1]! : null;
}

/** The lines of a section whose tool ran: the body without the "exit=N" line the script prints after it. */
function listing(body: string | null): string[] {
  if (body === null) return [];
  const lines = body.split("\n").filter((line) => line.trim() !== "");
  const exit = /^exit=(\d+)$/.exec((lines.at(-1) ?? "").trim());
  if (!exit || Number(exit[1]) !== 0) return [];
  return lines.slice(0, -1);
}

export const adapter: Adapter = {
  sourceKind: "ostree",
  os: ["linux"],
  probes(_ctx: ProbeContext, _location: string) {
    return [{ id: "list", argv: ["/bin/sh", "-c", OSTREE_SH] }];
  },
  parse(outputs: ProbeOutputs, location: string): ScanResult {
    const probe = outputs["list"];
    if (!probe) return { sourceKind: "ostree", location, status: "failed", installs: [], message: "probe output missing" };
    if (probe.exitCode !== 0 || probe.stdout.trim() === "") {
      return { sourceKind: "ostree", location, status: "skipped", installs: [], message: `rpm-ostree did not run (exit ${probe.exitCode}): ${firstLine(probe.stderr)}` };
    }
    const text = probe.stdout.replaceAll("\r\n", "\n");
    const found = deployments(listing(section(text, "STATUS")).join("\n"));
    const bootedAt = found.findIndex((d) => d.booted);
    const booted = bootedAt >= 0 ? found[bootedAt] : undefined;
    if (!booted || booted.version === "") {
      return { sourceKind: "ostree", location, status: "partial", installs: [], message: "no booted deployment found" };
    }
    // rpm-ostree lists a staged deployment before the booted one and the rollback after it, so only the one before it is an update.
    const staged = found.slice(0, bootedAt).find((d) => d.version !== "") ?? null;
    const labels = remoteLabels(section(text, "REMOTE"));
    const colon = booted.ref.lastIndexOf(":");
    const tagged = colon > booted.ref.lastIndexOf("/");
    const tag = tagged ? booted.ref.slice(colon + 1) : "";
    const key = tagged ? booted.ref.slice(0, colon) : booted.ref;
    const name = key.slice(key.lastIndexOf("/") + 1);
    const released = labels?.version ?? "";
    const availableVersion = staged?.version ?? (released !== "" && released !== booted.version ? released : "");
    const install: InstallRecord = {
      ecosystem: "ostree",
      key,
      name,
      kind: "image",
      version: booted.version,
      location: "",
      ...(labels?.url ? { homepage: labels.url } : {}),
      details: { image: booted.ref, tag, digest: booted.digest, staged: staged !== null, ...(availableVersion !== "" ? { availableVersion } : {}) },
    };
    return { sourceKind: "ostree", location, status: "ok", installs: [install] };
  },
};
