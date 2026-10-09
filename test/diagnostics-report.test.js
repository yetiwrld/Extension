import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDiagnosticsReport } from '../src/sidepanel/diagnostics.js';

/*
 * The "Copy report" button puts formatDiagnosticsReport's output on the clipboard. The
 * report must be complete enough to diagnose a live-page mismatch (which fields and
 * controls exist, which selectors ran, what was detected, why a composer was or was
 * not selected) and must never carry private page content.
 */

const REPORT = {
  checkedAt: 1_760_000_000_000,
  url: 'https://flow.google.com/project/abc',
  flowPage: true,
  contentScript: 'responding',
  adapterVersion: '1.0.0',
  frames: { inspected: 2, unreachable: 1 },
  isProjectPage: true,
  workspaceDetected: false,
  promptFound: false,
  promptStrategy: null,
  promptEnabled: false,
  promptAmbiguous: false,
  promptReasons: [],
  composerLayout: null,
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
  selectorResults: [
    { selector: 'textarea', scope: 'top', matched: 1, visible: 1 },
    { selector: 'role=textbox', scope: 'top', matched: 0, visible: 0 },
    { selector: 'inside shadow roots', scope: 'top', matched: 0, visible: 0 },
  ],
  promptCandidates: [
    {
      tag: 'textarea',
      kind: 'textarea',
      role: '',
      name: 'Describe your image or video',
      placeholder: 'Describe your image or video',
      type: '',
      contenteditable: '',
      disabled: false,
      readonly: false,
      visible: true,
      frame: 'top',
      inShadowRoot: false,
      rect: { x: 24, y: 812, width: 640, height: 72 },
      rejection: 'inside a dialog',
      error: null,
    },
    {
      tag: 'input',
      kind: 'input',
      role: 'searchbox',
      name: 'Search Flow',
      placeholder: '',
      type: 'search',
      contenteditable: '',
      disabled: false,
      readonly: false,
      visible: true,
      frame: 'top',
      inShadowRoot: false,
      rect: { x: 24, y: 12, width: 240, height: 32 },
      rejection: 'search field',
      error: null,
    },
  ],
  checks: [
    { label: 'Flow connector', ok: true, detail: 'The connector answers in this tab (adapter 1.0.0).' },
    { label: 'Flow page', ok: true, detail: 'This is a supported Flow page.' },
    { label: 'Prompt box', ok: false, detail: 'Not found. 2 text field(s) on the page (0 usable).' },
    { label: 'Settings control', ok: false, detail: 'Not found. Controls near the prompt: button "Generate"; button[switch] "Agent".' },
  ],
  promptControls: [
    { tag: 'button', role: '', name: 'Generate', title: '', popup: '', disabled: true, purpose: 'generate' },
    { tag: 'button', role: 'switch', name: 'Agent', title: '', popup: '', disabled: false, purpose: 'agent' },
  ],
  issues: ['settings control: not found'],
  exceptions: [{ label: 'prompt candidates', message: 'one element threw', stack: 'Error: one element threw | at read (x.js:1) | at probe (y.js:2)' }],
};

test('the report names the page state, the checks and the controls', () => {
  const text = formatDiagnosticsReport(REPORT);
  assert.match(text, /Flow Scene Queue — Flow page check/);
  assert.match(text, /URL: https:\/\/flow\.google\.com\/project\/abc/);
  assert.match(text, /Flow page: yes/);
  assert.match(text, /Flow connector: responding/);
  assert.match(text, /Frames inspected: 2 \(1 more frame\(s\) unreachable from this one\)/);
  assert.match(text, /Prompt box: NOT FOUND/);
  assert.match(text, /Generate button: found \(generate-in-prompt-region\), disabled/);
  assert.match(text, /Settings control: NOT FOUND/);
  assert.match(text, /Agent control: found, off/);
  assert.match(text, /Detected in Flow: model=Nano Banana Pro/);
  assert.match(text, /FAIL {2}Settings control — Not found\. Controls near the prompt:/);
  assert.match(text, /FAIL {2}Prompt box — Not found\. 2 text field\(s\) on the page/);
  assert.match(text, /Controls near the prompt:/);
  assert.match(text, /purpose=generate "Generate"/);
  assert.match(text, /role=switch purpose=agent "Agent"/);
  assert.match(text, /Issues:/);
  assert.match(text, /settings control: not found/);
});

