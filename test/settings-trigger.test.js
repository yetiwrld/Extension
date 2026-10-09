import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  classifyControl,
  findDetectedSettings,
  findPromptBox,
  findSettingsTrigger,
  findSettingsTriggerWhenReady,
  listPromptControls,
} from '../src/flow/selectors.js';
import { createFlowAdapter } from '../src/flow/adapter.js';

/*
 * The settings trigger is the control that opens Flow's settings menu (Mode, Model,
 * Aspect ratio). Google's own help says to "click the model name" in the prompt box.
 * These tests pin how the trigger is chosen when the live page does not match the
 * synthetic fixture exactly: controls outside the detected prompt region, non-button
 * triggers, custom-element hosts, aspect-ratio chips that open a smaller menu,
 * ambiguity, and controls that must never be selected (Generate, Add, Remove). They
 * also pin the diagnostics that name the controls near the prompt and the settings the
 * controls themselves show.
 */

const FLOW_URL = 'https://flow.google.com/project/abc';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pageWith(html, url = FLOW_URL) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url, pretendToBeVisual: true });
  const { window } = dom;
  // jsdom has no layout: give every element a size so the visibility checks apply, as on a real page.
  window.Element.prototype.getClientRects = function getClientRects() {
    return [{ width: 200, height: 200, top: 0, left: 0, right: 200, bottom: 200 }];
  };
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { width: 200, height: 200, top: 0, left: 0, right: 200, bottom: 200, x: 0, y: 0 };
  };
  return window;
}

const promptOf = (window) => window.document.querySelector('#prompt');

test('the model-name control in the prompt region is the settings trigger', () => {
  const window = pageWith(`
    <div id="prompt-box">
      <div class="row">
        <button aria-haspopup="menu">Nano Banana Pro \u25be</button>
        <button aria-label="Add">+ Add</button>
      </div>
      <textarea id="prompt" placeholder="Describe your image or video"></textarea>
      <button aria-label="Generate">Generate</button>
    </div>`);
  const trigger = findSettingsTrigger(window.document, promptOf(window));
  assert.ok(trigger, 'a trigger is found');
  assert.equal(trigger.el.textContent.trim(), 'Nano Banana Pro \u25be');
  assert.equal(trigger.strategy, 'settings-trigger-aria-haspopup');
  assert.equal(trigger.ambiguous, false);
});

test('the model-name control outranks an aspect-ratio chip that opens a smaller menu', () => {
  const window = pageWith(`
    <div id="prompt-box">
      <button id="chip" aria-haspopup="menu">16:9</button>
      <button id="model">Nano Banana Pro</button>
      <textarea id="prompt" placeholder="Describe your image or video"></textarea>
      <button aria-label="Generate">Generate</button>
    </div>`);
  const trigger = findSettingsTrigger(window.document, promptOf(window));
  assert.equal(trigger.el.id, 'model', 'the control that opens the full menu wins over the ratio chip');
});

test('a trigger outside the detected prompt region is found in the document', () => {
  // No ancestor of the prompt box holds two buttons, so the region is the prompt's parent only.
  const window = pageWith(`
    <header><button id="model">Veo 3.1</button></header>
    <div id="prompt-box"><textarea id="prompt" placeholder="Describe your video"></textarea></div>`);
  const trigger = findSettingsTrigger(window.document, promptOf(window));
  assert.ok(trigger, 'the model control is found even outside the prompt region');
  assert.equal(trigger.el.id, 'model');
  assert.equal(trigger.strategy, 'settings-trigger-by-name-in-document');
});

test('a weak document-wide match (a bare "Video" tab) is never clicked when nothing stronger exists', () => {
  const window = pageWith(`
    <nav><button id="nav-video">Video</button></nav>
    <div id="prompt-box"><textarea id="prompt" placeholder="Describe your video"></textarea></div>`);
  assert.equal(findSettingsTrigger(window.document, promptOf(window)), null, 'no blind clicks on generic controls');
});

