import { SCENE_STATUS } from './states.js';

/**
 * Builds the persisted scene queue from a parse result and reference matches,
 * preserving progress from a previous analysis.
 *
 * Duplicate protection: completion records are keyed by scene id (number +
 * prompt + references). They survive re-analysis and are only cleared by an
 * explicit "Regenerate" or by clearing the project. A scene that was already
 * generated therefore cannot be generated again by accident.
 *
 * @typedef {import('../parser/parse-scenes.js').ParsedScene} ParsedScene
 * @typedef {import('../references/match.js').ReferenceResolution} ReferenceResolution
 */

/**
 * @param {object} args
 * @param {ParsedScene[]} args.scenes
 * @param {Array<{status: string, matchedFileIds: string[], missing: ReferenceResolution[], ambiguous: ReferenceResolution[], resolutions: ReferenceResolution[]}>} args.summaries
 *        One per scene, same order as `scenes`.
 * @param {{scenes?: any[], completed?: Record<string, any>}|null} args.previous
 * @param {number} args.now
 */
export function buildSceneQueue({ scenes, summaries, previous, now }) {
  const previousById = new Map((previous?.scenes ?? []).map((scene) => [scene.id, scene]));
  const completed = { ...(previous?.completed ?? {}) };
  const usedIds = new Set();

  const queueScenes = scenes.map((scene, index) => {
    const summary = summaries[index];
    const id = uniqueSceneId(scene.id, usedIds);
    const prior = previousById.get(id);
    const completion = completed[id] ?? null;

    let status = SCENE_STATUS.WAITING;
    let resumeStep = null;
    let baseline = null;
    let submittedAt = null;
    let detail = '';
    // A scene that was submitted and then paused keeps its in-flight record, so
    // resuming it waits for the existing generation instead of submitting again.
    if (completion) {
      status = SCENE_STATUS.COMPLETED;
      detail = 'Completed in an earlier run.';
    } else if (prior && prior.status === SCENE_STATUS.PAUSED && prior.resumeStep === SCENE_STATUS.GENERATING && prior.baseline) {
      status = SCENE_STATUS.PAUSED;
      resumeStep = SCENE_STATUS.GENERATING;
      baseline = prior.baseline;
      submittedAt = prior.submittedAt ?? null;
      detail = 'Submitted to Flow. Waiting for it to finish.';
    }

    return {
      id,
      index,
      number: scene.number,
      numberLabel: scene.numberLabel,
      title: scene.title ?? '',
      startLine: scene.startLine,
      prompt: scene.prompt,
      promptHash: scene.promptHash,
      referenceNames: scene.referenceTokens.map((token) => token.name),
      references: summary.resolutions,
      referenceStatus: summary.status,
      matchedFileIds: summary.matchedFileIds,
      status,
      resumeStep,
      baseline,
      submittedAt,
      attempts: prior?.attempts ?? 0,
      detail,
      error: null,
      completion,
      startedAt: null,
      completedAt: completion?.completedAt ?? null,
      updatedAt: now,
    };
  });

  return { scenes: queueScenes, completed, updatedAt: now };
}

/**
 * Refresh only the reference data of scenes already in the queue. Statuses,
 * completion records and progress are left untouched, so a library change never
 * resets a failed or paused scene.
 */
export function updateReferenceSummaries({ queue, scenes, summaries, now }) {
  const byId = new Map(scenes.map((scene, index) => [scene.id, { scene, summary: summaries[index] }]));
  const next = {
    ...queue,
    scenes: (queue?.scenes ?? []).map((item) => {
      const match = byId.get(item.id);
      if (!match) return item;
      const { summary } = match;
      return {
        ...item,
        referenceNames: match.scene.referenceTokens.map((token) => token.name),
        references: summary.resolutions,
        referenceStatus: summary.status,
        matchedFileIds: summary.matchedFileIds,
        updatedAt: now,
      };
    }),
    updatedAt: now,
  };
  return next;
}

/** Scene IDs must be unique inside one document. Duplicates (already reported as errors) get a suffix. */
function uniqueSceneId(id, usedIds) {
  let candidate = id;
  let suffix = 2;
  while (usedIds.has(candidate)) {
    candidate = `${id}-${suffix}`;
    suffix += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

/** Scenes that still need work, in document order. */
export function pendingScenes(queue) {
  return (queue?.scenes ?? []).filter((scene) => !queue.completed?.[scene.id] && scene.status !== SCENE_STATUS.COMPLETED && scene.status !== SCENE_STATUS.SKIPPED);
}

/** Summary counters for the UI. */
export function countByStatus(queue) {
  const counts = { total: 0, completed: 0, failed: 0, skipped: 0, pending: 0 };
  for (const scene of queue?.scenes ?? []) {
    counts.total += 1;
    if (scene.status === SCENE_STATUS.COMPLETED) counts.completed += 1;
    else if (scene.status === SCENE_STATUS.FAILED) counts.failed += 1;
    else if (scene.status === SCENE_STATUS.SKIPPED) counts.skipped += 1;
    else counts.pending += 1;
  }
  return counts;
}
