import type { Adapter, InstallRecord, ProbeContext, ProbeOutputs, ScanResult } from "@scout/core";

// Read-only: list every container and every image as one JSON object per line. The script texts are
// byte-identical to tools/probes/macos/docker-containers.sh and tools/probes/macos/docker-images.sh.
// A container names the image it runs; an image record carries the digest and full id we report for it.

const CONTAINERS_SH = "docker ps -a --no-trunc --format '{{json .}}'\n";
const IMAGES_SH = "docker image ls --digests --no-trunc --format '{{json .}}'\n";

const firstLine = (text: string): string => text.trim().split("\n")[0] ?? "";

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

/** Split an image reference into repository and tag. A colon starts a tag only when what follows has no
 * slash, so a registry port (`host:5000/repo`) stays in the repository. The tag defaults to `latest`. */
function splitImage(image: string): { repository: string; tag: string } {
  const colon = image.lastIndexOf(":");
  if (colon >= 0) {
    const after = image.slice(colon + 1);
    if (after !== "" && !after.includes("/")) return { repository: image.slice(0, colon), tag: after };
  }
  return { repository: image, tag: "latest" };
}

/** One comma-separated `key=value` string. A value may contain `=` but never `,`. */
function parseLabels(labels: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of labels.split(",")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

/** Parse one JSON object per line, skipping blank lines and counting the lines that are not objects. */
function jsonObjects(stdout: string): { rows: Record<string, unknown>[]; skipped: number } {
  const rows: Record<string, unknown>[] = [];
  let skipped = 0;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      skipped++;
      continue;
    }
    rows.push(value as Record<string, unknown>);
  }
  return { rows, skipped };
}

/**
 * An image is built when Docker reports no digest for it, or when it carries compose's default name for a built
 * service (`<project>-<service>`); Docker's containerd image store gives locally built images a digest, so the
 * digest alone misses them. Otherwise a tag of `latest` or one with no digit is floating, and the rest are exact.
 */
function tagKindOf(repository: string, tag: string, digest: string, project: string | undefined, service: string | undefined): string {
  if (digest === "<none>") return "built";
  if (project && service && repository === `${project}-${service}`) return "built";
  if (tag === "latest" || !/[0-9]/.test(tag)) return "floating";
  return "exact";
}

interface Pending {
  install: InstallRecord;
  key: string;
  baseLocation: string;
  name: string;
}

export const adapter: Adapter = {
  sourceKind: "image",
  os: ["macos"],
  probes(_ctx: ProbeContext, _location: string) {
    return [
      { id: "containers", argv: ["/bin/sh", "-c", CONTAINERS_SH] },
      { id: "images", argv: ["/bin/sh", "-c", IMAGES_SH] },
    ];
  },
  parse(outputs: ProbeOutputs, location: string): ScanResult {
    const containers = outputs["containers"];
    if (!containers) {
      return { sourceKind: "image", location, status: "failed", installs: [], message: "probe output missing" };
    }
    if (containers.exitCode !== 0) {
      return {
        sourceKind: "image",
        location,
        status: "skipped",
        installs: [],
        message: `docker did not run (exit ${containers.exitCode}): ${firstLine(containers.stderr)}`,
      };
    }

    const problems: string[] = [];

    const parsedContainers = jsonObjects(containers.stdout);
    if (parsedContainers.skipped > 0) problems.push(`skipped ${parsedContainers.skipped} malformed container line(s)`);

    const images = outputs["images"];
    const imageRows: Record<string, unknown>[] = [];
    if (!images) {
      problems.push("image probe output missing");
    } else if (images.exitCode !== 0) {
      problems.push(`docker image ls did not run (exit ${images.exitCode}): ${firstLine(images.stderr)}`);
    } else {
      const parsedImages = jsonObjects(images.stdout);
      imageRows.push(...parsedImages.rows);
      if (parsedImages.skipped > 0) problems.push(`skipped ${parsedImages.skipped} malformed image line(s)`);
    }

    const byId = new Map<string, Record<string, unknown>>();
    const byRepositoryTag = new Map<string, Record<string, unknown>>();
    for (const image of imageRows) {
      const id = asString(image.ID);
      if (id !== "") byId.set(id, image);
      byRepositoryTag.set(`${asString(image.Repository)}\u0000${asString(image.Tag)}`, image);
    }

    const pending: Pending[] = [];
    for (const row of parsedContainers.rows) {
      const name = asString(row.Names).replace(/^\//, "");
      const reference = splitImage(asString(row.Image));
      const labels = parseLabels(asString(row.Labels));
      const composeImage = labels["com.docker.compose.image"] ?? "";
      const record = (composeImage !== "" ? byId.get(composeImage) : undefined) ?? byRepositoryTag.get(`${reference.repository}\u0000${reference.tag}`);
      const recordId = record ? asString(record.ID) : "";
      const recordDigest = record ? asString(record.Digest) : "";
      const configFile = labels["com.docker.compose.project.config_files"] ?? "";
      const baseLocation = configFile !== "" ? configFile : name;

      const install: InstallRecord = {
        ecosystem: "image",
        key: reference.repository,
        name,
        kind: "image",
        version: reference.tag,
        location: baseLocation,
        details: {
          container: name,
          containerId: asString(row.ID).slice(0, 12),
          state: asString(row.State) !== "" ? asString(row.State) : null,
          project: labels["com.docker.compose.project"] ?? null,
          service: labels["com.docker.compose.service"] ?? null,
          workingDir: labels["com.docker.compose.project.working_dir"] ?? null,
          imageId: recordId !== "" ? recordId : composeImage !== "" ? composeImage : null,
          tagKind: tagKindOf(reference.repository, reference.tag, recordDigest, labels["com.docker.compose.project"], labels["com.docker.compose.service"]),
        },
      };
      if (recordDigest !== "" && recordDigest !== "<none>") install.digest = recordDigest;
      pending.push({ install, key: reference.repository, baseLocation, name });
    }

    // Two containers of one image would collide on (key, location). When a compose service has several
    // containers, qualify the location with the container name so both survive.
    const counts = new Map<string, number>();
    for (const item of pending) {
      const identity = `${item.key}\u0000${item.baseLocation}`;
      counts.set(identity, (counts.get(identity) ?? 0) + 1);
    }
    for (const item of pending) {
      if ((counts.get(`${item.key}\u0000${item.baseLocation}`) ?? 0) > 1) {
        item.install.location = `${item.baseLocation}#${item.name}`;
      }
    }

    const installs = pending.map((item) => item.install);
    if (problems.length > 0) {
      return { sourceKind: "image", location, status: "partial", installs, message: problems.join("; ") };
    }
    return { sourceKind: "image", location, status: "ok", installs };
  },
};
