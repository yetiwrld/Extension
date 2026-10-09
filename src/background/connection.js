import { attachConnector, connectorFailure, isFlowUrl, isNoReceiverError } from './flow-bridge.js';
import { ERROR_CODES, toErrorPayload } from '../utils/errors.js';
import { withTimeout } from '../utils/async.js';
import { FLOW_TARGET } from '../shared/protocol.js';

/** A connection check waits this long for a page that is busy rendering. */
const PROBE_TIMEOUT_MS = 8000;

/**
 * Connection status for the side panel's "● Connected / ○ Not Connected" line.
 * "Connected" means: the active tab in the focused window is a Flow page AND its
 * content script answers. Nothing is typed in by the user; no project ID is needed.
 *
 * @returns {Promise<{status: 'connected'|'not_connected', tabId: number|null, url: string|null,
 *                    message: string, checkedAt: number, promptFound: boolean}>}
 */
export async function checkFlowConnection({ chromeApi = globalThis.chrome, now = () => Date.now() } = {}) {
  const checkedAt = now();
  const [tab] = await chromeApi.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) {
    return notConnected(null, null, 'No active tab. Click a Flow tab to connect.', checkedAt);
  }
  if (!isFlowUrl(tab.url)) {
    return notConnected(tab.id, tab.url ?? null, 'Open Flow (flow.google.com) in the active tab to connect.', checkedAt);
  }
  try {
    const probe = await askTab(chromeApi, tab.id, 'probe');
    const settingsFound = Boolean(probe.settingsFound);
    // "Connected" means the Flow tab is detected and its content script answers.
    // What is NOT yet working is said here, so a failed capability is never hidden
    // behind a green indicator. Whether settings were READ is shown in the settings
    // card (it is read asynchronously and can fail on its own).
    const missing = [];
    if (!probe.isProjectPage) missing.push('no project open');
    if (!probe.promptFound) missing.push('no prompt composer');
    if (!settingsFound) missing.push('no model/settings control');
    return {
      status: 'connected',
      tabId: tab.id,
      url: tab.url,
      message: missing.length
        ? `Connected to Flow (tab and connector OK), but ${missing.join(', ')} — run "Check Flow page" in Settings.`
        : 'Connected to Flow.',
      checkedAt,
      promptFound: Boolean(probe.promptFound),
      settingsFound,
      projectPage: Boolean(probe.isProjectPage),
      detectedSettings: probe.detectedSettings ?? null,
    };
  } catch (error) {
    const payload = toErrorPayload(error);
    const message =
      payload.code === ERROR_CODES.FLOW_NO_RESPONSE
        ? payload.message
        : `Flow is open, but it did not answer: ${payload.message}`;
    return notConnected(tab.id, tab.url, message, checkedAt);
  }
}

async function askTab(chromeApi, tabId, cmd) {
  const send = () => chromeApi.tabs.sendMessage(tabId, { target: FLOW_TARGET, cmd, payload: null }, { frameId: 0 });
  let reply;
  try {
    reply = await withTimeout(send(), PROBE_TIMEOUT_MS, 'Flow did not respond.');
  } catch (error) {
    if (!isNoReceiverError(error)) throw error;
    // No connector in this tab: it was open before the extension was loaded or reloaded.
    await attachConnector(chromeApi, tabId);
    try {
      reply = await withTimeout(send(), PROBE_TIMEOUT_MS, 'Flow did not respond after attaching.');
    } catch (retryError) {
      throw await connectorFailure(chromeApi, tabId, retryError);
    }
  }
  if (!reply?.ok) {
    throw Object.assign(new Error(reply?.error?.message ?? 'Flow did not respond.'), {
      code: reply?.error?.code ?? ERROR_CODES.FLOW_NO_RESPONSE,
    });
  }
  return reply.data;
}

function notConnected(tabId, url, message, checkedAt) {
  return {
    status: 'not_connected',
    tabId,
    url,
    message,
    checkedAt,
    promptFound: false,
    settingsFound: false,
    projectPage: false,
    detectedSettings: null,
  };
}
