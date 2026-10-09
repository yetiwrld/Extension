import {
  SCENE_STATUS,
  SESSION_PHASE,
  RUNNABLE_STATUSES,
  assertSceneTransition,
  assertSessionTransition,
  canSessionTransition,
  isActivePhase,
} from './states.js';
import { awaitFlowIdle, awaitGenerationSettled, awaitSubmissionAccepted } from './completion.js';
import { computeReadiness } from './readiness.js';
import { countByStatus } from './scene-model.js';
import { AutomationError, ERROR_CODES, toErrorPayload } from '../utils/errors.js';
import { createSerialQueue, systemClock } from '../utils/async.js';
import { uid } from '../utils/ids.js';
import { pluralize } from '../utils/text.js';
import { mergePrefs, STORAGE_KEYS } from '../storage/schema.js';
import { SCENE_REFERENCE_STATUS } from '../references/match.js';

/**
 * Sequential automation runner.
 *
 * Guarantees:
 *  - One scene is in flight at a time. Scene N+1 starts only after scene N is
 *    COMPLETED (Flow showed its output) or explicitly SKIPPED.
 *  - A submitted generation is never submitted again by Resume. Resume waits for
 *    the existing generation instead.
 *  - Pause is honoured at safe checkpoints (between steps and while waiting).
 *    Submitting is not interruptible, so a click that reached Flow is always
 *    followed by a recorded outcome.
 *  - Failures pause the queue (default) and are never silently skipped.
 *
 * Dependencies (all injected, so the loop is testable without Chrome):
 *   store   { read(key) -> value, update(key, mutator) -> Promise }
 *   flow    Flow port (methods listed in src/shared/protocol.js, FLOW_PORT_METHODS)
 *   files   { load(fileIds) -> Promise<Array<{id, name, mime, base64}>> }
 *   log     (level, message, sceneId?) -> Promise<void>
 *   clock   { now(), sleep(ms) }
 */

const S = SCENE_STATUS;
const P = SESSION_PHASE;

export const DEFAULT_TIMINGS = Object.freeze({
  pollMs: 2000,
  settleMs: 4000,
  requiredCompletedPolls: 2,
  submitTimeoutMs: 30000,
  idleTimeoutMs: 180000,
  maxAutomaticRetries: 1,
  retryDelayMs: 3000,
});

const SETTING_LABELS = Object.freeze({ mode: 'mode', model: 'model', aspectRatio: 'aspect ratio', outputs: 'output count' });

/** A status read has no side effects, so a busy page that misses one answer is asked again, this many times in all. */
const POLL_READ_ATTEMPTS = 3;

/** Errors that mean "Flow is not reachable right now": pause, never fail the scene. */
const PAUSE_CODES = new Set([
  ERROR_CODES.FLOW_NOT_CONNECTED,
  ERROR_CODES.FLOW_TAB_CLOSED,
  ERROR_CODES.FLOW_NO_RESPONSE,
  ERROR_CODES.INTERRUPTED,
  ERROR_CODES.FLOW_AGENT_ON,
  ERROR_CODES.FLOW_AGENT_ONLY,
  ERROR_CODES.REFERENCE_MANUAL_REQUIRED,
]);

export class AutomationRunner {
  constructor({ store, flow, files, log, clock = systemClock, timings = {} }) {
    this.store = store;
    this.flow = flow;
    this.files = files;
    this.logger = log;
    this.clock = clock;
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
    this.flags = { pause: false, stop: false };
    this.loop = null;
    this.commands = createSerialQueue();
  }

  /** True while the background loop is alive. */
  get busy() {
    return this.loop !== null;
  }

  /** Resolves when the active loop (if any) has finished. Used by tests and shutdown. */
  whenIdle() {
    return this.loop ?? Promise.resolve();
  }

  // ---------------------------------------------------------------------------
  // Commands (serialised; each returns once the state change is persisted)
  // ---------------------------------------------------------------------------

  /** Start the queue from the first pending scene. */
  start({ tabId } = {}) {
    return this.commands(() => this.doStart({ tabId }));
  }

  resume({ tabId } = {}) {
    return this.commands(() => this.doResume({ tabId }));
  }

  /** Request a pause. Takes effect at the next safe checkpoint. */
  pause() {
    return this.commands(() => this.doPause());
  }

  /** Stop the queue. In-flight generations keep running in Flow; Start resumes waiting for them. */
  stop() {
    return this.commands(() => this.doStop());
  }

  retry(sceneId) {
    return this.commands(() => this.doRetry(sceneId));
  }

  skip(sceneId) {
    return this.commands(() => this.doSkip(sceneId));
  }

  markCompleted(sceneId) {
    return this.commands(() => this.doMarkCompleted(sceneId));
  }

  regenerate(sceneId) {
    return this.commands(() => this.doRegenerate(sceneId));
  }

  /**
   * Called once when the service worker starts. A loop cannot survive a worker
   * restart, so an active phase is converted to a safe, user-decided pause.
   */
  recoverAfterRestart() {
    return this.commands(() => this.doRecover());
  }

  // ---------------------------------------------------------------------------
  // Command implementations
  // ---------------------------------------------------------------------------

  async doStart({ tabId }) {
    this.assertNoLoop();
    const phase = this.automation().phase;
    if (phase === P.PAUSED) {
      throw new AutomationError(ERROR_CODES.INVALID_STATE, 'Automation is paused. Use Resume to continue.');
    }
    if (isActivePhase(phase)) {
      throw new AutomationError(ERROR_CODES.INVALID_STATE, 'Automation is already running.');
    }
    await this.assertReady();
    await this.enterConnecting({ tabId, runId: uid('run'), startedAt: this.clock.now(), message: 'Connecting to Flow\u2026' });
    await this.log('info', 'Automation started.');
    this.launch();
  }

  async doResume({ tabId }) {
    this.assertNoLoop();
    const phase = this.automation().phase;
    if (phase !== P.PAUSED) {
      throw new AutomationError(ERROR_CODES.INVALID_STATE, 'Automation is not paused.');
    }
    await this.assertReady();
    await this.enterConnecting({ tabId, message: 'Reconnecting to Flow\u2026' });
    await this.log('info', 'Resuming automation.');
    this.launch();
  }