test('the report lists the composer selectors that ran, with match counts', () => {
  const text = formatDiagnosticsReport(REPORT);
  assert.match(text, /Composer selectors \(matched\/visible\):/);
  assert.match(text, / - textarea \[top\]: 1 matched, 1 visible/);
  assert.match(text, / - role=textbox \[top\]: 0 matched, 0 visible/, 'a failed selector is reported as failed');
  assert.match(text, / - inside shadow roots \[top\]: 0 matched, 0 visible/);
});

test('the report lists every prompt field candidate with its verdict and geometry', () => {
  const text = formatDiagnosticsReport(REPORT);
  assert.match(text, /Prompt field candidates \(2\):/);
  assert.match(text, / - textarea visible enabled "Describe your image or video" 640x72 at \(24, 812\) — REJECTED: inside a dialog/);
  assert.match(text, / - input role=searchbox type=search visible enabled "Search Flow" 240x32 at \(24, 12\) — REJECTED: search field/);
});

test('the report carries exceptions with trimmed stack traces', () => {
  const text = formatDiagnosticsReport(REPORT);
  assert.match(text, /Exceptions \(stack traces trimmed\):/);
  assert.match(text, / - prompt candidates: one element threw/);
  assert.match(text, /at read \(x\.js:1\)/);
});

test('the report names the model chip and the settings-read attempt, success or failure', () => {
  const ok = formatDiagnosticsReport({
    ...REPORT,
    modelChip: 'Nano Banana 2.1',
    settingsRead: {
      attempted: true,
      ok: true,
      current: { mode: 'Image', model: 'Nano Banana 2.1', aspectRatio: '16:9' },
      options: { mode: ['Image', 'Video'], model: ['Nano Banana 2.1', 'Veo 3.1'], aspectRatio: ['16:9', '9:16'] },
      strategy: 'settings-trigger-model-name; popover-options=7',
      chipModel: 'Nano Banana 2.1',
      modelMatchesChip: true,
    },
  });
  assert.match(ok, /Model chip in the composer: "Nano Banana 2\.1"/);
  assert.match(ok, /Settings read attempt:/);
  assert.match(ok, / - ok \(settings-trigger-model-name; popover-options=7\): mode=Image, model=Nano Banana 2\.1, aspectRatio=16:9/);
  assert.match(ok, / - model options: Nano Banana 2\.1, Veo 3\.1/);
  assert.match(ok, / - composer chip shows "Nano Banana 2\.1"/);

  const failed = formatDiagnosticsReport({
    ...REPORT,
    modelChip: 'Nano Banana 2.1',
    settingsRead: {
      attempted: true,
      ok: false,
      error: 'The Flow settings menu did not open after clicking "Nano Banana 2.1 \u25be".',
      code: 'FLOW_UI_CHANGED',
    },
  });
  assert.match(failed, / - FAILED \(FLOW_UI_CHANGED\): The Flow settings menu did not open after clicking/);

  const mismatch = formatDiagnosticsReport({
    ...REPORT,
    settingsRead: {
      attempted: true,
      ok: true,
      current: { mode: 'Image', model: 'dashboardGrid', aspectRatio: null },
      options: { mode: [], model: [], aspectRatio: [] },
      chipModel: 'Nano Banana 2.1',
      modelMatchesChip: false,
    },
  });
  assert.match(mismatch, /composer chip shows "Nano Banana 2\.1" — DIFFERS from the menu/);
});

