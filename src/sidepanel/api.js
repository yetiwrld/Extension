import { MESSAGE_TYPE } from '../shared/protocol.js';

/** Error thrown for any failed command. Carries the stable code and a recovery hint. */
export class PanelError extends Error {
  constructor({ code = 'UNKNOWN', message = 'Something went wrong.', recoverable = true } = {}) {
    super(message);
    this.name = 'PanelError';
    this.code = code;
    this.recoverable = recoverable;
  }
}

/** Send a command to the service worker and unwrap the reply. */
export async function send(name, payload = {}) {
  let reply;
  try {
    reply = await chrome.runtime.sendMessage({ type: MESSAGE_TYPE.PANEL, name, payload });
  } catch (error) {
    throw new PanelError({
      code: 'UNKNOWN',
      message: `The extension background is not responding (${error?.message ?? 'no connection'}). Reload the side panel.`,
    });
  }
  if (!reply) {
    throw new PanelError({ code: 'UNKNOWN', message: 'The extension background returned no answer. Reload the side panel.' });
  }
  if (!reply.ok) throw new PanelError(reply.error);
  return reply.data;
}

/** Plain-language next step for each error code. */
export const RECOVERY_HINTS = Object.freeze({
  FLOW_NOT_CONNECTED: 'Open Flow in the active tab, then try again.',
  FLOW_TAB_CLOSED: 'Reopen Flow, then press Resume.',
  FLOW_NO_RESPONSE: 'Reload the Flow tab, then press Resume.',
  FLOW_UI_CHANGED: 'Flow may have changed its layout. Run "Check Flow page" in Settings for details.',
  FLOW_SETTING_FAILED: 'Check the setting in Flow, then press Resume.',
  FLOW_AGENT_ON: 'Turn off Agent in the Flow prompt box, then press Resume.',
  FLOW_AGENT_ONLY:
    'This Flow project shows only the Agent composer, with no agent toggle and no standard settings control. Model, mode, aspect ratio and output count cannot be set by the extension here — set them in Flow, or use a project that shows the standard composer.',
  FLOW_BUSY: 'Let Flow finish its current work, then retry the scene.',
  REFERENCE_MISSING: 'Add the missing file to the reference library.',
  REFERENCE_AMBIGUOUS: 'Choose the file to use for the ambiguous reference.',
  REFERENCE_UPLOAD_FAILED: 'Check the reference images in Flow, then retry the scene.',
  REFERENCE_CLEAR_FAILED: 'Remove the old reference images in Flow manually, then retry.',
  PROMPT_INSERT_FAILED: 'Check the Flow prompt box, then retry the scene.',
  GENERATE_UNAVAILABLE: 'Make sure the prompt is not empty and Flow settings are valid, then retry.',
  GENERATION_NOT_STARTED: 'Check Flow: if the output exists, choose Mark completed. Otherwise retry.',
  GENERATION_FAILED: 'Flow reported an error. Adjust the prompt or references, then retry.',
  GENERATION_TIMEOUT: 'Check Flow. If the output exists, choose Mark completed.',
  INTERRUPTED: 'Check Flow for this scene before continuing.',
  INVALID_STATE: 'Refresh the panel and try again.',
  INVALID_INPUT: 'Fix the highlighted input and try again.',
});

export function hintFor(code) {
  return RECOVERY_HINTS[code] ?? 'Check the Activity log for details, then try again.';
}
