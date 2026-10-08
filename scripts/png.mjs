/**
 * Minimal PNG encoder for the icon and fixture generators. No dependencies.
 * Input: { width, height, rgba: Uint8Array } (4 bytes per pixel, row-major).
 */
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBytes = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, crc]);
}

export function encodePng({ width, height, rgba }) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Simple RGBA canvas with helpers for flat shapes. Anti-aliasing via supersampling. */
export function createCanvas(width, height, background = [0, 0, 0, 255]) {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i += 1) rgba.set(background, i * 4);
  return {
    width,
    height,
    rgba,
    /** Fill pixels for which `inside(x, y)` (in pixel units, sampled at sub-pixel offsets) is true. */
    shape(color, inside, samples = 3) {
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          let hits = 0;
          for (let sy = 0; sy < samples; sy += 1) {
            for (let sx = 0; sx < samples; sx += 1) {
              const px = x + (sx + 0.5) / samples;
              const py = y + (sy + 0.5) / samples;
              if (inside(px, py)) hits += 1;
            }
          }
          if (hits === 0) continue;
          const alpha = (hits / (samples * samples)) * (color[3] ?? 255) / 255;
          const offset = (y * width + x) * 4;
          for (let c = 0; c < 3; c += 1) {
            rgba[offset + c] = Math.round(rgba[offset + c] * (1 - alpha) + color[c] * alpha);
          }
          rgba[offset + 3] = 255;
        }
      }
      return this;
    },
    png() {
      return encodePng({ width, height, rgba });
    },
  };
}
