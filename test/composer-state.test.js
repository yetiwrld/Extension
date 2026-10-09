import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createFlowAdapter } from '../src/flow/adapter.js';
import { classifyComposerState } from '../src/flow/selectors.js';
import { ERROR_CODES } from '../src/utils/errors.js';
import { installFlowFixture } from './fixtures/flow-fixture.js';
import { formatDiagnosticsReport } from '../src/sidepanel/diagnostics.js';

/*
 * Which of the three researched Flow interface states the page is in is decided
 * from measured facts, once, before anything is clicked:
 *   A  recoverable migrated composer (pressed agent chip + hidden classic trigger)
 *   B  agent-only composer (no usable toggle, agent composer is the only one)
 *   C  standard composer whose control does not behave
 */

const FLOW_URL = 'https://flow.google.com/project/abc123';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5)));
const timings = { settleMs: 0, popoverMs: 200 };

function page(options) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: FLOW_URL, pretendToBeVisual: true });
  const { window } = dom;
  window.Element.prototype.getClientRects = () => [{ width: 200, height: 200, top: 0, left: 0, right: 200, bottom: 200 }];
  window.Element.prototype.getBoundingClientRect = () => ({ width: 200, height: 200, top: 0, left: 0, right: 200, bottom: 200, x: 0, y: 0 });
  installFlowFixture(window, options);
  const adapter = createFlowAdapter({ doc: window.document, location: new URL(FLOW_URL), sleep, timings });
  return { window, adapter };
}

test('a normal Flow composer classifies as the standard state', () => {
  const { window } = page({});
  const state = classifyComposerState(window.document);
  assert.equal(state.state, 'standard');
  assert.equal(state.activeComposer, null, 'no flow-* composer host in the classic fixture');
  assert.ok(state.evidence.some((line) => line.includes('resolved settings trigger: found')));
});

test('Agent mode with a hidden classic trigger classifies as state A (recoverable)', () => {
  const { window } = page({ agentMode: true });
  const state = classifyComposerState(window.document);
  assert.equal(state.state, 'A');
  assert.equal(state.chip.pressed, true);
  assert.equal(state.settingsButton.exists, true);
  assert.equal(state.settingsButton.visible, false);
  assert.equal(state.activeComposer, 'agent');
});

test('an agent-only composer with no toggle classifies as state B', () => {
  const { window } = page({ agentOnly: true });
  const state = classifyComposerState(window.document);
  assert.equal(state.state, 'B');
  assert.equal(state.chip, null);
  assert.equal(state.activeComposer, 'agent');
});

test('state B is reported truthfully instead of retrying the old selectors', async () => {
  const { adapter } = page({ agentOnly: true });
  await assert.rejects(
    () => adapter.readSettings(),
    (error) => {
      assert.equal(error.code, ERROR_CODES.FLOW_AGENT_ONLY);
      assert.match(error.message, /only its Agent composer/i);
      assert.match(error.message, /cannot set the model, mode, aspect ratio or output count/i);
      return true;
    },
  );
});

test('the diagnostic names the composer state and its consequence', async () => {
  const { adapter } = page({ agentOnly: true });
  const diagnostics = await adapter.diagnose();
  assert.equal(diagnostics.composerState.state, 'B');
  const check = diagnostics.checks.find((item) => item.label === 'Composer state');
  assert.ok(check && !check.ok, 'state B is not reported as a passing check');
  const report = formatDiagnosticsReport(diagnostics);
  assert.match(report, /Composer state: B/);
  assert.match(report, /cannot set model, mode, aspect ratio or output count/i);
});
