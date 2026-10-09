import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createFlowAdapter } from '../src/flow/adapter.js';
import {
  diffSignatures,
  findGenerateButton,
  findPromptBox,
  findSettingsMenu,
  findSettingsMenuByContent,
  findSettingsTrigger,
  inspectSettingsTrigger,
  resolveInteractiveControl,
  snapshotMenuish,
} from '../src/flow/selectors.js';
import { installFlowFixture } from './fixtures/flow-fixture.js';

/*
 * The community DOM reference for the live page:
 *
 *   flow-base-prompt-box
 *     └─ (shadow) div.submit-controls
 *          ├─ button.settings-trigger-button
 *          │    └─ <visible model label>      ← the chip is a CHILD of the button
 *          └─ flow-generate-icon-button
 *               └─ (shadow) button.generate-icon-button
 *   flow-rich-text-editor.prompt-input
 *     └─ (shadow) div.ProseMirror            ← the prompt editor
 *   <portal at body level>                     ← the settings menu, NO ARIA roles
 *
 * The previous click failure: the extension clicked the LABEL (or a role-less,
 * portal-rendered menu was invisible to role-based detection). These tests pin the
 * corrected behaviour against that exact shape.
 */

const FLOW_URL = 'https://flow.google.com/project/abc123';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5)));
const timings = { settleMs: 0, popoverMs: 300 };

function pageWith(html, url = FLOW_URL) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url, pretendToBeVisual: true });
  const { window } = dom;
  window.Element.prototype.getClientRects = function getClientRects() {
    return [{ width: 200, height: 200, top: 0, left: 0, right: 200, bottom: 200 }];
  };
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { width: 200, height: 200, top: 0, left: 0, right: 200, bottom: 200, x: 0, y: 0 };
  };
  return window;
}

function componentPage(options = {}) {
  const window = pageWith('', FLOW_URL);
  const page = installFlowFixture(window, { flowComponents: true, liveMenu: true, ...options });
  const adapter = createFlowAdapter({ doc: window.document, location: new URL(FLOW_URL), sleep, timings });
  return { window, page, adapter };
}

// ---------------------------------------------------------------------------
// The prompt editor and the generate button in the component composer
// ---------------------------------------------------------------------------

test('the ProseMirror editor inside flow-rich-text-editor is the prompt box', () => {
  const { window } = componentPage();
  const prompt = findPromptBox(window.document);
  assert.ok(prompt, 'the editor is found');
  assert.equal(prompt.el.className, 'ProseMirror');
  assert.equal(prompt.el.getAttribute('contenteditable'), 'true');
  assert.equal(prompt.enabled, true);
  assert.match(prompt.strategy, /in-shadow-root/);
});

test('the generate-icon-button inside flow-generate-icon-button is found by class', () => {
  const { window } = componentPage();
  const prompt = findPromptBox(window.document);
  const generate = findGenerateButton(window.document, prompt.el);
  assert.ok(generate, 'the icon button is found');
  assert.equal(generate.el.className, 'generate-icon-button');
  assert.match(generate.strategy, /in-prompt-region/);
});

// ---------------------------------------------------------------------------
// The trigger: the label resolves to the button that opens the menu
// ---------------------------------------------------------------------------

test('the settings button is the trigger, with the chip text as its label', () => {
  const { window } = componentPage();
  const prompt = findPromptBox(window.document);
  const trigger = findSettingsTrigger(window.document, prompt.el);
  assert.ok(trigger, 'the trigger is found');
  assert.equal(trigger.el.tagName, 'BUTTON', 'the CONTROL is returned, not the label');
  assert.equal(trigger.el.className, 'settings-trigger-button');
  assert.match(trigger.label, /Nano Banana 2\.1/, 'the label (the chip text) is kept for messages');
});

