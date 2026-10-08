import { FLOW_CONTENT_SCRIPT, isFlowUrl } from './flow-bridge.js';
import { ERROR_CODES, toErrorPayload } from '../utils/errors.js';
import { withTimeout } from '../utils/async.js';
import { FLOW_TARGET } from '../shared/protocol.js';

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
    return {
      status: 'connected',
      tabId: tab.id,
      url: tab.url,
      message: probe.promptFound ? 'Connected to Flow.' : 'Connected to Flow. Open a project to find the prompt box.',
      checkedAt,
      promptFound: Boolean(probe.promptFound),
      projectPage: Boolean(probe.isProjectPage),
    };
  } catch (error) {
    const payload = toErrorPayload(error);
    return notConnected(tab.id, tab.url, `Flow is open but did not respond: ${payload.message}`, checkedAt);
  }
}

async function askTab(chromeApi, tabId, cmd) {
  const send = () => chromeApi.tabs.sendMessage(tabId, { target: FLOW_TARGET, cmd, payload: null }, { frameId: 0 });
  let reply;
  try {
    reply = await withTimeout(send(), 4000, 'Flow did not respond.');
  } catch (error) {
    if (!/receiving end|establish connection|message port/i.test(String(error?.message ?? error))) throw error;
    await chromeApi.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: [FLOW_CONTENT_SCRIPT] });
    reply = await withTimeout(send(), 4000, 'Flow did not respond after reloading the connector.');
  }
  if (!reply?.ok) {
    throw Object.assign(new Error(reply?.error?.message ?? 'Flow did not respond.'), { code: reply?.error?.code ?? ERROR_CODES.FLOW_NO_RESPONSE });
  }
  return reply.data;
}

function notConnected(tabId, url, message, checkedAt) {
  return { status: 'not_connected', tabId, url, message, checkedAt, promptFound: false, projectPage: false };
}