  async doPause() {
    const { phase } = this.automation();
    if (phase === P.RUNNING) {
      this.flags.pause = true;
      await this.setPhase(P.PAUSING, { message: 'Pausing after the current step\u2026' });
      await this.log('info', 'Pause requested. Waiting for a safe checkpoint.');
      return;
    }
    if (phase === P.CONNECTING || phase === P.PAUSING) {
      this.flags.pause = true;
      return;
    }
    throw new AutomationError(ERROR_CODES.INVALID_STATE, 'Automation is not running.');
  }

  async doStop() {
    const { phase } = this.automation();
    if (phase === P.RUNNING || phase === P.PAUSING || phase === P.CONNECTING) {
      this.flags.stop = true;
      await this.setPhase(P.STOPPING, { message: 'Stopping\u2026' });
      await this.log('warn', 'Stop requested.');
      return;
    }
    if (phase === P.STOPPING) return;
    if (phase === P.PAUSED) {
      await this.setPhase(P.STOPPED, {
        decision: null,
        progress: null,
        currentSceneId: null,
        message: 'Stopped. Start will continue from the current scene.',
      });
      await this.log('warn', 'Automation stopped while paused.');
      return;
    }
    throw new AutomationError(ERROR_CODES.INVALID_STATE, 'Automation is not running.');
  }

  async doRetry(sceneId) {
    this.assertNoLoop();
    const scene = this.findScene(sceneId);
    if (scene.status !== S.FAILED) {
      throw new AutomationError(ERROR_CODES.INVALID_STATE, 'Only failed scenes can be retried. Use Resume for paused scenes.');
    }
    await this.updateScene(sceneId, (draft) => {
      assertSceneTransition(draft.status, S.WAITING);
      Object.assign(draft, {
        status: S.WAITING,
        error: null,
        detail: 'Queued for retry.',
        resumeStep: null,
        baseline: null,
        submittedAt: null,
        attempts: (draft.attempts ?? 0) + 1,
      });
    });
    await this.log('info', `Scene ${scene.numberLabel} queued for retry.`, sceneId);
    await this.continueAfterDecision(sceneId);
  }

  async doSkip(sceneId) {
    this.assertNoLoop();
    const { phase, decision } = this.automation();
    if (isActivePhase(phase)) {
      throw new AutomationError(ERROR_CODES.INVALID_STATE, 'Pause the automation before skipping a scene.');
    }
    const scene = this.findScene(sceneId);
    if (![S.WAITING, S.FAILED, S.PAUSED].includes(scene.status)) {
      throw new AutomationError(ERROR_CODES.INVALID_STATE, 'This scene cannot be skipped right now.');
    }
    const wasGenerating = scene.status === S.PAUSED && scene.resumeStep === S.GENERATING;
    await this.updateScene(sceneId, (draft) => {
      assertSceneTransition(draft.status, S.SKIPPED);
      Object.assign(draft, { status: S.SKIPPED, error: null, detail: 'Skipped by user.', resumeStep: null, baseline: null });
    });
    await this.log(
      'warn',
      wasGenerating
        ? `Scene ${scene.numberLabel} skipped. A generation already running in Flow is not cancelled.`
        : `Scene ${scene.numberLabel} skipped.`,
      sceneId,
    );
    if (phase === P.PAUSED && decision?.sceneId === sceneId) {
      await this.continueAfterDecision(sceneId);
    }
  }

  async doMarkCompleted(sceneId) {
    this.assertNoLoop();
    const { phase, decision } = this.automation();
    if (isActivePhase(phase)) {
      throw new AutomationError(ERROR_CODES.INVALID_STATE, 'Pause the automation before marking a scene completed.');
    }
    const scene = this.findScene(sceneId);
    if (scene.status !== S.FAILED && scene.status !== S.PAUSED) {
      throw new AutomationError(ERROR_CODES.INVALID_STATE, 'Only failed or paused scenes can be marked completed.');
    }
    await this.recordCompletion(sceneId, { manual: true, observedAt: this.clock.now(), newOutputs: 0 });
    await this.log('warn', `Scene ${scene.numberLabel} marked completed manually. Make sure its output exists in Flow.`, sceneId);
    if (phase === P.PAUSED && decision?.sceneId === sceneId) {
      await this.continueAfterDecision(sceneId);
    }
  }

  async doRegenerate(sceneId) {
    this.assertNoLoop();
    const { phase } = this.automation();
    if (isActivePhase(phase)) {
      throw new AutomationError(ERROR_CODES.INVALID_STATE, 'Stop the automation before regenerating a scene.');
    }
    const scene = this.findScene(sceneId);
    if (scene.status !== S.COMPLETED) {
      throw new AutomationError(ERROR_CODES.INVALID_STATE, 'Only completed scenes can be regenerated.');
    }
    await this.store.update(STORAGE_KEYS.queue, (queue) => {
      const draft = queue.scenes.find((item) => item.id === sceneId);
      assertSceneTransition(draft.status, S.WAITING);
      delete queue.completed[sceneId];
      Object.assign(draft, {
        status: S.WAITING,
        completion: null,
        completedAt: null,
        detail: 'Queued to regenerate. Start the queue to run it.',
        resumeStep: null,
        baseline: null,
        error: null,
      });
      queue.updatedAt = this.clock.now();
      return queue;
    });
    await this.log('info', `Scene ${scene.numberLabel} queued to regenerate. It will run when you start the queue.`, sceneId);
  }

  async doRecover() {
    const { phase } = this.automation();
    if (!isActivePhase(phase)) return false;

    await this.store.update(STORAGE_KEYS.queue, (queue) => {
      for (const scene of queue.scenes) {
        if (scene.status === S.SUBMITTING) {
          assertSceneTransition(scene.status, S.FAILED);
          Object.assign(scene, {
            status: S.FAILED,
            resumeStep: null,
            baseline: null,
            error: {
              code: ERROR_CODES.INTERRUPTED,
              message: 'The extension restarted while submitting. Check Flow: the generation may already have started.',
              recoverable: true,
            },
            detail: 'Interrupted while submitting.',
          });
        } else if (scene.status === S.GENERATING) {
          assertSceneTransition(scene.status, S.PAUSED);
          Object.assign(scene, { status: S.PAUSED, resumeStep: S.GENERATING, detail: 'Interrupted while waiting for Flow. Resume to keep waiting.' });
        } else if ([S.PREPARING, S.UPLOADING, S.INSERTING, S.RETRYING].includes(scene.status)) {
          const resumeStep = scene.status === S.RETRYING ? S.PREPARING : scene.status;
          assertSceneTransition(scene.status, S.PAUSED);
          Object.assign(scene, { status: S.PAUSED, resumeStep, detail: 'Interrupted. Resume to run this step again.' });
        }
      }
      queue.updatedAt = this.clock.now();
      return queue;
    });

    const targetPhase = phase === P.STOPPING ? P.STOPPED : P.PAUSED;
    await this.setPhase(targetPhase, {
      decision: {
        type: 'interrupted',
        sceneId: this.automation().currentSceneId,
        code: ERROR_CODES.INTERRUPTED,
        title: 'Automation was interrupted',
        message: 'The extension restarted while automation was running. Review the current scene in Flow, then press Resume.',
        actions: ['resume', 'stop'],
      },
      message: 'Interrupted. Review Flow, then press Resume.',
      progress: null,
    });
    await this.log('warn', 'The extension restarted during automation. Automation paused for review.');
    return true;
  }

