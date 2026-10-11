// Builds every Scout icon from the single SVG master at packages/web/public/icon.svg.
// Run: node tools/make-icons.mjs
// The web icons come from @resvg/resvg-js; the tray and app icon set (ico, icns, and every size the bundle lists) comes from Tauri's icon generator.
import { Resvg } from "@resvg/resvg-js";
import jpeg from "jpeg-js";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pub = join(root, "packages/web/public");
const master = readFileSync(join(pub, "icon.svg"), "utf8");

const png = (svg, size) => new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng();

// A square version without the rounded plate or its rim, for the places where the operating system supplies the rounding.
const bare = master
  .replace('<clipPath id="plate"><rect width="1024" height="1024" rx="224"/></clipPath>', '<clipPath id="plate"><rect width="1024" height="1024"/></clipPath>')
  .replace(/\s*<rect x="10" y="10"[^>]*\/>/, "");
// The maskable version keeps the artwork inside the 80 percent safe circle, on a full-bleed background.
const plate = /<g clip-path="url\(#plate\)">[\s\S]*?<\/g>/;
const maskable = bare
  .replace(plate, '<rect width="1024" height="1024" fill="url(#sky)"/><g transform="translate(102.4 102.4) scale(0.8)">')
  .replace("</svg>", "</g></svg>");

const web = {
  "icon-192.png": png(master, 192),
  "icon-512.png": png(master, 512),
  "icon-maskable-512.png": png(maskable, 512),
  "apple-touch-icon.png": png(bare, 180),
  "favicon-32.png": png(master, 32),
};
for (const [name, data] of Object.entries(web)) writeFileSync(join(pub, name), data);

// A phone fetches the linked home-screen icon in a separate process that has no sign-in, so the page also carries the Apple touch icon (as a small opaque JPEG) and the favicon inline.
const raw = new Resvg(bare, { fitTo: { mode: "width", value: 180 } }).render();
const touchJpeg = jpeg.encode({ data: raw.pixels, width: raw.width, height: raw.height }, 90).data;
const dataUri = (type, data) => `data:${type};base64,${Buffer.from(data).toString("base64")}`;
const indexPath = join(pub, "index.html");
const index = readFileSync(indexPath, "utf8");
const marker = /(<!-- inline-icons -->\r?\n)[\s\S]*?(\r?\n\s*<!-- \/inline-icons -->)/;
if (!marker.test(index)) throw new Error("index.html has no inline-icons markers");
const links = [`  <link rel="icon" type="image/png" sizes="32x32" href="${dataUri("image/png", web["favicon-32.png"])}">`, `  <link rel="apple-touch-icon" href="${dataUri("image/jpeg", touchJpeg)}">`].join(index.includes("\r\n") ? "\r\n" : "\n");
writeFileSync(indexPath, index.replace(marker, (_, open, close) => `${open}${links}${close}`));

const scratch = join(root, ".scout-data");
mkdirSync(scratch, { recursive: true });
const source = join(scratch, "icon-1024.png");
writeFileSync(source, png(master, 1024));
const tray = join(root, "packages/tray");
const [command, args] = process.platform === "win32" ? ["cmd.exe", ["/c", "pnpm", "exec", "tauri", "icon", source]] : ["pnpm", ["exec", "tauri", "icon", source]];
execFileSync(command, args, { cwd: tray, stdio: "inherit" });
// The generator also writes Android and iOS sets, which the tray does not ship.
for (const extra of ["android", "ios"]) rmSync(join(tray, "src-tauri/icons", extra), { recursive: true, force: true });
console.log("icons written");
