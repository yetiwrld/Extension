/**
 * Flow content script. It runs in the top frame of Flow pages: declared in the manifest,
 * and injected by the service worker into Flow tabs that were open before the extension
 * was loaded or reloaded. It answers commands from the service worker through the Flow adapter.
 *
 * Each injection replaces the connector from the previous injection. The new listener is added
 * before the old one is removed. Both happen within one task, so no command can arrive between
 * them, and a failed registration leaves the working connector in place.
 *
 * A connector left behind by an extension reload has no extension context and cannot receive
 * commands. Each injection therefore records what it found in CONNECTOR_STATUS_KEY. When a command
 * gets no answer, the service worker reads that record and reports the reason, instead of only
 * reporting that nothing was listening.
 */
import { createFlowAdapter, handleFlowCommand } from '../flow/adapter.js';
import { CONNECTOR_STATUS_KEY, FLOW_TARGET } from '../shared/protocol.js';
import { toErrorPayload } from '../utils/errors.js';

const REMOVE_PREVIOUS = '__flowSceneQueueRemoveConnector__';

const OLDER_COPY_REASON =
  'This Flow tab still has a connector from an older copy of the extension. Reload the Flow tab (press F5) and try again.';

function report(status) {
  globalThis[CONNECTOR_STATUS_KEY] = {
    ...status,
    url: String(globalThis.location?.href ?? ''),
    at: Date.now(),
  };
}

function installConnector() {
  const runtime = typeof chrome === 'undefined' ? null : chrome.runtime;
  // With no extension context (its id is gone after a reload), nothing can be delivered here.
  if (!runtime?.id || !runtime.onMessage) {
    report({ installed: false, reason: OLDER_COPY_REASON });
    return;
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

  // Register the new listener first. If that throws, the previous connector is still in place.
  runtime.onMessage.addListener(listener);

  const removePrevious = globalThis[REMOVE_PREVIOUS];
  if (typeof removePrevious === 'function') {
    try {
      removePrevious();
    } catch (error) {
      // The previous connector's extension context is gone, so it cannot answer anyway. Note it for debugging.
      console.warn('[Flow Scene Queue] The previous connector could not be removed.', error);
    }
  }
  globalThis[REMOVE_PREVIOUS] = () => runtime.onMessage.removeListener(listener);
  report({ installed: true, reason: '' });
}

try {
  installConnector();
} catch (error) {
  report({
    installed: false,
    reason: `The connector could not start in this tab (${error?.message || error}). Reload the Flow tab (press F5) and try again.`,
  });
}