  // ---------------------------------------------------------------------------
  // Loop
  // ---------------------------------------------------------------------------

  launch() {
    this.flags = { pause: false, stop: false };
    this.loop = this.runLoop()
      .catch((error) => this.log('error', `Unexpected automation failure: ${error?.message || error}`))
      .finally(() => {
        this.loop = null;
      });
  }

  async runLoop() {
    try {
      const connected = await this.prepareSession();
      if (!connected) return;
      if (this.flags.stop) return await this.finishStopped();
      if (this.flags.pause) return await this.finishPaused(null);

      if (!(await this.enterRunning())) {
        if (this.flags.stop) return await this.finishStopped();
        if (this.flags.pause) return await this.finishPaused(null);
        throw new AutomationError(ERROR_CODES.INVALID_STATE, 'Automation could not enter the running state.', { recoverable: false });
      }

      for (;;) {
        if (this.flags.stop) return await this.finishStopped();
        if (this.flags.pause) return await this.finishPaused(null);

        const scene = this.nextRunnableScene();
        if (!scene) return await this.finishCompleted();

        await this.updateAutomation({ currentSceneId: scene.id, message: `Scene ${scene.numberLabel} is running.` });
        const outcome = await this.runScene(scene.id);

        if (outcome.type === 'completed') {
          const { continueAfterSuccess } = this.prefs();
          if (!continueAfterSuccess && this.nextRunnableScene() && !this.flags.stop) {
            return await this.finishPaused({
              type: 'awaiting-continue',
              sceneId: scene.id,
              code: null,
              title: `Scene ${scene.numberLabel} completed`,
              message: `Scene ${scene.numberLabel} is done. Press Continue to start the next scene.`,
              actions: ['continue', 'stop'],
            });
          }
          continue;
        }
        if (outcome.type === 'failed') {
          if (this.prefs().pauseOnFailure) {
            return await this.finishPaused(outcome.decision);
          }
          // Failure is recorded on the scene and stays visible; the queue moves on.
          await this.log('warn', `Scene ${this.findScene(scene.id).numberLabel} failed. Continuing because "Pause on failure" is off.`, scene.id);
          continue;
        }
        if (outcome.type === 'paused') {
          return await this.finishPaused(outcome.decision ?? null);
        }
        // 'skipped' and other outcomes: loop again; flags are checked at the top.
      }
    } catch (error) {
      await this.handleUnexpected(error);
    }
    return undefined;
  }

  /** Connect, verify Flow is usable, and capture the settings this run will use. */
  async prepareSession() {
    try {
      await this.log('info', 'Checking the Flow connection\u2026');
      const probe = await this.flow.probe();
      // Agent mode no longer blocks the run: the settings read leaves Agent mode
      // itself (verified recovery) when it would otherwise fail. Report it here so
      // the log shows the state the session started in.
      if (probe.agentMode?.chipPressed) {
        await this.log('info', 'Agent mode is on in Flow (button.agent-mode-chip is pressed). The settings read will leave it before proceeding.');
      } else if (probe.agentOn) {
        await this.log('warn', 'An Agent control is on in the Flow prompt box. The settings read will leave Agent mode if it blocks the settings.');
      }
      if (!probe.promptFound) {
        throw new AutomationError(ERROR_CODES.FLOW_UI_CHANGED, 'Flow prompt box not found. Open a project and make sure the prompt box is visible.');
      }
      // Capture what Flow shows now. Every scene re-applies these values before it generates.
      const result = await this.flow.readSettings();
      const target = pickTargetSettings(result?.current);
      // This workflow generates individual scenes one at a time, so each scene runs
      // with a single output. Pin x1 when Flow offers output counts (older layouts
      // without the control are left exactly as Flow shows them).
      if (Array.isArray(result?.options?.outputs) && result.options.outputs.some((option) => /^x1$/i.test(option))) {
        target.outputs = 'x1';
        await this.log('info', 'Output count set to x1: each scene is generated individually.');
      }
      await this.updateAutomation({ settingsTarget: target });
      await this.store.update(STORAGE_KEYS.flowSettings, () => ({
        current: result?.current ?? {},
        options: result?.options ?? {},
        readAt: this.clock.now(),
        source: 'flow',
      }));
      await this.log('success', `Connected to Flow. Settings: ${describeSettings(target)}.`);
      return true;
    } catch (error) {
      const payload = toErrorPayload(error);
      await this.log('error', `Could not start: ${payload.message}`);
      await this.finishPaused(this.decisionFor(error, null));
      return false;
    }
  }