test('a model label inside the button resolves to the button (light DOM and shadow)', () => {
  // The community reference: the visible model label is a CHILD of the clickable
  // button. Clicking the label only works because it bubbles; the extension clicks
  // the control itself.
  const window = pageWith(`
    <div id="prompt-box">
      <button class="settings-trigger-button"><span class="model-chip">Nano Banana 2.1 crop_16_9 x1</span></button>
      <textarea id="prompt" placeholder="What do you want to create?"></textarea>
      <button aria-label="Generate">Generate</button>
    </div>`);
  const label = window.document.querySelector('.model-chip');
  const resolved = resolveInteractiveControl(label);
  assert.ok(resolved, 'the label resolves to a control');
  assert.equal(resolved.el.tagName, 'BUTTON');
  assert.equal(resolved.el.className, 'settings-trigger-button');
  assert.equal(resolved.via, 'ancestor-1');

  // The same shape inside a custom element's shadow root.
  const window2 = pageWith('<div id="prompt-box"><flow-chip></flow-chip><textarea id="prompt" placeholder="What do you want to create?"></textarea><button aria-label="Generate">Generate</button></div>');
  const host = window2.document.querySelector('flow-chip');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<button class="settings-trigger-button"><span class="model-chip">Nano Banana 2.1</span></button>';
  const shadowLabel = shadow.querySelector('.model-chip');
  const resolved2 = resolveInteractiveControl(shadowLabel);
  assert.equal(resolved2.el.tagName, 'BUTTON');
  assert.equal(resolved2.via, 'ancestor-1');
});

test('resolveInteractiveControl walks out of a shadow root to the host button', () => {
  const window = pageWith('<flow-chip></flow-chip>');
  const doc = window.document;
  const host = doc.querySelector('flow-chip');
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = '<button class="settings-trigger-button"><span>Nano Banana 2.1</span></button>';
  const label = shadow.querySelector('span');
  const resolved = resolveInteractiveControl(label);
  assert.equal(resolved.el.tagName, 'BUTTON');
  assert.equal(resolved.via, 'ancestor-1');
});

test('inspectSettingsTrigger reports the expected button, the control and the chip link', () => {
  const { window } = componentPage();
  const prompt = findPromptBox(window.document);
  const report = inspectSettingsTrigger(window.document, prompt.el);
  assert.equal(report.found, true);
  assert.equal(report.expectedButton.exists, true, 'the community reference button exists');
  assert.equal(report.expectedButton.tag, 'button');
  assert.equal(report.expectedButton.classes, 'settings-trigger-button');
  assert.equal(report.control.tag, 'button');
  assert.equal(report.control.visible, true);
  assert.equal(report.control.enabled, true);
  assert.equal(report.control.connected, true);
  assert.equal(report.control.inComposer, true);
  assert.equal(report.associatedWithChip, true, 'the control contains the visible model label');
  assert.deepEqual(report.customAncestors, ['flow-base-prompt-box']);
});

// ---------------------------------------------------------------------------
// The menu: role-less, in a portal, found by content
// ---------------------------------------------------------------------------

test('a role-less menu in a body-level portal is found by its content', async () => {
  const { window, adapter } = componentPage();
  const prompt = findPromptBox(window.document);
  const trigger = findSettingsTrigger(window.document, prompt.el);
  // Click the resolved control, exactly as the settings code does.
  trigger.el.click();
  await sleep(10);
  const menu = findSettingsMenu(window.document, { exclude: prompt.el, chipModel: 'Nano Banana 2.1' });
  assert.ok(menu, 'the portal menu is detected without any ARIA role');
  assert.equal(menu.className, 'flow-settings-menu');
  const byContent = findSettingsMenuByContent(window.document, { exclude: prompt.el, chipModel: 'Nano Banana 2.1' });
  assert.equal(byContent, menu, 'content-based detection finds the same surface');
  assert.equal(adapter, adapter); // keep the adapter referenced for the read test below
});

