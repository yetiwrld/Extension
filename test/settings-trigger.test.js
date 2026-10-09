import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { findSettingsTrigger, listPromptControls } from '../src/flow/selectors.js';
import { createFlowAdapter } from '../src/flow/adapter.js';

/*
 * The settings trigger is the control that opens Flow's settings menu (Mode, Model,
 * Aspect ratio). Google's own help says to "click the model name" in the prompt box.
 * These tests pin how the trigger is chosen when the live page does not match the
 * synthetic fixture exactly: controls outside the detected prompt region, non-button
 * triggers, aspect-ratio chips that open a smaller menu, and controls that must never
 * be clicked (Generate, Add, Remove). They also pin the diagnostics that name the
 * controls near the prompt when no trigger is found.
 */

const FLOW_URL = 'https://flow.google.com/project/abc';

function pageWith(html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: FLOW_URL, pretendToBeVisual: true });
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

test('Generate, Add and Remove controls are never chosen, even when they declare a popup', () => {
  const window = pageWith(`
    <div id="prompt-box">
      <button aria-haspopup="menu" aria-label="Add">+ Add</button>
      <button aria-haspopup="menu" aria-label="Generate">Generate</button>
      <textarea id="prompt" placeholder="Describe your image or video"></textarea>
    </div>`);
  assert.equal(findSettingsTrigger(window.document, promptOf(window)), null);
});

test('probe lists the controls near the prompt when no settings trigger exists', async () => {
  const window = pageWith(`
    <div id="prompt-box">
      <textarea id="prompt" placeholder="Describe your image or video"></textarea>
      <button aria-label="Generate">Generate</button>
      <button role="switch" aria-checked="false">Agent</button>
    </div>`);
  const adapter = createFlowAdapter({ doc: window.document, location: window.location });
  const probe = await adapter.probe();
  assert.equal(probe.settingsFound, false);
  assert.deepEqual(
    probe.settingsCandidates.map((control) => control.name),
    ['Generate', 'Agent'],
  );
  assert.deepEqual(
    probe.settingsCandidates.map((control) => control.tag),
    ['button', 'button'],
  );
  assert.equal(probe.settingsCandidates[1].role, 'switch');
});

test('the "Check Flow page" report names the controls near the prompt when the trigger is missing', async () => {
  const window = pageWith(`
    <div id="prompt-box">
      <textarea id="prompt" placeholder="Describe your image or video"></textarea>
      <button aria-label="Generate">Generate</button>
      <button role="switch" aria-checked="false">Agent</button>
    </div>`);
  const adapter = createFlowAdapter({ doc: window.document, location: window.location });
  const report = await adapter.diagnose();
  const settingsCheck = report.checks.find((check) => check.label === 'Settings control');
  assert.equal(settingsCheck.ok, false);
  assert.match(settingsCheck.detail, /Not found\. Controls near the prompt:/);
  assert.match(settingsCheck.detail, /"Generate"/);
  assert.match(settingsCheck.detail, /"Agent"/);
});

test('probe reports no candidates when the settings trigger is found', async () => {
  const window = pageWith(`
    <div id="prompt-box">
      <button aria-haspopup="menu">Nano Banana Pro \u25be</button>
      <textarea id="prompt" placeholder="Describe your image or video"></textarea>
      <button aria-label="Generate">Generate</button>
    </div>`);
  const adapter = createFlowAdapter({ doc: window.document, location: window.location });
  const probe = await adapter.probe();
  assert.equal(probe.settingsFound, true);
  assert.deepEqual(probe.settingsCandidates, []);
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
