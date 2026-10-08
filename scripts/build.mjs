/**
 * Builds the unpacked extension into dist/ (load this folder in chrome://extensions).
 *   npm run build            one-off build
 *   npm run watch            rebuild on change
 */
import { build, context } from 'esbuild';
import { copyFile, cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');
const dist = join(root, 'dist');
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

const entries = {
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
  await cp(join(src, 'icons'), join(dist, 'icons'), { recursive: true });
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
  console.log(`Built extension to ${dist}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
