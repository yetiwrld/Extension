import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCENE_STATUS,
  assertSceneTransition,
  assertSessionTransition,
  canSceneTransition,
  canSessionTransition,
} from '../src/queue/states.js';
import { awaitFlowIdle, awaitGenerationSettled, awaitSubmissionAccepted } from '../src/queue/completion.js';
import { virtualClock } from './helpers.js';
import { AutomationError } from '../src/utils/errors.js';

const S = SCENE_STATUS;

test('the sequential scene path is allowed', () => {
  const path = [S.WAITING, S.PREPARING, S.UPLOADING, S.INSERTING, S.SUBMITTING, S.GENERATING, S.DOWNLOADING, S.COMPLETED];
  for (let i = 0; i < path.length - 1; i += 1) {
    assert.ok(canSceneTransition(path[i], path[i + 1]), `${path[i]} -> ${path[i + 1]}`);
  }
});

test('a scene cannot jump from generating to waiting or back to preparing without a result', () => {
  assert.equal(canSceneTransition(S.GENERATING, S.WAITING), false);
  assert.equal(canSceneTransition(S.GENERATING, S.PREPARING), false);
  assert.equal(canSceneTransition(S.GENERATING, S.SKIPPED), false);
});

test('a submitted scene cannot be paused, only completed, failed, or left in flight', () => {
  assert.equal(canSceneTransition(S.SUBMITTING, S.PAUSED), false);
  assert.equal(canSceneTransition(S.SUBMITTING, S.GENERATING), true);
  assert.equal(canSceneTransition(S.SUBMITTING, S.FAILED), true);
});

test('COMPLETED requires observed evidence', () => {
  assert.throws(() => assertSceneTransition(S.GENERATING, S.COMPLETED), (error) => {
    assert.ok(error instanceof AutomationError);
    assert.equal(error.code, 'INVALID_STATE');
    return true;
  });
  assert.doesNotThrow(() => assertSceneTransition(S.DOWNLOADING, S.COMPLETED, { evidence: { observedAt: 1 } }));
  assert.doesNotThrow(() => assertSceneTransition(S.FAILED, S.COMPLETED, { evidence: { manual: true } }));
});

test('illegal scene transitions throw INVALID_STATE', () => {
  assert.throws(() => assertSceneTransition(S.COMPLETED, S.GENERATING), /cannot move/);
});

test('same-state transitions are no-ops', () => {
  assert.doesNotThrow(() => assertSceneTransition(S.PAUSED, S.PAUSED));
  assert.doesNotThrow(() => assertSessionTransition('paused', 'paused'));
});

test('session phases follow the run lifecycle', () => {
  assert.ok(canSessionTransition('idle', 'connecting'));
  assert.ok(canSessionTransition('connecting', 'running'));
  assert.ok(canSessionTransition('running', 'pausing'));
  assert.ok(canSessionTransition('pausing', 'paused'));
  assert.ok(canSessionTransition('paused', 'connecting'));
  assert.ok(canSessionTransition('running', 'stopping'));
  assert.ok(canSessionTransition('stopping', 'stopped'));
  assert.equal(canSessionTransition('idle', 'running'), false);
  assert.equal(canSessionTransition('completed', 'paused'), false);
  assert.throws(() => assertSessionTransition('idle', 'paused'), /cannot move/);
});

test('generation completes only after consecutive completed polls held for the settle window', async () => {
  const clock = virtualClock();
  const seen = [];
  const statuses = [
    { state: 'in_progress', inProgress: true, newOutputs: 0 },
    { state: 'completed', inProgress: false, newOutputs: 1, outputKeys: ['o1'] },
    { state: 'completed', inProgress: false, newOutputs: 1, outputKeys: ['o1'] },
    { state: 'completed', inProgress: false, newOutputs: 1, outputKeys: ['o1'] },
  ];
  const result = await awaitGenerationSettled({
    poll: async () => {
      const next = statuses.shift() ?? statuses.at(-1);
      seen.push(next.state);
      return next;
    },
    clock,
    timeoutMs: 60000,
    pollMs: 1000,
    settleMs: 2000,
    requiredCompletedPolls: 2,
  });
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(result.evidence.outputKeys, ['o1']);
  assert.ok(seen.filter((state) => state === 'completed').length >= 2);
});

test('a single completed poll is not enough', async () => {
  const clock = virtualClock();
  let polls = 0;
  const result = await awaitGenerationSettled({
    poll: async () => {
      polls += 1;
      return polls === 1 ? { state: 'completed', inProgress: false, newOutputs: 1 } : { state: 'pending', inProgress: false, newOutputs: 0 };
    },
    clock,
    timeoutMs: 5000,
    pollMs: 1000,
    settleMs: 0,
    requiredCompletedPolls: 2,
  });
  assert.equal(result.outcome, 'timeout');
});

test('time alone never completes a generation: no output means timeout, not success', async () => {
  const clock = virtualClock();
  const result = await awaitGenerationSettled({
    poll: async () => ({ state: 'in_progress', inProgress: true, newOutputs: 0 }),
    clock,
    timeoutMs: 10000,
    pollMs: 1000,
    settleMs: 1000,
  });
  assert.equal(result.outcome, 'timeout');
});

test('two consecutive failed polls fail the generation', async () => {
  const clock = virtualClock();
  const result = await awaitGenerationSettled({
    poll: async () => ({ state: 'failed', error: { message: 'Quota reached' } }),
    clock,
    timeoutMs: 60000,
    pollMs: 1000,
    settleMs: 1000,
  });
  assert.equal(result.outcome, 'failed');
  assert.equal(result.error.message, 'Quota reached');
});

test('an interruption request stops waiting and reports the reason', async () => {
  const clock = virtualClock();
  let stop = null;
  const result = await awaitGenerationSettled({
    poll: async () => {
      stop = 'pause';
      return { state: 'in_progress', inProgress: true };
    },
    clock,
    timeoutMs: 60000,
    pollMs: 1000,
    settleMs: 1000,
    shouldStop: () => stop,
  });
  assert.equal(result.outcome, 'interrupted');
  assert.equal(result.reason, 'pause');
});

test('submission acceptance is detected from the first sign of a new generation', async () => {
  const clock = virtualClock();
  let polls = 0;
  const result = await awaitSubmissionAccepted({
    poll: async () => {
      polls += 1;
      return polls < 3 ? { started: false, state: 'pending' } : { started: true, state: 'in_progress' };
    },
    clock,
    timeoutMs: 20000,
    pollMs: 1000,
  });
  assert.equal(result.outcome, 'started');
  assert.equal(polls, 3);
});

test('submission that never shows a generation is reported as not started', async () => {
  const clock = virtualClock();
  const result = await awaitSubmissionAccepted({
    poll: async () => ({ started: false, state: 'pending' }),
    clock,
    timeoutMs: 3000,
    pollMs: 1000,
  });
  assert.equal(result.outcome, 'not_started');
});

test('flow idle waits for pending generations to clear, then reports idle', async () => {
  const clock = virtualClock();
  let busy = 2;
  const result = await awaitFlowIdle({
    poll: async () => {
      busy -= 1;
      return busy > 0 ? { inProgress: true, pending: 1 } : { inProgress: false, pending: 0 };
    },
    clock,
    timeoutMs: 10000,
    pollMs: 500,
  });
  assert.equal(result.outcome, 'idle');
});
