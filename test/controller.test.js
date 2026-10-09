import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/background/controller.js';
import { KeyValueStore } from '../src/storage/store.js';
import { memoryKv } from '../src/storage/kv.js';
import { STORAGE_KEYS } from '../src/storage/schema.js';
import { AutomationRunner } from '../src/queue/runner.js';
import { createFlowBridge, isFlowUrl } from '../src/background/flow-bridge.js';
import { checkFlowConnection } from '../src/background/connection.js';
import { createFileLoader } from '../src/background/files.js';
import { virtualClock, scriptedFlow, readExampleDocument, FAST_TIMINGS, TEST_LIBRARY } from './helpers.js';

const FLOW_TAB = { id: 7, url: 'https://flow.google.com/project/abc123', active: true };

/** Minimal chrome.* surface used by the controller, bridge and connection check. */
function fakeChrome({ tabs = [FLOW_TAB], probe = { promptFound: true, isProjectPage: true }, respond = true } = {}) {
  const sessionData = {};
  return {
    sessionData,
    tabs: {
      query: async () => tabs.filter((tab) => tab.active),
      get: async (id) => {
        const tab = tabs.find((item) => item.id === id);
        if (!tab) throw new Error('No tab with id');
        return tab;
      },
      sendMessage: async (tabId, message) => {
        if (!respond) throw new Error('Could not establish connection. Receiving end does not exist.');
        if (message.cmd === 'ping') return { ok: true, data: { ready: true } };
        if (message.cmd === 'probe') return { ok: true, data: probe };
        return { ok: true, data: null };
      },
    },
    scripting: { executeScript: async () => [] },
    storage: {
      session: {
        get: async (key) => ({ [key]: sessionData[key] }),
        set: async (values) => Object.assign(sessionData, values),
      },
    },
  };
}

async function createController({ library = TEST_LIBRARY, text = readExampleDocument(), flowScript = {}, chromeApi = fakeChrome() } = {}) {
  const clock = virtualClock();
  const kv = memoryKv({ referenceLibrary: library });
  const store = new KeyValueStore(kv);
  await store.load([
    STORAGE_KEYS.prefs,
    STORAGE_KEYS.document,
    STORAGE_KEYS.queue,
    STORAGE_KEYS.automation,
    STORAGE_KEYS.overrides,
    STORAGE_KEYS.logs,
    STORAGE_KEYS.flowSettings,
  ]);
  const flow = scriptedFlow(flowScript);
  const bridge = { ...flow, diagnoseTab: async () => ({ checks: [{ label: 'Prompt box', ok: true, detail: 'Found.' }] }) };
  const runner = new AutomationRunner({
    store,
    flow: bridge,
    files: createFileLoader(kv, { getReferenceBlob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }) }),
    log: async () => {},
    clock,
    timings: FAST_TIMINGS,
  });
  const controller = new Controller({ store, runner, bridge, kv, chromeApi, now: clock.now });
  return { controller, store, runner, flow, kv, chromeApi };
}

test('isFlowUrl accepts Flow project pages and rejects look-alike hosts', () => {
  assert.equal(isFlowUrl('https://flow.google.com/project/abc'), true);
  assert.equal(isFlowUrl('https://labs.google/fx/tools/flow/project/abc'), true);
  assert.equal(isFlowUrl('https://flow.google.com.evil.example/project/abc'), false);
  assert.equal(isFlowUrl('http://flow.google.com/project/abc'), false);
  assert.equal(isFlowUrl('https://labs.google/fx/tools/other'), false);
  assert.equal(isFlowUrl(undefined), false);
});