test('a non-button element that declares a popup is a valid trigger', () => {
  const window = pageWith(`
    <div id="prompt-box">
      <div id="settings" aria-haspopup="menu" aria-label="Settings">\u2699</div>
      <textarea id="prompt" placeholder="Describe your image or video"></textarea>
      <button aria-label="Generate">Generate</button>
    </div>`);
  const trigger = findSettingsTrigger(window.document, promptOf(window));
  assert.ok(trigger, 'a div with aria-haspopup is found');
  assert.equal(trigger.el.tagName, 'DIV');
});

test('a custom-element host with a model-like name is a valid trigger (shadow DOM control)', () => {
  const window = pageWith(`
    <div id="prompt-box">
      <flow-model-picker aria-label="Model: Veo 3.1"></flow-model-picker>
      <textarea id="prompt" placeholder="Describe your video"></textarea>
      <button aria-label="Generate">Generate</button>
    </div>`);
  const trigger = findSettingsTrigger(window.document, promptOf(window));
  assert.ok(trigger, 'the custom-element host is found');
  assert.equal(trigger.el.tagName, 'FLOW-MODEL-PICKER');
});

test('Generate, Add and Remove controls are never chosen, even when they declare a popup', () => {
  const window = pageWith(`
    <div id="prompt-box">
      <button aria-haspopup="menu" aria-label="Add">+ Add</button>
      <button aria-haspopup="menu" aria-label="Generate">Generate</button>
      <textarea id="prompt" placeholder="Describe your image or video"></textarea>
    </div>`);
  assert.equal(findSettingsTrigger(window.document, promptOf(window)), null);
});

test('several equally strong matches are reported as ambiguous, not hidden', () => {
  const window = pageWith(`
    <div id="prompt-box">
      <button id="first">Nano Banana Pro</button>
      <button id="second">Veo 3.1</button>
      <textarea id="prompt" placeholder="Describe your image or video"></textarea>
      <button aria-label="Generate">Generate</button>
    </div>`);
  const trigger = findSettingsTrigger(window.document, promptOf(window));
  assert.equal(trigger.el.id, 'first', 'the first match is used');
  assert.equal(trigger.ambiguous, true, 'the ambiguity is reported');
});

test('classifyControl names each control purpose', () => {
  const window = pageWith(`
    <div>
      <button id="a" aria-label="Generate">Generate</button>
      <button id="b" aria-label="Add">+ Add</button>
      <button id="c" aria-label="Remove">Remove</button>
      <button id="d" role="switch">Agent</button>
      <button id="e">Nano Banana Pro \u25be</button>
      <button id="f" aria-haspopup="menu">16:9</button>
      <button id="g">Video</button>
      <button id="h" aria-haspopup="menu">Settings</button>
      <button id="i">Something else</button>
    </div>`);
  const doc = window.document;
  const purpose = (id) => classifyControl(doc.getElementById(id));
  assert.equal(purpose('a'), 'generate');
  assert.equal(purpose('b'), 'add');
  assert.equal(purpose('c'), 'remove');
  assert.equal(purpose('d'), 'agent');
  assert.equal(purpose('e'), 'model');
  assert.equal(purpose('f'), 'aspect-ratio');
  assert.equal(purpose('g'), 'mode');
  assert.equal(purpose('h'), 'settings');
  assert.equal(purpose('i'), 'other');
});

test('findDetectedSettings reads mode, model and aspect ratio from the controls themselves', () => {
  const window = pageWith(`
    <div id="prompt-box">
      <button>Video</button>
      <button>Veo 3.1 \u25be</button>
      <button aria-haspopup="menu">9:16</button>
      <textarea id="prompt" placeholder="Describe your video"></textarea>
      <button aria-label="Generate">Generate</button>
    </div>`);
  assert.deepEqual(findDetectedSettings(window.document, promptOf(window)), {
    mode: 'Video',
    model: 'Veo 3.1',
    aspectRatio: '9:16',
  });
});

