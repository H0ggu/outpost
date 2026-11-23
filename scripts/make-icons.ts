/**
 * Generates Outpost's own app icons (a watchtower glyph; deliberately not any Lichess artwork):
 *   web/public/icons/icon.svg, icon-180.png, icon-192.png, icon-512.png, icon-maskable-512.png
 * Run: node scripts/make-icons.ts   (no dependencies; PNGs are encoded with node:zlib)
 */
import { writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';

const OUT = new URL('../web/public/icons/', import.meta.url);
const BG = [0x0b, 0x0b, 0x0b] as const;
const FG = [0xe2, 0xe0, 0xdc] as const;
const ACCENT = [0xd6, 0x4f, 0x00] as const;

/** Shapes on a 512×512 canvas. */
const RECTS: Array<{ x: number; y: number; w: number; h: number; c: readonly [number, number, number] }> = [
  { x: 156, y: 120, w: 50, h: 52, c: FG }, // merlons
  { x: 231, y: 120, w: 50, h: 52, c: FG },
  { x: 306, y: 120, w: 50, h: 52, c: FG },
  { x: 146, y: 170, w: 220, h: 46, c: FG }, // parapet
  { x: 181, y: 214, w: 150, h: 148, c: FG }, // body
  { x: 146, y: 360, w: 220, h: 40, c: FG }, // base
  { x: 236, y: 280, w: 40, h: 80, c: ACCENT }, // lit doorway
];
const RADIUS = 96;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${RADIUS}" fill="#0b0b0b"/>
${RECTS.map(r => `  <rect x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="#${r.c.map(v => v.toString(16).padStart(2, '0')).join('')}"/>`).join('\n')}
</svg>
`;

function insideRounded(x: number, y: number, size: number, radius: number): boolean {
  const cx = Math.min(Math.max(x, radius), size - radius);
  const cy = Math.min(Math.max(y, radius), size - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function render(size: number, rounded: boolean): Buffer {
  const ss = 4; // supersampling per axis
  const scale = 512 / size;
  const rows: Buffer[] = [];
  for (let py = 0; py < size; py++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++)
        for (let sx = 0; sx < ss; sx++) {
          const x = (px + (sx + 0.5) / ss) * scale;
          const y = (py + (sy + 0.5) / ss) * scale;
          if (rounded && !insideRounded(x, y, 512, RADIUS)) continue;
          let c: readonly number[] = BG;
          for (const s of RECTS) if (x >= s.x && x < s.x + s.w && y >= s.y && y < s.y + s.h) c = s.c;
          r += c[0]!; g += c[1]!; b += c[2]!; a += 255;
        }
      const n = ss * ss;
      const alpha = a / n;
      const o = 1 + px * 4;
      const k = alpha > 0 ? 255 / a : 0; // un-premultiply
      row[o] = Math.round(r * k);
      row[o + 1] = Math.round(g * k);
      row[o + 2] = Math.round(b * k);
      row[o + 3] = Math.round(alpha);
    }
    rows.push(row);
  }
  return png(size, size, Buffer.concat(rows));
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

function png(w: number, h: number, raw: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

writeFileSync(new URL('icon.svg', OUT), svg);
for (const size of [180, 192, 512]) writeFileSync(new URL(`icon-${size}.png`, OUT), render(size, true));
writeFileSync(new URL('icon-maskable-512.png', OUT), render(512, false));
console.log('icons written to', OUT.pathname);