  /**
   * Execute one scene from its recorded step to COMPLETED / FAILED / PAUSED.
   * @returns {Promise<{type: 'completed'|'failed'|'paused'|'skipped', decision?: object|null}>}
   */
  async runScene(sceneId) {
    const scene = this.findScene(sceneId);
    if (this.queue().completed[sceneId]) {
      return { type: 'skipped' };
    }

    if (scene.referenceStatus === SCENE_REFERENCE_STATUS.MISSING || scene.referenceStatus === SCENE_REFERENCE_STATUS.AMBIGUOUS) {
      const problem = (scene.references ?? []).find((ref) => ref.status !== 'matched');
      const isMissing = scene.referenceStatus === SCENE_REFERENCE_STATUS.MISSING;
      const message = isMissing
        ? `${problem?.token ?? 'A reference'} is not in the reference library.`
        : `${problem?.token ?? 'A reference'} is ambiguous. Choose the file to use.`;
      const decision = await this.failScene(
        sceneId,
        new AutomationError(isMissing ? ERROR_CODES.REFERENCE_MISSING : ERROR_CODES.REFERENCE_AMBIGUOUS, message, { recoverable: false }),
      );
      return { type: 'failed', decision };
    }

    if (scene.status === S.PAUSED && scene.resumeStep === S.GENERATING) {
      if (!scene.baseline) {
        const decision = await this.failScene(
          sceneId,
          new AutomationError(ERROR_CODES.INVALID_STATE, 'The submission record is missing. Check Flow before retrying.'),
          { verify: true },
        );
        return { type: 'failed', decision };
      }
      await this.setScene(sceneId, S.GENERATING, { detail: 'Waiting for Flow to finish.' });
      await this.log('info', `Scene ${scene.numberLabel}: resuming wait for the generation already submitted.`, sceneId);
      return this.waitForScene(sceneId);
    }

    const resumeFrom = scene.status === S.PAUSED && scene.resumeStep ? scene.resumeStep : S.PREPARING;
    // Re-insert the prompt when resuming at submission: the page may have changed since the pause.
    let step = resumeFrom === S.SUBMITTING ? S.INSERTING : resumeFrom;
    let automaticRetries = 0;

    for (;;) {
      const outcome = await this.runPreSubmitSteps(sceneId, step);
      if (outcome.type === 'ready') break;
      if (outcome.type === 'paused') {
        return { type: 'paused', decision: outcome.decision ?? null };
      }

      const { error, failedStep } = outcome;
      const payload = toErrorPayload(error);
      if (PAUSE_CODES.has(payload.code)) {
        await this.pauseScene(sceneId, failedStep, `Paused: ${payload.message}`);
        await this.log('warn', `Scene ${scene.numberLabel} paused: ${payload.message}`, sceneId);
        return { type: 'paused', decision: this.decisionFor(error, sceneId) };
      }
      if (payload.recoverable && automaticRetries < this.timings.maxAutomaticRetries) {
        automaticRetries += 1;
        await this.setScene(sceneId, S.RETRYING, { detail: `Retrying once: ${payload.message}`, error: payload });
        await this.log('warn', `Scene ${scene.numberLabel}: ${payload.message} Retrying once.`, sceneId);
        await this.clock.sleep(this.timings.retryDelayMs);
        step = S.PREPARING;
        continue;
      }
      const decision = await this.failScene(sceneId, error);
      return { type: 'failed', decision };
    }

    return this.submitAndWait(sceneId);
  }

  /**
   * Preparing -> uploading references -> inserting prompt.
   * Each step is preceded by a checkpoint where pause/stop is honoured.
   */
  async runPreSubmitSteps(sceneId, fromStep) {
    const order = [S.PREPARING, S.UPLOADING, S.INSERTING];
    const start = Math.max(0, order.indexOf(fromStep));

    for (let i = start; i < order.length; i += 1) {
      const step = order[i];
      if (this.checkpoint()) {
        await this.pauseScene(sceneId, step, 'Paused before this step.');
        return { type: 'paused', decision: null };
      }
      try {
        await this.setScene(sceneId, step, { detail: stepDetail(step) });
        await this.runStep(sceneId, step);
      } catch (error) {
        if (error?.code === ERROR_CODES.INTERRUPTED && this.checkpoint()) {
          await this.pauseScene(sceneId, step, 'Paused.');
          return { type: 'paused', decision: null };
        }
        return { type: 'error', error: normalizeError(error), failedStep: step };
      }
    }

    if (this.checkpoint()) {
      await this.pauseScene(sceneId, S.SUBMITTING, 'Paused before submitting.');
      return { type: 'paused', decision: null };
    }
    return { type: 'ready' };
  }

  async runStep(sceneId, step) {
    const scene = this.findScene(sceneId);
    switch (step) {
      case S.PREPARING:
        return this.stepPrepare(scene);
      case S.UPLOADING:
        return this.stepUpload(scene);
      case S.INSERTING:
        return this.stepInsert(scene);
      default:
        throw new AutomationError(ERROR_CODES.INVALID_STATE, `Unknown step "${step}".`, { recoverable: false });
    }
  }

  async stepPrepare(scene) {
    const probe = await this.flow.probe();
    // Agent mode is handled by the settings read's verified recovery; it is reported,
    // not a hard stop, so a recovered session can continue.
    if (probe.agentMode?.chipPressed) {
      await this.log('info', `Scene ${scene.numberLabel}: Agent mode is on in Flow. The settings step will leave it if needed.`, scene.id);
    }
    if (!probe.promptFound) {
      throw new AutomationError(ERROR_CODES.FLOW_UI_CHANGED, 'Flow prompt box not found. Keep the project open and visible.');
    }

    // Never start while Flow is still generating something else in this project.
    const idle = await awaitFlowIdle({
      poll: () => this.readGenerationStatus(null),
      clock: this.clock,
      timeoutMs: this.timings.idleTimeoutMs,
      pollMs: this.timings.pollMs,
      shouldStop: () => this.checkpoint(),
    });
    if (idle.outcome === 'interrupted') {
      throw new AutomationError(ERROR_CODES.INTERRUPTED, 'Paused while waiting for Flow to become idle.');
    }
    if (idle.outcome === 'timeout') {
      throw new AutomationError(ERROR_CODES.FLOW_BUSY, 'Flow is still generating something else in this project. Let it finish, then Retry.');
    }

    const target = this.automation().settingsTarget ?? {};
    if (Object.keys(target).length) {
      const result = await this.applySceneSettings(target, scene);
      // A null result means the menu would not open but the chip already verified the
      // settings (logged as a warning): there is nothing further to verify.
      const notOffered = result?.notOffered ?? [];
      for (const key of notOffered) {
        await this.log(
          'warn',
          `Scene ${scene?.numberLabel ?? ''}: Flow offers no ${SETTING_LABELS[key] ?? key} control in this mode; it was left as Flow has it.`.trim(),
          scene?.id,
        );
      }
      for (const key of result ? Object.keys(target) : []) {
        if (notOffered.includes(key)) continue;
        // Verify against what Flow reports after the change, never against what was requested.
        const actual = result?.current?.[key];
        if (actual !== target[key]) {
          const shown = actual ? ` Flow shows "${actual}".` : '';
          throw new AutomationError(ERROR_CODES.FLOW_SETTING_FAILED, `Unable to set ${SETTING_LABELS[key] ?? key} to "${target[key]}" in Flow.${shown}`);
        }
      }
    }

    const cleared = await this.flow.clearReferences();
    if ((cleared?.remaining ?? 0) > 0) {
      throw new AutomationError(
        ERROR_CODES.REFERENCE_CLEAR_FAILED,
        `Could not remove ${pluralize(cleared.remaining, 'reference')} left from earlier scenes in Flow.`,
      );
    }
  }

