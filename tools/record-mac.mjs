// Record probe output from a Mac into a fixture case. Usage:
//   node tools/record-mac.mjs <user@host> <fixtureDir> <location> <id>=<script-file> [<id>=<script-file> ...]
// Each script file is fed to `/bin/sh -s` on the remote side, as the scan runs it. Home-directory usernames are redacted.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [host, dir, location, ...probes] = process.argv.slice(2);
mkdirSync(dir, { recursive: true });
const user = host.includes("@") ? host.split("@")[0] : "user";
const outputs = {};
for (const p of probes) {
  const [id, file] = p.split("=");
  const r = spawnSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, "/bin/sh -s"], {
    input: readFileSync(file),
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  const redact = (s) => s.replaceAll(`/Users/${user}`, "/Users/USER");
  outputs[id] = { exitCode: r.status ?? -1, stdout: redact(r.stdout ?? ""), stderr: redact(r.stderr ?? "") };
}
writeFileSync(join(dir, "outputs.json"), JSON.stringify(outputs, null, 1) + "\n");
if (location) writeFileSync(join(dir, "location.txt"), location + "\n");
console.log(Object.entries(outputs).map(([k, v]) => `${k}: exit ${v.exitCode}, ${v.stdout.length} bytes`).join("\n"));
