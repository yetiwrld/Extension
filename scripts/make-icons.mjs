/**
 * Generates the extension icons (16, 32, 48, 128 px) into src/icons/.
 * Design: near-black rounded square, thin grey border, white play triangle.
 * Run with: npm run icons
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas } from './png.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'src', 'icons');
const SIZES = [16, 32, 48, 128];

function roundedRectInside(x, y, size, radius) {
  const dx = Math.max(radius - x, 0, x - (size - radius));
  const dy = Math.max(radius - y, 0, y - (size - radius));
  return dx * dx + dy * dy <= radius * radius;
}

function triangleInside(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

function drawIcon(size) {
  const radius = size * 0.2;
  const border = Math.max(1, size / 32);
  const canvas = createCanvas(size, size, [0, 0, 0, 0]);
  // Outer rounded square: border colour, then inner fill.
  canvas.shape([58, 58, 65, 255], (x, y) => roundedRectInside(x, y, size, radius));
  canvas.shape([20, 20, 23, 255], (x, y) => roundedRectInside(x - border, y - border, size - border * 2, Math.max(0, radius - border)) && roundedRectInside(x, y, size, radius) && x >= border && y >= border && x <= size - border && y <= size - border);
  // Play triangle, optically centred.
  const left = size * 0.36;
  const right = size * 0.7;
  const top = size * 0.28;
  const bottom = size * 0.72;
  const midY = size / 2;
  canvas.shape([255, 255, 255, 255], (x, y) => triangleInside(x, y, [left, top], [left, bottom], [right, midY]));
  return canvas.png();
}

await mkdir(outDir, { recursive: true });
for (const size of SIZES) {
  await writeFile(join(outDir, `icon-${size}.png`), drawIcon(size));
  console.log(`wrote src/icons/icon-${size}.png`);
}