  async stepUpload(scene) {
    const ids = scene.matchedFileIds ?? [];
    if (!ids.length) {
      await this.log('info', `Scene ${scene.numberLabel}: no references for this scene.`, scene.id);
      return;
    }
    const payloads = await this.files.load(ids);
    const names = payloads.map((item) => item.name).join(', ');

    // Resuming after a manual-attach pause: Flow's own chips are the proof, and the
    // references the user attached must NOT be cleared away first.
    if (this.manualReferenceScenes?.has(scene.id)) {
      const status = await this.flow.countReferences();
      if ((status?.attached ?? 0) >= payloads.length) {
        this.manualReferenceScenes.delete(scene.id);
        await this.log('info', `Scene ${scene.numberLabel}: using the ${pluralize(payloads.length, 'reference')} attached in Flow by hand.`, scene.id);
        return;
      }
      throw new AutomationError(
        ERROR_CODES.REFERENCE_MANUAL_REQUIRED,
        `Flow still shows ${status?.attached ?? 0} of ${pluralize(payloads.length, 'reference')} for Scene ${scene.numberLabel}. Attach ${names} in Flow, then press Resume.`,
      );
    }

    // Clear again right before attaching: a resumed scene must carry exactly its own references.
    const cleared = await this.flow.clearReferences();
    if ((cleared?.remaining ?? 0) > 0) {
      throw new AutomationError(ERROR_CODES.REFERENCE_CLEAR_FAILED, `Could not remove ${pluralize(cleared.remaining, 'reference')} before uploading.`);
    }
    let result = null;
    let uploadError = null;
    try {
      result = await this.flow.attachReferences(payloads);
    } catch (error) {
      if (error?.code !== ERROR_CODES.REFERENCE_UPLOAD_FAILED) throw error;
      uploadError = error;
    }
    const attached = result?.attached ?? 0;
    if (!uploadError && attached >= payloads.length) {
      // Name the technique Flow accepted: on a page with no file input the run uses a
      // drop or a paste, and that fact belongs in the log rather than in a guess.
      const how = result?.strategy ? ` (via ${result.strategy})` : '';
      await this.log('info', `Scene ${scene.numberLabel}: uploaded ${names}${how}.`, scene.id);
      return;
    }
    // The first failure may be transient (Flow still busy with the previous scene):
    // let the normal single automatic retry happen before concluding anything.
    this.uploadAttempts = this.uploadAttempts ?? new Map();
    const attempts = (this.uploadAttempts.get(scene.id) ?? 0) + 1;
    this.uploadAttempts.set(scene.id, attempts);
    if (attempts < 2) {
      throw (
        uploadError ??
        new AutomationError(
          ERROR_CODES.REFERENCE_UPLOAD_FAILED,
          `Flow confirmed ${attached} of ${pluralize(payloads.length, 'reference file')} for Scene ${scene.numberLabel}.`,
        )
      );
    }
    // Flow would not take the files from the extension. That is a real limitation of
    // this page (its uploader is an OS file dialog), not a scene error: the run PAUSES
    // and asks for the files to be attached by hand, instead of failing the scene and
    // instead of generating a scene without its references.
    this.manualReferenceScenes = this.manualReferenceScenes ?? new Set();
    this.manualReferenceScenes.add(scene.id);
    const detail = uploadError ? ` ${uploadError.message}` : ` Flow confirmed ${attached} of ${pluralize(payloads.length, 'reference file')}.`;
    throw new AutomationError(
      ERROR_CODES.REFERENCE_MANUAL_REQUIRED,
      `Flow did not accept ${names} from the extension for Scene ${scene.numberLabel}.${detail} ` +
        'Attach the file(s) in Flow yourself (Add ingredients), then press Resume to continue this scene.',
    );
  }

  /** Forget the upload bookkeeping for a scene that is starting over. */
  resetUploadState(sceneId) {
    this.uploadAttempts?.delete(sceneId);
    this.manualReferenceScenes?.delete(sceneId);
  }

  /**
   * Apply the scene's settings. A menu that will not open is NOT a scene failure when
   * the composer's own chip already shows the required settings: the chip is Flow's
   * ground truth for model, ratio and output count, and the mode was verified when the
   * session read the settings. Everything else fails the scene as before.
   */
  async applySceneSettings(target, scene) {
    let result;
    try {
      result = await this.flow.applySettings(target);
    } catch (error) {
      const payload = toErrorPayload(error);
      const menuWouldNotOpen = payload.code === ERROR_CODES.FLOW_UI_CHANGED && /did not open/.test(payload.message);
      if (!menuWouldNotOpen) throw error;
      const probe = await this.flow.probe().catch(() => null);
      const chip = probe?.detectedSettings ?? {};
      const chipKeys = ['model', 'aspectRatio', 'outputs'];
      const chipOk = chipKeys.every((key) => !target[key] || (chip[key] && String(chip[key]).toLowerCase() === String(target[key]).toLowerCase()));
      const stored = this.store.read(STORAGE_KEYS.flowSettings)?.current ?? {};
      const modeOk = !target.mode || String(stored.mode ?? target.mode).toLowerCase() === String(target.mode).toLowerCase();
      if (!chipOk || !modeOk) throw error;
      await this.log(
        'warn',
        `Scene ${scene.numberLabel}: the settings menu would not open, but the composer chip already shows ${chipKeys.filter((key) => target[key]).map((key) => `${key} ${chip[key]}`).join(', ')}. Continuing with the verified settings.`,
        scene.id,
      );
      return null;
    }
    for (const line of result?.trace ?? []) {
      await this.log('info', `Scene ${scene.numberLabel}: settings — ${line.step}: ${line.detail}`, scene.id);
    }
    return result;
  }

  async stepInsert(scene) {
    const result = await this.flow.insertPrompt(scene.prompt);
    if (!result?.verified) {
      throw new AutomationError(ERROR_CODES.PROMPT_INSERT_FAILED, 'Flow did not keep the prompt text that was inserted. Check the prompt box.');
    }
    await this.log('info', `Scene ${scene.numberLabel}: prompt entered and verified (${result.length} characters).`, scene.id);
  }

