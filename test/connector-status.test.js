import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import {
  attachConnector,
  connectorFailure,
  RELOAD_TAB_MESSAGE,
  RUNNING_NOT_DELIVERED_MESSAGE,
} from '../src/background/flow-bridge.js';
import { CONNECTOR_STATUS_KEY } from '../src/shared/protocol.js';

/*
 * The connector reports its own state in the tab, and the service worker reads that report when a
 * command gets no answer. A connector whose extension context is gone must say so, a connector that
 * registers must say it is installed, and a failed start must never look like a success. The content
 * script tests below run the real bundle in a jsdom page.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLOW_URL = 'https://flow.google.com/project/abc';
const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';
const OLDER_COPY =
  'This Flow tab still has a connector from an older copy of the extension. Reload the Flow tab (press F5) and try again.';

const contentScript = (
  await build({
    entryPoints: [path.join(ROOT, 'src/content/content-script.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
  })
).outputFiles[0].text;

/** One extension context. `alive` turns false when the extension is reloaded, as Chrome does. */
function extensionContext({ addListenerError = null } = {}) {
  const ctx = { alive: true, listeners: [] };
  ctx.chrome = {
    runtime: {
      get id() {
        return ctx.alive ? 'flow-scene-queue-test' : undefined;
      },
      onMessage: {
        addListener(listener) {
          if (addListenerError) throw new Error(addListenerError);
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

function newPage() {
  return new JSDOM('<!doctype html><html><body></body></html>', { url: FLOW_URL, runScripts: 'outside-only' }).window;
}

function runConnector(window, ctx) {
  window.chrome = ctx.chrome;
  window.eval(contentScript);
}

test('a connector in a live extension context installs and reports that it did', () => {
  const window = newPage();
  const ctx = extensionContext();
  runConnector(window, ctx);
  assert.equal(ctx.listeners.length, 1);
  assert.equal(window[CONNECTOR_STATUS_KEY].installed, true);
});

test('a connector from an older copy of the extension does not pretend to listen, and says why', () => {
  const window = newPage();
  const stale = extensionContext();
  stale.alive = false; // the extension was reloaded after this connector was injected
  runConnector(window, stale);
  assert.equal(stale.listeners.length, 0);
  assert.equal(window[CONNECTOR_STATUS_KEY].installed, false);
  assert.equal(window[CONNECTOR_STATUS_KEY].reason, OLDER_COPY);
});

test('when a new connector cannot register, the working connector keeps answering', () => {
  const window = newPage();
  const working = extensionContext();
  runConnector(window, working);
  const broken = extensionContext({ addListenerError: 'Extension context invalidated.' });
  runConnector(window, broken);
  assert.equal(working.listeners.length, 1, 'the working connector must not be removed');
  assert.equal(window[CONNECTOR_STATUS_KEY].installed, false);
  assert.match(window[CONNECTOR_STATUS_KEY].reason, /could not start in this tab \(Extension context invalidated\./);
});

/** The service worker's view of a tab: file injections succeed, and status reads return `status`. */
function serviceWorkerApi({ status = null, injectError = null } = {}) {
  return {
    scripting: {
      executeScript: async (options) => {
        if (options.func) return [{ result: status }];
        if (injectError) throw new Error(injectError);
        return [{ result: null }];
      },
    },
  };
}

test('a command with no answer gives the connector\'s own reason when the connector declined to start', async () => {
  const api = serviceWorkerApi({ status: { installed: false, reason: OLDER_COPY } });
  const error = await connectorFailure(api, 7, new Error(NO_RECEIVER));
  assert.equal(error.code, 'FLOW_NO_RESPONSE');
  assert.ok(error.message.startsWith(OLDER_COPY), error.message);
  assert.ok(error.message.includes(NO_RECEIVER), 'Chrome\'s own error is kept as details');
});

test('when the connector is running but a command was not delivered, the reason says so', async () => {
  const api = serviceWorkerApi({ status: { installed: true, reason: '' } });
  const error = await connectorFailure(api, 7, new Error(NO_RECEIVER));
  assert.ok(error.message.startsWith(RUNNING_NOT_DELIVERED_MESSAGE), error.message);
});

test('when the connector never reported, the reason is the reload advice', async () => {
  const api = serviceWorkerApi({ status: null });
  const error = await connectorFailure(api, 7, new Error(NO_RECEIVER));
  assert.ok(error.message.startsWith(RELOAD_TAB_MESSAGE), error.message);
});

test('attaching fails with the connector\'s reason when the connector declined to start', async () => {
  const api = serviceWorkerApi({ status: { installed: false, reason: OLDER_COPY } });
  await assert.rejects(attachConnector(api, 7), (error) => {
    assert.equal(error.code, 'FLOW_NO_RESPONSE');
    assert.equal(error.message, OLDER_COPY);
    return true;
  });
});

test('attaching succeeds when the connector reports that it is installed', async () => {
  const api = serviceWorkerApi({ status: { installed: true, reason: '' } });
  await attachConnector(api, 7);
});

test('a tab that never answers the status read still gets a failure report', async () => {
  const api = {
    scripting: {
      executeScript: async (options) => (options.func ? new Promise(() => {}) : [{ result: null }]),
    },
  };
  const error = await connectorFailure(api, 7, new Error(NO_RECEIVER));
  assert.ok(error.message.startsWith(RELOAD_TAB_MESSAGE), error.message);
});
