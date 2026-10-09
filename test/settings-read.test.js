import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createFlowAdapter } from '../src/flow/adapter.js';
import {
  classifySettingOption,
  findDetectedSettings,
  findOpenPopover,
  findSettingsTrigger,
  listPromptControls,
} from '../src/flow/selectors.js';
import { installFlowFixture } from './fixtures/flow-fixture.js';

/*
 * The live-page failure this file pins. On the real Flow page the composer holds a
 * model chip ("Nano Banana 2.1") that is a PLAIN element with no button semantics,
 * and the top toolbar holds a gear icon. The old detection could not see the chip,
 * clicked the gear instead, and the wrong menu's selected option ("dashboardGrid")
 * was classified as the model because classifySettingOption defaulted to 'model'.
 *
 * These tests pin the corrected behaviour:
 *  - the chip is found by its model name and is the control that gets clicked;
 *  - a generic toolbar popup (the gear) is never chosen for generation settings;
 *  - an unrecognised option is never a model;
 *  - a menu that is not the generation settings menu is rejected with its options
 *    named, so no unrelated value can reach the panel;
 *  - the chip's own text is the ground truth the report cross-checks against.
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

function fixturePage(options = {}, url = FLOW_URL) {
  const window = pageWith('', url);
  const page = installFlowFixture(window, options);
  const adapter = createFlowAdapter({ doc: window.document, location: new URL(url), sleep, timings });
  return { window, page, adapter };
}

const promptOf = (window) => window.document.querySelector('#prompt');

// ---------------------------------------------------------------------------
// Trigger selection: the chip, never the gear
// ---------------------------------------------------------------------------

test('a plain model chip in the composer is the settings trigger, not the toolbar gear', () => {
  const { window } = fixturePage({ chipPlain: true, gearMenu: true });
  const trigger = findSettingsTrigger(window.document, promptOf(window));
  assert.ok(trigger, 'the chip is found');
  assert.equal(trigger.el.id, 'settings-btn');
  assert.equal(trigger.el.tagName, 'DIV', 'the chip has no button semantics and is still found');
  assert.equal(trigger.strategy, 'settings-trigger-model-name');
  assert.equal(trigger.ambiguous, false);
  assert.equal(window.document.getElementById('gear').tagName, 'BUTTON', 'the gear exists on the page');
});

test('the toolbar gear is never chosen when the composer has no model chip', () => {
  const { window } = fixturePage({ gearMenu: true });
  window.document.getElementById('settings-btn').remove();
  const trigger = findSettingsTrigger(window.document, promptOf(window));
  assert.equal(trigger, null, 'a generic toolbar popup is not verified to open the generation settings');
});

test('a model name in a non-interactive element outside the composer is not clicked', () => {
  const window = pageWith(`
    <div class="card"><h3>Nano Banana 2.1 remix</h3></div>
    <div id="prompt-box"><textarea id="prompt" placeholder="What do you want to create?"></textarea></div>`);
  assert.equal(findSettingsTrigger(window.document, promptOf(window)), null, 'a project-card title is not a control');
});

test('a model-named interactive control outside the composer is still found', () => {
  const window = pageWith(`
    <header><button id="model">Veo 3.1</button></header>
    <div id="prompt-box"><textarea id="prompt" placeholder="What do you want to create?"></textarea></div>`);
  const trigger = findSettingsTrigger(window.document, promptOf(window));
  assert.equal(trigger.el.id, 'model');
});

// ---------------------------------------------------------------------------
// Classification: an unrelated option is never a model
// ---------------------------------------------------------------------------

test('an unrecognised option is unknown, not a model (the "dashboardGrid" guard)', () => {
  assert.equal(classifySettingOption({ name: 'dashboardGrid', group: null, selected: true }), null);
  assert.equal(classifySettingOption({ name: 'listView', group: null, selected: false }), null);
  assert.equal(classifySettingOption({ name: 'Nano Banana 2.1', group: null, selected: true }, { chipModel: 'Nano Banana 2.1' }), 'model');
  assert.equal(classifySettingOption({ name: 'Image', group: null, selected: true }), 'mode');
  assert.equal(classifySettingOption({ name: '16:9', group: null, selected: true }), 'aspectRatio');
  assert.equal(classifySettingOption({ name: 'Nano Banana Pro', group: 'Model', selected: true }), 'model');
});

// ---------------------------------------------------------------------------
// Reading: the chip's menu is read, the wrong menu is rejected
// ---------------------------------------------------------------------------

test('readSettings reads the chip\u2019s menu when the chip is a plain div', async () => {
  const { adapter } = fixturePage({ chipPlain: true });
  const result = await adapter.readSettings();
  assert.deepEqual(result.current, { mode: 'Image', model: 'Nano Banana Pro', aspectRatio: '16:9', outputs: null });
  assert.deepEqual(result.options.model, ['Nano Banana Pro', 'Nano Banana']);
  assert.equal(result.chipModel, 'Nano Banana Pro');
  assert.equal(result.modelMatchesChip, true);
});

test('readSettings rejects a menu that is not the generation settings, naming its options and the chip', async () => {
  // The chip opens a view menu whose selected option is "dashboardGrid" — exactly
  // the value the live page leaked into the panel as the "model".
  const window = pageWith(`
    <main>
      <div id="prompt-box">
        <div id="chip" class="model-chip">Nano Banana 2.1 \u25be</div>
        <textarea id="prompt" placeholder="What do you want to create?"></textarea>
        <button id="agent" role="switch" aria-checked="false">Agent</button>
        <button id="generate" aria-label="Generate">Generate</button>
      </div>
      <div id="overlay"></div>
    </main>`);
  const doc = window.document;
  doc.getElementById('chip').addEventListener('click', () => {
    doc.getElementById('overlay').innerHTML = `
      <div role="menu" aria-label="View">
        <div role="menuitemradio" aria-checked="true">dashboardGrid</div>
        <div role="menuitemradio" aria-checked="false">listView</div>
      </div>`;
  });
  const adapter = createFlowAdapter({ doc, location: window.location, sleep, timings });
  await assert.rejects(
    () => adapter.readSettings(),
    (error) => {
      assert.equal(error.code, 'FLOW_UI_CHANGED');
      assert.match(error.message, /not Flow's generation settings menu/);
      assert.match(error.message, /dashboardGrid/, 'the wrong menu\u2019s options are named');
      assert.match(error.message, /listView/);
      assert.match(error.message, /Nano Banana 2.1/, 'the chip text is named');
      return true;
    },
  );
});

test('readSettings rejects a menu with no recognizable generation options at all', async () => {
  const window = pageWith(`
    <main>
      <div id="prompt-box">
        <button id="chip" aria-haspopup="menu">Nano Banana 2.1 \u25be</button>
        <textarea id="prompt" placeholder="What do you want to create?"></textarea>
        <button id="generate" aria-label="Generate">Generate</button>
      </div>
      <div id="overlay"></div>
    </main>`);
  const doc = window.document;
  doc.getElementById('chip').addEventListener('click', () => {
    doc.getElementById('overlay').innerHTML = '<div role="menu" aria-label="Help"><div role="menuitem">About</div><div role="menuitem">Shortcuts</div></div>';
  });
  const adapter = createFlowAdapter({ doc, location: window.location, sleep, timings });
  await assert.rejects(
    () => adapter.readSettings(),
    (error) => {
      assert.equal(error.code, 'FLOW_UI_CHANGED');
      assert.match(error.message, /not Flow's generation settings menu/);
      assert.match(error.message, /About, Shortcuts/);
      return true;
    },
  );
});

test('readSettings says which control was clicked when no menu opens', async () => {
  const window = pageWith(`
    <main>
      <div id="prompt-box">
        <div id="chip" class="model-chip">Nano Banana 2.1 \u25be</div>
        <textarea id="prompt" placeholder="What do you want to create?"></textarea>
        <button id="generate" aria-label="Generate">Generate</button>
      </div>
    </main>`);
  const adapter = createFlowAdapter({ doc: window.document, location: window.location, sleep, timings });
  await assert.rejects(
    () => adapter.readSettings(),
    (error) => {
      assert.equal(error.code, 'FLOW_UI_CHANGED');
      assert.match(error.message, /The Flow settings menu did not open after clicking "Nano Banana 2.1/);
      assert.match(error.message, /Check Flow page/);
      return true;
    },
  );
});

test('a menu surface without ARIA roles is still detected as an open menu', () => {
  const window = pageWith(`
    <main>
      <div id="prompt-box">
        <div id="chip" class="model-chip">Nano Banana 2.1 \u25be</div>
        <textarea id="prompt" placeholder="What do you want to create?"></textarea>
        <button id="generate" aria-label="Generate">Generate</button>
      </div>
      <div id="surface" data-state="open"><div>Nano Banana 2.1</div><div>Veo 3.1</div><div>16:9</div></div>
    </main>`);
  const popover = findOpenPopover(window.document, { exclude: promptOf(window) });
  assert.ok(popover, 'a role-less open menu surface is detected');
  assert.equal(popover.id, 'surface');
});

test('a match that contains the composer is not treated as the menu', () => {
  const window = pageWith(`
    <main>
      <div id="prompt-box" data-state="open">
        <div id="chip" class="model-chip">Nano Banana 2.1 \u25be</div>
        <textarea id="prompt" placeholder="What do you want to create?"></textarea>
        <button id="generate" aria-label="Generate">Generate</button>
      </div>
    </main>`);
  assert.equal(findOpenPopover(window.document, { exclude: promptOf(window) }), null, 'the composer is not inside its own menu');
});

// ---------------------------------------------------------------------------
// Chip evidence and diagnostics
// ---------------------------------------------------------------------------

test('the chip text is detected and listed as a control with purpose model', () => {
  const { window } = fixturePage({ chipPlain: true });
  const detected = findDetectedSettings(window.document, promptOf(window));
  assert.equal(detected.model, 'Nano Banana Pro');
  const controls = listPromptControls(window.document, promptOf(window));
  const chip = controls.find((control) => control.name.startsWith('Nano Banana Pro'));
  assert.ok(chip, 'the plain-div chip is listed');
  assert.equal(chip.tag, 'div');
  assert.equal(chip.purpose, 'model');
});

test('diagnose reports the model chip and the settings-read attempt, success or failure', async () => {
  const ok = await fixturePage({ chipPlain: true }).adapter.diagnose();
  assert.equal(ok.modelChip, 'Nano Banana Pro');
  assert.equal(ok.settingsRead.ok, true);
  assert.deepEqual(ok.settingsRead.current, { mode: 'Image', model: 'Nano Banana Pro', aspectRatio: '16:9', outputs: null });
  const chipCheck = ok.checks.find((item) => item.label === 'Model chip');
  assert.equal(chipCheck.ok, true);
  assert.match(chipCheck.detail, /Nano Banana Pro/);

  // The chip that opens nothing: the report says which control was clicked and why it failed.
  const window = pageWith(`
    <main>
      <div id="prompt-box">
        <div id="chip" class="model-chip">Nano Banana 2.1 \u25be</div>
        <textarea id="prompt" placeholder="What do you want to create?"></textarea>
        <button id="generate" aria-label="Generate">Generate</button>
      </div>
    </main>`);
  const adapter = createFlowAdapter({ doc: window.document, location: window.location, sleep, timings });
  const report = await adapter.diagnose();
  assert.equal(report.settingsRead.attempted, true);
  assert.equal(report.settingsRead.ok, false);
  assert.equal(report.settingsRead.code, 'FLOW_UI_CHANGED');
  assert.match(report.settingsRead.error, /did not open after clicking "Nano Banana 2.1/);
  const settingsCheck = report.checks.find((item) => item.label === 'Settings control');
  assert.equal(settingsCheck.ok, false);
  assert.match(settingsCheck.detail, /reading it failed: The Flow settings menu did not open after clicking/);
  assert.ok(report.exceptions.some((item) => item.label === 'settings read'), 'the exception is in the report');
});

test('the gear menu never reaches the panel: probe, diagnose and read all refuse it', async () => {
  // The full user scenario: chip present (plain div) + gear present. The chip must
  // be the trigger, the gear's menu must never be read as settings.
  const { adapter, window } = fixturePage({ chipPlain: true, gearMenu: true });
  const probe = await adapter.probe();
  assert.equal(probe.settingsFound, true);
  assert.equal(probe.settingsStrategy, 'settings-trigger-model-name');
  assert.equal(probe.detectedSettings.model, 'Nano Banana Pro');
  const result = await adapter.readSettings();
  assert.equal(result.current.model, 'Nano Banana Pro');
  assert.notEqual(result.current.model, 'dashboardGrid');
  assert.equal(window.document.getElementById('gear').getAttribute('aria-expanded'), null, 'the gear was never clicked');
});
