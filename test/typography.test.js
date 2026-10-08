import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIDEPANEL = path.join(ROOT, 'src', 'sidepanel');
const read = (file) => readFileSync(path.join(SIDEPANEL, file), 'utf8');

const css = read('sidepanel.css');
const typography = read('typography.css');
const html = read('index.html');
const scripts = readdirSync(SIDEPANEL)
  .filter((file) => file.endsWith('.js'))
  .map((file) => read(file))
  .join('\n');

test('every font-family in the panel stylesheet uses a typography token', () => {
  const values = [...css.matchAll(/font-family:\s*([^;]+);/g)].map((match) => match[1].trim());
  assert.ok(values.length > 0);
  for (const value of values) {
    assert.match(value, /^var\(--font-(text|display)\)$/, `not a token: ${value}`);
  }
});

test('every font-size uses the one size scale', () => {
  const values = [...css.matchAll(/font-size:\s*([^;]+);/g)].map((match) => match[1].trim());
  assert.ok(values.length > 0);
  for (const value of values) {
    assert.match(value, /^var\(--text-(xs|sm|md|lg)\)$/, `off the scale: ${value}`);
  }
});

test('the smallest text token is 12px, so no text the user reads is smaller', () => {
  assert.match(typography, /--text-xs:\s*12px;/);
});

test('the old fonts are gone: no monospace, and no font named outside the tokens', () => {
  for (const source of [css, html, scripts]) {
    assert.doesNotMatch(source, /monospace|SFMono|Consolas|Menlo|Courier/i);
  }
  assert.doesNotMatch(css, /\bInter\b|system-ui/);
  assert.doesNotMatch(html, /font-family/);
  assert.doesNotMatch(scripts, /font-family|fontFamily/);
  assert.doesNotMatch(css, /text-transform/);
});

test('the typography tokens name the bundled families first, then system fallbacks', () => {
  assert.match(typography, /--font-text:\s*"Inter",\s*system-ui/);
  assert.match(typography, /--font-display:\s*"DM Sans",\s*"Inter",\s*system-ui/);
});

test('every font file the stylesheet loads is bundled, and nothing is loaded remotely', () => {
  assert.doesNotMatch(typography, /@import|https?:\/\//);
  const urls = [...typography.matchAll(/url\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.ok(urls.length >= 5, 'expected the bundled weights');
  for (const url of urls) {
    assert.ok(existsSync(path.join(SIDEPANEL, url)), `missing font file: ${url}`);
  }
});

test('the font licenses ship next to the font files', () => {
  for (const license of ['LICENSE-Inter.txt', 'LICENSE-DM-Sans.txt']) {
    const file = path.join(SIDEPANEL, 'fonts', license);
    assert.ok(existsSync(file), `missing ${license}`);
    assert.match(readFileSync(file, 'utf8'), /SIL Open Font License,? Version 1\.1/);
  }
});

function luminance(hex) {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

function colorToken(name) {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6});`));
  assert.ok(match, `missing colour token --${name}`);
  return match[1];
}

test('text colours meet WCAG AA (4.5:1) on every panel surface, including small text', () => {
  const surfaces = ['bg', 'surface', 'surface-2', 'surface-3'].map(colorToken);
  for (const name of ['text', 'muted', 'faint', 'ok', 'warn', 'bad']) {
    for (const surface of surfaces) {
      const ratio = contrast(colorToken(name), surface);
      assert.ok(ratio >= 4.5, `--${name} on ${surface} is ${ratio.toFixed(2)}:1`);
    }
  }
});
