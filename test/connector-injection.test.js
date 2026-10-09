import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { checkFlowConnection } from '../src/background/connection.js';
import { createFlowBridge } from '../src/background/flow-bridge.js';

/*
 * A Flow tab that was open before the extension was loaded (or reloaded) has no content
 * script. Chrome then answers tabs.sendMessage with "Receiving end does not exist". These
 * tests run the real content script bundle in a jsdom page, so the injection path is
 * exercised as it runs in Chrome. The browser harness stubs injection and cannot cover it.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLOW_URL = 'https://flow.google.com/project/abc';
const TAB_ID = 7;
const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';

const contentScript = (
  await build({
    entryPoints: [path.join(ROOT, 'src/content/content-script.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
  })
).outputFiles[0].text;

/** One extension context. `alive` turns false when the extension is reloaded. */
function extensionContext() {
  const ctx = { alive: true, listeners: [] };
  ctx.chrome = {
    runtime: {
      get id() {
        return ctx.alive ? 'flow-scene-queue-test' : undefined;
      },
      onMessage: {
        addListener(listener) {
          ctx.listeners.push(listener);
        },
        removeListener(listener) {
          ctx.listeners = ctx.listeners.filter((item) => item !== listener);
        },
      },
    },
  };
  return ctx;
}

function flowPage({ injectionError = null } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><main id="app"></main></body></html>', {
    url: FLOW_URL,
    runScripts: 'outside-only',
  });
  const page = {
    window: dom.window,
    contexts: [],
    current: null,
    injectionCalls: 0,
    injectionError,
    newContext() {
      page.current = extensionContext();
      page.contexts.push(page.current);
      return page.current;
    },
    /** Run the content script the way Chrome does: in the page, with that context's `chrome`. */
    runContentScript(ctx) {
      page.window.chrome = ctx.chrome;
      page.window.eval(contentScript);
    },
    /** The old extension's connectors can no longer answer; new injections use a new context. */
    reloadExtension() {
      for (const ctx of page.contexts) ctx.alive = false;
      return page.newContext();
    },
  };
  return page;
}

/** Chrome's message delivery: only live contexts answer, and the first reply wins. */
function deliver(page, message) {
  const listeners = page.contexts.filter((ctx) => ctx.alive).flatMap((ctx) => ctx.listeners);
  if (listeners.length === 0) throw new Error(NO_RECEIVER);
  return new Promise((resolve) => {
    const keepOpen = listeners[0](message, {}, resolve);
    if (!keepOpen) resolve(undefined);
  });
}

function chromeApiFor(page) {
  return {
    tabs: {
      query: async () => [{ id: TAB_ID, url: FLOW_URL, active: true }],
      get: async (id) => {
        if (id !== TAB_ID) throw new Error(`No tab with id: ${id}`);
        return { id: TAB_ID, url: FLOW_URL };
      },
      sendMessage: async (_tabId, message) => deliver(page, message),
    },
    scripting: {
      executeScript: async ({ target, files, func, args = [] }) => {
        if (func) {
          // Status reads and clears run inside the page, as Chrome runs them in the connector's world.
          const run = page.window.eval(`(${func.toString()})`);
          return [{ result: run(...args) }];
        }
        page.injectionCalls += 1;
        if (page.injectionError) throw new Error(page.injectionError);
        if (target.tabId !== TAB_ID || target.frameIds?.[0] !== 0 || files[0] !== 'content/content-script.js') {
          throw new Error('Unexpected injection target.');
        }
        page.runContentScript(page.current ?? page.newContext());
        return [{ result: null }];
      },
    },
  };
}

test('a Flow tab that was open before the extension loaded gets the connector and connects', async () => {
  const page = flowPage();
  page.newContext();
  const status = await checkFlowConnection({ chromeApi: chromeApiFor(page) });
  assert.equal(status.status, 'connected', status.message);
  assert.equal(page.injectionCalls, 1);
});

test('a connector left behind by an extension reload is replaced, so the tab connects', async () => {
  const page = flowPage();
  page.runContentScript(page.newContext()); // the connector from the previous extension version
  page.reloadExtension(); // that connector can no longer answer
  const status = await checkFlowConnection({ chromeApi: chromeApiFor(page) });
  assert.equal(status.status, 'connected', status.message);
  assert.equal(page.injectionCalls, 1);
});

test('a live connector is never duplicated, so one command cannot run twice', () => {
  const page = flowPage();
  const ctx = page.newContext();
  page.runContentScript(ctx); // manifest injection...
  page.runContentScript(ctx); // ...racing an injection from the service worker
  assert.equal(ctx.listeners.length, 1);
});

test('a tab with a live connector is not injected again', async () => {
  const page = flowPage();
  page.runContentScript(page.newContext());
  const status = await checkFlowConnection({ chromeApi: chromeApiFor(page) });
  assert.equal(status.status, 'connected', status.message);
  assert.equal(page.injectionCalls, 0);
});

test('when the connector cannot be injected, the user is told to reload the Flow tab', async () => {
  const page = flowPage({ injectionError: 'Cannot access contents of the url.' });
  page.newContext();
  const status = await checkFlowConnection({ chromeApi: chromeApiFor(page) });
  assert.equal(status.status, 'not_connected');
  assert.match(status.message, /reload the Flow tab/i);
  assert.doesNotMatch(status.message, /receiving end/i);
});

test('after an extension reload, the command bridge also reattaches and answers', async () => {
  const page = flowPage();
  page.runContentScript(page.newContext());
  page.reloadExtension();
  const bridge = createFlowBridge({ getTabId: () => TAB_ID, chromeApi: chromeApiFor(page) });
  const data = await bridge.probe();
  assert.ok(data && typeof data === 'object', 'probe returns data from the content script');
  assert.equal(page.injectionCalls, 1);
});
