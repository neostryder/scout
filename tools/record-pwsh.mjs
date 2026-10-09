// Record probe output from this Windows machine into a fixture case. Usage:
//   node tools/record-pwsh.mjs <fixtureDir> <location> <id>=<script.ps1> [<id>=<script.ps1> ...]
// Each script runs under `pwsh -NoProfile -File`. The Windows username in paths is redacted.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";

const [dir, location, ...probes] = process.argv.slice(2);
mkdirSync(dir, { recursive: true });
const user = userInfo().username;
const redact = (s) => s.replace(new RegExp(String.raw`(?<=Users[\\/]+)${user}(?![A-Za-z])`, "gi"), "USER");
const outputs = {};
for (const p of probes) {
  const [id, file] = p.split("=");
  const r = spawnSync("pwsh", ["-NoProfile", "-File", file], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  outputs[id] = { exitCode: r.status ?? -1, stdout: redact(r.stdout ?? ""), stderr: redact(r.stderr ?? "") };
}
writeFileSync(join(dir, "outputs.json"), JSON.stringify(outputs, null, 1) + "\n");
if (location) writeFileSync(join(dir, "location.txt"), location + "\n");
console.log(Object.entries(outputs).map(([k, v]) => `${k}: exit ${v.exitCode}, ${v.stdout.length} bytes`).join("\n"));
