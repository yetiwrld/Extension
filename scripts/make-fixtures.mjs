/**
 * Writes the test reference library to examples/reference-library/:
 * Aron.png, Vex.png, Mira.png, Laboratory.png. Each is a plain, labelled-by-shape
 * placeholder so screenshots and manual tests can tell the references apart.
 * Run with: node scripts/make-fixtures.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from './png.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'examples', 'reference-library');
const SIZE = 256;

const fixtures = {
  'Aron.png': (c) => c.shape([96, 165, 250, 255], (x, y) => (x - 128) ** 2 + (y - 128) ** 2 <= 84 ** 2),
  'Vex.png': (c) => c.shape([245, 166, 35, 255], (x, y) => Math.abs(x - 128) <= 80 && Math.abs(y - 128) <= 80),
  'Mira.png': (c) =>
    c.shape([120, 214, 140, 255], (x, y) => {
      const top = 40;
      const bottom = 216;
      if (y < top || y > bottom) return false;
      const half = ((y - top) / (bottom - top)) * 90;
      return Math.abs(x - 128) <= half;
    }),
  'Laboratory.png': (c) =>
    c.shape([200, 200, 210, 255], (x, y) => {
      const stripe = Math.floor(y / 32) % 2 === 0;
      return stripe && x > 24 && x < SIZE - 24 && y > 24 && y < SIZE - 24;
    }),
};

await mkdir(outDir, { recursive: true });
for (const [name, paint] of Object.entries(fixtures)) {
  const canvas = createCanvas(SIZE, SIZE, [18, 18, 20, 255]);
  paint(canvas);
  await writeFile(join(outDir, name), canvas.png());
  console.log(`wrote examples/reference-library/${name}`);
}
