import {
  findAlertTexts,
  findGenerateButton,
  findOutputMedia,
  findProgressIndicators,
  findPromptBox,
  isGenerateEnabled,
} from './selectors.js';

/**
 * Generation tracking in Flow's results area.
 *
 * Before a scene is submitted we take a baseline of existing outputs and alerts.
 * After submission, only NEW outputs count, and only when no progress indicator
 * is still active. The runner additionally requires the state to hold across
 * consecutive polls before it accepts completion.
 */

const MAX_KEYS = 48;

/** @returns {{outputKeys: string[], alerts: string[], generateEnabled: boolean|null, takenAt: number}} */
export function snapshotOutputs(doc, now = () => Date.now()) {
  const prompt = findPromptBox(doc);
  const promptEl = prompt?.el ?? null;
  const outputs = findOutputMedia(doc, promptEl);
  const generate = findGenerateButton(doc, promptEl);
  return {
    outputKeys: outputs.map((item) => item.key).slice(0, MAX_KEYS),
    alerts: findAlertTexts(doc).slice(0, 12),
    // A transition from enabled before submit to disabled afterwards is how
    // Flow's own Generate component exposes submission acceptance.
    generateEnabled: generate ? isGenerateEnabled(generate.el) : null,
    takenAt: now(),
  };
}

/**
 * @param {{outputKeys: string[], alerts: string[], generateEnabled?: boolean|null}|null} baseline
 * @returns {{state: 'pending'|'in_progress'|'completed'|'failed', started: boolean, inProgress: boolean,
 *            pending: number, newOutputs: number, outputKeys: string[], detail: string, error?: {message: string}}}
 */
export function generationStatus(doc, baseline) {
  const prompt = findPromptBox(doc);
  const promptEl = prompt?.el ?? null;
  const baseKeys = new Set(baseline?.outputKeys ?? []);
  const baseAlerts = new Set(baseline?.alerts ?? []);

  const outputs = findOutputMedia(doc, promptEl);
  const newKeys = outputs.map((item) => item.key).filter((key) => !baseKeys.has(key));
  const progress = findProgressIndicators(doc, promptEl);
  const inProgress = progress.length > 0;
  const generate = findGenerateButton(doc, promptEl);
  const generateDisabledAfterSubmit = baseline?.generateEnabled === true
    && Boolean(generate)
    && !isGenerateEnabled(generate.el);
  const newAlerts = findAlertTexts(doc).filter((text) => !baseAlerts.has(text));

  let state = 'pending';
  let detail = 'Waiting for Flow to start the generation.';
  let error;
  if (newAlerts.length && !inProgress && newKeys.length === 0) {
    state = 'failed';
    error = { message: newAlerts[0].slice(0, 300) };
    detail = 'Flow reported an error.';
  } else if (inProgress) {
    state = 'in_progress';
    detail = `Flow is generating (${progress.length} in progress).`;
  } else if (newKeys.length > 0) {
    state = 'completed';
    detail = `${newKeys.length} new output${newKeys.length === 1 ? '' : 's'} in Flow.`;
  }

  if (state === 'pending' && generateDisabledAfterSubmit) {
    detail = 'Flow accepted Generate; waiting for generation progress or output.';
  }

  return {
    state,
    started: generateDisabledAfterSubmit || inProgress || newKeys.length > 0 || newAlerts.length > 0,
    inProgress,
    pending: progress.length,
    newOutputs: newKeys.length,
    outputKeys: newKeys.slice(0, MAX_KEYS),
    detail,
    ...(error ? { error } : {}),
  };
}
