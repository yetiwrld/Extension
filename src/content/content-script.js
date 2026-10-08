/**
 * Flow content script. Runs only in the top frame of Flow pages (see manifest).
 * It answers commands from the service worker by calling the Flow adapter.
 * Guarded so that re-injection never registers a second listener.
 */
import { createFlowAdapter, handleFlowCommand } from '../flow/adapter.js';
import { FLOW_TARGET } from '../shared/protocol.js';

const GUARD = '__flowSceneQueueConnector__';

if (!globalThis[GUARD] && typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  globalThis[GUARD] = true;
  const adapter = createFlowAdapter({ doc: document, location: window.location });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.target !== FLOW_TARGET) return false;
    handleFlowCommand(adapter, message.cmd, message.payload).then(sendResponse);
    return true;
  });
}
