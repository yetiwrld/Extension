import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';
import { FLOW_TARGET } from '../src/shared/protocol.js';

/*
 * The content script answers the worker through sendResponse. If that reply cannot be sent, the
 * worker must hear about it. Before, the failure was swallowed, and the worker waited for a reply
 * that never came. These tests run the real content script bundle in a jsdom page.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLOW_URL = 'https://flow.google.com/project/abc';

const contentScript = (
  await build({
    entryPoints: [path.join(ROOT, 'src/content/content-script.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    write: false,
  })
).outputFiles[0].text;

test('a reply that cannot be sent is replaced by an error reply, so the worker is not left waiting', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: FLOW_URL, runScripts: 'outside-only' });
  const listeners = [];
  dom.window.chrome = {
    runtime: { onMessage: { addListener: (fn) => listeners.push(fn), removeListener: () => {} } },
  };
  dom.window.eval(contentScript);
  assert.equal(listeners.length, 1, 'the content script registers one listener');

  const replies = [];
  const answered = new Promise((resolve) => {
    listeners[0]({ target: FLOW_TARGET, cmd: 'probe', payload: null }, {}, (reply) => {
      replies.push(reply);
      // The first reply cannot be sent (for example, it cannot be serialised).
      if (replies.length === 1) throw new Error('The reply could not be serialised.');
      resolve();
    });
  });
  await answered;

  assert.equal(replies[0].ok, true, 'the first reply carried the probe result');
  assert.equal(replies[1].ok, false, 'the second reply says what went wrong');
  assert.match(replies[1].error.message, /could not be serialised/);
});