test('connection reads "Connected" only when the active tab is Flow and its connector answers', async () => {
  const connected = await checkFlowConnection({ chromeApi: fakeChrome() });
  assert.equal(connected.status, 'connected');
  assert.equal(connected.tabId, 7);
  assert.equal(connected.promptFound, true);

  const notFlow = await checkFlowConnection({ chromeApi: fakeChrome({ tabs: [{ id: 9, url: 'https://example.com/', active: true }] }) });
  assert.equal(notFlow.status, 'not_connected');
  assert.match(notFlow.message, /Open Flow/);

  const silent = await checkFlowConnection({ chromeApi: fakeChrome({ respond: false }) });
  assert.equal(silent.status, 'not_connected');
  assert.match(silent.message, /Reload the Flow tab/);
});

test('the bridge reports a closed tab as FLOW_TAB_CLOSED so the queue pauses instead of failing', async () => {
  const chromeApi = fakeChrome();
  const bridge = createFlowBridge({ getTabId: () => 999, chromeApi });
  await assert.rejects(bridge.probe(), (error) => {
    assert.equal(error.code, 'FLOW_TAB_CLOSED');
    return true;
  });
});

test('the bridge reports a tab that navigated away from Flow as FLOW_NOT_CONNECTED', async () => {
  const chromeApi = fakeChrome({ tabs: [{ id: 7, url: 'https://accounts.google.com/', active: false }] });
  const bridge = createFlowBridge({ getTabId: () => 7, chromeApi });
  await assert.rejects(bridge.probe(), (error) => {
    assert.equal(error.code, 'FLOW_NOT_CONNECTED');
    return true;
  });
});

test('the bridge injects the connector once when the page predates the extension, then retries', async () => {
  let injected = 0;
  let sends = 0;
  const chromeApi = fakeChrome();
  chromeApi.scripting.executeScript = async (options) => {
    // Status reads and clears are functions. Only file injections count as injections.
    if (options.files) injected += 1;
    return [{ result: null }];
  };
  chromeApi.tabs.sendMessage = async () => {
    sends += 1;
    if (sends === 1) throw new Error('Could not establish connection. Receiving end does not exist.');
    return { ok: true, data: { promptFound: true } };
  };
  const bridge = createFlowBridge({ getTabId: () => 7, chromeApi });
  const data = await bridge.probe();
  assert.equal(injected, 1);
  assert.equal(data.promptFound, true);
});

test('analyzing the example document builds a four-scene queue that is ready to start', async () => {
  const { controller, store } = await createController({ text: '' });
  const result = await controller.handle('analyze', { text: readExampleDocument() });
  assert.equal(result.sceneCount, 4);
  assert.equal(result.readiness.canStart, true);
  assert.deepEqual(
    store.read(STORAGE_KEYS.queue).scenes.map((scene) => scene.referenceStatus),
    ['ok', 'ok', 'ok', 'ok'],
  );
});

test('start is refused while a reference is missing, and Flow is not touched', async () => {
  const { controller, flow } = await createController({ library: TEST_LIBRARY.slice(0, 2) });
  await controller.handle('analyze', { text: readExampleDocument() });
  await assert.rejects(controller.handle('start'), (error) => {
    assert.equal(error.code, 'REFERENCE_MISSING');
    return true;
  });
  assert.equal(flow.state.calls.length, 0);
});

test('an ambiguous bare reference blocks start until the user chooses a file', async () => {
  const library = [...TEST_LIBRARY, { id: 'ref-aron-close', name: 'Aron_Closeup.png', mime: 'image/png', size: 1 }];
  const text = '[Scene 1]\nA shot.\nReference images: Aron\n';
  const { controller, store } = await createController({ library, text });
  const first = await controller.handle('analyze', { text });
  assert.equal(first.readiness.canStart, false);
  assert.equal(first.readiness.blockers[0].code, 'REFERENCE_AMBIGUOUS');

  await controller.handle('setOverride', { sceneNumber: 1, tokenKey: 'aron', fileId: 'ref-aron' });
  const queue = store.read(STORAGE_KEYS.queue);
  assert.equal(queue.scenes[0].referenceStatus, 'ok');
  assert.deepEqual(queue.scenes[0].matchedFileIds, ['ref-aron']);
  const state = await controller.getState();
  assert.equal(state.readiness.canStart, true);
});

