import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunner } from './helpers.js';
import { STORAGE_KEYS } from '../src/storage/schema.js';
import { AutomationError, ERROR_CODES } from '../src/utils/errors.js';

const phaseOf = (store) => store.read(STORAGE_KEYS.automation).phase;

/** Make the next `count` status reads get no answer, the way a busy page does. */
function missAnswers(flow, count) {
  const original = flow.generationStatus;
  let remaining = count;
  flow.generationStatus = async (baseline) => {
    if (remaining > 0) {
      remaining -= 1;
      throw new AutomationError(ERROR_CODES.FLOW_NO_RESPONSE, 'Flow did not answer.');
    }
    return original(baseline);
  };
}

test('a status read that gets no answer is asked again, and the run carries on', async () => {
  const { runner, store, flow } = await createRunner({ flowScript: { pollsUntilDone: 2 } });
  missAnswers(flow, 1);
  await runner.start({ tabId: 7 });
  await runner.whenIdle();
  assert.equal(phaseOf(store), 'completed');
});

test('when Flow misses every answer in a row, the run pauses for the user instead of failing a scene', async () => {
  const { runner, store, flow } = await createRunner({ flowScript: { pollsUntilDone: 2 } });
  missAnswers(flow, 1000);
  await runner.start({ tabId: 7 });
  await runner.whenIdle();
  assert.equal(phaseOf(store), 'paused');
});