test('readSettings reads the component composer end to end (label click, portal menu)', async () => {
  const { adapter } = componentPage();
  const result = await adapter.readSettings();
  assert.deepEqual(result.current, { mode: 'Image', model: 'Nano Banana 2.1', aspectRatio: '16:9', outputs: 'x1' });
  assert.deepEqual(result.options.outputs, ['x1', 'x2', 'x3', 'x4']);
  assert.deepEqual(result.options.model, ['Nano Banana 2.1', 'Nano Banana Pro', 'Veo 3.1', 'Veo 3']);
  assert.equal(result.click.control, 'button.settings-trigger-button', 'the click landed on the control');
  assert.equal(result.click.clicked, true);
  assert.ok(result.click.domAdded.length > 0, 'the DOM diff shows what the click rendered');
  assert.ok(result.click.domAdded.some((entry) => entry.startsWith('row:')), 'the diff names the menu rows');
  assert.ok(result.trace.some((line) => line.step === 'trigger-found'));
  assert.ok(result.trace.some((line) => line.step === 'menu-opened'));
});

test('applySettings works through the component shape and verifies via the chip', async () => {
  const { adapter, page } = componentPage();
  const result = await adapter.applySettings({ mode: 'Video', aspectRatio: '9:16', outputs: 'x2', model: 'Veo 3.1' });
  assert.deepEqual(result.current, { mode: 'Video', model: 'Veo 3.1', aspectRatio: '9:16', outputs: 'x2' });
  assert.equal(page.state.model, 'Veo 3.1');
  assert.equal(page.state.outputCount, 'x2');
  assert.match(page.settingsBtn.querySelector('.model-chip').textContent, /Veo 3\.1 crop_9_16 x2/);
});

test('a stale trigger element is retried once with a fresh element', async () => {
  // React-style event delegation: the menu opens from a listener on the DOCUMENT, so
  // a click on a DETACHED button never reaches it — exactly how a Flow rerender
  // (which replaces the composer's button) makes a found element stale.
  const window = pageWith(`
    <main>
      <div id="prompt-box">
        <button class="settings-trigger-button" aria-haspopup="menu"><span class="model-chip">\uD83C\uDF4C Nano Banana 2.1 crop_16_9 x1</span></button>
        <textarea id="prompt" placeholder="What do you want to create?"></textarea>
        <button aria-label="Generate">Generate</button>
      </div>
      <div id="overlay-root"></div>
    </main>`);
  const doc = window.document;
  const menuHtml = `
    <div class="flow-settings-menu">
      <div data-key="mode" aria-checked="true">Image</div>
      <div data-key="mode" aria-checked="false">Video</div>
      <div data-key="aspectRatio" aria-checked="true">16:9</div>
      <div data-key="aspectRatio" aria-checked="false">4:3</div>
      <div data-key="aspectRatio" aria-checked="false">1:1</div>
      <div data-key="aspectRatio" aria-checked="false">3:4</div>
      <div data-key="aspectRatio" aria-checked="false">9:16</div>
      <div role="menuitem" aria-haspopup="menu">Select model family</div>
      <div data-key="outputCount" aria-checked="true">x1</div>
      <div data-key="outputCount" aria-checked="false">x2</div>
      <div data-key="outputCount" aria-checked="false">x3</div>
      <div data-key="outputCount" aria-checked="false">x4</div>
    </div>`;
  doc.addEventListener('click', (event) => {
    if (event.target.closest?.('.settings-trigger-button')) {
      doc.getElementById('overlay-root').innerHTML = menuHtml;
    }
  });
  const original = doc.querySelector('.settings-trigger-button');
  // Flow replaces the button mid-click (a rerender): the extension's click lands on
  // the detached original, whose delegated handler never fires.
  original.addEventListener('mousedown', () => {
    original.replaceWith(original.cloneNode(true));
  });
  const adapter = createFlowAdapter({ doc, location: window.location, sleep, timings });
  const result = await adapter.readSettings();
  assert.equal(result.current.mode, 'Image', 'the retry with the fresh element opened the menu');
  assert.equal(result.click.retried, true, 'the retry is reported');
  assert.equal(result.click.clicked, true);
});

// ---------------------------------------------------------------------------
// Skip when the chip already shows the required settings
// ---------------------------------------------------------------------------

