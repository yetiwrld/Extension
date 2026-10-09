/**
 * Error model shared by the service worker, the Flow content script and the
 * side panel. Every failure that the user can act on carries a stable `code`
 * so the UI can show a precise message and the queue can choose a recovery.
 */

export const ERROR_CODES = Object.freeze({
  FLOW_NOT_CONNECTED: 'FLOW_NOT_CONNECTED',
  FLOW_TAB_CLOSED: 'FLOW_TAB_CLOSED',
  FLOW_NO_RESPONSE: 'FLOW_NO_RESPONSE',
  FLOW_UI_CHANGED: 'FLOW_UI_CHANGED',
  FLOW_SETTING_FAILED: 'FLOW_SETTING_FAILED',
  FLOW_AGENT_ON: 'FLOW_AGENT_ON',
  FLOW_AGENT_ONLY: 'FLOW_AGENT_ONLY',
  FLOW_BUSY: 'FLOW_BUSY',
  REFERENCE_MISSING: 'REFERENCE_MISSING',
  REFERENCE_AMBIGUOUS: 'REFERENCE_AMBIGUOUS',
  REFERENCE_CLEAR_FAILED: 'REFERENCE_CLEAR_FAILED',
  REFERENCE_UPLOAD_FAILED: 'REFERENCE_UPLOAD_FAILED',
  REFERENCE_MANUAL_REQUIRED: 'REFERENCE_MANUAL_REQUIRED',
  PROMPT_INSERT_FAILED: 'PROMPT_INSERT_FAILED',
  GENERATE_UNAVAILABLE: 'GENERATE_UNAVAILABLE',
  GENERATION_NOT_STARTED: 'GENERATION_NOT_STARTED',
  GENERATION_FAILED: 'GENERATION_FAILED',
  GENERATION_TIMEOUT: 'GENERATION_TIMEOUT',
  INTERRUPTED: 'INTERRUPTED',
  INVALID_STATE: 'INVALID_STATE',
  INVALID_INPUT: 'INVALID_INPUT',
  UNKNOWN: 'UNKNOWN',
});

export class AutomationError extends Error {
  /**
   * @param {string} code One of ERROR_CODES.
   * @param {string} message Human-readable explanation shown in the UI.
   * @param {{recoverable?: boolean, details?: unknown}} [options]
   */
  constructor(code, message, { recoverable = true, details } = {}) {
    super(message);
    this.name = 'AutomationError';
    this.code = code;
    this.recoverable = recoverable;
    this.details = details;
  }
}

/** Convert any thrown value into a JSON-safe payload for messaging. */
export function toErrorPayload(error) {
  if (error instanceof AutomationError) {
    return { code: error.code, message: error.message, recoverable: error.recoverable };
  }
  // Plain payloads that already carry a code (e.g. received over messaging) keep it.
  if (error && typeof error === 'object' && typeof error.code === 'string' && typeof error.message === 'string') {
    return { code: error.code, message: error.message, recoverable: error.recoverable !== false };
  }
  const message = error?.message || String(error || 'Unknown error');
  return { code: ERROR_CODES.UNKNOWN, message, recoverable: true };
}

/** Rebuild an AutomationError from a payload produced by toErrorPayload. */
export function fromErrorPayload(payload) {
  if (!payload) return new AutomationError(ERROR_CODES.UNKNOWN, 'Unknown error');
  return new AutomationError(payload.code || ERROR_CODES.UNKNOWN, payload.message || 'Unknown error', {
    recoverable: payload.recoverable !== false,
  });
}