test('findDetectedSettings reports null for what the controls do not show', () => {
  const window = pageWith(`
    <div id="prompt-box">
      <textarea id="prompt" placeholder="Describe your image or video"></textarea>
      <button aria-label="Generate">Generate</button>
    </div>`);
  assert.deepEqual(findDetectedSettings(window.document, promptOf(window)), { mode: null, model: null, aspectRatio: null });
});

test('findSettingsTriggerWhenReady finds a control that appears after the first look', async () => {
  const window = pageWith('<div id="prompt-box"><textarea id="prompt" placeholder="Describe"></textarea></div>');
  setTimeout(() => {
    const button = window.document.createElement('button');
    button.id = 'late-model';
    button.textContent = 'Nano Banana Pro';
    window.document.getElementById('prompt-box').append(button);
  }, 30);
  const trigger = await findSettingsTriggerWhenReady(window.document, promptOf(window), { timeoutMs: 1000, intervalMs: 10, sleep });
  assert.ok(trigger, 'the late control is found');
  assert.equal(trigger.el.id, 'late-model');
});

test('probe lists the controls near the prompt and the settings they show', async () => {
  const window = pageWith(`
    <div id="prompt-box">
      <textarea id="prompt" placeholder="Describe your image or video"></textarea>
      <button aria-label="Generate">Generate</button>
      <button role="switch" aria-checked="false">Agent</button>
    </div>`);
  const adapter = createFlowAdapter({ doc: window.document, location: window.location, sleep, waits: { triggerMs: 20 } });
  const probe = await adapter.probe();
  assert.equal(probe.settingsFound, false);
  assert.deepEqual(
    probe.promptControls.map((control) => control.name),
    ['Generate', 'Agent'],
  );
  assert.equal(probe.promptControls[1].role, 'switch');
  assert.equal(probe.promptControls[1].purpose, 'agent');
  assert.deepEqual(probe.detectedSettings, { mode: null, model: null, aspectRatio: null });
});

test('the "Check Flow page" report names the controls near the prompt when the trigger is missing', async () => {
  const window = pageWith(`
    <div id="prompt-box">
      <textarea id="prompt" placeholder="Describe your image or video"></textarea>
      <button aria-label="Generate">Generate</button>
      <button role="switch" aria-checked="false">Agent</button>
    </div>`);
  const adapter = createFlowAdapter({ doc: window.document, location: window.location, sleep, waits: { triggerMs: 20 } });
  const report = await adapter.diagnose();
  const settingsCheck = report.checks.find((check) => check.label === 'Settings control');
  assert.equal(settingsCheck.ok, false);
  assert.match(settingsCheck.detail, /Not found\. Controls near the prompt:/);
  assert.match(settingsCheck.detail, /"Generate"/);
  assert.match(settingsCheck.detail, /"Agent"/);
});

test('probe reports the controls and detected settings when the trigger is found', async () => {
  const window = pageWith(`
    <div id="prompt-box">
      <button aria-haspopup="menu">Nano Banana Pro \u25be</button>
      <textarea id="prompt" placeholder="Describe your image or video"></textarea>
      <button aria-label="Generate">Generate</button>
    </div>`);
  const adapter = createFlowAdapter({ doc: window.document, location: window.location, sleep });
  const probe = await adapter.probe();
  assert.equal(probe.settingsFound, true);
  assert.equal(probe.settingsAmbiguous, false);
  assert.ok(
    probe.promptControls.some((control) => control.name === 'Nano Banana Pro \u25be' && control.purpose === 'model'),
    'the controls list names the model control',
  );
  assert.deepEqual(probe.detectedSettings, { mode: null, model: 'Nano Banana Pro', aspectRatio: null });
});

