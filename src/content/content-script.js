/**
 * Flow content script. It runs in the top frame of Flow pages: declared in the manifest,
 * and injected by the service worker into Flow tabs that were open before the extension
 * was loaded or reloaded. It answers commands from the service worker through the Flow adapter.
 *
 * Each injection replaces the connector from the previous injection. Removing the old listener
 * stops a live duplicate from answering the same command twice. A stale connector, left behind
 * by an extension reload, cannot answer anyway, so the new one takes over.
 */
import { createFlowAdapter, handleFlowCommand } from '../flow/adapter.js';
import { FLOW_TARGET } from '../shared/protocol.js';
import { toErrorPayload } from '../utils/errors.js';

const REMOVE_PREVIOUS = '__flowSceneQueueRemoveConnector__';

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  const removePrevious = globalThis[REMOVE_PREVIOUS];
  if (typeof removePrevious === 'function') {
    try {
      removePrevious();
    } catch {
      // The earlier connector belonged to a reloaded extension and is already gone.
    }
  }

  // The adapter is built on the first command, so a failure there is reported to the caller
  // instead of leaving the tab without a listener.
  let adapter = null;
  const listener = (message, _sender, sendResponse) => {
    if (!message || message.target !== FLOW_TARGET) return false;
    Promise.resolve()
      .then(() => {
        adapter ??= createFlowAdapter({ doc: document, location: window.location });
        return handleFlowCommand(adapter, message.cmd, message.payload);
      })
      .catch((error) => ({ ok: false, error: toErrorPayload(error) }))
      .then((reply) => {
        try {
          sendResponse(reply);
        } catch (error) {
          // The reply could not be sent, for example because it could not be serialised. Send the
          // reason instead, so the service worker is not left waiting for a reply that never comes.
          sendResponse({ ok: false, error: toErrorPayload(error) });
        }
      })
      .catch((error) => {
        // Not even the error reply could be sent, so the channel is gone. Leave a trace for debugging.
        console.error('[Flow Scene Queue] Could not send the reply to', message.cmd, error);
      });
    return true;
  };

  chrome.runtime.onMessage.addListener(listener);
  globalThis[REMOVE_PREVIOUS] = () => chrome.runtime.onMessage.removeListener(listener);
}