  /**
   * Click Generate, confirm Flow accepted it, then wait for completion.
   * This section is not interruptible: once the click may have happened, the
   * outcome must be recorded.
   */
  async submitAndWait(sceneId) {
    const scene = this.findScene(sceneId);
    let baseline;
    try {
      baseline = await this.flow.snapshotOutputs();
    } catch (error) {
      const decision = await this.failScene(sceneId, normalizeError(error));
      return { type: 'failed', decision };
    }

    await this.setScene(sceneId, S.SUBMITTING, { detail: 'Submitting to Flow.', baseline, resumeStep: S.SUBMITTING, error: null });

    try {
      await this.flow.submit();
    } catch (error) {
      const decision = await this.failScene(
        sceneId,
        normalizeError(error),
        { note: 'Generate could not be clicked. Nothing was submitted.' },
      );
      return { type: 'failed', decision };
    }

    let accepted;
    try {
      accepted = await awaitSubmissionAccepted({
        poll: () => this.readGenerationStatus(baseline),
        clock: this.clock,
        timeoutMs: this.timings.submitTimeoutMs,
        pollMs: this.timings.pollMs,
      });
    } catch (error) {
      const reason = normalizeError(error).message;
      const decision = await this.failScene(
        sceneId,
        new AutomationError(ERROR_CODES.INTERRUPTED, `Lost contact with Flow right after Generate. Check Flow before retrying. (${reason})`),
        { verify: true },
      );
      return { type: 'failed', decision };
    }

    if (accepted.outcome === 'failed') {
      const decision = await this.failScene(
        sceneId,
        new AutomationError(ERROR_CODES.GENERATION_FAILED, `Flow reported an error when Generate was clicked: ${accepted.error?.message ?? 'unknown error'}`),
      );
      return { type: 'failed', decision };
    }
    if (accepted.outcome === 'not_started') {
      const decision = await this.failScene(
        sceneId,
        new AutomationError(
          ERROR_CODES.GENERATION_NOT_STARTED,
          'Flow did not show a new generation after Generate was clicked. It may still have started: check Flow before retrying.',
        ),
        { verify: true },
      );
      return { type: 'failed', decision };
    }

    await this.setScene(sceneId, S.GENERATING, {
      detail: 'Generating in Flow.',
      resumeStep: S.GENERATING,
      submittedAt: this.clock.now(),
      error: null,
    });
    await this.log('info', `Scene ${scene.numberLabel}: generation submitted. Waiting for Flow to finish.`, sceneId);
    return this.waitForScene(sceneId);
  }

