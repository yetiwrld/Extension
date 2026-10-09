/**
 * Messaging contract between the side panel, the service worker and the
 * Flow content script. Keep names here; never inline string literals elsewhere.
 *
 *   side panel  --chrome.runtime.sendMessage-->  service worker
 *                 { type: 'panel', name, payload }
 *   service worker --chrome.tabs.sendMessage--> Flow content script
 *                 { target: 'flow-adapter', cmd, payload }
 *
 * Every reply is { ok: true, data } or { ok: false, error: { code, message, recoverable } }.
 */

export const MESSAGE_TYPE = Object.freeze({
  PANEL: 'panel',
});

export const FLOW_TARGET = 'flow-adapter';

/** Global the connector writes its status to in the tab. The service worker reads it when a command gets no answer. */
export const CONNECTOR_STATUS_KEY = '__flowSceneQueueConnectorStatus__';

/** Methods the queue runner calls on the Flow port. */
export const FLOW_PORT_METHODS = Object.freeze([
  'probe',
  'readSettings',
  'applySettings',
  'clearReferences',
  'attachReferences',
  'insertPrompt',
  'snapshotOutputs',
  'submit',
  'generationStatus',
]);

/** Additional commands used for connection checks and diagnostics. */
export const FLOW_EXTRA_COMMANDS = Object.freeze(['ping', 'diagnose']);

export const FLOW_COMMANDS = Object.freeze([...FLOW_PORT_METHODS, ...FLOW_EXTRA_COMMANDS]);

/** Commands the side panel may send to the service worker. */
export const PANEL_COMMANDS = Object.freeze([
  'getState',
  'checkFlow',
  'diagnoseFlow',
  'analyze',
  'setPrefs',
  'setOverride',
  'refreshReferences',
  'clearProject',
  'refreshFlowSettings',
  'setFlowSetting',
  'start',
  'pause',
  'resume',
  'stop',
  'retry',
  'skip',
  'markCompleted',
  'regenerate',
  'clearLogs',
]);

export function okReply(data = null) {
  return { ok: true, data };
}

export function errorReply(error) {
  return {
    ok: false,
    error: {
      code: error?.code ?? 'UNKNOWN',
      message: error?.message ?? 'Unknown error',
      recoverable: error?.recoverable !== false,
    },
  };
}
