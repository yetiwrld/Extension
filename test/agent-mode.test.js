import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createFlowAdapter } from '../src/flow/adapter.js';
import {
  findAgentModeChip,
  findComposerHosts,
  findSettingsTriggerButton,
  isAgentModeOn,
} from '../src/flow/selectors.js';
import { installFlowFixture } from './fixtures/flow-fixture.js';

/*
 * The migrated Agent-mode state (verified against the live DOM by an independent
 * automation project, gflow-cli #749/#751):
 *
 *   chip aria-pressed=false  →  flow-prompt-box, .settings-trigger-button visible
 *   chip aria-pressed=true   →  flow-creative-agent-prompt-box,
 *                               .settings-trigger-button HIDDEN (display:none, 0x0)
 *
 * Flow remembers the chip per account, so a run can land in Agent mode with the
 * classic settings trigger dead in the DOM. The recovery: click the EXACT pressed
 * chip once, verify the state change and the classic composer's return, then retry.
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

function agentPage(options = {}) {
  const window = pageWith('', FLOW_URL);
  const page = installFlowFixture(window, { agentMode: true, ...options });
  const adapter = createFlowAdapter({ doc: window.document, location: new URL(FLOW_URL), sleep, timings });
  return { window, page, adapter };
}

// ---------------------------------------------------------------------------
// The chip detection (exact, state-guarded)
// ---------------------------------------------------------------------------

test('the agent-mode chip is found with its pressed state', () => {
  const { window } = agentPage();
  const chip = findAgentModeChip(window.document);
  assert.ok(chip, 'the chip is found');
  assert.equal(chip.pressed, true);
  assert.equal(chip.visible, true);
  assert.equal(chip.enabled, true);
  assert.equal(isAgentModeOn(window.document), true);
});

test('the exact pressed selector only matches when there is something to undo', () => {
  const window = pageWith(`
    <div>
      <button class="agent-mode-chip" aria-pressed="false">Agent</button>
      <button aria-pressed="true">A DECOY generic pressed button</button>
    </div>`);
  assert.equal(isAgentModeOn(window.document), false, 'an unpressed chip is not agent mode');
  const chip = findAgentModeChip(window.document);
  assert.equal(chip.pressed, false);
  assert.equal(window.document.querySelectorAll('button[aria-pressed="true"]').length, 1, 'the decoy exists but is not the chip');
});

test('the composer hosts and the settings-button state are reported', () => {
  const { window } = agentPage();
  const hosts = findComposerHosts(window.document);
  assert.equal(hosts.classic.exists, true);
  assert.equal(hosts.classic.visible, false, 'the classic composer is hidden in Agent mode');
  assert.equal(hosts.agent.exists, true);
  assert.equal(hosts.agent.visible, true, 'the agent composer is the visible one');
  assert.equal(hosts.agent.tag, 'flow-creative-agent-prompt-box');
  const button = findSettingsTriggerButton(window.document);
  assert.equal(button.exists, true);
  assert.equal(button.hidden, true, 'the classic settings trigger is hidden');
  assert.equal(button.visible, false);
  assert.equal(button.tag, 'button');
});

// ---------------------------------------------------------------------------
// The recovery: readSettings leaves Agent mode and retries
// ---------------------------------------------------------------------------

test('readSettings recovers from Agent mode: one chip click, verified, then the menu opens', async () => {
  const { adapter, page, window } = agentPage();
  const result = await adapter.readSettings();
  assert.equal(result.current.mode, 'Image');
  assert.equal(result.current.model, 'Nano Banana Pro');
  const recovery = result.agentModeRecovery;
  assert.ok(recovery, 'the recovery is reported on the result');
  assert.equal(recovery.attempted, true);
  assert.equal(recovery.clicked, true);
  assert.equal(recovery.stateChanged, true, 'the chip flipped to unpressed');
  assert.equal(recovery.classicComposerBack, true, 'the classic composer and its controls returned');
  assert.equal(page.state.agentChipClicks(), 1, 'the chip was clicked exactly once');
  assert.equal(window.document.getElementById('agent-mode-chip').getAttribute('aria-pressed'), 'false');
  assert.equal(window.document.getElementById('classic-box').hidden, false, 'the classic composer is visible again');
  assert.equal(window.document.getElementById('settings-btn').hidden, false, 'the settings trigger is back');
  assert.equal(window.document.querySelector('[role="menu"]'), null, 'the menu was closed after the read');
});

test('applySettings recovers from Agent mode too', async () => {
  const { adapter, page } = agentPage();
  const result = await adapter.applySettings({ aspectRatio: '1:1' });
  assert.equal(result.current.aspectRatio, '1:1');
  assert.ok(result.agentModeRecovery?.classicComposerBack, 'the recovery ran before the settings change');
  assert.equal(page.state.agentChipClicks(), 1);
});

test('the recovery is self-guarding: an unpressed chip is never clicked', async () => {
  // A healthy composer (chip present but NOT pressed) whose menu will not open:
  // the recovery must not toggle the user's UI into Agent mode.
  const window = pageWith(`
    <main>
      <div id="prompt-box">
        <button id="settings-btn" class="settings-trigger-button" aria-haspopup="menu"><span class="model-chip">Nano Banana Pro \u25be</span></button>
        <button class="agent-mode-chip" id="chip" aria-pressed="false" aria-label="Agent">Agent</button>
        <textarea id="prompt" placeholder="What do you want to create?"></textarea>
        <button id="generate" aria-label="Generate">Generate</button>
      </div>
    </main>`);
  let chipClicks = 0;
  window.document.getElementById('chip').addEventListener('click', () => {
    chipClicks += 1;
  });
  const adapter = createFlowAdapter({ doc: window.document, location: window.location, sleep, timings });
  await assert.rejects(
    () => adapter.readSettings(),
    (error) => {
      assert.equal(error.code, 'FLOW_UI_CHANGED');
      assert.match(error.message, /did not open/);
      return true;
    },
  );
  assert.equal(chipClicks, 0, 'the unpressed chip was never clicked');
  assert.equal(window.document.getElementById('chip').getAttribute('aria-pressed'), 'false');
});

test('a generic pressed button is never clicked by the recovery', async () => {
  const { adapter, window } = agentPage();
  // Add a decoy: a generic pressed button next to the real chip.
  const decoy = window.document.createElement('button');
  decoy.setAttribute('aria-pressed', 'true');
  decoy.textContent = 'Decoy';
  window.document.getElementById('agent-box').append(decoy);
  let decoyClicks = 0;
  decoy.addEventListener('click', () => {
    decoyClicks += 1;
  });
  await adapter.readSettings();
  assert.equal(decoyClicks, 0, 'the decoy was never clicked');
});

test('a stuck chip produces a clear diagnostic, never a false success', async () => {
  const { adapter, page } = agentPage({ agentChipStuck: true });
  await assert.rejects(
    () => adapter.readSettings(),
    (error) => {
      assert.equal(error.code, 'FLOW_AGENT_ON');
      assert.match(error.message, /Agent mode is on in Flow \(button\.agent-mode-chip is pressed\)/);
      assert.match(error.message, /could not leave it: the chip did not change state after the click/);
      assert.match(error.message, /Turn off Agent mode in Flow, then retry/);
      return true;
    },
  );
  assert.equal(page.state.agentChipClicks(), 1, 'one click was attempted, not blind retries');
});

// ---------------------------------------------------------------------------
// The probe and the diagnostic report the Agent-mode state
// ---------------------------------------------------------------------------

test('probe reports the agent-mode state and the composer hosts', async () => {
  const { adapter } = agentPage();
  const probe = await adapter.probe();
  assert.equal(probe.agentMode.chipFound, true);
  assert.equal(probe.agentMode.chipPressed, true);
  assert.equal(probe.agentMode.composer, 'agent');
  assert.equal(probe.agentMode.classicVisible, false);
  assert.equal(probe.agentMode.agentVisible, true);
  assert.equal(probe.agentMode.composerHosts.classic.exists, true);
  assert.equal(probe.agentMode.composerHosts.agent.tag, 'flow-creative-agent-prompt-box');
  assert.equal(probe.agentOn, true);
  // The composer area carries the same facts.
  assert.equal(probe.composerArea.agentChip.exists, true);
  assert.equal(probe.composerArea.agentChip.pressed, true);
  assert.equal(probe.composerArea.settingsButton.exists, true);
  assert.equal(probe.composerArea.settingsButton.hidden, true);
  assert.equal(probe.composerArea.composerHosts.agent.visible, true);
});

test('diagnose names Agent mode in the Agent mode check', async () => {
  const { adapter } = agentPage();
  const report = await adapter.diagnose();
  const agentCheck = report.checks.find((item) => item.label === 'Agent mode');
  assert.equal(agentCheck.ok, false);
  assert.match(agentCheck.detail, /button\.agent-mode-chip is pressed/);
  assert.match(agentCheck.detail, /leaves Agent mode automatically/);
});

test('after recovery the probe reports the classic composer and agent mode off', async () => {
  const { adapter, window } = agentPage();
  await adapter.readSettings();
  const probe = await adapter.probe();
  assert.equal(probe.agentMode.composer, 'classic');
  assert.equal(probe.agentMode.chipPressed, false);
  assert.equal(probe.composerArea.settingsButton.hidden, false);
  assert.equal(window.document.getElementById('classic-box').hidden, false);
});

// ---------------------------------------------------------------------------
// Regression: the normal composer is untouched
// ---------------------------------------------------------------------------

test('the normal composer (no agent chip) reads settings without any recovery', async () => {
  const window = pageWith('', FLOW_URL);
  installFlowFixture(window, {});
  const adapter = createFlowAdapter({ doc: window.document, location: new URL(FLOW_URL), sleep, timings });
  const result = await adapter.readSettings();
  assert.equal(result.current.mode, 'Image');
  assert.equal(result.agentModeRecovery, undefined, 'no recovery ran on a healthy composer');
});
