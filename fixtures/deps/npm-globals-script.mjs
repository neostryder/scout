import { readdirSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
const out = { node: process.version, root, packages: [] };
const names = [];
for (const entry of readdirSync(root)) {
  if (entry.startsWith("@")) for (const sub of readdirSync(root + "/" + entry)) names.push(entry + "/" + sub);
  else names.push(entry);
}
for (const name of names) {
  const file = root + "/" + name + "/package.json";
  if (!existsSync(file)) continue;
  try { const p = JSON.parse(readFileSync(file, "utf8")); out.packages.push({ name: p.name, version: p.version, engines: p.engines ?? null, peerDependencies: p.peerDependencies ?? null }); } catch {}
}
console.log(JSON.stringify(out));
