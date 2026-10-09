/**
 * Builds the unpacked extension into dist/ (load this folder in chrome://extensions).
 *   npm run build            one-off build, then checks the files Chrome will load
 *   npm run watch            rebuild on change
 */
import { build, context } from 'esbuild';
import { copyFile, cp, mkdir, readFile, rm } from 'node:fs/promises';
import { Script } from 'node:vm';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
export const dist = join(root, 'dist');
const watch = process.argv.includes('--watch');
const target = ['chrome116'];

const shared = {
  bundle: true,
  target,
  platform: 'browser',
  sourcemap: true,
  legalComments: 'none',
  logLevel: 'info',
  absWorkingDir: root,
};

/**
 * One esbuild entry per script Chrome loads. The content script is an IIFE because Chrome runs
 * content scripts as classic scripts, which cannot contain import or export statements.
 * Exported so the tests build exactly what this script builds.
 */
export const entries = {
  background: {
    ...shared,
    entryPoints: [join(src, 'background', 'service-worker.js')],
    outfile: join(dist, 'background', 'service-worker.js'),
    format: 'esm',
  },
  content: {
    ...shared,
    entryPoints: [join(src, 'content', 'content-script.js')],
    outfile: join(dist, 'content', 'content-script.js'),
    format: 'iife',
  },
  sidepanel: {
    ...shared,
    entryPoints: [join(src, 'sidepanel', 'main.js')],
    outfile: join(dist, 'sidepanel', 'main.js'),
    format: 'esm',
  },
};

async function copyStaticAssets() {
  await mkdir(join(dist, 'sidepanel'), { recursive: true });
  await copyFile(join(src, 'manifest.json'), join(dist, 'manifest.json'));
  await copyFile(join(src, 'sidepanel', 'index.html'), join(dist, 'sidepanel', 'index.html'));
  await copyFile(join(src, 'sidepanel', 'sidepanel.css'), join(dist, 'sidepanel', 'sidepanel.css'));
  await copyFile(join(src, 'sidepanel', 'typography.css'), join(dist, 'sidepanel', 'typography.css'));
  await cp(join(src, 'sidepanel', 'fonts'), join(dist, 'sidepanel', 'fonts'), { recursive: true });
  await cp(join(src, 'icons'), join(dist, 'icons'), { recursive: true });
}

/**
 * Checks the files Chrome will load from `distDir`. The manifest must declare exactly the one
 * content script this build writes, and that file must parse as a classic script. Anything else
 * would fail in Chrome only at runtime, and the panel would then report "Receiving end does not exist".
 * Returns the content script path, as the manifest and the service worker name it.
 */
export async function verifyArtifacts(distDir = dist) {
  const manifest = JSON.parse(await readFile(join(distDir, 'manifest.json'), 'utf8'));
  const expected = relative(dist, entries.content.outfile).split(sep).join('/');
  const declared = (manifest.content_scripts ?? []).flatMap((script) => script.js ?? []);
  if (declared.length !== 1 || declared[0] !== expected) {
    throw new Error(`manifest.json must declare exactly "${expected}" as its content script; it declares ${JSON.stringify(declared)}.`);
  }
  const code = await readFile(join(distDir, expected), 'utf8');
  try {
    new Script(code, { filename: expected });
  } catch (error) {
    throw new Error(`${expected} is not a classic script (${error.message}). Content scripts cannot contain import or export statements.`);
  }
  return expected;
}

async function main() {
  if (!watch) await rm(dist, { recursive: true, force: true });
  await copyStaticAssets();

  if (watch) {
    const contexts = await Promise.all(Object.values(entries).map((options) => context(options)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log('Watching for changes. Static assets are copied once at start; rerun build after editing HTML, CSS or the manifest.');
    return;
  }

  await Promise.all(Object.values(entries).map((options) => build(options)));
  await verifyArtifacts();
  console.log(`Built extension to ${dist}`);
}

// Build only when this file is run directly, so tests can import the entries without building.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