  /**
   * Read Flow's generation status. A read has no side effects, so a busy page that misses one
   * answer is asked again. Any other failure is raised at once.
   */
  async readGenerationStatus(baseline) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.flow.generationStatus(baseline);
      } catch (error) {
        const transient = toErrorPayload(error).code === ERROR_CODES.FLOW_NO_RESPONSE;
        if (!transient || attempt >= POLL_READ_ATTEMPTS) throw error;
        await this.clock.sleep(this.timings.pollMs);
      }
    }
  }

  /** Wait for Flow to report completion. Completion is never inferred from elapsed time. */
  async waitForScene(sceneId) {
    const scene = this.findScene(sceneId);
    const baseline = scene.baseline;
    const minutes = this.prefs().generationTimeoutMinutes;
    const poll = async () => {
      const status = await this.readGenerationStatus(baseline);
      await this.reportProgress(sceneId, status);
      return status;
    };

    let result;
    try {
      result = await awaitGenerationSettled({
        poll,
        clock: this.clock,
        timeoutMs: minutes * 60 * 1000,
        pollMs: this.timings.pollMs,
        settleMs: this.timings.settleMs,
        requiredCompletedPolls: this.timings.requiredCompletedPolls,
        shouldStop: () => this.checkpoint(),
      });
    } catch (error) {
      const payload = toErrorPayload(error);
      if (PAUSE_CODES.has(payload.code)) {
        await this.pauseScene(sceneId, S.GENERATING, 'Lost contact with Flow while waiting. Resume to keep waiting.');
        await this.log('warn', `Scene ${scene.numberLabel}: ${payload.message}`, sceneId);
        return { type: 'paused', decision: this.decisionFor(error, sceneId) };
      }
      const decision = await this.failScene(sceneId, normalizeError(error), { verify: true });
      return { type: 'failed', decision };
    }

    switch (result.outcome) {
      case 'completed': {
        await this.recordCompletion(sceneId, { ...result.evidence, manual: false });
        await this.log('success', `Scene ${scene.numberLabel} completed.`, sceneId);
        return { type: 'completed' };
      }
      case 'failed': {
        const decision = await this.failScene(
          sceneId,
          new AutomationError(ERROR_CODES.GENERATION_FAILED, `Flow reported a failed generation: ${result.error?.message ?? 'unknown error'}`),
        );
        return { type: 'failed', decision };
      }
      case 'timeout': {
        const decision = await this.failScene(
          sceneId,
          new AutomationError(
            ERROR_CODES.GENERATION_TIMEOUT,
            `Scene ${scene.numberLabel} did not finish within ${pluralize(minutes, 'minute')}. If Flow shows the output, choose Mark completed.`,
          ),
          { verify: true },
        );
        return { type: 'failed', decision };
      }
      case 'interrupted': {
        await this.pauseScene(sceneId, S.GENERATING, 'Waiting for Flow to finish. Resume to keep waiting.');
        return { type: 'paused', decision: null };
      }
      default:
        throw new AutomationError(ERROR_CODES.INVALID_STATE, `Unexpected wait outcome "${result.outcome}".`, { recoverable: false });
    }
  }

  // ---------------------------------------------------------------------------
  // Scene state helpers
  // ---------------------------------------------------------------------------

  async recordCompletion(sceneId, evidence) {
    const now = this.clock.now();
    await this.store.update(STORAGE_KEYS.queue, (queue) => {
      const draft = queue.scenes.find((item) => item.id === sceneId);
      if (!draft) throw missingScene(sceneId);
      assertSceneTransition(draft.status, S.COMPLETED, { evidence });
      Object.assign(draft, {
        status: S.COMPLETED,
        completion: { ...evidence, completedAt: now },
        completedAt: now,
        detail: evidence.manual ? 'Marked completed by you.' : 'Output detected in Flow.',
        error: null,
        resumeStep: null,
        baseline: null,
      });
      queue.completed[sceneId] = {
        completedAt: now,
        number: draft.number,
        label: draft.numberLabel,
        manual: Boolean(evidence.manual),
      };
      queue.updatedAt = now;
      return queue;
    });
  }

  /** Persist a failure and return the decision the user must make. */
  async failScene(sceneId, error, { verify = false, note = '' } = {}) {
    const payload = toErrorPayload(error);
    const scene = this.findScene(sceneId);
    const now = this.clock.now();
    await this.store.update(STORAGE_KEYS.queue, (queue) => {
      const draft = queue.scenes.find((item) => item.id === sceneId);
      if (!draft) throw missingScene(sceneId);
      assertSceneTransition(draft.status, S.FAILED);
      Object.assign(draft, {
        status: S.FAILED,
        error: { ...payload, at: now, note },
        detail: note ? `${payload.message} ${note}` : payload.message,
        resumeStep: null,
        baseline: null,
      });
      queue.updatedAt = now;
      return queue;
    });
    await this.log('error', `Scene ${scene.numberLabel} failed: ${payload.message}${note ? ` ${note}` : ''}`, sceneId);
    return this.decisionFor(payload, sceneId, { verify, submitted: Boolean(scene.baseline) || verify });
  }

  /** Pause a scene at a checkpoint, recording the step to resume from. */
  async pauseScene(sceneId, resumeStep, detail) {
    await this.store.update(STORAGE_KEYS.queue, (queue) => {
      const draft = queue.scenes.find((item) => item.id === sceneId);
      if (!draft) throw missingScene(sceneId);
      if (draft.status === S.WAITING) return queue;
      if (draft.status !== S.PAUSED) assertSceneTransition(draft.status, S.PAUSED);
      Object.assign(draft, { status: S.PAUSED, resumeStep, detail });
      queue.updatedAt = this.clock.now();
      return queue;
    });
  }

  async setScene(sceneId, status, patch = {}) {
    const now = this.clock.now();
    await this.store.update(STORAGE_KEYS.queue, (queue) => {
      const draft = queue.scenes.find((item) => item.id === sceneId);
      if (!draft) throw missingScene(sceneId);
      assertSceneTransition(draft.status, status);
      Object.assign(draft, patch, { status, updatedAt: now });
      if (status === S.PREPARING && !draft.startedAt) draft.startedAt = now;
      queue.updatedAt = now;
      return queue;
    });
  }

  async updateScene(sceneId, mutate) {
    await this.store.update(STORAGE_KEYS.queue, (queue) => {
      const draft = queue.scenes.find((item) => item.id === sceneId);
      if (!draft) throw missingScene(sceneId);
      mutate(draft);
      queue.updatedAt = this.clock.now();
      return queue;
    });
  }

  async reportProgress(sceneId, status) {
    const now = this.clock.now();
    await this.updateAutomation({
      progress: {
        sceneId,
        state: status.state,
        detail: status.detail ?? '',
        newOutputs: status.newOutputs ?? 0,
        pending: status.pending ?? 0,
        updatedAt: now,
      },
    });
  }

  /** After a decision is resolved (retry/skip/mark), continue the queue if the run was paused for it. */
  async continueAfterDecision(sceneId) {
    const { phase, decision } = this.automation();
    if (phase !== P.PAUSED) return;
    if (decision && decision.sceneId && decision.sceneId !== sceneId) return;
    await this.enterConnecting({ message: 'Continuing\u2026' });
    await this.log('info', 'Continuing automation.');
    this.launch();
  }

  // ---------------------------------------------------------------------------
  // Session helpers
  // ---------------------------------------------------------------------------

  async enterConnecting(patch) {
    const { phase } = this.automation();
    if (phase !== P.CONNECTING) {
      await this.setPhase(P.CONNECTING, { decision: null, progress: null, ...patch });
    } else {
      await this.updateAutomation({ decision: null, progress: null, ...patch });
    }
  }

  /** Move to RUNNING only if the session is still in a phase that allows it (a pause or stop may have arrived). */
  async enterRunning() {
    const { phase } = this.automation();
    if (phase === P.RUNNING) return true;
    if (!canSessionTransition(phase, P.RUNNING)) return false;
    await this.setPhase(P.RUNNING, { message: 'Running.' });
    return true;
  }

  async finishPaused(decision) {
    if (this.flags.stop) return this.finishStopped();
    this.flags.pause = false;
    const currentSceneId = this.automation().currentSceneId;
    await this.setPhase(P.PAUSED, {
      decision: decision ?? null,
      progress: null,
      message: decision?.message ?? 'Paused. Resume continues from the current step.',
      currentSceneId,
    });
    await this.log('warn', decision ? `Paused: ${decision.message}` : 'Paused.');
    return undefined;
  }

  async finishStopped() {
    this.flags = { pause: false, stop: false };
    if (this.automation().phase !== P.STOPPING) {
      await this.setPhase(P.STOPPING, { message: 'Stopping\u2026' });
    }
    await this.setPhase(P.STOPPED, {
      decision: null,
      progress: null,
      currentSceneId: null,
      message: 'Stopped. Start will continue from the current scene.',
    });
    await this.log('warn', 'Automation stopped.');
    return undefined;
  }

  async finishCompleted() {
    const counts = countByStatus(this.queue());
    const parts = [`Completed ${counts.completed} of ${counts.total} scenes.`];
    if (counts.failed) parts.push(`${counts.failed} failed: retry them to finish.`);
    if (counts.skipped) parts.push(`${counts.skipped} skipped.`);
    const message = parts.join(' ');
    await this.setPhase(P.COMPLETED, { decision: null, progress: null, currentSceneId: null, message });
    await this.log(counts.failed ? 'warn' : 'success', message);
    return undefined;
  }

  async handleUnexpected(error) {
    const payload = toErrorPayload(error);
    await this.log('error', `Unexpected error: ${payload.message}`);
    const currentSceneId = this.automation().currentSceneId;
    try {
      await this.store.update(STORAGE_KEYS.queue, (queue) => {
        for (const scene of queue.scenes) {
          if (scene.status === S.SUBMITTING) {
            Object.assign(scene, { status: S.FAILED, resumeStep: null, error: { ...payload, at: this.clock.now() }, detail: payload.message });
          } else if (scene.status === S.GENERATING) {
            Object.assign(scene, { status: S.PAUSED, resumeStep: S.GENERATING, detail: 'Paused after an unexpected error. Resume to keep waiting.' });
          } else if ([S.PREPARING, S.UPLOADING, S.INSERTING, S.RETRYING].includes(scene.status)) {
            const resumeStep = scene.status === S.RETRYING ? S.PREPARING : scene.status;
            Object.assign(scene, { status: S.PAUSED, resumeStep, detail: 'Paused after an unexpected error.' });
          }
        }
        return queue;
      });
    } catch (storeError) {
      await this.log('error', `Could not record scene state: ${storeError?.message || storeError}`);
    }
    this.flags = { pause: false, stop: false };
    const { phase } = this.automation();
    if (phase === P.STOPPING) {
      await this.setPhase(P.STOPPED, { decision: null, message: 'Stopped after an unexpected error.' });
      return;
    }
    if (canSessionTransition(phase, P.ERROR)) {
      await this.setPhase(P.ERROR, { message: payload.message });
    }
    await this.setPhase(P.PAUSED, {
      decision: {
        type: 'unexpected',
        sceneId: currentSceneId,
        code: payload.code,
        title: 'Unexpected error',
        message: `${payload.message} Review Flow, then press Resume.`,
        actions: ['resume', 'stop'],
      },
      progress: null,
      message: 'Paused after an unexpected error.',
    });
  }

  /** Map a failure to what the user can do next. */
  decisionFor(error, sceneId, { verify = false, submitted = false } = {}) {
    const payload = toErrorPayload(error);
    const base = { sceneId, code: payload.code, message: payload.message };
    switch (payload.code) {
      case ERROR_CODES.FLOW_NOT_CONNECTED:
      case ERROR_CODES.FLOW_TAB_CLOSED:
      case ERROR_CODES.FLOW_NO_RESPONSE:
        return { ...base, type: 'flow-unavailable', title: 'Flow is not reachable', actions: ['resume', 'stop'] };
      case ERROR_CODES.FLOW_AGENT_ON:
        return { ...base, type: 'agent-on', title: 'Agent is on', actions: ['resume', 'stop'] };
      case ERROR_CODES.FLOW_AGENT_ONLY:
        return { ...base, type: 'agent-only', title: 'Flow shows only the Agent composer', actions: ['resume', 'stop'] };
      case ERROR_CODES.INTERRUPTED:
        return { ...base, type: 'interrupted', title: 'Interrupted', actions: ['resume', 'stop'] };
      case ERROR_CODES.REFERENCE_MANUAL_REQUIRED:
        return { ...base, type: 'manual-reference', title: 'Attach the reference in Flow', actions: ['resume', 'skip', 'stop'] };
      case ERROR_CODES.REFERENCE_MISSING:
      case ERROR_CODES.REFERENCE_AMBIGUOUS:
        return { ...base, type: 'missing-reference', title: 'Reference needs attention', actions: ['retry', 'skip', 'stop'] };
      default: {
        const actions = ['retry', 'skip', 'stop'];
        if (verify || submitted) actions.splice(1, 0, 'mark-completed');
        return {
          ...base,
          type: verify ? 'verify-submission' : 'scene-failed',
          title: verify ? 'Check Flow before retrying' : 'Scene failed',
          actions,
        };
      }
    }
  }

  nextRunnableScene() {
    const queue = this.queue();
    return queue.scenes.find((scene) => RUNNABLE_STATUSES.includes(scene.status) && !queue.completed[scene.id]) ?? null;
  }

  checkpoint() {
    if (this.flags.stop) return 'stop';
    if (this.flags.pause) return 'pause';
    return null;
  }

  async assertReady() {
    const readiness = computeReadiness({ queue: this.queue(), documentState: this.store.read(STORAGE_KEYS.document) });
    if (!readiness.canStart) {
      const [first] = readiness.blockers;
      throw new AutomationError(first.code, first.message, { details: readiness.blockers, recoverable: true });
    }
  }

  assertNoLoop() {
    if (this.loop) {
      throw new AutomationError(ERROR_CODES.INVALID_STATE, 'Automation is still finishing the current step. Try again in a moment.');
    }
  }

  async setPhase(phase, patch = {}) {
    const now = this.clock.now();
    const values = definedOnly(patch);
    await this.store.update(STORAGE_KEYS.automation, (automation) => {
      assertSessionTransition(automation.phase, phase);
      return { ...automation, ...values, phase, updatedAt: now };
    });
  }

  async updateAutomation(patch) {
    const now = this.clock.now();
    const values = definedOnly(patch);
    await this.store.update(STORAGE_KEYS.automation, (automation) => ({ ...automation, ...values, updatedAt: now }));
  }

  async log(level, message, sceneId = null) {
    try {
      await this.logger(level, message, sceneId);
    } catch {
      // Logging must never break the queue.
    }
  }

  automation() {
    return this.store.read(STORAGE_KEYS.automation);
  }

  queue() {
    return this.store.read(STORAGE_KEYS.queue);
  }

  prefs() {
    return mergePrefs(this.store.read(STORAGE_KEYS.prefs));
  }

  findScene(sceneId) {
    const scene = this.queue().scenes.find((item) => item.id === sceneId);
    if (!scene) throw missingScene(sceneId);
    return scene;
  }
}

function definedOnly(patch) {
  return Object.fromEntries(Object.entries(patch ?? {}).filter(([, value]) => value !== undefined));
}

function pickTargetSettings(current) {
  const target = {};
  for (const key of ['mode', 'model', 'aspectRatio', 'outputs']) {
    if (current && current[key]) target[key] = current[key];
  }
  return target;
}

export function describeSettings(target) {
  const parts = [target.mode, target.model, target.aspectRatio, target.outputs].filter(Boolean);
  return parts.length ? parts.join(' \u00b7 ') : 'as currently set in Flow';
}

function stepDetail(step) {
  switch (step) {
    case S.PREPARING:
      return 'Preparing: checking Flow and settings.';
    case S.UPLOADING:
      return 'Uploading references.';
    case S.INSERTING:
      return 'Inserting prompt.';
    default:
      return '';
  }
}

function normalizeError(error) {
  if (error instanceof AutomationError) return error;
  const payload = toErrorPayload(error);
  return new AutomationError(payload.code, payload.message, { recoverable: payload.recoverable });
}

function missingScene(sceneId) {
  return new AutomationError(ERROR_CODES.INVALID_STATE, `Scene ${sceneId} no longer exists. Analyze the document again.`, { recoverable: false });
}

