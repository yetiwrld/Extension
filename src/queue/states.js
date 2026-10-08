import { AutomationError, ERROR_CODES } from '../utils/errors.js';

/**
 * Explicit state machines for the automation session and for each scene.
 *
 * Invariants enforced here (and covered by tests):
 *  - A scene reaches COMPLETED only with completion evidence observed in Flow.
 *    Timers never complete a scene.
 *  - A scene that has been submitted to Flow can only leave GENERATING through
 *    COMPLETED, FAILED or PAUSED. It is never skipped over.
 *  - Scenes are never run concurrently: the runner only has one active scene.
 *  - Transitions not listed below are rejected with INVALID_STATE.
 */

export const SCENE_STATUS = Object.freeze({
  WAITING: 'waiting',
  PREPARING: 'preparing',
  UPLOADING: 'uploading',
  INSERTING: 'inserting',
  SUBMITTING: 'submitting',
  GENERATING: 'generating',
  COMPLETED: 'completed',
  FAILED: 'failed',
  RETRYING: 'retrying',
  PAUSED: 'paused',
  SKIPPED: 'skipped',
});

/** Steps a paused scene can resume from. Only pre-submit steps and waiting. */

export const SESSION_PHASE = Object.freeze({
  IDLE: 'idle',
  CONNECTING: 'connecting',
  RUNNING: 'running',
  PAUSING: 'pausing',
  PAUSED: 'paused',
  STOPPING: 'stopping',
  STOPPED: 'stopped',
  COMPLETED: 'completed',
  ERROR: 'error',
});

const S = SCENE_STATUS;

const SCENE_TRANSITIONS = Object.freeze({
  [S.WAITING]: [S.PREPARING, S.SKIPPED, S.FAILED],
  [S.PREPARING]: [S.UPLOADING, S.INSERTING, S.RETRYING, S.FAILED, S.PAUSED],
  [S.UPLOADING]: [S.INSERTING, S.RETRYING, S.FAILED, S.PAUSED],
  [S.INSERTING]: [S.SUBMITTING, S.RETRYING, S.FAILED, S.PAUSED],
  // Submitting is not interruptible: a click may already have been delivered.
  [S.SUBMITTING]: [S.GENERATING, S.FAILED],
  [S.GENERATING]: [S.COMPLETED, S.FAILED, S.PAUSED],
  [S.RETRYING]: [S.PREPARING, S.FAILED, S.PAUSED],
  [S.FAILED]: [S.PREPARING, S.WAITING, S.SKIPPED, S.COMPLETED],
  [S.PAUSED]: [S.PREPARING, S.UPLOADING, S.INSERTING, S.SUBMITTING, S.GENERATING, S.FAILED, S.SKIPPED, S.COMPLETED, S.WAITING],
  [S.COMPLETED]: [S.WAITING],
  [S.SKIPPED]: [S.WAITING],
});

const P = SESSION_PHASE;

const SESSION_TRANSITIONS = Object.freeze({
  [P.IDLE]: [P.CONNECTING],
  [P.CONNECTING]: [P.RUNNING, P.PAUSED, P.PAUSING, P.STOPPING, P.STOPPED, P.ERROR],
  [P.RUNNING]: [P.PAUSING, P.PAUSED, P.STOPPING, P.STOPPED, P.COMPLETED, P.ERROR],
  [P.PAUSING]: [P.PAUSED, P.STOPPING, P.ERROR, P.COMPLETED, P.STOPPED],
  [P.PAUSED]: [P.CONNECTING, P.STOPPED],
  [P.STOPPING]: [P.STOPPED, P.ERROR, P.COMPLETED],
  [P.STOPPED]: [P.CONNECTING],
  [P.COMPLETED]: [P.CONNECTING],
  [P.ERROR]: [P.PAUSED],
});

/** @returns {boolean} */
export function canSceneTransition(from, to) {
  return (SCENE_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Throws INVALID_STATE for illegal transitions and for COMPLETED without evidence.
 * @param {string} from
 * @param {string} to
 * @param {{evidence?: object|null}} [options]
 */
export function assertSceneTransition(from, to, { evidence } = {}) {
  if (from === to) return;
  if (!canSceneTransition(from, to)) {
    throw new AutomationError(ERROR_CODES.INVALID_STATE, `Scene cannot move from "${from}" to "${to}".`, {
      recoverable: false,
    });
  }
  if (to === S.COMPLETED) {
    const hasEvidence = Boolean(evidence && (evidence.observedAt || evidence.manual));
    if (!hasEvidence) {
      throw new AutomationError(ERROR_CODES.INVALID_STATE, 'A scene can only be marked completed after Flow shows its output.', {
        recoverable: false,
      });
    }
  }
}

/** @returns {boolean} */
export function canSessionTransition(from, to) {
  return (SESSION_TRANSITIONS[from] ?? []).includes(to);
}

export function assertSessionTransition(from, to) {
  if (from === to) return;
  if (!canSessionTransition(from, to)) {
    throw new AutomationError(ERROR_CODES.INVALID_STATE, `Automation cannot move from "${from}" to "${to}".`, {
      recoverable: false,
    });
  }
}

/** Scene statuses that count as "still to do" for the queue. */
export const RUNNABLE_STATUSES = Object.freeze([S.WAITING, S.PAUSED, S.RETRYING]);

/** Statuses that mean a scene was submitted or is in flight. */



/** Session phases in which an automation loop is (or may be) active. */
export const ACTIVE_PHASES = Object.freeze([P.CONNECTING, P.RUNNING, P.PAUSING, P.STOPPING]);

export function isActivePhase(phase) {
  return ACTIVE_PHASES.includes(phase);
}
