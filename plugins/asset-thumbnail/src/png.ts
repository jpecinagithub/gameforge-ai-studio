import { inflateSync, deflateSync } from 'node:zlib';

/**
 * Minimal PNG codec — Phase 6.
 *
 * Supports 8-bit, non-interlaced PNGs with color types 2 (RGB) and 6 (RGBA).
 * Anything else throws a typed error so the plugin can refuse honestly
 * instead of producing a fake thumbnail.
 */

export interface RgbaImage {
  width: number;
  height: number;
  /** Row-major RGBA bytes. */
  pixels: Uint8Array;
}

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export class PngError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PngError';
    this.code = code;
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Decode an 8-bit non-interlaced RGB/RGBA PNG into RGBA pixels. */
export function decodePng(data: Uint8Array): RgbaImage {
  const buf = Buffer.from(data);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) {
    throw new PngError('not_png', 'Not a PNG file (bad signature)');
  }
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idatParts: Buffer[] = [];
  let pos = 8;
  let seenIhdr = false;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const chunk = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      seenIhdr = true;
      width = chunk.readUInt32BE(0);
      height = chunk.readUInt32BE(4);
      const bitDepth = chunk[8];
      colorType = chunk[9];
      const interlace = chunk[12];
      if (bitDepth !== 8) throw new PngError('unsupported_png', `bit depth ${bitDepth} not supported`);
      if (colorType !== 2 && colorType !== 6) {
        throw new PngError('unsupported_png', `color type ${colorType} not supported (need RGB or RGBA)`);
      }
      if (interlace !== 0) throw new PngError('unsupported_png', 'interlaced PNGs not supported');
      if (width === 0 || height === 0 || width > 8192 || height > 8192) {
        throw new PngError('unsupported_png', `image dimensions ${width}x${height} out of range`);
      }
    } else if (type === 'IDAT') {
      if (!seenIhdr) throw new PngError('not_png', 'IDAT before IHDR');
      idatParts.push(chunk);
    } else if (type === 'IEND') {
      break;
    }
    pos += 12 + len;
  }
  if (!seenIhdr) throw new PngError('not_png', 'Missing IHDR');
  if (idatParts.length === 0) throw new PngError('not_png', 'Missing IDAT');

  const raw = inflateSync(Buffer.concat(idatParts));
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const pixels = new Uint8Array(width * height * 4);
  let p = 0;
  const prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const row = raw.subarray(p, p + stride);
    p += stride;
    const recon = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? recon[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v: number;
      switch (filter) {
        case 0: v = row[i]; break;
        case 1: v = row[i] + a; break;
        case 2: v = row[i] + b; break;
        case 3: v = row[i] + ((a + b) >> 1); break;
        case 4: v = row[i] + paeth(a, b, c); break;
        default: throw new PngError('not_png', `unknown filter type ${filter}`);
      }
      recon[i] = v & 0xff;
    }
    prev.set(recon);
    for (let x = 0; x < width; x++) {
      const d = (y * width + x) * 4;
      const s = x * channels;
      pixels[d] = recon[s];
      pixels[d + 1] = recon[s + 1];
      pixels[d + 2] = recon[s + 2];
      pixels[d + 3] = channels === 4 ? recon[s + 3] : 255;
    }
  }
  return { width, height, pixels };
}

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of buf) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  const crc = crc32(Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)]));
  out.writeUInt32BE(crc, 8 + data.length);
  return out;
}

/** Encode RGBA pixels as an 8-bit RGBA PNG (filter type 0 rows). */
export function encodePng(img: RgbaImage): Uint8Array {
  const { width, height, pixels } = img;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: None
    Buffer.from(pixels.subarray(y * width * 4, (y + 1) * width * 4)).copy(
      raw,
      y * (1 + width * 4) + 1,
    );
  }
  const compressed = deflateSync(raw);
  const out = Buffer.concat([
    PNG_SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', compressed),
    chunk('IEND', new Uint8Array(0)),
  ]);
  return new Uint8Array(out);
}

/** Box-filter downscale to fit within maxDim, preserving aspect ratio. */
export function downscale(img: RgbaImage, maxDim: number): RgbaImage {
  const { width, height, pixels } = img;
  const scale = Math.min(1, maxDim / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  if (w === width && h === height) return img;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y / h) * height);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) / h) * height));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x / w) * width);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) / w) * width));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const s = (sy * width + sx) * 4;
          r += pixels[s]; g += pixels[s + 1]; b += pixels[s + 2]; a += pixels[s + 3];
          n++;
        }
      }
      const d = (y * w + x) * 4;
      out[d] = Math.round(r / n);
      out[d + 1] = Math.round(g / n);
      out[d + 2] = Math.round(b / n);
      out[d + 3] = Math.round(a / n);
    }
  }
  return { width: w, height: h, pixels: out };
}
