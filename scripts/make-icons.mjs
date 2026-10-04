// Generates public/icons/*.png without any dependency (own PNG encoder). Run: npm run icons
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const png = (size, pixel) => {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixel(x, y, size);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};

// rounded square with blue->violet gradient and a white "route" glyph: ring + arrow
function pixel(x, y, s) {
  const SS = 3;
  let r = 0,
    g = 0,
    b = 0,
    a = 0;
  for (let i = 0; i < SS; i++)
    for (let j = 0; j < SS; j++) {
      const u = (x + (i + 0.5) / SS) / s,
        v = (y + (j + 0.5) / SS) / s;
      const qx = Math.abs(u - 0.5) - 0.5 + 0.22,
        qy = Math.abs(v - 0.5) - 0.5 + 0.22;
      const dRect = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - 0.22;
      const cov = dRect < 0 ? 1 : 0;
      if (!cov) continue;
      const t = (u + v) / 2;
      let cr = 37 + (124 - 37) * t,
        cg = 99 + (58 - 99) * t,
        cb = 235 + (237 - 235) * t;
      const ring = Math.abs(Math.hypot(u - 0.5, v - 0.5) - 0.26) < 0.065;
      const bar = Math.abs(v - 0.5) < 0.05 && u > 0.18 && u < 0.82;
      const dot = Math.hypot(u - 0.78, v - 0.5) < 0.09;
      if (ring || bar || dot) [cr, cg, cb] = [255, 255, 255];
      r += cr;
      g += cg;
      b += cb;
      a += 255;
    }
  const n = SS * SS;
  return a === 0
    ? [0, 0, 0, 0]
    : [Math.round(r / (a / 255)), Math.round(g / (a / 255)), Math.round(b / (a / 255)), Math.round(a / n)];
}
mkdirSync(new URL('../public/icons/', import.meta.url), { recursive: true });
for (const s of [16, 32, 48, 128])
  writeFileSync(new URL(`../public/icons/icon-${s}.png`, import.meta.url), png(s, pixel));
console.log('icons written');
