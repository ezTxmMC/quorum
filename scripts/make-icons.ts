// Erzeugt die App-Icons (PNG, ICO, ICNS) aus der Markengeometrie – ohne externe Tools.
//   node scripts/make-icons.ts
// Läuft automatisch vor `npm run dist:*`. Ausgabe: build/icon.png, build/icon.ico, build/icon.icns, build/icons/<n>x<n>.png
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { rasterize } from '../shared/brand.ts';

const crcTable = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf: Uint8Array): number { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

// Überall dieselbe Marke (logo-mark / favicon) auf transparentem Grund – kein separates App-Icon mit Hintergrund.
function png(size: number, background = false): Buffer {
  const rgba = rasterize(size, { background, order: 'rgba' });
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (size * 4 + 1)] = 0; Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function ico(sizes: number[]): Buffer {
  const imgs = sizes.map((s) => png(s));
  const head = Buffer.alloc(6); head.writeUInt16LE(1, 2); head.writeUInt16LE(imgs.length, 4);
  let offset = 6 + imgs.length * 16;
  const dir = imgs.map((img, i) => {
    const e = Buffer.alloc(16); const s = sizes[i];
    e[0] = s >= 256 ? 0 : s; e[1] = s >= 256 ? 0 : s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6); e.writeUInt32LE(img.length, 8); e.writeUInt32LE(offset, 12);
    offset += img.length; return e;
  });
  return Buffer.concat([head, ...dir, ...imgs]);
}

function icns(): Buffer {
  // PNG-basierte Einträge: ic07=128, ic08=256, ic09=512, ic10=1024
  const entries = [['ic07', 128], ['ic08', 256], ['ic09', 512], ['ic10', 1024]] as const;
  const parts = entries.map(([t, s]) => { const p = png(s); const h = Buffer.alloc(8); h.write(t, 0, 'ascii'); h.writeUInt32BE(p.length + 8, 4); return Buffer.concat([h, p]); });
  const total = 8 + parts.reduce((a, p) => a + p.length, 0);
  const h = Buffer.alloc(8); h.write('icns', 0, 'ascii'); h.writeUInt32BE(total, 4);
  return Buffer.concat([h, ...parts]);
}

mkdirSync('build/icons', { recursive: true });
writeFileSync('build/icon.png', png(512, false));
for (const s of [16, 32, 48, 64, 128, 256, 512]) writeFileSync(`build/icons/${s}x${s}.png`, png(s, false));
writeFileSync('build/icon.ico', ico([16, 32, 48, 64, 128, 256]));
writeFileSync('build/icon.icns', icns());
console.log('Icons geschrieben: build/icon.png, build/icon.ico, build/icon.icns, build/icons/*');
