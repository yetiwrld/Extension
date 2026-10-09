import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createFlowAdapter, handleFlowCommand } from '../src/flow/adapter.js';
import { insertPrompt } from '../src/flow/prompt.js';
import {
  candidateSummaries,
  collectPromptCandidates,
  countUnreachableFrames,
  findGenerateButton,
  findPromptBox,
  findPromptBoxWhenReady,
  findSettingsTrigger,
  isFlowPageUrl,
  requirePromptBox,
  selectPromptCandidate,
  selectorResults,
  summarizePromptRejections,
} from '../src/flow/selectors.js';
import { installFlowFixture } from './fixtures/flow-fixture.js';

/*
 * Prompt-composer detection. The composer is the one element every automation step
 * needs, so detection is pinned from every side the live page can differ: element
 * shape (textarea, input, contenteditable variants, role=textbox), layout (standard
 * vs Agent chat), timing (renders late), replacement (mode change), placement (shadow
 * root, iframe), and decoys (search fields, chat inputs, dialogs, disabled fields).
 *
 * These tests prove the detection logic on synthetic pages. They do NOT prove the live
 * Flow page matches; that needs the "Check Flow page" report from a signed-in session.
 */

const FLOW_URL = 'https://flow.google.com/project/abc123';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5)));
const timings = { settleMs: 0, popoverMs: 300 };

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

function fixturePage(options = {}, url = FLOW_URL) {
  const window = pageWith('', url);
  const page = installFlowFixture(window, options);
  const adapter = createFlowAdapter({ doc: window.document, location: new URL(url), sleep, timings });
  return { window, page, adapter };
}

const STANDARD_TOOLBAR = `
  <div id="prompt-box">
    <button id="add" aria-haspopup="menu">+ Add</button>
    <button id="model" aria-haspopup="menu">Nano Banana Pro \u25be</button>
    <button id="agent" role="switch" aria-checked="false">Agent</button>
  </div>`;

// ---------------------------------------------------------------------------
// Element shapes
// ---------------------------------------------------------------------------

test('standard layout: a textarea in a toolbar region is the composer', () => {
  const { window } = fixturePage();
  const prompt = findPromptBox(window.document);
  assert.equal(prompt.el.id, 'prompt');
  assert.equal(prompt.kind, 'textarea');
  assert.equal(prompt.strategy, 'composer-textarea-by-region');
  assert.equal(prompt.enabled, true);
  assert.equal(prompt.ambiguous, false);
  assert.ok(prompt.reasons.some((reason) => /Generate\/Send control/.test(reason)), prompt.reasons.join('; '));
});

test('a single-line input composer is detected (chat-style shapes)', () => {
  const { window } = fixturePage({ variant: 'input' });
  const prompt = findPromptBox(window.document);
  assert.equal(prompt.el.id, 'prompt');
  assert.equal(prompt.kind, 'input');
  assert.equal(prompt.strategy, 'composer-input-by-region');
});

test('contenteditable="plaintext-only" is detected, not just "true" and ""', () => {
  const { window } = fixturePage({ variant: 'plaintext-only' });
  const prompt = findPromptBox(window.document);
  assert.equal(prompt.kind, 'contenteditable');
  assert.equal(prompt.el.getAttribute('contenteditable'), 'plaintext-only');
});

test('a role=textbox element without contenteditable is still a candidate', () => {
  const window = pageWith(`
    <div id="prompt-box">
      <div id="prompt" role="textbox" aria-label="Describe your video"></div>
      <button aria-label="Generate">Generate</button>
      <button aria-label="Add">+ Add</button>
    </div>`);
  const prompt = findPromptBox(window.document);
  assert.ok(prompt, 'the textbox role alone identifies the composer');
  assert.equal(prompt.kind, 'textbox');
});

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

