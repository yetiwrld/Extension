import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { esc, bytes, clock, truncate } from '../src/sidepanel/html.js';
import * as R from '../src/sidepanel/render.js';
import { EXAMPLE_DOCUMENT } from '../src/sidepanel/example.js';
import { ROOT, readExampleDocument, buildProject, TEST_LIBRARY } from './helpers.js';

const manifest = JSON.parse(readFileSync(join(ROOT, 'src', 'manifest.json'), 'utf8'));

test('user text is escaped everywhere it is rendered', () => {
  const hostile = '<img src=x onerror=alert(1)>"\'&';
  assert.equal(esc(hostile), '&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;');

  const project = buildProject(`[Scene 1] ${hostile}\nReference images: ${hostile}.png`, { library: TEST_LIBRARY });
  const snapshot = {
    connection: { status: 'connected', message: hostile },
    document: { text: hostile, sceneCount: 1, analyzedAt: 1, errors: [{ message: hostile }], warnings: [] },
    queue: { scenes: project.queue.scenes, counts: { total: 1, completed: 0, failed: 0 } },
    readiness: { canStart: false, blockers: [{ message: hostile }], pending: 1 },
    automation: { phase: 'paused', decision: { type: 'x', title: hostile, message: hostile, actions: ['retry'], sceneId: project.queue.scenes[0].id } },
    flowSettings: { current: { mode: hostile }, options: { mode: [hostile] } },
    prefs: {},
    logs: [{ id: 'l', at: 1, level: 'info', message: hostile }],
  };
  const ui = { busy: false, notice: { tone: 'error', title: hostile, hint: hostile }, confirmStart: false, logOpen: true, diagnostics: null };
  const html = [
    R.renderConnection(snapshot),
    R.renderDocumentIssues(snapshot),
    R.renderBlockers(snapshot),
    R.renderQueue(snapshot, ui),
    R.renderAutomation(snapshot, ui),
    R.renderFlowSettings(snapshot, ui),
    R.renderNotice(ui.notice),
    R.renderLog(snapshot.logs, ui),
  ].join('\n');
  assert.equal(html.includes('<img src=x'), false, 'raw markup must never reach the DOM');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('status symbols and labels follow the specification', () => {
  const symbols = Object.fromEntries(Object.entries(R.STATUS).map(([key, value]) => [key, value.icon]));
  assert.equal(symbols.waiting, '○');
  assert.equal(symbols.completed, '✓');
  assert.equal(symbols.failed, '✕');
  assert.equal(symbols.paused, '⏸');
  assert.equal(symbols.retrying, '⚠');
  assert.deepEqual(
    Object.values(R.STATUS).map((value) => value.label).filter((label, index, all) => all.indexOf(label) === index).sort(),
    ['Completed', 'Failed', 'Generating', 'Paused', 'Preparing', 'Retrying', 'Skipped', 'Uploading', 'Waiting'],
  );
});

test('the connection line reads ● Connected or ○ Not Connected from the active tab state', () => {
  const on = R.renderConnection({ connection: { status: 'connected', message: 'Connected to Flow.' } });
  const off = R.renderConnection({ connection: { status: 'not_connected', message: 'Open Flow.' } });
  assert.match(on, /● Connected/);
  assert.match(off, /○ Not Connected/);
});

test('the connection line shows why when the settings control was not detected', () => {
  const hidden = R.renderConnection({ connection: { status: 'connected', message: 'Connected to Flow.', promptFound: true, settingsFound: true } });
  assert.doesNotMatch(hidden, /conn-detail/);
  const shown = R.renderConnection({
    connection: { status: 'connected', message: 'Connected to Flow. The model/settings control was not found — run "Check Flow page" in Settings.', promptFound: true, settingsFound: false },
  });
  assert.match(shown, /conn-detail/);
  assert.match(shown, /model\/settings control was not found/);
});

test('the Flow settings section offers only what Flow exposed', () => {
  const html = R.renderFlowSettings(
    {
      connection: { status: 'connected' },
      automation: { phase: 'idle' },
      flowSettings: { current: { mode: 'Image', model: 'Nano Banana Pro', aspectRatio: '16:9' }, options: { mode: ['Image', 'Video'], model: [], aspectRatio: ['16:9'] }, readAt: 1 },
    },
    { busy: false },
  );
  assert.match(html, /data-setting="mode"/);
  assert.match(html, />Video</);
  // Model has no options from Flow, so the select is disabled and offers nothing invented.
  assert.match(html, /data-setting="model" disabled/);
  assert.match(html, /Nano Banana Pro/);
});

test('the settings card distinguishes Not read yet, Unknown, Not offered and a read failure', () => {
  const base = { connection: { status: 'connected' }, automation: { phase: 'idle' } };
  const ui = { busy: false };

  const neverRead = R.renderFlowSettings(
    { ...base, flowSettings: { current: { mode: null, model: null, aspectRatio: null }, options: { mode: [], model: [], aspectRatio: [] }, readAt: null, readError: null } },
    ui,
  );
  assert.match(neverRead, /Not read yet/);
  assert.doesNotMatch(neverRead, /Read failed/);

  const readButUnknown = R.renderFlowSettings(
    { ...base, flowSettings: { current: { mode: null, model: null, aspectRatio: null }, options: { mode: [], model: [], aspectRatio: [] }, readAt: 1, readError: null } },
    ui,
  );
  assert.match(readButUnknown, /Last read/);
  const selects = readButUnknown.match(/<select data-setting="(\w+)" disabled[^>]*><option value="">([^<]*)<\/option>/g) ?? [];
  const emptyValue = (key) => selects.find((line) => line.includes(`data-setting="${key}"`))?.match(/<option value="">([^<]*)<\/option>/)?.[1];
  assert.equal(emptyValue('mode'), 'Unknown', 'mode was read but Flow offered no mode options: unknown, not a guess');
  assert.equal(emptyValue('model'), 'Unknown');
  assert.equal(emptyValue('aspectRatio'), 'Not offered in this mode', 'the ratio is reported as not exposed, not as unknown');

  const failed = R.renderFlowSettings(
    {
      ...base,
      flowSettings: {
        current: { mode: null, model: null, aspectRatio: null },
        options: { mode: [], model: [], aspectRatio: [] },
        readAt: null,
        readError: 'The Flow settings menu did not open after clicking "Nano Banana 2.1 ▾".',
      },
    },
    ui,
  );
  assert.match(failed, /Read failed: The Flow settings menu did not open after clicking/);
  assert.match(failed, /Not read yet/);
});

test('the settings card shows the model chip the composer actually displays', () => {
  const html = R.renderFlowSettings(
    {
      connection: { status: 'connected', detectedSettings: { mode: null, model: 'Nano Banana 2.1', aspectRatio: '16:9', outputs: 'x1' } },
      automation: { phase: 'idle' },
      flowSettings: {
        current: { mode: 'Image', model: 'Nano Banana 2.1', aspectRatio: '16:9', outputs: 'x1' },
        options: { mode: ['Image', 'Video'], model: ['Nano Banana 2.1'], aspectRatio: ['16:9', '9:16'], outputs: ['x1', 'x2', 'x3', 'x4'] },
        readAt: 1,
        readError: null,
      },
    },
    { busy: false },
  );
  assert.match(html, /Flow's composer shows: model Nano Banana 2\.1 \u00b7 16:9 \u00b7 x1/);
  assert.match(html, /data-setting="outputs"/);
  assert.match(html, />x4</, 'the output counts Flow offers are selectable');
  assert.match(html, /data-setting="outputs"[^>]*><option value="x1" selected/);
  const without = R.renderFlowSettings(
    {
      connection: { status: 'connected' },
      automation: { phase: 'idle' },
      flowSettings: { current: {}, options: {}, readAt: null, readError: null },
    },
    { busy: false },
  );
  assert.doesNotMatch(without, /Flow's composer shows:/);
});

test('ambiguous references render a chooser with the candidate files', () => {
  const project = buildProject('[Scene 1]\nShot.\nReference images: Aron', {
    library: [
      { id: 'a', name: 'Aron.png', mime: 'image/png', size: 1 },
      { id: 'b', name: 'Aron_Closeup.png', mime: 'image/png', size: 1 },
    ],
  });
  const html = R.renderQueue(
    { queue: { scenes: project.queue.scenes }, automation: { phase: 'idle' }, readiness: { canStart: false, blockers: [] } },
    { busy: false },
  );
  assert.match(html, /data-override/);
  assert.match(html, />Aron\.png</);
  assert.match(html, />Aron_Closeup\.png</);
});

test('missing references offer Add Reference for that exact name', () => {
  const project = buildProject('[Scene 2]\nShot.\nReference images: Unknown.png', { library: TEST_LIBRARY });
  const html = R.renderQueue({ queue: { scenes: project.queue.scenes }, automation: { phase: 'idle' } }, { busy: false });
  assert.match(html, /data-action="add-refs"[^>]*data-token="Unknown\.png"/);
});

test('the Start control is disabled until Flow is connected and the queue is ready', () => {
  const base = {
    queue: { scenes: buildProject(EXAMPLE_DOCUMENT, { library: TEST_LIBRARY }).queue.scenes },
    automation: { phase: 'idle' },
    readiness: { canStart: true, blockers: [] },
  };
  const connected = R.renderAutomation({ ...base, connection: { status: 'connected' } }, { busy: false, confirmStart: false });
  const disconnected = R.renderAutomation({ ...base, connection: { status: 'not_connected' } }, { busy: false, confirmStart: false });
  assert.match(connected, /data-action="start"(?![^>]*disabled)/);
  assert.match(disconnected, /data-action="start" disabled/);
});

test('helpers format bytes, clocks and truncated text', () => {
  assert.equal(bytes(512), '512 B');
  assert.equal(bytes(2048), '2 KB');
  assert.equal(bytes(3 * 1024 * 1024), '3.0 MB');
  assert.match(clock(new Date(2026, 9, 8, 9, 5, 3).getTime()), /^09:05:03$/);
  assert.equal(truncate('abcdefghij', 5), 'abcd\u2026');
});

test('the side panel example matches the shipped example document', () => {
  assert.equal(EXAMPLE_DOCUMENT, readExampleDocument());
});

test('the manifest uses Manifest V3 with side panel, storage and scripting only', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions.sort(), ['scripting', 'sidePanel', 'storage']);
  assert.ok(!manifest.permissions.includes('tabs'), 'tab URLs come from host permissions; no broad tabs permission');
  assert.ok(manifest.host_permissions.includes('https://flow.google.com/*'));
  assert.ok(manifest.host_permissions.some((host) => host.startsWith('https://labs.google/fx/tools/flow')));
  assert.equal(JSON.stringify(manifest).includes('<all_urls>'), false);
  assert.equal(manifest.side_panel.default_path, 'sidepanel/index.html');
  assert.equal(manifest.background.type, 'module');
});

test('every file the manifest references exists in the source tree', () => {
  const references = [
    join('src', manifest.background.service_worker),
    join('src', manifest.side_panel.default_path),
    ...manifest.content_scripts.flatMap((script) => script.js.map((file) => join('src', file))),
    ...Object.values(manifest.icons).map((file) => join('src', file)),
  ];
  for (const file of references) {
    assert.ok(existsSync(join(ROOT, file)), `missing ${file}`);
  }
});

test('the content script only runs on Flow hosts and only in the top frame', () => {
  const [script] = manifest.content_scripts;
  assert.equal(script.all_frames, false);
  assert.ok(script.matches.every((pattern) => pattern.includes('flow.google.com') || pattern.includes('labs.google/fx/tools/flow')));
});

test('the page check renders the composer candidates, selectors and exceptions', () => {
  const ui = { busy: false, notice: null, confirmStart: false, logOpen: false, diagnostics: null };
  const snapshot = { prefs: {}, automation: { phase: 'idle' } };
  const hostile = '<img src=x onerror=alert(1)>';
  const diagnostics = {
    checkedAt: 1_760_000_000_000,
    url: 'https://flow.google.com/project/abc',
    flowPage: true,
    contentScript: 'responding',
    adapterVersion: '1.0.0',
    frames: { inspected: 2, unreachable: 1 },
    isProjectPage: true,
    workspaceDetected: false,
    promptFound: false,
    promptCandidates: [
      {
        tag: 'input',
        role: 'searchbox',
        name: hostile,
        placeholder: '',
        type: 'search',
        contenteditable: '',
        disabled: false,
        readonly: false,
        visible: true,
        frame: 'top',
        inShadowRoot: false,
        rect: { x: 1, y: 2, width: 3, height: 4 },
        rejection: 'search field',
        error: null,
      },
    ],
    selectorResults: [{ selector: 'textarea', scope: 'top', matched: 1, visible: 1 }],
    promptControls: [],
    detectedSettings: {},
    exceptions: [{ label: 'prompt candidates', message: hostile, stack: hostile }],
    checks: [
      { label: 'Flow connector', ok: true, detail: 'The connector answers.' },
      { label: 'Prompt box', ok: false, detail: 'Not found.' },
    ],
    issues: [],
  };
  const html = R.renderSettings(snapshot, { ...ui, diagnostics });
  assert.match(html, /Prompt field candidates \(1\)/);
  assert.match(html, /Composer selectors \(1\)/);
  assert.match(html, /Exceptions \(1\)/);
  assert.match(html, /\[searchbox\]/);
  assert.match(html, /rejected: search field/);
  assert.match(html, /3\u00d74 at \(1, 2\)/);
  assert.match(html, /data-action="copy-diagnostics"/, 'the copy button is always available');
  assert.equal(html.includes('<img src=x'), false, 'candidate names are escaped');
});

test('the page check renders a dead-connector report with its reason', () => {
  const ui = { busy: false, notice: null, confirmStart: false, logOpen: false, diagnostics: null };
  const snapshot = { prefs: {}, automation: { phase: 'idle' } };
  const diagnostics = {
    ok: false,
    contentScript: 'not responding',
    contentScriptDetail: 'Could not connect to this Flow tab.',
    url: 'https://flow.google.com/project/abc',
    flowPage: true,
    checkedAt: 1_760_000_000_000,
    checks: [{ label: 'Flow connector', ok: false, detail: 'Could not connect to this Flow tab.' }],
    promptCandidates: [],
    promptControls: [],
    issues: ['Could not connect to this Flow tab.'],
  };
  const html = R.renderSettings(snapshot, { ...ui, diagnostics });
  assert.match(html, /Flow connector/);
  assert.match(html, /Could not connect to this Flow tab\./);
  assert.match(html, /data-action="copy-diagnostics"/, 'the report can still be copied');
});

test('the panel shows the settings trigger the extension clicks', () => {
  const html = R.renderSettings(
    {
      prefs: { generationTimeoutMinutes: 10 },
      automation: { phase: 'idle' },
    },
    {
      busy: false,
      diagnostics: {
        checks: [],
        detectedSettings: { mode: 'Image', model: 'Nano Banana 2.1', aspectRatio: '16:9', outputs: 'x1' },
        modelChip: 'Nano Banana 2.1',
        settingsTrigger: {
          found: true,
          label: '🍌 Nano Banana 2.1 crop_16_9 x1',
          control: { tag: 'button', classes: 'settings-trigger-button', name: '🍌 Nano Banana 2.1 crop_16_9 x1', visible: true, enabled: true },
        },
        settingsRead: {
          attempted: true,
          ok: true,
          current: { mode: 'Image', model: 'Nano Banana 2.1', aspectRatio: '16:9', outputs: 'x1' },
          options: {},
          chipModel: 'Nano Banana 2.1',
        },
      },
    },
  );
  assert.ok(html, 'the settings section renders');
  assert.match(html, /Settings trigger/);
  assert.match(html, /settings-trigger-button/, 'the control is named');
  assert.match(html, /visible: true, enabled: true/);
});

test('the panel shows the Agent mode state when the chip is pressed', () => {
  const html = R.renderSettings(
    { prefs: {}, automation: { phase: 'idle' } },
    {
      busy: false,
      notice: null,
      confirmStart: false,
      logOpen: false,
      diagnostics: {
        checks: [],
        agentMode: { chipFound: true, chipPressed: true, composer: 'agent', classicVisible: false, agentVisible: true },
        detectedSettings: {},
        settingsRead: { attempted: false },
      },
    },
  );
  assert.match(html, /Agent mode/);
  assert.match(html, /button\.agent-mode-chip is pressed/);
  assert.match(html, /leaves Agent mode automatically/);
});
