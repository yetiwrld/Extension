/**
 * Polling helpers that decide when Flow has actually finished a generation.
 *
 * They never treat the passage of time as completion. Completion requires that
 * Flow reports the new output as finished, observed on consecutive polls and
 * stable for `settleMs`. A timeout is a failure, not a success.
 *
 * `poll` returns a status object from Flow:
 *   { state: 'pending'|'in_progress'|'completed'|'failed', started: boolean,
 *     inProgress: boolean, pending: number, newOutputs: number, error?: {message}, detail?: string }
 */

/**
 * Wait for the first sign that Flow accepted the submission.
 * @returns {Promise<{outcome: 'started'|'completed'|'failed'|'not_started', status?: object, error?: object}>}
 */
export async function awaitSubmissionAccepted({ poll, clock, timeoutMs, pollMs, shouldStop = () => null }) {
  const started = clock.now();
  for (;;) {
    if (shouldStop()) return { outcome: 'not_started' };
    const status = await poll();
    if (status.state === 'failed') {
      return { outcome: 'failed', status, error: status.error ?? { message: 'Flow reported an error.' } };
    }
    if (status.started) return { outcome: 'started', status };
    if (status.state === 'completed') return { outcome: 'completed', status };
    if (clock.now() - started >= timeoutMs) return { outcome: 'not_started', status };
    await clock.sleep(pollMs);
  }
}

/**
 * Wait until Flow shows no pending generations (used before submitting a new scene).
 * @returns {Promise<{outcome: 'idle'|'timeout'|'interrupted', reason?: string}>}
 */
export async function awaitFlowIdle({ poll, clock, timeoutMs, pollMs, shouldStop = () => null }) {
  const started = clock.now();
  for (;;) {
    const stop = shouldStop();
    if (stop) return { outcome: 'interrupted', reason: stop };
    const status = await poll();
    if (!status.inProgress && !status.pending) return { outcome: 'idle' };
    if (clock.now() - started >= timeoutMs) return { outcome: 'timeout' };
    await clock.sleep(pollMs);
  }
}

/**
 * Wait for the submitted generation to finish.
 *
 * @param {object} options
 * @param {() => Promise<object>} options.poll
 * @param {{now: () => number, sleep: (ms: number) => Promise<void>}} options.clock
 * @param {number} options.timeoutMs
 * @param {number} options.pollMs
 * @param {number} options.settleMs      Completed state must hold this long.
 * @param {number} [options.requiredCompletedPolls=2]
 * @param {() => string|null} [options.shouldStop]  Returns 'pause' | 'stop' to interrupt.
 * @param {(status: object, elapsedMs: number) => void} [options.onTick]
 * @returns {Promise<
 *   {outcome: 'completed', evidence: object, status: object} |
 *   {outcome: 'failed', error: object, status: object} |
 *   {outcome: 'timeout', status: object} |
 *   {outcome: 'interrupted', reason: string, status: object|null}
 * >}
 */
export async function awaitGenerationSettled({
  poll,
  clock,
  timeoutMs,
  pollMs,
  settleMs,
  requiredCompletedPolls = 2,
  shouldStop = () => null,
  onTick = () => {},
}) {
  const started = clock.now();
  let completedSince = null;
  let completedPolls = 0;
  let failedPolls = 0;
  let lastStatus = null;

  for (;;) {
    const stop = shouldStop();
    if (stop) return { outcome: 'interrupted', reason: stop, status: lastStatus };

    const status = await poll();
    lastStatus = status;
    onTick(status, clock.now() - started);

    if (status.state === 'failed') {
      failedPolls += 1;
      completedPolls = 0;
      completedSince = null;
      if (failedPolls >= 2) {
        return { outcome: 'failed', error: status.error ?? { message: 'Flow reported a failed generation.' }, status };
      }
    } else if (status.state === 'completed') {
      failedPolls = 0;
      completedPolls += 1;
      if (completedSince === null) completedSince = clock.now();
      const stableFor = clock.now() - completedSince;
      if (completedPolls >= requiredCompletedPolls && stableFor >= settleMs) {
        return {
          outcome: 'completed',
          evidence: {
            observedAt: clock.now(),
            newOutputs: status.newOutputs ?? 0,
            outputKeys: Array.isArray(status.outputKeys) ? status.outputKeys.slice(0, 12) : [],
          },
          status,
        };
      }
    } else {
      failedPolls = 0;
      completedPolls = 0;
      completedSince = null;
    }

    if (clock.now() - started >= timeoutMs) {
      return { outcome: 'timeout', status: lastStatus };
    }
    await clock.sleep(pollMs);
  }
}