test('the report never contains prompt text, page text or account data', () => {
  // The composer's placeholder is a control label (safe); the user's TYPED prompt is
  // never part of the report data, and the formatter must not echo it.
  const text = formatDiagnosticsReport({
    ...REPORT,
    settingsRead: {
      attempted: true,
      ok: true,
      current: { mode: 'Image', model: 'Nano Banana 2.1', aspectRatio: '16:9' },
      options: { mode: ['Image', 'Video'], model: ['Nano Banana 2.1'], aspectRatio: ['16:9'] },
      chipModel: 'Nano Banana 2.1',
      modelMatchesChip: true,
    },
    promptControls: [
      { tag: 'textarea', role: 'textbox', name: 'What do you want to create?', title: '', popup: '', disabled: false, purpose: 'prompt' },
    ],
  });
  assert.doesNotMatch(text, /my secret prompt about a cat/, 'a typed prompt value is never echoed');
  assert.doesNotMatch(text, /user@gmail\.com/, 'no account data');
  assert.doesNotMatch(text, /cookie|token|authorization/i, 'no credentials');
  assert.match(text, /purpose=prompt "What do you want to create\?"/, 'the placeholder label is the control summary');
});

test('the report says why the composer was selected when one was', () => {
  const text = formatDiagnosticsReport({
    ...REPORT,
    promptFound: true,
    promptStrategy: 'composer-textarea-by-region',
    promptEnabled: true,
    workspaceDetected: true,
    composerLayout: 'standard',
    promptReasons: ['prompt-like label', 'Generate/Send control in its region', 'size 640x72px'],
  });
  assert.match(text, /Prompt box: found \(composer-textarea-by-region\)/);
  assert.match(text, /Prompt layout: standard/);
  assert.match(text, /Selected because: prompt-like label; Generate\/Send control in its region; size 640x72px/);
  assert.match(text, /Workspace composer: detected/);
});

test('the report flags ambiguity instead of hiding it', () => {
  const text = formatDiagnosticsReport({
    ...REPORT,
    promptFound: true,
    promptStrategy: 'composer-input-by-region',
    promptEnabled: true,
    promptAmbiguous: true,
    settingsFound: true,
    settingsStrategy: 'settings-trigger-aria-haspopup',
    settingsAmbiguous: true,
  });
  assert.match(text, /Prompt box: found \(composer-input-by-region\), several fields match equally/);
  assert.match(text, /Settings control: found \(settings-trigger-aria-haspopup\) \(several controls match; the first was used\)/);
});

test('a connector that does not answer is reported as such, with the reason', () => {
  const text = formatDiagnosticsReport({
    ok: false,
    contentScript: 'not responding',
    contentScriptDetail: 'Could not connect to this Flow tab. Reload the Flow tab (press F5) and try again.',
    url: 'https://flow.google.com/project/abc',
    flowPage: true,
    checkedAt: 1_760_000_000_000,
    checks: [{ label: 'Flow connector', ok: false, detail: 'Could not connect to this Flow tab.' }],
    promptCandidates: [],
    promptControls: [],
    issues: ['Could not connect to this Flow tab.'],
  });
  assert.match(text, /Flow connector: NOT RESPONDING — Could not connect to this Flow tab/);
  assert.match(text, /FAIL {2}Flow connector — Could not connect/);
  assert.match(text, /Prompt field candidates \(0\):/);
  assert.match(text, / - none: the page offers no text-entry element/);
});

test('the report never contains prompt text, page text or account details', () => {
  const hostile = {
    ...REPORT,
    promptCandidates: [
      {
        tag: 'textarea',
        kind: 'textarea',
        role: '',
        name: 'Describe your image or video',
        placeholder: '',
        type: '',
        contenteditable: '',
        disabled: false,
        readonly: false,
        visible: true,
        frame: 'top',
        inShadowRoot: false,
        rect: { x: 0, y: 0, width: 100, height: 40 },
        rejection: null,
        error: null,
        // Hostile fields a buggy formatter might copy into the report:
        value: 'SECRET USER PROMPT TEXT',
        text: 'SECRET USER PROMPT TEXT',
        textContent: 'SECRET USER PROMPT TEXT',
        innerText: 'SECRET USER PROMPT TEXT',
        pageText: 'SECRET PAGE TEXT',
        accountEmail: 'user@example.com',
        cookies: 'SECRET COOKIE',
      },
    ],
    promptControls: [{ tag: 'button', role: '', name: 'Generate', title: '', popup: '', disabled: false, purpose: 'generate', textContent: 'SECRET CONTROL TEXT' }],
  };
  const text = formatDiagnosticsReport(hostile);
  assert.equal(text.includes('SECRET'), false, `no private content in the report:\n${text}`);
  assert.equal(text.includes('user@example.com'), false);
});

