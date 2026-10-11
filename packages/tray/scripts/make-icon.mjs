// Draws the app icon source (1024 px PNG) with no dependencies; `tauri icon` turns it into every size and format.
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SIZE = 1024;
const SUPER = 3;
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../src-tauri/icon-source.png");

const BG = [0x0b, 0x14, 0x17];
const EDGE = [0x2b, 0x4a, 0x50];
const GOLD = [0xd9, 0xb2, 0x6b];
const OK = [0x7f, 0xd6, 0xa0];

// Everything is drawn in the 24-unit box the tray icon uses, with the compass centered and a little larger than in the bar.
const u = (px) => (px / SIZE) * 24;

function inRoundedSquare(x, y, inset, radius) {
  const lo = inset, hi = 24 - inset;
  const cx = Math.min(Math.max(x, lo + radius), hi - radius);
  const cy = Math.min(Math.max(y, lo + radius), hi - radius);
  return x >= lo && x <= hi && y >= lo && y <= hi && Math.hypot(x - cx, y - cy) <= radius;
}

function sample(x, y) {
  if (!inRoundedSquare(x, y, 0.6, 5)) return null;
  if (!inRoundedSquare(x, y, 1.0, 4.6)) return EDGE;
  // Scale the compass about the center so the ring and needle fill more of the tile.
  const s = 1.22;
  const gx = 12 + (x - 12) / s, gy = 12 + (y - 12) / s;
  const dot = Math.hypot(gx - 19, gy - 19);
  if (dot <= 4.5) return OK;
  if (dot <= 6) return BG;
  const r = Math.hypot(gx - 12, gy - 12);
  const needle = Math.abs(gx - 12) / 3 + Math.abs(gy - 12) / 7 <= 1;
  if ((r >= 8 && r <= 10) || needle) return GOLD;
  return BG;
}

const rows = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let py = 0; py < SIZE; py++) {
  rows[py * (SIZE * 4 + 1)] = 0;
  for (let px = 0; px < SIZE; px++) {
    let r = 0, g = 0, b = 0, hits = 0;
    for (let sy = 0; sy < SUPER; sy++) {
      for (let sx = 0; sx < SUPER; sx++) {
        const c = sample(u(px + (sx + 0.5) / SUPER), u(py + (sy + 0.5) / SUPER));
        if (c) { r += c[0]; g += c[1]; b += c[2]; hits++; }
      }
    }
    const at = py * (SIZE * 4 + 1) + 1 + px * 4;
    if (hits === 0) continue;
    rows[at] = Math.round(r / hits);
    rows[at + 1] = Math.round(g / hits);
    rows[at + 2] = Math.round(b / hits);
    rows[at + 3] = Math.round((hits * 255) / (SUPER * SUPER));
  }
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