test('Agent layout: the chat input is the composer, and Agent is reported on', async () => {
  const { window, adapter } = fixturePage({ variant: 'agent' });
  const probe = await adapter.probe();
  assert.equal(probe.promptFound, true, 'the Agent chat input is detected as the composer');
  assert.equal(probe.promptStrategy, 'composer-input-by-region');
  assert.equal(probe.composerLayout, 'agent');
  assert.equal(probe.agentOn, true);
  assert.equal(probe.agentFound, true);
  // The Send control is what starts a run in this layout.
  assert.equal(probe.generateFound, true);
  assert.equal(probe.generateStrategy, 'send-in-prompt-region');
  // Settings discovery still works around the chat composer.
  assert.equal(probe.settingsFound, true);
  assert.equal(probe.detectedSettings.model, 'Nano Banana Pro');
  assert.equal(window.document.getElementById('prompt'), probe.promptCandidates.find((c) => c.tag === 'input' && !c.rejection)?.el ?? window.document.getElementById('prompt'));
});

test('Agent layout: insertPrompt types into the chat input', async () => {
  const { adapter } = fixturePage({ variant: 'agent' });
  const result = await adapter.insertPrompt('A scene about a lighthouse at dusk.');
  assert.equal(result.verified, true);
  assert.equal(result.strategy, 'composer-input-by-region');
});

test('standard layout with an unrelated chat input in a sidebar: the workspace composer wins', () => {
  const window = pageWith(`
    <aside>
      <input type="text" aria-label="Chat with support" placeholder="Ask anything">
      <button aria-label="Send">Send</button>
    </aside>
    <div id="prompt-box">
      ${STANDARD_TOOLBAR}
      <textarea id="prompt" placeholder="Describe your image or video"></textarea>
      <button aria-label="Generate">Generate</button>
    </div>`);
  const prompt = findPromptBox(window.document);
  assert.equal(prompt.el.id, 'prompt', 'the workspace composer, not the sidebar chat input');
  const candidates = collectPromptCandidates(window.document);
  const chat = candidates.find((candidate) => candidate.name === 'Chat with support');
  assert.ok(chat, 'the chat input is listed as a candidate');
  assert.match(chat.rejection, /page furniture/, 'rejected as sidebar furniture');
});

// ---------------------------------------------------------------------------
// Timing and replacement
// ---------------------------------------------------------------------------

test('delayed composer rendering: detection waits and finds it', async () => {
  const window = pageWith('<div id="prompt-box"></div>');
  setTimeout(() => {
    const area = window.document.createElement('textarea');
    area.id = 'prompt';
    area.setAttribute('placeholder', 'Describe your image or video');
    window.document.getElementById('prompt-box').append(area);
  }, 30);
  assert.equal(findPromptBox(window.document), null, 'nothing to find before it renders');
  const adapter = createFlowAdapter({ doc: window.document, location: window.location, sleep, timings, waits: { composerMs: 1000 } });
  const probe = await adapter.probe();
  assert.equal(probe.promptFound, true, 'the late composer is found after a bounded wait');
  assert.equal(probe.workspaceDetected, true);
});

test('the fixture late variant renders the composer after install', async () => {
  const { window, adapter } = fixturePage({ variant: 'late' });
  assert.equal(findPromptBox(window.document), null, 'not there yet');
  const found = await findPromptBoxWhenReady(window.document, { timeoutMs: 1000, intervalMs: 20, sleep });
  assert.ok(found, 'found once it renders');
  const probe = await adapter.probe();
  assert.equal(probe.promptFound, true);
});

test('composer replacement after a mode change: the new element is used, never a stale one', async () => {
  const { window, page, adapter } = fixturePage();
  const oldPrompt = window.document.getElementById('prompt');
  // Flow replaces the composer (mode change / rerender): the old node is detached.
  const fresh = window.document.createElement('textarea');
  fresh.id = 'prompt';
  fresh.setAttribute('placeholder', 'Describe your image or video');
  oldPrompt.replaceWith(fresh);

  const prompt = findPromptBox(window.document);
  assert.equal(prompt.el, fresh, 'detection returns the current element');
  assert.notEqual(prompt.el, oldPrompt);

  const result = await adapter.insertPrompt('The replacement composer must receive the prompt.');
  assert.equal(result.verified, true);
  assert.equal(fresh.value, 'The replacement composer must receive the prompt.');
  assert.equal(page.state.submitted.length, 0, 'nothing was submitted during the check');
});

