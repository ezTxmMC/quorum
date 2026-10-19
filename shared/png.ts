// Minimaler PNG-Encoder (RGBA, unkomprimierte Deflate-Blöcke) ohne Abhängigkeiten – für kleine Paletten-Texturen.
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = (buf: Uint8Array) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const body = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i++) body[i] = type.charCodeAt(i);
  body.set(data, 4);
  return Uint8Array.from([...u32(data.length), ...body, ...u32(crc32(body))]);
}

function zlibStored(raw: Uint8Array): Uint8Array {
  const out: number[] = [0x78, 0x01];
  for (let i = 0; i < raw.length; i += 65535) {
    const part = raw.subarray(i, Math.min(i + 65535, raw.length));
    const last = i + 65535 >= raw.length ? 1 : 0;
    out.push(last, part.length & 255, part.length >>> 8, ~part.length & 255, (~part.length >>> 8) & 255, ...part);
  }
  let a = 1, b = 0;
  for (const v of raw) { a = (a + v) % 65521; b = (b + a) % 65521; }
  out.push(...u32(((b << 16) | a) >>> 0));
  return Uint8Array.from(out);
}

/** RGBA-Pixel (Länge width*height*4) als PNG-Bytes. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width * 4 + 1)] = 0; raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1); }
  const ihdr = Uint8Array.from([...u32(width), ...u32(height), 8, 6, 0, 0, 0]);
  const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Uint8Array.from([...sig, ...chunk('IHDR', ihdr), ...chunk('IDAT', zlibStored(raw)), ...chunk('IEND', new Uint8Array())]);
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
