import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createFlowAdapter } from '../src/flow/adapter.js';
import {
  classifySettingOption,
  findGenerateButton,
  findPromptBox,
  isModelSubmenuTrigger,
  parseModelChip,
  readPopoverOptions,
} from '../src/flow/selectors.js';
import { installFlowFixture } from './fixtures/flow-fixture.js';

/*
 * The LIVE Flow menu (reported from the real page):
 *
 *   chip:  "🍌 Nano Banana 2.1 crop_16_9 x1"
 *   menu:  Image · Video · 16:9 4:3 1:1 3:4 9:16 · "Select model family" · x1 x2 x3 x4
 *
 * The earlier reader only accepted role="menuitem*" rows and classified any
 * unrecognised option as the model, so this real menu was either unreadable
 * ("classified as the wrong menu") or misread. These tests pin the corrected
 * behaviour: the menu is recognised as THE generation-settings menu, the model
 * list is read through its nested submenu, output counts are a first-class
 * setting, and every selection is verified against the chip's own text.
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

// ---------------------------------------------------------------------------
// The chip is the ground truth: parse model + aspect ratio + output count
// ---------------------------------------------------------------------------

test('parseModelChip reads model, aspect ratio and output count from the chip text', () => {
  assert.deepEqual(parseModelChip('\uD83C\uDF4C Nano Banana 2.1 crop_16_9 x1'), {
    model: 'Nano Banana 2.1',
    aspectRatio: '16:9',
    outputs: 'x1',
  });
  assert.deepEqual(parseModelChip('\uD83C\uDF4C Veo 3.1 crop_9_16 x2'), { model: 'Veo 3.1', aspectRatio: '9:16', outputs: 'x2' });
  assert.deepEqual(parseModelChip('Nano Banana Pro \u25be'), { model: 'Nano Banana Pro', aspectRatio: null, outputs: null });
  assert.deepEqual(parseModelChip('Nano Banana 2.1'), { model: 'Nano Banana 2.1', aspectRatio: null, outputs: null });
  assert.deepEqual(parseModelChip('16:9'), { model: null, aspectRatio: '16:9', outputs: null }, 'a bare ratio chip is not a model');
  assert.deepEqual(parseModelChip(''), { model: null, aspectRatio: null, outputs: null });
});

test('the chip is parsed without opening any menu (probe stays read-only)', async () => {
  const { adapter, window } = fixturePage({ liveMenu: true });
  const probe = await adapter.probe();
  assert.equal(probe.detectedSettings.model, 'Nano Banana 2.1');
  assert.equal(probe.detectedSettings.aspectRatio, '16:9');
  assert.equal(probe.detectedSettings.outputs, 'x1');
  assert.equal(probe.detectedSettings.mode, null, 'the chip does not show the mode');
  assert.equal(window.document.querySelector('[role="menu"]'), null, 'no menu was opened');
});

// ---------------------------------------------------------------------------
// The live menu is recognised as the generation-settings menu
// ---------------------------------------------------------------------------

test('readSettings ACCEPTS the live menu (mode + ratios + outputs + model submenu)', async () => {
  const { adapter } = fixturePage({ liveMenu: true });
  const result = await adapter.readSettings();
  assert.deepEqual(result.current, { mode: 'Image', model: 'Nano Banana 2.1', aspectRatio: '16:9', outputs: 'x1' });
  assert.deepEqual(result.options.mode, ['Image', 'Video']);
  assert.deepEqual(result.options.aspectRatio, ['16:9', '4:3', '1:1', '3:4', '9:16']);
  assert.deepEqual(result.options.outputs, ['x1', 'x2', 'x3', 'x4']);
  assert.deepEqual(result.options.model, ['Nano Banana 2.1', 'Nano Banana Pro', 'Veo 3.1', 'Veo 3'], 'model options come from the nested menu');
  assert.equal(result.hasModelSubmenu, true);
  assert.equal(result.chipModel, 'Nano Banana 2.1');
  assert.equal(result.chipAspectRatio, '16:9');
  assert.equal(result.chipOutputs, 'x1');
  assert.equal(result.modelMatchesChip, true);
  assert.equal(result.aspectMatchesChip, true);
  assert.equal(result.outputsMatchesChip, true);
});

test('the live menu is read even when its rows have no ARIA roles at all', () => {
  const window = pageWith(`
    <div id="menu-surface" data-state="open">
      <div>Image</div>
      <div>Video</div>
      <div>16:9</div>
      <div>4:3</div>
      <div>Select model family</div>
      <div>x1</div>
      <div>x2</div>
    </div>`);
  const options = readPopoverOptions(window.document.getElementById('menu-surface'));
  const names = options.map((option) => option.name);
  assert.deepEqual(names, ['Image', 'Video', '16:9', '4:3', 'Select model family', 'x1', 'x2']);
  assert.equal(classifySettingOption(options[0]), 'mode');
  assert.equal(classifySettingOption(options[2]), 'aspectRatio');
  assert.equal(classifySettingOption(options[4]), 'model', 'the submenu trigger is model evidence');
  assert.equal(isModelSubmenuTrigger(options[4]), true);
  assert.equal(classifySettingOption(options[5]), 'outputs');
  assert.equal(classifySettingOption(options[6]), 'outputs');
});

test('a menu with ONLY output counts is still the generation-settings menu', () => {
  assert.equal(classifySettingOption({ name: 'x1', group: null }), 'outputs');
  assert.equal(classifySettingOption({ name: 'x4', group: null }), 'outputs');
  assert.equal(classifySettingOption({ name: '2', group: 'Outputs' }), 'outputs');
  assert.equal(classifySettingOption({ name: '2', group: null }), null, 'a bare number is not guessed');
  assert.equal(classifySettingOption({ name: 'dashboardGrid', group: null }), null, 'a view option is never anything');
  assert.equal(classifySettingOption({ name: 'Select model family', group: null, submenu: true }), 'model');
});

test('the wrong (view) menu is still rejected, with its options named', async () => {
  const { adapter } = fixturePage({ chipPlain: true, chipOpensViewMenu: true });
  await assert.rejects(
    () => adapter.readSettings(),
    (error) => {
      assert.equal(error.code, 'FLOW_UI_CHANGED');
      assert.match(error.message, /not Flow's generation settings menu/);
      assert.match(error.message, /dashboardGrid, listView/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Applying settings: real clicks, verified against the chip
// ---------------------------------------------------------------------------

test('applySettings sets mode, aspect ratio, output count and model, each verified via the chip', async () => {
  const { adapter, page, window } = fixturePage({ liveMenu: true });
  const result = await adapter.applySettings({ mode: 'Video', aspectRatio: '9:16', outputs: 'x2', model: 'Veo 3.1' });
  assert.deepEqual(result.current, { mode: 'Video', model: 'Veo 3.1', aspectRatio: '9:16', outputs: 'x2' });
  assert.equal(page.state.mode, 'Video');
  assert.equal(page.state.aspectRatio, '9:16');
  assert.equal(page.state.outputCount, 'x2');
  assert.equal(page.state.model, 'Veo 3.1');
  assert.match(window.document.getElementById('settings-btn').textContent, /Veo 3\.1 crop_9_16 x2/, 'the chip shows the new state');
});

test('applySettings descends the nested model menu (flat: family list shows models)', async () => {
  const { adapter, page } = fixturePage({ liveMenu: true });
  const result = await adapter.applySettings({ model: 'Veo 3' });
  assert.equal(result.current.model, 'Veo 3');
  assert.equal(page.state.model, 'Veo 3');
});

test('applySettings descends TWO levels when the model list shows families first', async () => {
  const { adapter, page } = fixturePage({ liveMenu: true, liveMenuDeep: true });
  const read = await adapter.readSettings();
  assert.equal(read.current.model, 'Nano Banana 2.1', 'the chip supplies the model even through the family level');
  // The read descends into the family that contains the current model; applying a
  // model from ANOTHER family descends into that family instead.
  assert.deepEqual(read.options.model, ['Nano Banana 2.1', 'Nano Banana Pro']);
  const result = await adapter.applySettings({ model: 'Veo 3.1' });
  assert.equal(result.current.model, 'Veo 3.1');
  assert.equal(page.state.model, 'Veo 3.1');
});

test('a chip that does not confirm a selection is REPORTED, while the settings state decides', async () => {
  // The chip text alone does not prove a setting: the menu's selected state is the
  // settings state. When the two disagree, the change is verified by the menu and the
  // chip mismatch is reported — never hidden, never silently trusted.
  const { adapter, page } = fixturePage({ liveMenu: true, chipStale: true });
  const result = await adapter.applySettings({ aspectRatio: '4:3' });
  assert.equal(result.current.aspectRatio, '4:3', 'the settings state shows 4:3 selected');
  assert.equal(page.state.aspectRatio, '4:3', 'Flow did change');
  assert.equal(result.aspectMatchesChip, false, 'the stale chip is reported as a mismatch');
  assert.ok(
    result.trace.some((line) => line.step === 'verified' && /the chip still shows a different value/.test(line.detail)),
    'the trace reports the chip mismatch',
  );
  // When the settings state does NOT confirm the change, it is a FAILURE — the click
  // alone never counts. (The row's own state update is neutered, so the menu keeps
  // marking the old selection.)
  const stuck = fixturePage({ liveMenu: true, chipStale: true });
  stuck.window.document.addEventListener(
    'click',
    (event) => {
      if (event.target.closest?.('[data-key="aspectRatio"]')) event.stopImmediatePropagation();
    },
    true,
  );
  await assert.rejects(
    () => stuck.adapter.applySettings({ aspectRatio: '4:3' }),
    (error) => {
      assert.equal(error.code, 'FLOW_SETTING_FAILED');
      assert.match(error.message, /Flow still shows Aspect ratio "16:9" after selecting "4:3"/);
      return true;
    },
  );
});

test('a model Flow does not offer is refused with the real list', async () => {
  const { adapter } = fixturePage({ liveMenu: true });
  await assert.rejects(
    () => adapter.applySettings({ model: 'Flux Pro' }),
    (error) => {
      assert.equal(error.code, 'FLOW_SETTING_FAILED');
      assert.match(error.message, /does not offer model "Flux Pro"/);
      assert.match(error.message, /Nano Banana 2\.1, Nano Banana Pro, Veo 3\.1, Veo 3/);
      return true;
    },
  );
});

test('an output count Flow does not offer is refused with the real list', async () => {
  const { adapter } = fixturePage({ liveMenu: true });
  await assert.rejects(
    () => adapter.applySettings({ outputs: 'x8' }),
    (error) => {
      assert.equal(error.code, 'FLOW_SETTING_FAILED');
      assert.match(error.message, /does not offer "x8" for output count/);
      assert.match(error.message, /x1, x2, x3, x4/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Diagnose reports the live menu correctly
// ---------------------------------------------------------------------------

test('diagnose reports the live menu as read, with the chip cross-check', async () => {
  const { adapter } = fixturePage({ liveMenu: true });
  const report = await adapter.diagnose();
  assert.equal(report.modelChip, 'Nano Banana 2.1');
  assert.equal(report.settingsRead.ok, true);
  assert.deepEqual(report.settingsRead.current, { mode: 'Image', model: 'Nano Banana 2.1', aspectRatio: '16:9', outputs: 'x1' });
  assert.equal(report.settingsRead.hasModelSubmenu, true);
  assert.equal(report.settingsRead.outputsMatchesChip, true);
  const settingsCheck = report.checks.find((item) => item.label === 'Settings control');
  assert.equal(settingsCheck.ok, true);
  assert.match(settingsCheck.detail, /Read OK: mode=Image, model=Nano Banana 2\.1, aspectRatio=16:9, outputs=x1/);
  assert.match(settingsCheck.detail, /chip shows "Nano Banana 2\.1"/);
});

// ---------------------------------------------------------------------------
// Prompt-box detection: the shapes the live page can use
// ---------------------------------------------------------------------------

test('a composer whose placeholder lives in aria-placeholder is found', () => {
  const window = pageWith(`
    <div id="prompt-box">
      <div id="editor" contenteditable="true" role="textbox" aria-placeholder="What do you want to create?"></div>
      <button aria-label="Generate">Generate</button>
    </div>`);
  const prompt = findPromptBox(window.document);
  assert.ok(prompt, 'the editor is found');
  assert.equal(prompt.el.id, 'editor');
  assert.equal(prompt.enabled, true);
});

test('a composer whose placeholder lives in data-placeholder is found', () => {
  const window = pageWith(`
    <div id="prompt-box">
      <div id="editor" contenteditable="plaintext-only" data-placeholder="What do you want to create?"></div>
      <button aria-label="Generate">Generate</button>
    </div>`);
  const prompt = findPromptBox(window.document);
  assert.ok(prompt, 'the editor is found');
  assert.equal(prompt.el.id, 'editor');
});

test('an EMPTY contenteditable composer with a generate control is found by region', () => {
  const window = pageWith(`
    <div id="prompt-box">
      <div id="editor" contenteditable="true"></div>
      <button aria-label="Generate">Generate</button>
    </div>`);
  const prompt = findPromptBox(window.document);
  assert.ok(prompt, 'the empty editor is found through its region');
  assert.equal(prompt.el.id, 'editor');
});

test('a composer two shadow levels deep is found', () => {
  const window = pageWith('<flow-shell-a></flow-shell-a>');
  const doc = window.document;
  const hostA = doc.querySelector('flow-shell-a');
  const rootA = hostA.attachShadow({ mode: 'open' });
  rootA.innerHTML = '<flow-shell-b></flow-shell-b>';
  const hostB = rootA.querySelector('flow-shell-b');
  const rootB = hostB.attachShadow({ mode: 'open' });
  rootB.innerHTML = `
    <div id="prompt-box">
      <textarea id="prompt" placeholder="What do you want to create?"></textarea>
      <button aria-label="Generate">Generate</button>
    </div>`;
  const prompt = findPromptBox(doc);
  assert.ok(prompt, 'the editor is found two shadow levels deep');
  assert.equal(prompt.el.id, 'prompt');
  assert.equal(prompt.strategy.includes('in-shadow-root'), true);
});

test('an icon-only generate control (a material ligature, no text) is found in the region', () => {
  const window = pageWith(`
    <div id="prompt-box">
      <textarea id="prompt" placeholder="What do you want to create?"></textarea>
      <button aria-label=""><span class="material-symbols">arrow_forward</span></button>
    </div>`);
  const prompt = findPromptBox(window.document);
  assert.ok(prompt);
  const generate = findGenerateButton(window.document, prompt.el);
  assert.ok(generate, 'the icon-only button is found');
  assert.equal(generate.strategy, 'generate-icon-in-prompt-region');
});

test('the composer area dump maps the chip, its chain, the region fields and generate candidates', async () => {
  const { adapter, window } = fixturePage({ liveMenu: true });
  window.document.getElementById('prompt').remove(); // simulate the missing composer
  const probe = await adapter.probe();
  const area = probe.composerArea;
  assert.ok(area, 'the area is reported');
  assert.equal(area.chip.name, '\uD83C\uDF4C Nano Banana 2.1 crop_16_9 x1');
  assert.ok(area.chipChain.length >= 2, 'the chip\u2019s ancestors are listed');
  assert.equal(area.chipChain[0].tag, 'div');
  assert.ok(area.regionFields.length >= 0, 'text fields are listed (none after removal)');
  assert.ok(area.regionControls.some((control) => control.purpose === 'model'), 'the chip is listed as a control');
  assert.ok(area.generateCandidates.some((candidate) => candidate.labelled), 'generate candidates are listed');
  assert.equal(probe.promptFound, false);
});

test('a model whose menu row carries an icon and a description is still found (not "unavailable")', async () => {
  // The live menu writes "🍌 Nano Banana 2.1  Fast image generation" where the chip
  // writes "Nano Banana 2.1". A plain string comparison reported a model that IS in
  // the list as unavailable; the normalized label<->identifier mapping resolves it.
  const { adapter, page } = fixturePage({ liveMenu: true, liveMenuDeep: true, decoratedModelRows: true });
  const result = await adapter.applySettings({ model: 'Nano Banana Pro' });
  assert.equal(page.state.model, 'Nano Banana Pro', 'Flow really changed the model');
  assert.ok(/Nano Banana Pro/.test(result.current.model ?? ''), 'the applied model is read back from the UI');
});

test('the chip value is read from the chip, not from the trigger button\'s accessible name', async () => {
  // Measured on the live page (2026-10-09): the trigger is
  // <button aria-label="Settings trigger"><span>🍌 Nano Banana 2.1 crop_16_9 x1</span></button>.
  // Reading the accessible name reported the model as "Settings trigger".
  const { adapter } = fixturePage({ liveMenu: true, liveMenuDeep: true, flowComponents: true, triggerNamedSettings: true });
  const probe = await adapter.probe();
  assert.equal(probe.detectedSettings.model, 'Nano Banana 2.1');
  assert.equal(probe.detectedSettings.outputs, 'x1');
  const read = await adapter.readSettings();
  assert.equal(read.chipModel, 'Nano Banana 2.1');
  assert.equal(read.current.model, 'Nano Banana 2.1');
  assert.notEqual(read.current.model, 'Settings trigger');
});

test('an icon ligature beside a mode row does not become a second option', async () => {
  // The live menu reported "mode options: image, Image, Video" with mode="image".
  const { adapter } = fixturePage({ liveMenu: true, modeIconRow: true });
  const read = await adapter.readSettings();
  assert.deepEqual(read.options.mode, ['Image', 'Video']);
  assert.equal(read.current.mode, 'Image');
});

test('a leftover overlay backdrop no longer makes the trigger look dead mid-run', async () => {
  // Measured failure: the diagnostic opens the menu on a fresh page, but a scene run
  // (which has already opened and closed the menu once) reported "the click changed
  // nothing visible in the DOM". Angular CDK leaves a full-page backdrop behind, and
  // the next press is consumed dismissing it.
  const { adapter, page } = fixturePage({ liveMenu: true, cdkBackdrop: true });
  const first = await adapter.readSettings();
  assert.equal(first.current.aspectRatio, '16:9');
  // A backdrop is now on the page, exactly as Flow leaves one.
  assert.ok(page.doc.querySelector('.cdk-overlay-backdrop'), 'the fixture left a backdrop behind');
  const applied = await adapter.applySettings({ aspectRatio: '9:16' });
  assert.equal(page.state.aspectRatio, '9:16', 'Flow really changed');
  assert.equal(applied.current.aspectRatio, '9:16');
});

test('a settings menu that cannot be opened reports the backdrop and aria-expanded evidence', async () => {
  const { adapter } = fixturePage({ liveMenu: true, chipDead: true });
  await assert.rejects(
    () => adapter.readSettings(),
    (error) => {
      assert.match(error.message, /did not open/);
      assert.match(error.message, /press(es)?,/, 'the number of presses is reported');
      assert.match(error.message, /keyboard Enter and Space/, 'the keyboard routes were tried too');
      return true;
    },
  );
});

test('a material-symbol ligature is never read as a Mode option', async () => {
  // Measured live: with ingredients attached the menu carries <mat-icon>image</mat-icon>
  // and no Mode rows. Reading that icon as an option made the apply step click it.
  const { adapter } = fixturePage({ liveMenu: true, modeIconOnly: true });
  const read = await adapter.readSettings();
  assert.deepEqual(read.options.mode, [], 'no Mode options are invented from the icon');
  assert.equal(read.current.mode, null, 'Mode is unknown, not "image"');
});

test('a setting Flow does not offer is reported, not clicked and not failed', async () => {
  const { adapter, page } = fixturePage({ liveMenu: true, modeIconOnly: true });
  const result = await adapter.applySettings({ mode: 'Image', aspectRatio: '9:16' });
  assert.deepEqual(result.notOffered, ['mode'], 'Mode is reported as not offered');
  assert.ok(result.trace.some((line) => line.step === 'not-offered' && /Mode/.test(line.detail)));
  assert.equal(page.state.aspectRatio, '9:16', 'the settings Flow DOES offer were still applied');
});

test('a control that opens the media library menu is skipped for the model chip', async () => {
  // Measured live: "Settings trigger" opened All media / Images / Characters /
  // Scenes / Uploads / Tools. The model chip is what Flow's help says to click,
  // so it is ranked first and the library control is never read as settings.
  const { adapter } = fixturePage({ liveMenu: true, libraryTrigger: true });
  const read = await adapter.readSettings();
  assert.ok(read.options.aspectRatio.length > 0, 'the real generation menu was read');
  assert.match(read.strategy, /model-name/, 'the model chip is the trigger that was used');
});

test('when a control opens the wrong menu the next candidate is tried', async () => {
  // Chip first (wrong menu), then the library control (also wrong): the error names
  // every control tried and what each menu offered, and nothing is read as settings.
  const { adapter } = fixturePage({ chipOpensViewMenu: true, libraryTrigger: true });
  await assert.rejects(adapter.readSettings(), (error) => {
    assert.match(error.message, /None of the controls/);
    assert.match(error.message, /dashboardGrid/, 'the chip\'s wrong menu is named');
    assert.match(error.message, /All media/, 'the library control\'s wrong menu is named');
    return true;
  });
});

test("Flow's undo snackbar is never read as the settings menu", async () => {
  // Measured live: the read returned "6 items moved to bin, Undo, View in bin,
  // Dismiss" as the menu's options. A status surface is not a menu.
  const { adapter } = fixturePage({ liveMenu: true, snackbar: true });
  const read = await adapter.readSettings();
  assert.ok(read.options.aspectRatio.length > 0, 'the real generation menu was read');
  assert.ok(
    !JSON.stringify(read.options).includes('Undo'),
    'no snackbar button leaked into the settings options',
  );
});

test('a panel that was already open before the click is not the menu the click opened', async () => {
  // Measured live: the media library filter rail (All media, Images, ...) was
  // standing open and was reported as the menu that the trigger opened.
  const { adapter } = fixturePage({ liveMenu: true, libraryRail: true });
  const read = await adapter.readSettings();
  assert.ok(read.options.aspectRatio.length > 0, 'the real generation menu was read');
  assert.ok(!JSON.stringify(read.options).includes('All media'), 'the rail is not read as settings');
  assert.ok(read.options.model.length > 0, 'the real model list was still read');
});

test('the open probe reports, route by route, whether anything opened', async () => {
  // A control that opens nothing must be shown as opening nothing — for every
  // activation route — instead of some other surface being read as its menu.
  const { adapter } = fixturePage({ liveMenu: true, chipDead: true, libraryRail: true, snackbar: true });
  const report = await adapter.diagnose();
  const probe = report.openProbe;
  assert.ok(probe, 'the probe ran');
  assert.ok(probe.before.length > 0, 'the surfaces already open are recorded');
  assert.ok(probe.attempts.length >= 3, 'every activation route is reported');
  assert.ok(probe.attempts.every((attempt) => !attempt.opened), 'nothing opened, and nothing is claimed to have');
});

test('the open probe names the route that works', async () => {
  const { adapter } = fixturePage({ liveMenu: true });
  const probe = (await adapter.diagnose()).openProbe;
  const worked = probe.attempts.find((attempt) => attempt.opened);
  assert.ok(worked, 'a route opened the menu');
  assert.equal(worked.isGenerationMenu, true, 'and it is recognised as the generation menu');
});