test('insertPrompt re-queries when the composer is replaced mid-write', async () => {
  const { window, adapter } = fixturePage();
  const original = window.document.getElementById('prompt');
  // Replace the composer while the first write is being verified: the retry must
  // land on the fresh element, not write into a detached node.
  const originalValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
  let writes = 0;
  Object.defineProperty(window.HTMLTextAreaElement.prototype, 'value', {
    configurable: true,
    get: originalValue.get,
    set(value) {
      writes += 1;
      if (writes === 1) {
        const fresh = window.document.createElement('textarea');
        fresh.id = 'prompt';
        fresh.setAttribute('placeholder', 'Describe your image or video');
        original.replaceWith(fresh);
      }
      originalValue.set.call(this, value);
    },
  });
  try {
    const result = await adapter.insertPrompt('Scene prompt that must survive a rerender.');
    assert.equal(result.verified, true);
    const current = window.document.getElementById('prompt');
    assert.notEqual(current, original, 'the composer was replaced');
    assert.equal(current.value, 'Scene prompt that must survive a rerender.');
  } finally {
    Object.defineProperty(window.HTMLTextAreaElement.prototype, 'value', originalValue);
  }
});

// ---------------------------------------------------------------------------
// No composer / decoys / disambiguation
// ---------------------------------------------------------------------------

test('no prompt field: detection fails with an actionable error that names the fields found', () => {
  const window = pageWith(`
    <header><input type="search" role="searchbox" aria-label="Search Flow" placeholder="Search"></header>
    <div id="prompt-box"><button aria-label="Generate">Generate</button></div>`);
  assert.equal(findPromptBox(window.document), null);
  assert.throws(
    () => requirePromptBox(window.document),
    (error) => {
      assert.equal(error.code, 'FLOW_UI_CHANGED');
      assert.match(error.message, /Flow prompt box not found/);
      assert.match(error.message, /search field/, 'the search box is named as the reason it was rejected');
      assert.match(error.message, /Check Flow page/);
      return true;
    },
  );
});

test('no text entry at all: the error says so plainly', () => {
  const window = pageWith('<div id="prompt-box"><button aria-label="Generate">Generate</button></div>');
  assert.throws(
    () => requirePromptBox(window.document),
    /no text-entry element exists on this page/,
  );
});

test('multiple candidates: search, dialog and header fields are rejected by role and ancestry', () => {
  const window = pageWith(`
    <header><input type="text" aria-label="Search projects" placeholder="Search"></header>
    <div role="dialog" aria-label="New project">
      <textarea aria-label="Describe your video"></textarea>
      <button>Create</button>
    </div>
    <div id="prompt-box">
      ${STANDARD_TOOLBAR}
      <textarea id="prompt" placeholder="Describe your image or video"></textarea>
      <button aria-label="Generate">Generate</button>
    </div>`);
  const prompt = findPromptBox(window.document);
  assert.equal(prompt.el.id, 'prompt');
  const candidates = collectPromptCandidates(window.document);
  assert.equal(candidates.length, 3, 'all three fields are listed');
  const byLabel = Object.fromEntries(candidates.map((candidate) => [candidate.name, candidate]));
  assert.match(byLabel['Search projects'].rejection, /page furniture/);
  assert.match(byLabel['Describe your video'].rejection, /inside a dialog/);
  assert.equal(byLabel['Describe your image or video'].rejection, null);
});

test('a disabled composer is detected and reported as disabled, not as missing', async () => {
  const { window, adapter } = fixturePage();
  window.document.getElementById('prompt').disabled = true;
  const prompt = findPromptBox(window.document);
  assert.ok(prompt, 'still detected');
  assert.equal(prompt.enabled, false);
  const probe = await adapter.probe();
  assert.equal(probe.promptFound, true);
  assert.equal(probe.promptEnabled, false);
  await assert.rejects(
    () => adapter.insertPrompt('text'),
    (error) => {
      assert.equal(error.code, 'PROMPT_INSERT_FAILED');
      assert.match(error.message, /disabled/);
      return true;
    },
  );
});

