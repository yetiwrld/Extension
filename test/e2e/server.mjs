/**
 * Static server for the browser harness. Serves the built extension (dist/), the
 * harness pages, the synthetic Flow fixture and the example reference library.
 * The side panel is served with <base href="/dist/sidepanel/"> and with
 * window.chrome bound to the harness stub, which the extension itself never sees
 * differently from a real chrome.* object.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(join(here, '..', '..'));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.map': 'application/json; charset=utf-8',
};

async function fileFor(urlPath) {
  const path = decodeURIComponent(urlPath.split('?')[0]);
  const fixed = {
    '/': join(here, 'harness', 'index.html'),
    '/harness/stub.js': join(here, 'harness', 'stub.js'),
    '/flow-frame.html': join(here, 'harness', 'flow-frame.html'),
    '/fixture/flow-fixture.js': join(ROOT, 'test', 'fixtures', 'flow-fixture.js'),
  };
  if (fixed[path]) return fixed[path];
  if (path.startsWith('/dist/') || path.startsWith('/examples/')) {
    const full = normalize(join(ROOT, path));
    if (!full.startsWith(ROOT + sep)) return null;
    return full;
  }
  return null;
}

async function panelFrameHtml() {
  const html = await readFile(join(ROOT, 'dist', 'sidepanel', 'index.html'), 'utf8');
  // Bind the panel's chrome to the harness stub before any panel script runs.
  return html.replace(
    '<head>',
    '<head><base href="/dist/sidepanel/" /><script>window.chrome = parent.chrome;</script>',
  );
}

export function startServer(port = 0) {
  const server = createServer(async (req, res) => {
    try {
      const url = req.url || '/';
      if (url.split('?')[0] === '/panel-frame.html') {
        res.writeHead(200, { 'content-type': TYPES['.html'], 'cache-control': 'no-store' });
        res.end(await panelFrameHtml());
        return;
      }
      const file = await fileFor(url);
      if (!file) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'content-type': 'text/plain' });
      res.end(error.code === 'ENOENT' ? 'not found' : String(error));
    }
  });
  return new Promise((resolvePromise) => {
    server.listen(port, '127.0.0.1', () => resolvePromise(server));
  });
}
