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
    ['Completed', 'Downloading 2K', 'Failed', 'Generating', 'Paused', 'Preparing', 'Retrying', 'Skipped', 'Uploading', 'Waiting'],
  );
});

test('the connection line reads ● Connected or ○ Not Connected from the active tab state', () => {
  const on = R.renderConnection({ connection: { status: 'connected', message: 'Connected to Flow.' } });
  const off = R.renderConnection({ connection: { status: 'not_connected', message: 'Open Flow.' } });
  assert.match(on, /● Connected/);
  assert.match(off, /○ Not Connected/);
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
  assert.deepEqual(manifest.permissions.sort(), ['debugger', 'scripting', 'sidePanel', 'storage']);
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
