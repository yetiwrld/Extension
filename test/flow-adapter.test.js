import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createFlowAdapter, handleFlowCommand } from '../src/flow/adapter.js';
import { installFlowFixture } from './fixtures/flow-fixture.js';

/**
 * Adapter tests against the SYNTHETIC Flow fixture (test/fixtures/flow-fixture.js).
 * They prove the adapter logic, not that the live Flow page matches the fixture.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5)));
const timings = { settleMs: 0, popoverMs: 300 };

class FakeDataTransfer {
  constructor() {
    this._files = [];
    const self = this;
    this.items = {
      add(file) {
        self._files.push(file);
        return true;
      },
    };
  }

  get files() {
    return this._files;
  }
}

before(() => {
  globalThis.DataTransfer = FakeDataTransfer;
});

function createPage({ variant = 'textarea', url = 'https://flow.google.com/project/abc123' } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url, pretendToBeVisual: true });
  const { window } = dom;
  // jsdom has no layout: give every element a size so visibility and thumbnail heuristics apply.
  window.Element.prototype.getClientRects = function getClientRects() {
    return [{ width: 200, height: 200, top: 0, left: 0, right: 200, bottom: 200 }];
  };
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { width: 200, height: 200, top: 0, left: 0, right: 200, bottom: 200, x: 0, y: 0 };
  };
  const page = installFlowFixture(window, { variant });
  const adapter = createFlowAdapter({
    doc: window.document,
    location: new URL(url),
    sleep,
    timings,
  });
  return { window, page, adapter };
}

let current;
beforeEach(() => {
  current = createPage();
});

test('probe reports the prompt box, Generate, settings and Agent state on a project page', async () => {
  const probe = await current.adapter.probe();
  assert.equal(probe.promptFound, true);
  assert.equal(probe.promptStrategy, 'composer-textarea-by-region');
  assert.equal(probe.promptEnabled, true);
  assert.equal(probe.promptAmbiguous, false);
  assert.equal(probe.workspaceDetected, true);
  assert.equal(probe.flowPage, true);
  assert.equal(probe.composerLayout, 'standard');
  assert.equal(probe.generateFound, true);
  assert.equal(probe.generateEnabled, false, 'Generate is disabled while the prompt is empty');
  assert.equal(probe.settingsFound, true);
  assert.equal(probe.settingsAmbiguous, false);
  assert.ok(
    probe.promptControls.some((control) => control.name === 'Nano Banana Pro \u25be' && control.purpose === 'model'),
    'the controls near the prompt are listed',
  );
  assert.deepEqual(probe.detectedSettings, { mode: null, model: 'Nano Banana Pro', aspectRatio: null });
  assert.equal(probe.agentOn, false);
  assert.equal(probe.isProjectPage, true);
  // The composer evidence: every text field on the page, with why it is or is not the composer.
  const composer = probe.promptCandidates.find((candidate) => candidate.tag === 'textarea');
  assert.ok(composer, 'the textarea is listed as a candidate');
  assert.equal(composer.rejection, null);
  assert.equal(composer.visible, true);
  assert.equal(composer.disabled, false);
  assert.ok(composer.rect.width > 0, 'the candidate carries its bounding rectangle');
  assert.ok(probe.promptReasons.length >= 2, `the selection says why: ${probe.promptReasons}`);
  assert.ok(probe.selectorResults.some((row) => row.selector === 'textarea' && row.matched >= 1), 'selector results are reported');
  assert.equal(probe.frames.inspected, 1);
  assert.deepEqual(probe.exceptions, []);
});

test('probe reports Agent as on when its switch is on', async () => {
  current.window.document.getElementById('agent').setAttribute('aria-checked', 'true');
  const probe = await current.adapter.probe();
  assert.equal(probe.agentOn, true);
});

test('probe on a non-project Flow page reports no prompt instead of guessing', async () => {
  const page = createPage({ url: 'https://flow.google.com/' });
  page.window.document.querySelector('#prompt-box').remove();
  const probe = await page.adapter.probe();
  assert.equal(probe.promptFound, false);
  assert.equal(probe.isProjectPage, false);
});

test('readSettings returns Flow\'s current values and the options it exposes, then closes the menu', async () => {
  const result = await current.adapter.readSettings();
  assert.deepEqual(result.current, { mode: 'Image', model: 'Nano Banana Pro', aspectRatio: '16:9' });
  assert.deepEqual(result.options.mode, ['Image', 'Video']);
  assert.deepEqual(result.options.model, ['Nano Banana Pro', 'Nano Banana']);
  assert.deepEqual(result.options.aspectRatio, ['16:9', '9:16', '1:1']);
  assert.equal(current.window.document.querySelector('[role="menu"]'), null, 'popover must be closed');
});

test('applySettings changes Flow\'s own settings, and the model list follows the mode', async () => {
  const result = await current.adapter.applySettings({ mode: 'Video' });
  assert.equal(result.current.mode, 'Video');
  assert.equal(current.page.state.mode, 'Video');
  assert.deepEqual(result.options.model, ['Veo 3.1', 'Gemini Omni'], 'model options come from Flow after the mode change');

  const next = await current.adapter.applySettings({ model: 'Gemini Omni', aspectRatio: '9:16' });
  assert.equal(next.current.model, 'Gemini Omni');
  assert.equal(next.current.aspectRatio, '9:16');
});

test('applySettings refuses a value Flow does not offer and lists what is available', async () => {
  await assert.rejects(current.adapter.applySettings({ mode: 'Audio' }), (error) => {
    assert.equal(error.code, 'FLOW_SETTING_FAILED');
    assert.match(error.message, /Image, Video|Available/);
    return true;
  });
  assert.equal(current.window.document.querySelector('[role="menu"]'), null, 'popover must close after a failure');
});

test('insertPrompt writes the exact text into a textarea and verifies it', async () => {
  const text = 'Wide establishing shot of a quiet harbour.\nSecond line with detail.';
  const result = await current.adapter.insertPrompt(text);
  assert.equal(result.verified, true);
  assert.equal(current.page.promptEl.value, text);
  assert.equal((await current.adapter.probe()).generateEnabled, true);
});

test('insertPrompt verifies rich-text prompt boxes as well', async () => {
  const rich = createPage({ variant: 'contenteditable' });
  const result = await rich.adapter.insertPrompt('A rich text prompt.');
  assert.equal(result.verified, true);
  assert.equal(rich.page.promptEl.textContent, 'A rich text prompt.');
});

test('attachReferences uses the Add > Upload path and confirms each file Flow shows', async () => {
  const payloads = [
    { name: 'Aron.png', mime: 'image/png', base64: Buffer.from('a').toString('base64') },
    { name: 'Laboratory.png', mime: 'image/png', base64: Buffer.from('b').toString('base64') },
  ];
  const result = await current.adapter.attachReferences(payloads);
  assert.equal(result.attached, 2);
  assert.deepEqual(current.page.state.references, ['Aron.png', 'Laboratory.png']);
});

test('clearReferences removes every reference chip and reports none remaining', async () => {
  await current.adapter.attachReferences([{ name: 'Vex.png', mime: 'image/png', base64: Buffer.from('v').toString('base64') }]);
  const result = await current.adapter.clearReferences();
  assert.equal(result.removed, 1);
  assert.equal(result.remaining, 0);
  assert.deepEqual(current.page.state.references, []);
});

test('submit refuses when Generate is disabled, with a message the user can act on', async () => {
  await assert.rejects(current.adapter.submit(), (error) => {
    assert.equal(error.code, 'GENERATE_UNAVAILABLE');
    assert.match(error.message, /disabled/);
    return true;
  });
  assert.deepEqual(current.page.state.submitted, []);
});

test('submit clicks Generate once the prompt is in place', async () => {
  await current.adapter.insertPrompt('A prompt to send.');
  const result = await current.adapter.submit();
  assert.equal(result.clicked, true);
  assert.deepEqual(current.page.state.submitted, ['A prompt to send.']);
});

test('generation status follows progress, then completion, using only NEW outputs', async () => {
  await current.adapter.insertPrompt('Scene one.');
  const baseline = await current.adapter.snapshotOutputs();
  assert.deepEqual(baseline.outputKeys, []);

  await current.adapter.submit();
  const inProgress = await current.adapter.generationStatus(baseline);
  assert.equal(inProgress.state, 'in_progress');
  assert.equal(inProgress.inProgress, true);
  assert.equal(inProgress.started, true);

  current.page.finishGeneration();
  const done = await current.adapter.generationStatus(baseline);
  assert.equal(done.state, 'completed');
  assert.equal(done.newOutputs, 1);
  assert.equal(done.inProgress, false);
});

test('an output that existed before submission does not count as completion', async () => {
  current.page.finishGeneration();
  const baseline = await current.adapter.snapshotOutputs();
  assert.equal(baseline.outputKeys.length, 1);
  await current.adapter.insertPrompt('Next scene.');
  await current.adapter.submit();
  const status = await current.adapter.generationStatus(baseline);
  assert.equal(status.state, 'in_progress');
  assert.equal(status.newOutputs, 0);
});

test('a new error message in Flow is reported as a failed generation with its text', async () => {
  await current.adapter.insertPrompt('A prompt that Flow rejects.');
  const baseline = await current.adapter.snapshotOutputs();
  await current.adapter.submit();
  current.page.failGeneration('Flow could not generate this image. Try a different prompt.');
  const status = await current.adapter.generationStatus(baseline);
  assert.equal(status.state, 'failed');
  assert.match(status.error.message, /could not generate/);
});

test('an error that was already on screen before the scene is not reported again', async () => {
  current.page.failGeneration('Old error from a previous scene.');
  const baseline = await current.adapter.snapshotOutputs();
  const status = await current.adapter.generationStatus(baseline);
  assert.equal(status.state, 'pending');
});

test('diagnose lists each check with a plain-language result', async () => {
  const report = await current.adapter.diagnose();
  const labels = report.checks.map((item) => item.label);
  assert.deepEqual(labels, ['Flow page', 'Project open', 'Prompt box', 'Generate button', 'Settings control', 'Agent mode', 'Page checks']);
  assert.ok(report.checks.every((item) => typeof item.detail === 'string' && item.detail.length > 0));
  assert.equal(report.checks.find((item) => item.label === 'Prompt box').ok, true);
});

test('handleFlowCommand returns errors as payloads instead of throwing into the page', async () => {
  const reply = await handleFlowCommand(current.adapter, 'submit', null);
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, 'GENERATE_UNAVAILABLE');
});

test('handleFlowCommand rejects commands the adapter does not provide', async () => {
  const reply = await handleFlowCommand(current.adapter, 'deleteEverything', null);
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, 'INVALID_INPUT');
});

test('ping answers with the adapter version so the worker can confirm the connector is loaded', async () => {
  const reply = await handleFlowCommand(current.adapter, 'ping', null);
  assert.equal(reply.ok, true);
  assert.equal(reply.data.ready, true);
});
