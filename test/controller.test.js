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
import { AutomationError, ERROR_CODES } from '../src/utils/errors.js';
import { virtualClock, scriptedFlow, readExampleDocument, FAST_TIMINGS, TEST_LIBRARY } from './helpers.js';

const FLOW_TAB = { id: 7, url: 'https://flow.google.com/project/abc123', active: true };

/** Minimal chrome.* surface used by the controller, bridge and connection check. */
function fakeChrome({ tabs = [FLOW_TAB], probe = { promptFound: true, isProjectPage: true, settingsFound: true }, respond = true } = {}) {
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

test('a connected tab whose settings control is missing says so instead of looking ready', async () => {
  const api = fakeChrome({ probe: { promptFound: true, isProjectPage: true, settingsFound: false } });
  const connected = await checkFlowConnection({ chromeApi: api });
  assert.equal(connected.status, 'connected');
  assert.equal(connected.promptFound, true);
  assert.equal(connected.settingsFound, false);
  assert.match(connected.message, /no model\/settings control/);
  assert.match(connected.message, /tab and connector OK/);

  const ready = await checkFlowConnection({ chromeApi: fakeChrome() });
  assert.equal(ready.settingsFound, true);
  assert.equal(ready.message, 'Connected to Flow.');
});

test('the connection line enumerates every missing capability, one by one', async () => {
  const noComposer = await checkFlowConnection({
    chromeApi: fakeChrome({ probe: { promptFound: false, isProjectPage: true, settingsFound: false, detectedSettings: null } }),
  });
  assert.equal(noComposer.status, 'connected');
  assert.match(noComposer.message, /no prompt composer/);
  assert.match(noComposer.message, /no model\/settings control/);
  assert.equal(noComposer.detectedSettings, null);

  const noProject = await checkFlowConnection({
    chromeApi: fakeChrome({ probe: { promptFound: false, isProjectPage: false, settingsFound: false } }),
  });
  assert.match(noProject.message, /no project open/);
  assert.match(noProject.message, /no prompt composer/);

  const withChip = await checkFlowConnection({
    chromeApi: fakeChrome({ probe: { promptFound: true, isProjectPage: true, settingsFound: true, detectedSettings: { mode: null, model: 'Nano Banana 2.1', aspectRatio: null } } }),
  });
  assert.equal(withChip.message, 'Connected to Flow.');
  assert.equal(withChip.detectedSettings.model, 'Nano Banana 2.1', 'the chip text travels to the panel');
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

test('a failed automatic settings read is logged and reported, never a crash in the worker', async () => {
  const { controller, store } = await createController();
  // Flow exposes no settings control (the first thing that can differ on the live page):
  // the automatic settings read fails while the user is already acting.
  const failure = Object.assign(new Error('Could not find the model/settings control next to the Flow prompt box.'), {
    code: 'FLOW_UI_CHANGED',
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  controller.bridge.readSettings = async () => {
    await gate;
    throw failure;
  };

  await controller.handle('checkFlow'); // connected + prompt found: starts the automatic read
  const pending = controller.settingsReadPromise;
  assert.ok(pending, 'the automatic settings read is in flight');

  // A command that waits for the background read (Start, Resume, Read from Flow, a setting change)
  // must surface Flow's own error, not a crash inside the failure handler.
  const userAction = controller.handle('refreshFlowSettings');
  release();
  await assert.rejects(userAction, (error) => {
    assert.equal(error.code, 'FLOW_UI_CHANGED');
    assert.match(error.message, /model\/settings control/);
    return true;
  });

  // The background read resolves: the failure was handled and logged, not rethrown into the worker.
  await pending;
  const logs = store.read(STORAGE_KEYS.logs).map((entry) => entry.message);
  assert.ok(
    logs.some((message) => /Flow settings are not read yet: Could not find the model\/settings control/.test(message)),
    JSON.stringify(logs),
  );
  assert.equal(store.read(STORAGE_KEYS.flowSettings).readAt, null, 'no settings were stored');
  assert.match(
    store.read(STORAGE_KEYS.flowSettings).readError,
    /Could not find the model\/settings control/,
    'the failure is stored so the panel can show it instead of a bare "Not read yet"',
  );
});

test('a manual Read from Flow stores the failure in the settings card and rethrows it to the panel', async () => {
  const { controller, store } = await createController();
  const failure = Object.assign(new Error('The Flow settings menu did not open after clicking "Nano Banana 2.1 \u25be".'), {
    code: 'FLOW_UI_CHANGED',
  });
  controller.bridge.readSettings = async () => {
    throw failure;
  };
  await assert.rejects(controller.handle('refreshFlowSettings'), (error) => {
    assert.equal(error.code, 'FLOW_UI_CHANGED');
    assert.match(error.message, /did not open after clicking/);
    return true;
  });
  const settings = store.read(STORAGE_KEYS.flowSettings);
  assert.equal(settings.readAt, null);
  assert.match(settings.readError, /did not open after clicking/);

  // A successful read clears the stored failure.
  controller.bridge.readSettings = async () => ({ current: { mode: 'Image', model: 'Nano Banana 2.1', aspectRatio: null }, options: { mode: ['Image'], model: ['Nano Banana 2.1'], aspectRatio: [] }, strategy: 's' });
  await controller.handle('refreshFlowSettings');
  assert.equal(store.read(STORAGE_KEYS.flowSettings).readError, null);
  assert.equal(store.read(STORAGE_KEYS.flowSettings).current.model, 'Nano Banana 2.1');
});

test('Read from Flow is refused while the automation runs, so Flow menus are never driven by two callers', async () => {
  const { controller } = await createController({ flowScript: { neverFinish: true } });
  await controller.handle('analyze', { text: readExampleDocument() });
  await controller.handle('start');
  await assert.rejects(controller.handle('refreshFlowSettings'), /Stop the automation/);
  await controller.handle('stop');
  await controller.runner.whenIdle();
});

test('the page check reports a responding connector and prepends its check', async () => {
  const { controller } = await createController();
  const report = await controller.handle('diagnoseFlow');
  assert.equal(report.contentScript, 'responding');
  assert.equal(report.ok, undefined, 'the report itself is the answer, not an error envelope');
  assert.equal(report.checks[0].label, 'Flow connector');
  assert.equal(report.checks[0].ok, true);
  assert.match(report.checks[0].detail, /adapter/);
  assert.ok(report.checks.some((check) => check.label === 'Prompt box'), 'the adapter checks follow');
  assert.equal(report.tabId, 7);
});

test('the page check still produces a report when the connector does not answer', async () => {
  const { controller } = await createController({ chromeApi: fakeChrome({ respond: false }) });
  const report = await controller.handle('diagnoseFlow');
  assert.equal(report.contentScript, 'not responding');
  assert.match(report.contentScriptDetail, /Reload the Flow tab/);
  assert.equal(report.checks.length, 1);
  assert.equal(report.checks[0].label, 'Flow connector');
  assert.equal(report.checks[0].ok, false);
  assert.match(report.checks[0].detail, /Reload the Flow tab/);
  assert.deepEqual(report.promptCandidates, [], 'no candidates are invented for a dead tab');
  assert.ok(report.issues.length >= 1);
});

test('the page check reports a tab that is not on Flow', async () => {
  const api = fakeChrome({ tabs: [{ id: 7, url: 'https://example.com/', active: true }] });
  const { controller } = await createController({ chromeApi: api });
  const report = await controller.handle('diagnoseFlow');
  assert.equal(report.contentScript, 'not responding');
  assert.equal(report.flowPage, false);
  assert.equal(report.url, 'https://example.com/');
  assert.match(report.checks[0].detail, /Open Flow/);
});

test('the page check reports a connector that dies between the connection check and the page check', async () => {
  const { controller } = await createController();
  controller.bridge.diagnoseTab = async () => {
    throw new AutomationError(ERROR_CODES.FLOW_NO_RESPONSE, 'Flow did not answer "diagnose".');
  };
  const report = await controller.handle('diagnoseFlow');
  assert.equal(report.contentScript, 'not responding');
  assert.match(report.contentScriptDetail, /did not answer/);
  assert.equal(report.checks[0].ok, false);
  assert.deepEqual(report.promptCandidates, []);
});
