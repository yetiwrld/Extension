import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMAND_TIMEOUTS_MS, commandTimeoutMs } from '../src/background/flow-bridge.js';
import { DEFAULT_TIMINGS as PAGE_TIMINGS } from '../src/flow/adapter.js';
import { ATTACH_TIMEOUT_MS } from '../src/flow/references.js';

/*
 * The worker gives up on a Flow command once its limit passes. A limit shorter than the page's own
 * waits reports a step that is still working as failed. The run then pauses, and a retry can repeat
 * the step (for example, attach the same files twice). Each limit below must exceed the slowest wait
 * the page can take for that command.
 */

test('attaching references allows for the file picker and for every file in the batch', () => {
  const pickerWait = PAGE_TIMINGS.popoverMs * 10;
  for (const files of [1, 4, 12]) {
    const payloads = Array.from({ length: files }, () => ({}));
    const limit = commandTimeoutMs('attachReferences', payloads, 20000);
    assert.ok(limit > pickerWait + files * ATTACH_TIMEOUT_MS, `${files} files: ${limit} ms is not enough`);
  }
});

test('applying settings allows for opening and closing each menu, for all three settings and the final read', () => {
  // Per setting: open (up to three popover waits), settle, close (up to two). The final read opens and closes once.
  const perSetting = 5 * PAGE_TIMINGS.popoverMs + PAGE_TIMINGS.settleMs;
  const slowest = 3 * perSetting + 5 * PAGE_TIMINGS.popoverMs;
  assert.ok(COMMAND_TIMEOUTS_MS.applySettings > slowest, `${COMMAND_TIMEOUTS_MS.applySettings} ms is not enough for ${slowest} ms`);
});

test('reading settings allows for one open and one close', () => {
  const slowest = 5 * PAGE_TIMINGS.popoverMs;
  assert.ok(COMMAND_TIMEOUTS_MS.readSettings > slowest, `${COMMAND_TIMEOUTS_MS.readSettings} ms is not enough for ${slowest} ms`);
});

test('a status read still gives up quickly, so a page that has stopped responding is noticed', () => {
  assert.ok(commandTimeoutMs('generationStatus', null, 20000) <= 20000);
});
