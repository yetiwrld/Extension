import { pendingScenes } from './scene-model.js';
import { SCENE_REFERENCE_STATUS } from '../references/match.js';
import { ERROR_CODES } from '../utils/errors.js';

/**
 * Pre-flight checks shared by the side panel (to explain why Start is disabled)
 * and the service worker (to refuse a Start that would be unsafe).
 *
 * Blocking problems:
 *  - parse errors (duplicate scene numbers, empty prompts, no scene markers)
 *  - pending scenes whose references are missing or ambiguous
 *  - nothing left to run
 *
 * @returns {{canStart: boolean, blockers: Array<{code: string, message: string, sceneId?: string, sceneNumber?: number}>, pending: number}}
 */
export function computeReadiness({ queue, documentState }) {
  const blockers = [];

  for (const problem of documentState?.errors ?? []) {
    blockers.push({ code: problem.code, message: problem.message, sceneNumber: problem.sceneNumber ?? undefined });
  }

  const pending = pendingScenes(queue);

  for (const scene of pending) {
    if (scene.referenceStatus === SCENE_REFERENCE_STATUS.MISSING) {
      const names = scene.references.filter((ref) => ref.status === 'missing').map((ref) => ref.token);
      blockers.push({
        code: ERROR_CODES.REFERENCE_MISSING,
        sceneId: scene.id,
        sceneNumber: scene.number,
        message: `Scene ${scene.numberLabel} requires ${names.join(', ')} but it is not in your reference library.`,
      });
    } else if (scene.referenceStatus === SCENE_REFERENCE_STATUS.AMBIGUOUS) {
      const names = scene.references.filter((ref) => ref.status === 'ambiguous').map((ref) => ref.token);
      blockers.push({
        code: ERROR_CODES.REFERENCE_AMBIGUOUS,
        sceneId: scene.id,
        sceneNumber: scene.number,
        message: `Scene ${scene.numberLabel} has an ambiguous reference (${names.join(', ')}). Choose the file to use.`,
      });
    }
  }

  if (!(queue?.scenes ?? []).length) {
    blockers.push({ code: ERROR_CODES.INVALID_INPUT, message: 'Paste a scene document and press Analyze Scenes first.' });
  } else if (!pending.length) {
    blockers.push({ code: ERROR_CODES.INVALID_INPUT, message: 'Every scene is already completed or skipped.' });
  }

  return { canStart: blockers.length === 0, blockers, pending: pending.length };
}