test('strict filename matching turns bare names into missing references and refreshes the queue', async () => {
  const text = '[Scene 1]\nA shot.\nReference images: Vex\n';
  const { controller, store } = await createController({ text });
  await controller.handle('analyze', { text });
  assert.equal(store.read(STORAGE_KEYS.queue).scenes[0].referenceStatus, 'ok');
  await controller.handle('setPrefs', { strictFilenameMatching: true });
  assert.equal(store.read(STORAGE_KEYS.queue).scenes[0].referenceStatus, 'missing');
});

test('the document cannot be replaced while automation is running', async () => {
  const { controller, runner } = await createController({ flowScript: { neverFinish: true } });
  await controller.handle('analyze', { text: readExampleDocument() });
  await controller.handle('start');
  await assert.rejects(controller.handle('analyze', { text: '[Scene 1]\nX.' }), /Stop the automation/);
  await controller.handle('stop');
  await runner.whenIdle();
});

test('a scene whose text changed after completion is reported as a new scene, not silently regenerated', async () => {
  const { controller, store, flow } = await createController();
  await controller.handle('analyze', { text: readExampleDocument() });
  await controller.handle('start');
  await controller.runner.whenIdle();
  assert.equal(flow.state.submits.length, 4);

  const edited = readExampleDocument().replace('quiet harbour', 'busy harbour');
  const result = await controller.handle('analyze', { text: edited });
  assert.equal(result.sceneCount, 4);
  const scene = store.read(STORAGE_KEYS.queue).scenes[0];
  assert.equal(scene.status, 'waiting', 'the edited scene must be queued again');
  const logs = store.read(STORAGE_KEYS.logs).map((entry) => entry.message);
  assert.ok(logs.some((message) => /Scene 01 has a changed prompt/.test(message)));
});

test('getState returns the connection, readiness and queue counts the panel renders', async () => {
  const { controller } = await createController();
  await controller.handle('analyze', { text: readExampleDocument() });
  const state = await controller.getState();
  assert.equal(state.queue.counts.total, 4);
  assert.equal(state.readiness.canStart, true);
  assert.equal(state.automation.phase, 'idle');
  assert.equal(state.prefs.pauseOnFailure, true);
});

test('unknown panel commands are refused', async () => {
  const { controller } = await createController();
  await assert.rejects(controller.handle('format-disk'), /Unknown command/);
});

test('clearing the project keeps the reference library and preferences', async () => {
  const { controller, store, kv } = await createController();
  await controller.handle('analyze', { text: readExampleDocument() });
  await controller.handle('setPrefs', { pauseOnFailure: false });
  await controller.handle('clearProject');
  assert.equal(store.read(STORAGE_KEYS.queue).scenes.length, 0);
  assert.equal(store.read(STORAGE_KEYS.document).text, '');
  assert.equal(store.read(STORAGE_KEYS.prefs).pauseOnFailure, false);
  assert.equal((await kv.get(['referenceLibrary'])).referenceLibrary.length, TEST_LIBRARY.length);
});

test('the first time a Flow project is seen, its settings are read for the panel without a manual step', async () => {
  const { controller, store, flow } = await createController();
  await controller.handle('checkFlow');
  await controller.settingsReadPromise;
  const settings = store.read(STORAGE_KEYS.flowSettings);
  assert.equal(settings.current.mode, 'Image');
  assert.deepEqual(settings.options.model, ['Nano Banana Pro', 'Nano Banana']);
  assert.ok(flow.state.calls.includes('readSettings'));
});

test('Read from Flow is refused while the automation runs, so Flow menus are never driven by two callers', async () => {
  const { controller } = await createController({ flowScript: { neverFinish: true } });
  await controller.handle('analyze', { text: readExampleDocument() });
  await controller.handle('start');
  await assert.rejects(controller.handle('refreshFlowSettings'), /Stop the automation/);
  await controller.handle('stop');
  await controller.runner.whenIdle();
});