test('probe waits for a composer that renders late instead of failing at once', async () => {
  const window = pageWith('<div id="prompt-box"></div>', FLOW_URL);
  setTimeout(() => {
    const area = window.document.createElement('textarea');
    area.id = 'prompt';
    area.setAttribute('placeholder', 'Describe your image or video');
    window.document.getElementById('prompt-box').append(area);
  }, 30);
  const adapter = createFlowAdapter({ doc: window.document, location: window.location, sleep, waits: { composerMs: 1000 } });
  const probe = await adapter.probe();
  assert.equal(probe.promptFound, true, 'the late composer is found after a bounded wait');
  // No toolbar buttons in this page, so the label decides between candidates.
  assert.equal(probe.promptStrategy, 'composer-textarea-by-label');
});

test('probe does not wait on a settled non-project page', async () => {
  const window = pageWith('<div id="prompt-box"></div>', 'https://flow.google.com/');
  // Let the document settle, as document_idle does in a real browser.
  await new Promise((resolve) => {
    if (window.document.readyState === 'complete') resolve();
    else window.addEventListener('load', resolve);
  });
  const adapter = createFlowAdapter({ doc: window.document, location: window.location, sleep, waits: { composerMs: 5000 } });
  const started = Date.now();
  const probe = await adapter.probe();
  assert.equal(probe.promptFound, false);
  assert.equal(probe.isProjectPage, false);
  assert.ok(Date.now() - started < 500, 'no long wait on a page that has no composer');
});

test('probe waits only briefly on a non-project page that is still loading', async () => {
  const window = pageWith('<div id="prompt-box"></div>', 'https://flow.google.com/');
  // readyState is still 'loading' here, exactly as at document_idle on a slow page.
  assert.notEqual(window.document.readyState, 'complete');
  const adapter = createFlowAdapter({ doc: window.document, location: window.location, sleep, waits: { composerMs: 5000 } });
  const started = Date.now();
  const probe = await adapter.probe();
  assert.equal(probe.promptFound, false);
  assert.ok(Date.now() - started < 2000, `the off-project wait stays bounded (took ${Date.now() - started}ms)`);
});

test('listPromptControls also lists custom-element hosts (shadow DOM controls)', () => {
  const window = pageWith(`
    <div id="prompt-box">
      <flow-model-picker aria-label="Model: Nano Banana Pro"></flow-model-picker>
      <textarea id="prompt" placeholder="Describe your image or video"></textarea>
      <button aria-label="Generate">Generate</button>
    </div>`);
  const controls = listPromptControls(window.document, promptOf(window));
  const host = controls.find((control) => control.tag === 'flow-model-picker');
  assert.ok(host, 'the custom-element host is listed');
  assert.equal(host.name, 'Model: Nano Banana Pro');
});

test('findPromptBox still finds the composer directly (detection stays a separate operation)', () => {
  const window = pageWith('<div id="prompt-box"><textarea id="prompt" placeholder="Describe"></textarea></div>');
  const prompt = findPromptBox(window.document);
  assert.equal(prompt.el.id, 'prompt');
  assert.equal(prompt.strategy, 'composer-textarea-by-label');
  assert.equal(prompt.enabled, true);
});

test('the controls list never includes the composer or its text (privacy)', () => {
  const window = pageWith(`
    <div id="prompt-box">
      <textarea id="prompt">PRIVATE SCENE TEXT [Scene 1]</textarea>
      <p>PRIVATE PAGE CONTENT</p>
      <button aria-label="Generate">Generate</button>
    </div>`);
  const controls = listPromptControls(window.document, promptOf(window));
  const names = controls.map((control) => control.name).join(' ');
  assert.doesNotMatch(names, /PRIVATE SCENE TEXT/);
  assert.doesNotMatch(names, /PRIVATE PAGE CONTENT/);
  assert.ok(controls.every((control) => control.tag !== 'textarea'), 'text-entry elements are not listed as controls');
});