test('the report degrades gracefully with no data', () => {
  assert.equal(formatDiagnosticsReport(null), 'No Flow page check has run yet. Press "Check Flow page" first.');
  const text = formatDiagnosticsReport({ checkedAt: 1_760_000_000_000 });
  assert.match(text, /URL: unknown/);
  assert.match(text, /Flow connector: unknown/);
  assert.match(text, /Prompt box: NOT FOUND/);
  assert.match(text, /Prompt field candidates \(0\):/);
  assert.match(text, /Checks:/);
});

test('the report maps the composer area: chip, chain, region fields, controls, generate candidates', () => {
  const text = formatDiagnosticsReport({
    ...REPORT,
    composerArea: {
      chip: { tag: 'div', role: '', name: '🍌 Nano Banana 2.1 crop_16_9 x1', rect: { x: 24, y: 812, width: 180, height: 32 } },
      chipChain: [
        { tag: 'div', role: '', label: '', childTags: 'div,button' },
        { tag: 'main', role: '', label: '', childTags: 'header,section,div' },
      ],
      regionFields: [
        { tag: 'div', role: 'textbox', kind: 'contenteditable', name: 'What do you want to create?', readonly: false, disabled: false, visible: true, rect: { x: 24, y: 760, width: 640, height: 48 } },
      ],
      regionControls: [{ tag: 'div', role: '', name: '🍌 Nano Banana 2.1 crop_16_9 x1', title: '', popup: '', disabled: false, purpose: 'model' }],
      generateCandidates: [
        { tag: 'button', name: 'Generate', title: '', labelled: true },
        { tag: 'button', name: 'New project', title: '', labelled: false },
      ],
      shadowHosts: [{ tag: 'flow-shell' }],
    },
  });
  assert.match(text, /Composer area \(read-only DOM map\):/);
  assert.match(text, / - model chip: <div> "🍌 Nano Banana 2\.1 crop_16_9 x1"/);
  assert.match(text, / - chip ancestor chain \(2\):/);
  assert.match(text, /<main> children: header,section,div/);
  assert.match(text, / - text fields in the chip's region \(1\):/);
  assert.match(text, /<div> contenteditable role=textbox "What do you want to create\?" visible 640x48 at \(24, 760\)/);
  assert.match(text, / - controls in the chip's region \(1\):/);
  assert.match(text, / — model\n/, 'the chip is listed with its purpose');
  assert.match(text, / - generate-button candidates: "Generate"/);
  assert.match(text, / - custom elements with shadow roots: flow-shell/);
  assert.doesNotMatch(text, /my secret prompt/, 'the composer\u2019s own text never crosses into the report');
});

test('the report shows output counts in the detected line, the read attempt and the chip settings', () => {
  const text = formatDiagnosticsReport({
    ...REPORT,
    detectedSettings: { mode: 'Image', model: 'Nano Banana 2.1', aspectRatio: '16:9', outputs: 'x1' },
    modelChip: 'Nano Banana 2.1',
    settingsRead: {
      attempted: true,
      ok: true,
      current: { mode: 'Image', model: 'Nano Banana 2.1', aspectRatio: '16:9', outputs: 'x1' },
      options: { mode: ['Image', 'Video'], model: ['Nano Banana 2.1', 'Veo 3.1'], aspectRatio: ['16:9', '9:16'], outputs: ['x1', 'x2', 'x3', 'x4'] },
      strategy: 'settings-trigger-model-name; popover-options=12; model-menu-options=4',
      chipModel: 'Nano Banana 2.1',
      chipAspectRatio: '16:9',
      chipOutputs: 'x1',
      modelMatchesChip: true,
      aspectMatchesChip: true,
      outputsMatchesChip: true,
      hasModelSubmenu: true,
    },
  });
  assert.match(text, /Detected in Flow: mode=Image, model=Nano Banana 2\.1, aspectRatio=16:9, outputs=x1/);
  assert.match(text, /Chip settings: 16:9 \u00b7 x1/);
  assert.match(text, / - ok \(settings-trigger-model-name; popover-options=12; model-menu-options=4\): mode=Image, model=Nano Banana 2\.1, aspectRatio=16:9, outputs=x1/);
  assert.match(text, / - outputs options: x1, x2, x3, x4/);
  assert.match(text, / - chip shows: 16:9 \u00b7 x1/);
  assert.match(text, / - the model list is nested behind "Select model family" \(it was opened and read\)/);
});

test('the report carries the settings-trigger inspection, the click evidence and the trace', () => {
  const text = formatDiagnosticsReport({
    ...REPORT,
    settingsTrigger: {
      found: true,
      strategy: 'settings-trigger-aria-haspopup',
      ambiguous: false,
      label: '🍌 Nano Banana 2.1 crop_16_9 x1',
      control: {
        tag: 'button',
        classes: 'settings-trigger-button',
        role: '',
        name: '🍌 Nano Banana 2.1 crop_16_9 x1',
        rect: { x: 24, y: 812, width: 180, height: 32 },
        visible: true,
        enabled: true,
        connected: true,
        inComposer: true,
        via: 'ancestor-1',
      },
      foundElement: { tag: 'span', classes: 'model-chip', interactive: false },
      expectedButton: { exists: true, tag: 'button', classes: 'settings-trigger-button', role: '', name: '🍌 Nano Banana 2.1 crop_16_9 x1', rect: null, visible: true, enabled: true },
      associatedWithChip: true,
      coveredBy: null,
      customAncestors: ['flow-base-prompt-box'],
    },
    settingsRead: {
      attempted: true,
      ok: false,
      error: 'The Flow settings menu did not open after clicking "🍌 Nano Banana 2.1 crop_16_9 x1". The click changed nothing visible in the DOM.',
      code: 'FLOW_UI_CHANGED',
      click: {
        control: 'button.settings-trigger-button',
        label: '🍌 Nano Banana 2.1 crop_16_9 x1',
        clicked: true,
        retried: true,
        domAdded: ['flow:div.flow-settings-menu', 'row:Image', 'row:16:9'],
        domRemoved: [],
      },
      trace: [
        { step: 'trigger-found', detail: 'settings-trigger-aria-haspopup: "🍌 Nano Banana 2.1 crop_16_9 x1"' },
        { step: 'menu-opened', detail: 'popover detected after clicking button.settings-trigger-button' },
      ],
    },
  });
  assert.match(text, /Settings trigger \(read-only inspection\):/);
  assert.match(text, / - found \(settings-trigger-aria-haspopup\): label "🍌 Nano Banana 2\.1 crop_16_9 x1"/);
  assert.match(text, / - control: <button class="settings-trigger-button"> "🍌 Nano Banana 2\.1 crop_16_9 x1" 180x32 at \(24, 812\) — visible: true, enabled: true, connected: true, in composer: true, resolved via ancestor-1/);
  assert.match(text, / - the found element <span> is a LABEL, not a control \(resolved to the control above\)/);
  assert.match(text, / - expected button \(candidate\): <button class="settings-trigger-button"> "🍌 Nano Banana 2\.1 crop_16_9 x1" visible: true/);
  assert.match(text, / - associated with the model chip: true/);
  assert.match(text, / - covered by another element: no/);
  assert.match(text, / - custom-element ancestors: flow-base-prompt-box/);
  assert.match(text, /Settings-menu click evidence:/);
  assert.match(text, / - clicked: button\.settings-trigger-button "🍌 Nano Banana 2\.1 crop_16_9 x1" \(retried once with a fresh element\)/);
  assert.match(text, / - DOM added after the click: flow:div\.flow-settings-menu; row:Image; row:16:9/);
  assert.match(text, / - DOM removed after the click: nothing/);
  assert.match(text, /Settings read trace:/);
  assert.match(text, / - trigger-found: settings-trigger-aria-haspopup/);
  assert.match(text, / - menu-opened: popover detected after clicking button\.settings-trigger-button/);
});