test('applySettings skips the menu entirely when the chip already matches', async () => {
  const { adapter, window } = componentPage();
  const result = await adapter.applySettings({ model: 'Nano Banana 2.1', aspectRatio: '16:9', outputs: 'x1' });
  assert.equal(result.skipped, true);
  assert.equal(result.current.model, 'Nano Banana 2.1');
  assert.equal(result.current.aspectRatio, '16:9');
  assert.equal(result.current.outputs, 'x1');
  assert.equal(window.document.querySelector('.flow-settings-menu'), null, 'no menu was opened');
  assert.ok(result.trace.some((line) => line.step === 'skipped-all'));
});

test('applySettings skips only the chip-verified keys and still checks mode in the menu', async () => {
  const { adapter, page } = componentPage();
  const result = await adapter.applySettings({ mode: 'Image', model: 'Nano Banana 2.1', aspectRatio: '16:9', outputs: 'x1' });
  assert.equal(result.current.mode, 'Image');
  assert.ok(result.trace.some((line) => line.step === 'already-correct' && line.detail.includes('Model')));
  assert.ok(result.trace.some((line) => line.step === 'already-selected' && line.detail.includes('Mode')), 'mode was checked, not re-clicked');
  assert.equal(page.state.mode, 'Image');
});

// ---------------------------------------------------------------------------
// The DOM diff evidence
// ---------------------------------------------------------------------------

test('snapshotMenuish and diffSignatures capture what a click renders', async () => {
  const { window } = componentPage();
  const prompt = findPromptBox(window.document);
  const before = snapshotMenuish(window.document, { chipModel: 'Nano Banana 2.1' });
  const trigger = findSettingsTrigger(window.document, prompt.el);
  trigger.el.click();
  await sleep(10);
  const after = snapshotMenuish(window.document, { chipModel: 'Nano Banana 2.1' });
  const diff = diffSignatures(before, after);
  assert.ok(diff.added.some((entry) => entry === 'row:Image'), 'the menu rows appear as added');
  assert.ok(diff.added.some((entry) => entry === 'row:x1'));
  assert.ok(diff.added.some((entry) => entry.startsWith('flow:')), 'the role-less menu surface appears as added');
  assert.equal(diff.removed.length, 0);
});

// ---------------------------------------------------------------------------
// The diagnostic reports the trigger and the prompt editor
// ---------------------------------------------------------------------------

test('probe reports the trigger inspection and the component composer area', async () => {
  const { adapter } = componentPage();
  const probe = await adapter.probe();
  assert.equal(probe.promptFound, true);
  assert.equal(probe.settingsFound, true);
  assert.equal(probe.settingsTrigger.found, true);
  assert.equal(probe.settingsTrigger.control.tag, 'button');
  assert.equal(probe.settingsTrigger.expectedButton.exists, true);
  const field = probe.composerArea.regionFields.find((item) => item.classes.includes('ProseMirror'));
  assert.ok(field, 'the ProseMirror editor is listed with its class');
  assert.deepEqual(field.customAncestors, ['flow-rich-text-editor', 'flow-base-prompt-box']);
  assert.equal(field.name, 'What do you want to create?');
  const generate = probe.composerArea.generateCandidates.find((item) => item.classes.includes('generate-icon-button'));
  assert.ok(generate, 'the generate icon button is listed');
  assert.equal(generate.labelled, true);
});

test('diagnose carries the trigger inspection, the click evidence and the trace', async () => {
  const { adapter } = componentPage();
  const report = await adapter.diagnose();
  assert.equal(report.settingsRead.ok, true);
  assert.equal(report.settingsRead.click.control, 'button.settings-trigger-button');
  assert.ok(report.settingsRead.click.domAdded.length > 0);
  assert.ok(report.settingsRead.trace.some((line) => line.step === 'menu-opened'));
  assert.equal(report.settingsTrigger.found, true);
  const settingsCheck = report.checks.find((item) => item.label === 'Settings control');
  assert.equal(settingsCheck.ok, true);
});
