// Redact the Windows username from recorded fixtures. Usage: node tools/redact-fixtures.mjs <user> <outputs.json>...
// The name also appears ROT13-encoded in the UserAssist registry values, so that form is replaced too.
import { readFileSync, writeFileSync } from "node:fs";
const [user, ...files] = process.argv.slice(2);
const rot13 = (s) => s.replace(/[a-z]/gi, (c) => String.fromCharCode(((c.charCodeAt(0) & 223) - 52) % 26 + (c.charCodeAt(0) & 32) + 65));
const re = new RegExp(String.raw`(?<=Users[\\/]+)${user}(?![A-Za-z])`, "gi");
const reRot = new RegExp(String.raw`(?<=Hfref[\\/]+)${rot13(user)}(?![A-Za-z])`, "gi");
for (const f of files) {
  const o = JSON.parse(readFileSync(f, "utf8"));
  for (const v of Object.values(o)) {
    v.stdout = v.stdout.replace(re, "USER").replace(reRot, "HFRE");
    v.stderr = v.stderr.replace(re, "USER").replace(reRot, "HFRE");
  }
  writeFileSync(f, JSON.stringify(o, null, 1) + "\n");
}