test('ambiguous candidates are reported, not silently resolved', () => {
  const window = pageWith(`
    <div id="one"><textarea id="prompt-a" placeholder="Describe your image or video"></textarea><button aria-label="Generate">Generate</button><button aria-label="Add">+ Add</button></div>
    <div id="two"><textarea id="prompt-b" placeholder="Describe your image or video"></textarea><button aria-label="Generate">Generate</button><button aria-label="Add">+ Add</button></div>`);
  const prompt = findPromptBox(window.document);
  assert.ok(prompt);
  assert.equal(prompt.ambiguous, true, 'two equal candidates are flagged');
  const probeCandidates = candidateSummaries(collectPromptCandidates(window.document));
  assert.equal(probeCandidates.filter((candidate) => !candidate.rejection).length, 2);
});

// ---------------------------------------------------------------------------
// Placement: shadow DOM and frames
// ---------------------------------------------------------------------------

test('a composer inside a shadow root is found, with its shadow toolbar', () => {
  const window = pageWith('<div id="prompt-box"></div>');
  const host = window.document.createElement('flow-composer');
  window.document.getElementById('prompt-box').append(host);
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <div class="toolbar">
      <button id="add" aria-haspopup="menu">+ Add</button>
      <button id="model" aria-haspopup="menu">Nano Banana Pro \u25be</button>
    </div>
    <textarea id="prompt" placeholder="Describe your image or video"></textarea>
    <button id="generate" aria-label="Generate">Generate</button>`;
  const prompt = findPromptBox(window.document);
  assert.ok(prompt, 'the shadow composer is found');
  assert.equal(prompt.el.id, 'prompt');
  assert.equal(prompt.strategy, 'composer-textarea-in-shadow-root-by-region');
  // Region relationships cross the shadow boundary: the shadow Generate button is found.
  const generate = findGenerateButton(window.document, prompt.el);
  assert.ok(generate, 'the Generate button inside the shadow root is found');
  assert.equal(generate.el.id, 'generate');
  const trigger = findSettingsTrigger(window.document, prompt.el);
  assert.ok(trigger, 'the settings trigger inside the shadow root is found');
  assert.equal(trigger.el.id, 'model');
});

test('a composer inside a same-origin iframe is found and tagged with its frame', async () => {
  const window = pageWith('<div id="host"></div>');
  const frame = window.document.createElement('iframe');
  frame.id = 'workspace';
  window.document.getElementById('host').append(frame);
  const frameDoc = frame.contentDocument;
  // jsdom gives every frame its own window: the visibility stubs must be applied there too.
  frameDoc.defaultView.Element.prototype.getClientRects = function getClientRects() {
    return [{ width: 200, height: 200, top: 0, left: 0, right: 200, bottom: 200 }];
  };
  frameDoc.defaultView.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { width: 200, height: 200, top: 0, left: 0, right: 200, bottom: 200, x: 0, y: 0 };
  };
  frameDoc.body.innerHTML = `
    <div id="prompt-box">
      <button aria-haspopup="menu">Nano Banana Pro \u25be</button>
      <textarea id="prompt" placeholder="Describe your image or video"></textarea>
      <button aria-label="Generate">Generate</button>
    </div>`;
  const prompt = findPromptBox(window.document);
  assert.ok(prompt, 'the composer in the frame is found');
  assert.equal(prompt.strategy, 'composer-textarea-in-frame-by-region');
  const candidate = collectPromptCandidates(window.document).find((item) => item.tag === 'textarea');
  assert.equal(candidate.frame, 'iframe#workspace');

  const adapter = createFlowAdapter({ doc: window.document, location: window.location, sleep, timings });
  const probe = await adapter.probe();
  assert.equal(probe.promptFound, true);
  assert.equal(probe.frames.inspected, 2, 'top document plus the frame');
  assert.equal(probe.frames.unreachable, 0);
});

test('a frame the extension cannot reach is counted, never guessed at', async () => {
  const window = pageWith('<div id="host"></div>');
  const frame = window.document.createElement('iframe');
  window.document.getElementById('host').append(frame);
  // A cross-origin frame exposes no contentDocument to this frame.
  Object.defineProperty(frame, 'contentDocument', { configurable: true, get: () => null });
  assert.equal(countUnreachableFrames(window.document), 1);
  const adapter = createFlowAdapter({ doc: window.document, location: window.location, sleep, timings });
  const probe = await adapter.probe();
  assert.equal(probe.frames.unreachable, 1);
  assert.equal(probe.promptFound, false, 'no composer is invented for the unreachable frame');
});

// ---------------------------------------------------------------------------
// Evidence and privacy
// ---------------------------------------------------------------------------

test('candidate evidence: shapes, labels, geometry, verdicts — and never the field content', () => {
  const window = pageWith(`
    <header><input type="search" role="searchbox" aria-label="Search Flow"></header>
    <div id="prompt-box">
      ${STANDARD_TOOLBAR}
      <textarea id="prompt" placeholder="Describe your image or video">SECRET USER PROMPT TEXT</textarea>
      <button aria-label="Generate">Generate</button>
    </div>`);
  const summaries = candidateSummaries(collectPromptCandidates(window.document));
  assert.equal(summaries.length, 2);
  const composer = summaries.find((candidate) => candidate.tag === 'textarea');
  assert.equal(composer.rejection, null);
  assert.equal(composer.visible, true);
  assert.equal(composer.disabled, false);
  assert.ok(composer.rect.width > 0 && composer.rect.height > 0);
  assert.equal(composer.frame, 'top');
  const search = summaries.find((candidate) => candidate.tag === 'input');
  assert.match(search.rejection, /search field/);
  const serialized = JSON.stringify(summaries);
  assert.equal(serialized.includes('SECRET USER PROMPT TEXT'), false, 'the prompt text never reaches the report');
  assert.equal(serialized.includes('"el"'), false, 'no element references cross the message boundary');
});

test('the not-found error never contains prompt text either', () => {
  const window = pageWith(`
    <div role="dialog"><textarea aria-label="Describe">SECRET DIALOG PROMPT</textarea></div>`);
  assert.throws(
    () => requirePromptBox(window.document),
    (error) => {
      assert.equal(error.message.includes('SECRET DIALOG PROMPT'), false);
      assert.match(error.message, /inside a dialog/);
      return true;
    },
  );
});

test('selector results report which composer selectors matched, per scope', () => {
  const window = pageWith(`
    <div id="prompt-box">
      ${STANDARD_TOOLBAR}
      <textarea id="prompt" placeholder="Describe your image or video"></textarea>
      <input type="text" aria-label="Nickname">
      <button aria-label="Generate">Generate</button>
    </div>`);
  const rows = selectorResults(window.document);
  const bySelector = Object.fromEntries(rows.map((row) => [row.selector, row]));
  assert.equal(bySelector.textarea.matched, 1);
  assert.equal(bySelector.textarea.visible, 1);
  assert.equal(bySelector['text-like input'].matched, 1);
  assert.equal(bySelector['role=textbox'].matched, 0, 'no role=textbox on this page: the selector ran and failed');
  assert.ok(rows.every((row) => row.scope === 'top'));
});

test('isFlowPageUrl accepts the supported Flow hosts only', () => {
  assert.equal(isFlowPageUrl({ href: 'https://flow.google.com/project/abc' }), true);
  assert.equal(isFlowPageUrl({ href: 'https://labs.google/fx/tools/flow' }), true);
  assert.equal(isFlowPageUrl({ href: 'https://example.com/project/abc' }), false);
  assert.equal(isFlowPageUrl({ href: 'http://flow.google.com/' }), false);
  assert.equal(isFlowPageUrl(null), false);
});

test('summarizePromptRejections lists each rejected field with its reason', () => {
  const window = pageWith(`
    <header><input type="search" role="searchbox" aria-label="Search Flow"></header>
    <div role="dialog"><textarea readonly aria-label="Locked notes"></textarea></div>`);
  const summary = summarizePromptRejections(collectPromptCandidates(window.document));
  assert.match(summary, /search field/);
  assert.match(summary, /read-only/);
  assert.equal(summarizePromptRejections([]), 'no text-entry element exists on this page');
});

test('selectPromptCandidate ignores invisible and rejected candidates', () => {
  const window = pageWith(`
    <textarea id="hidden" placeholder="Describe" style="display:none"></textarea>
    <header><input type="text" aria-label="Search Flow"></header>
    <div id="prompt-box">
      ${STANDARD_TOOLBAR}
      <textarea id="prompt" placeholder="Describe your image or video"></textarea>
      <button aria-label="Generate">Generate</button>
    </div>`);
  const candidates = collectPromptCandidates(window.document);
  const prompt = selectPromptCandidate(candidates);
  assert.equal(prompt.el.id, 'prompt');
  const hidden = candidates.find((candidate) => candidate.tag === 'textarea' && candidate.name === 'Describe');
  assert.equal(hidden.visible, false, 'the display:none field is listed but not selected');
  assert.equal(hidden.rejection, 'not visible');
});

// ---------------------------------------------------------------------------
// Adapter-level behaviour
// ---------------------------------------------------------------------------

test('probe on a page without a composer reports the candidates and the rejections', async () => {
  const window = pageWith(`
    <header><input type="search" role="searchbox" aria-label="Search Flow"></header>
    <div id="prompt-box"><button aria-label="Generate">Generate</button></div>`, 'https://flow.google.com/project/abc123');
  const adapter = createFlowAdapter({ doc: window.document, location: window.location, sleep, timings, waits: { composerMs: 50 } });
  const probe = await adapter.probe();
  assert.equal(probe.promptFound, false);
  assert.equal(probe.workspaceDetected, false);
  assert.equal(probe.isProjectPage, true);
  assert.equal(probe.flowPage, true);
  assert.equal(probe.promptCandidates.length, 1);
  assert.match(probe.promptCandidates[0].rejection, /search field/);
  assert.equal(probe.generateFound, true, 'Generate is still found document-wide');
  assert.equal(probe.composerLayout, null);

  const report = await adapter.diagnose();
  const promptCheck = report.checks.find((check) => check.label === 'Prompt box');
  assert.equal(promptCheck.ok, false);
  assert.match(promptCheck.detail, /1 text field\(s\) on the page/);
  assert.match(promptCheck.detail, /search field/);
  const projectCheck = report.checks.find((check) => check.label === 'Project open');
  assert.equal(projectCheck.ok, true);
});

test('diagnose marks a workspace on a non-project URL as a warning, not a failure', async () => {
  const { window, adapter } = fixturePage({}, 'https://flow.google.com/');
  const report = await adapter.diagnose();
  const projectCheck = report.checks.find((check) => check.label === 'Project open');
  assert.equal(projectCheck.ok, false);
  assert.equal(projectCheck.warn, true, 'a workspace is open even though the URL is not /project/');
  assert.match(projectCheck.detail, /Workspace composer detected: yes/);
  assert.equal(report.promptFound, true);
});

test('an adapter failure is returned as an error payload, never a hang', async () => {
  const window = pageWith('<div></div>');
  const hostileDoc = {
    readyState: 'complete',
    querySelectorAll() {
      throw new Error('the DOM is gone');
    },
  };
  const adapter = createFlowAdapter({ doc: hostileDoc, location: window.location, sleep, timings });
  const reply = await handleFlowCommand(adapter, 'readSettings', null);
  assert.equal(reply.ok, false);
  assert.equal(reply.error.code, 'UNKNOWN', 'an unexpected crash keeps its message and a stable code');
  assert.match(reply.error.message, /the DOM is gone/);
});

test('insertPrompt verifies against Flow, not against the extension\u2019s own state', async () => {
  const { window, adapter } = fixturePage();
  const result = await adapter.insertPrompt('  A padded prompt.  ');
  assert.equal(result.verified, true, 'whitespace differences are tolerated');
  assert.equal(window.document.getElementById('prompt').value, '  A padded prompt.  ', 'the text is inserted verbatim');
});
