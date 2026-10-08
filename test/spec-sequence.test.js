import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCENE_STATUS,
  SESSION_PHASE,
  canSceneTransition,
  canSessionTransition,
} from '../src/queue/states.js';

/*
 * The spec names the machine's states in capitals. Each one maps onto an implemented
 * state (the mapping is also in the README, "State mapping"). These tests walk the
 * spec's sequence through the real transition tables, so the mapping cannot drift.
 * The mapping is documented in the README under "State machine (specification names
 * → implementation)".
 */

const SCENE_SPEC_PATH = [
  SCENE_STATUS.WAITING, // NEXT_SCENE hands over to this state
  SCENE_STATUS.PREPARING, // PREPARING_SCENE
  SCENE_STATUS.UPLOADING, // UPLOADING_REFERENCES
  SCENE_STATUS.INSERTING, // INSERTING_PROMPT
  SCENE_STATUS.SUBMITTING, // GENERATING (Generate has been clicked)
  SCENE_STATUS.GENERATING, // WAITING_FOR_COMPLETION
  SCENE_STATUS.COMPLETED, // COMPLETED (only with evidence, see states-completion tests)
];

test('one scene walks the spec sequence in order', () => {
  for (let i = 0; i < SCENE_SPEC_PATH.length - 1; i += 1) {
    const from = SCENE_SPEC_PATH[i];
    const to = SCENE_SPEC_PATH[i + 1];
    assert.ok(canSceneTransition(from, to), `${from} -> ${to} must be allowed`);
  }
});

test('NEXT_SCENE: a completed scene hands over, and the next scene starts preparing', () => {
  assert.ok(canSceneTransition(SCENE_STATUS.COMPLETED, SCENE_STATUS.WAITING));
  assert.ok(canSceneTransition(SCENE_STATUS.WAITING, SCENE_STATUS.PREPARING));
});

test('GENERATING never reaches NEXT_SCENE directly, whether or not the scene was submitted', () => {
  for (const from of [SCENE_STATUS.SUBMITTING, SCENE_STATUS.GENERATING]) {
    for (const to of [SCENE_STATUS.WAITING, SCENE_STATUS.PREPARING]) {
      assert.equal(canSceneTransition(from, to), false, `${from} -> ${to} must be rejected`);
    }
  }
});

test('the session walks IDLE, CONNECTING, READY, and ERROR leads to PAUSED', () => {
  assert.ok(canSessionTransition(SESSION_PHASE.IDLE, SESSION_PHASE.CONNECTING));
  assert.ok(canSessionTransition(SESSION_PHASE.CONNECTING, SESSION_PHASE.RUNNING));
  assert.ok(canSessionTransition(SESSION_PHASE.RUNNING, SESSION_PHASE.ERROR));
  assert.ok(canSessionTransition(SESSION_PHASE.ERROR, SESSION_PHASE.PAUSED));
});

test('the session cannot run without connecting first', () => {
  assert.equal(canSessionTransition(SESSION_PHASE.IDLE, SESSION_PHASE.RUNNING), false);
});
