import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDiagnosticsReport } from '../src/sidepanel/diagnostics.js';

/*
 * The "Copy report" button puts formatDiagnosticsReport's output on the clipboard. The
 * report must be complete enough to diagnose a live-page mismatch (which controls exist,
 * which checks failed, what was detected) and must never carry private page content.
 */

const REPORT = {
  checkedAt: 1_760_000_000_000,
  url: 'https://flow.google.com/project/abc',
  adapterVersion: '1.0.0',
  isProjectPage: true,
  promptFound: true,
  promptStrategy: 'visible-textarea',
  generateFound: true,
  generateStrategy: 'generate-in-prompt-region',
  generateEnabled: false,
  settingsFound: false,
  settingsStrategy: null,
  settingsAmbiguous: false,
  agentFound: true,
  agentOn: false,
  referencesAttached: 2,
  outputsVisible: 1,
  detectedSettings: { mode: null, model: 'Nano Banana Pro', aspectRatio: null },
  checks: [
    { label: 'Flow page', ok: true, detail: 'https://flow.google.com/project/abc' },
    { label: 'Settings control', ok: false, detail: 'Not found. Controls near the prompt: button "Generate"; button[switch] "Agent".' },
  ],
  promptControls: [
    { tag: 'button', role: '', name: 'Generate', title: '', popup: '', disabled: true, purpose: 'generate' },
    { tag: 'button', role: 'switch', name: 'Agent', title: '', popup: '', disabled: false, purpose: 'agent' },
  ],
  issues: ['settings control: not found'],
};

test('the report names the page state, the checks and the controls', () => {
  const text = formatDiagnosticsReport(REPORT);
  assert.match(text, /Flow Scene Queue — Flow page check/);
  assert.match(text, /URL: https:\/\/flow\.google\.com\/project\/abc/);
  assert.match(text, /Prompt box: found \(visible-textarea\)/);
  assert.match(text, /Generate button: found \(generate-in-prompt-region\), disabled/);
  assert.match(text, /Settings control: NOT FOUND/);
  assert.match(text, /Agent control: found, off/);
  assert.match(text, /Detected in Flow: model=Nano Banana Pro/);
  assert.match(text, /FAIL {2}Settings control — Not found\. Controls near the prompt:/);
  assert.match(text, /Controls near the prompt:/);
  assert.match(text, /purpose=generate "Generate"/);
  assert.match(text, /role=switch purpose=agent "Agent"/);
  assert.match(text, /Issues:/);
  assert.match(text, /settings control: not found/);
});

test('the report flags ambiguity instead of hiding it', () => {
  const text = formatDiagnosticsReport({ ...REPORT, settingsFound: true, settingsStrategy: 'settings-trigger-aria-haspopup', settingsAmbiguous: true });
  assert.match(text, /Settings control: found \(settings-trigger-aria-haspopup\) \(several controls match; the first was used\)/);
});

test('the report never contains private page content', () => {
  // Unknown fields are ignored: the formatter reads the known probe fields only.
  const hostile = {
    ...REPORT,
    prompt: 'PRIVATE SCENE TEXT [Scene 1]',
    pageText: 'PRIVATE PAGE CONTENT',
    accountEmail: 'private@example.com',
  };
  const text = formatDiagnosticsReport(hostile);
  assert.doesNotMatch(text, /PRIVATE SCENE TEXT/);
  assert.doesNotMatch(text, /PRIVATE PAGE CONTENT/);
  assert.doesNotMatch(text, /private@example\.com/);
});

test('the report degrades gracefully with no data', () => {
  assert.match(formatDiagnosticsReport(null), /No Flow page check has run yet/);
  const text = formatDiagnosticsReport({ url: 'https://flow.google.com/project/abc' });
  assert.match(text, /Prompt box: NOT FOUND/);
  assert.match(text, /Detected in Flow: not identifiable/);
});
