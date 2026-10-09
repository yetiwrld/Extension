import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import { JSDOM, VirtualConsole } from 'jsdom';
import { build } from 'esbuild';
import { dist, entries, verifyArtifacts } from '../scripts/build.mjs';
import { FLOW_CONTENT_SCRIPT } from '../src/background/flow-bridge.js';
import { CONNECTOR_STATUS_KEY, FLOW_TARGET } from '../src/shared/protocol.js';

/*
 * The content script is the one file Chrome runs in a Flow tab: when the manifest declares it, and
 * when the service worker injects it into a tab that was already open. These tests check the built
 * file, then run it the way Chrome does. The page context outlives injections, each extension
 * context receives messages only while it is alive, and every live listener gets each message.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLOW_URL = 'https://flow.google.com/project/abc';
const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';
/** The boolean guard the first build left in the page. A later copy must not be stopped by it. */
const FIRST_BUILD_GUARD = '__flowSceneQueueConnector__';
const PING = { target: FLOW_TARGET, cmd: 'ping', payload: null };

const contentScript = (
  await build({ ...entries.content, write: false, logLevel: 'silent' })
).outputFiles.find((file) => file.path.endsWith('.js')).text;

/** A Flow tab. Each injection runs the bundle in the tab's page context, with one extension context's `chrome`. */
function flowTab() {
  // Warnings the connector logs while it cleans up a dead context are expected, so the console is not shown.
  const dom = new JSDOM('<!doctype html><html><body><main id="app"></main></body></html>', {
    url: FLOW_URL,
    runScripts: 'outside-only',
    virtualConsole: new VirtualConsole(),
  });
  const contexts = [];
  const tab = {
    newContext() {
      const ctx = { alive: true, listeners: [] };
      const onMessage = {
        addListener: (listener) => ctx.listeners.push(listener),
        removeListener: (listener) => {
          ctx.listeners = ctx.listeners.filter((item) => item !== listener);
        },
      };
      ctx.chrome = {
        runtime: {
          get id() {
            return ctx.alive ? 'flow-scene-queue-test' : undefined;
          },
          // Chrome refuses API access from a context that was invalidated by a reload.
          get onMessage() {
            if (!ctx.alive) throw new Error('Extension context invalidated.');
            return onMessage;
          },
        },
      };
      contexts.push(ctx);
      return ctx;
    },
    inject(ctx) {
      dom.window.chrome = ctx.chrome;
      dom.window.eval(contentScript);
    },
    window: dom.window,
    liveListeners() {
      return contexts.filter((ctx) => ctx.alive).flatMap((ctx) => ctx.listeners);
    },
    /** Chrome's delivery: every live listener is called; the first reply sent is the one the sender gets. */
    send(message) {
      const listeners = tab.liveListeners();
      if (listeners.length === 0) return Promise.reject(new Error(NO_RECEIVER));
      return new Promise((resolve) => {
        let keepOpen = false;
        for (const listener of listeners) {
          keepOpen = listener(message, {}, resolve) === true || keepOpen;
        }
        if (!keepOpen) resolve(undefined);
      });
    },
    close: () => dom.window.close(),
  };
  return tab;
}

async function withTab(run) {
  const tab = flowTab();
  try {
    return await run(tab);
  } finally {
    tab.close();
  }
}

test('the content script is one classic script, with no import or export left in it', () => {
  assert.doesNotThrow(() => new Script(contentScript, { filename: 'content-script.js' }));
  assert.doesNotMatch(contentScript, /^\s*(import|export)\s/m);
  assert.doesNotMatch(contentScript, /import\.meta/);
});

test('the manifest, the service worker and the build all name the same content script file', async () => {
  const manifest = JSON.parse(await readFile(path.join(ROOT, 'src/manifest.json'), 'utf8'));
  assert.deepEqual(manifest.content_scripts[0].js, [FLOW_CONTENT_SCRIPT]);
  assert.equal(path.relative(dist, entries.content.outfile).split(path.sep).join('/'), FLOW_CONTENT_SCRIPT);
});

test('the build refuses to finish when the manifest names another file, or the content script is a module', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'flow-queue-dist-'));
  try {
    await mkdir(path.join(dir, 'content'), { recursive: true });
    const write = (manifestJs, code) =>
      Promise.all([
        writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ content_scripts: [{ js: manifestJs }] })),
        writeFile(path.join(dir, 'content', 'content-script.js'), code),
      ]);
    await write([FLOW_CONTENT_SCRIPT], "import { x } from './dep.js';\nconsole.log(x);\n");
    await assert.rejects(verifyArtifacts(dir), /not a classic script/);
    await write(['content/other.js'], '(() => {})();\n');
    await assert.rejects(verifyArtifacts(dir), /must declare exactly "content\/content-script.js"/);
    await write([FLOW_CONTENT_SCRIPT], '(() => {})();\n');
    assert.equal(await verifyArtifacts(dir), FLOW_CONTENT_SCRIPT);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a guard left in the page by the first build does not stop a later copy from registering', async () => {
  await withTab(async (tab) => {
    tab.window[FIRST_BUILD_GUARD] = true;
    const ctx = tab.newContext();
    tab.inject(ctx);
    assert.equal(ctx.listeners.length, 1);
    assert.equal(tab.window[CONNECTOR_STATUS_KEY].installed, true);
    assert.equal((await tab.send(PING)).ok, true);
  });
});

test('however often the connector is injected, one listener answers each command, including after a reload', async () => {
  await withTab(async (tab) => {
    const first = tab.newContext();
    tab.inject(first); // declared in the manifest
    tab.inject(first); // injected again by the service worker, in the same live context
    tab.inject(first);
    assert.equal(tab.liveListeners().length, 1);
    assert.equal((await tab.send(PING)).ok, true);

    // The extension is reloaded: the old context dies, and the next injection replaces its connector.
    first.alive = false;
    const second = tab.newContext();
    tab.inject(second);
    assert.equal(tab.liveListeners().length, 1);
    assert.equal(second.listeners.length, 1);
    assert.equal(tab.window[CONNECTOR_STATUS_KEY].installed, true);
    assert.equal((await tab.send(PING)).ok, true);
  });
});

test('after a reload with no new injection, the tab reports that no connector is listening', async () => {
  await withTab(async (tab) => {
    const first = tab.newContext();
    tab.inject(first);
    first.alive = false; // the old connector is orphaned and nothing has been injected since
    await assert.rejects(tab.send(PING), { message: NO_RECEIVER });
  });
});

test('an unsupported command gets an error reply; other targets and empty messages are left to other listeners', async () => {
  await withTab(async (tab) => {
    const ctx = tab.newContext();
    tab.inject(ctx);
    const unknown = await tab.send({ target: FLOW_TARGET, cmd: 'deleteEverything', payload: null });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.error.code, 'INVALID_INPUT');
    const [listener] = ctx.listeners;
    const replies = [];
    assert.equal(listener({ target: 'another-extension', cmd: 'probe' }, {}, (reply) => replies.push(reply)), false);
    assert.equal(listener(null, {}, (reply) => replies.push(reply)), false);
    assert.deepEqual(replies, []);
  });
});
