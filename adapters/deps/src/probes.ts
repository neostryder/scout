export const NPM_GLOBALS_SCRIPT = String.raw`import { readdirSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
const root = execFileSync("npm", ["root", "-g"], { encoding: "utf8", shell: process.platform === "win32", windowsHide: true }).trim();
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
`;

export const PYVENV_SCRIPT = String.raw`import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
const out = { venvs: [], unavailable: [], errors: [] };
for (const [ecosystem, command, args] of [["pipx", "pipx", ["environment", "--value", "PIPX_LOCAL_VENVS"]], ["uv-tool", "uv", ["tool", "dir"]]]) {
  let root;
  try { root = execFileSync(command, args, { encoding: "utf8", windowsHide: true }).trim(); }
  catch (error) {
    (error.code === "ENOENT" ? out.unavailable : out.errors).push(ecosystem);
    continue;
  }
  function walk(dir, tool) {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch (error) { if (error.code !== "ENOENT") out.errors.push(ecosystem); return; }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(join(dir, entry.name), tool || entry.name);
      else if (entry.isFile() && entry.name === "pyvenv.cfg" && tool) {
        try { out.venvs.push({ ecosystem, key: tool, cfg: readFileSync(join(dir, entry.name), "utf8") }); }
        catch { out.errors.push(ecosystem); }
      }
    }
  }
  if (root) walk(root, "");
  else out.errors.push(ecosystem);
}
console.log(JSON.stringify(out));
`;
