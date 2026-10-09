/**
 * Storage schema.
 *
 * chrome.storage.local keys and their single writer:
 *   prefs        - service worker (via prefs.update)
 *   document     - service worker (prompt text + analysis results)
 *   queue        - service worker (scene list, statuses, completion records)
 *   automation   - service worker (run phase, decision, progress)
 *   overrides    - service worker (user's choices for ambiguous references)
 *   logs         - service worker (activity log, capped)
 *   flowSettings - service worker (last values / options read from Flow)
 *   referenceLibrary - side panel (reference metadata; image bytes live in IndexedDB)
 *
 * chrome.storage.session (in-memory, cleared on browser restart):
 *   connection   - service worker (Flow connection status shown in the panel)
 */

export const STORAGE_KEYS = Object.freeze({
  prefs: 'prefs',
  document: 'document',
  queue: 'queue',
  automation: 'automation',
  overrides: 'overrides',
  logs: 'logs',
  flowSettings: 'flowSettings',
  library: 'referenceLibrary',
  connection: 'connection',
});

export const LOG_LIMIT = 300;

export const DEFAULT_PREFS = Object.freeze({
  pauseOnFailure: true,
  requireConfirmation: true,
  continueAfterSuccess: true,
  caseInsensitiveMatching: true,
  strictFilenameMatching: false,
  generationTimeoutMinutes: 10,
});

export const PREF_LIMITS = Object.freeze({
  generationTimeoutMinutes: { min: 1, max: 120 },
});

export function mergePrefs(stored) {
  const merged = { ...DEFAULT_PREFS, ...(stored && typeof stored === 'object' ? stored : {}) };
  const { min, max } = PREF_LIMITS.generationTimeoutMinutes;
  merged.generationTimeoutMinutes = clampNumber(merged.generationTimeoutMinutes, min, max, DEFAULT_PREFS.generationTimeoutMinutes);
  for (const key of Object.keys(DEFAULT_PREFS)) {
    if (key === 'generationTimeoutMinutes') continue;
    merged[key] = Boolean(merged[key]);
  }
  return merged;
}

/** Fresh default values. Always return new objects so callers can mutate safely. */
export function defaultValue(key) {
  switch (key) {
    case STORAGE_KEYS.prefs:
      return { ...DEFAULT_PREFS };
    case STORAGE_KEYS.document:
      return { text: '', updatedAt: null, analyzedAt: null, sceneCount: 0, errors: [], warnings: [], preamble: '' };
    case STORAGE_KEYS.queue:
      return { scenes: [], completed: {}, updatedAt: null };
    case STORAGE_KEYS.automation:
      return {
        phase: 'idle',
        tabId: null,
        runId: null,
        startedAt: null,
        updatedAt: null,
        currentSceneId: null,
        decision: null,
        message: 'Not started.',
        progress: null,
        settingsTarget: null,
      };
    case STORAGE_KEYS.overrides:
      return {};
    case STORAGE_KEYS.logs:
      return [];
    case STORAGE_KEYS.flowSettings:
      return {
        current: { mode: null, model: null, aspectRatio: null },
        options: { mode: [], model: [], aspectRatio: [] },
        readAt: null,
        source: null,
        readError: null,
      };
    case STORAGE_KEYS.library:
      return [];
    case STORAGE_KEYS.connection:
      return { status: 'not_connected', tabId: null, url: null, checkedAt: null, message: 'Checking Flow connection\u2026', probe: null, settingsFound: null };
    default:
      return undefined;
  }
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}
