import { AutomationError, ERROR_CODES, fromErrorPayload } from '../utils/errors.js';
import { withTimeout } from '../utils/async.js';
import { FLOW_COMMANDS, FLOW_PORT_METHODS, FLOW_TARGET } from '../shared/protocol.js';

/**
 * Service-worker side of the Flow port. Each call is routed to the content script
 * of the bound Flow tab (top frame only). Failures are mapped to stable codes so
 * the runner can pause (connection problems) or fail (UI problems) correctly.
 */

export const FLOW_CONTENT_SCRIPT = 'content/content-script.js';

export function isFlowUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    if (parsed.hostname === 'flow.google.com') return true;
    return parsed.hostname === 'labs.google' && parsed.pathname.startsWith('/fx/tools/flow');
  } catch {
    return false;
  }
}

const NO_RECEIVER = /receiving end does not exist|could not establish connection|message port closed/i;

/**
 * @param {object} options
 * @param {() => number|null} options.getTabId
 * @param {typeof chrome} [options.chromeApi]
 * @param {number} [options.timeoutMs]
 */
export function createFlowBridge({ getTabId, chromeApi = globalThis.chrome, timeoutMs = 20000 }) {
  async function resolveTab() {
    const tabId = getTabId();
    if (!tabId) {
      throw new AutomationError(ERROR_CODES.FLOW_NOT_CONNECTED, 'No Flow tab is connected. Open Flow in the active tab and try again.');
    }
    let tab;
    try {
      tab = await chromeApi.tabs.get(tabId);
    } catch {
      throw new AutomationError(ERROR_CODES.FLOW_TAB_CLOSED, 'The Flow tab was closed. Reopen Flow, then press Resume.');
    }
    if (!isFlowUrl(tab.url)) {
      throw new AutomationError(ERROR_CODES.FLOW_NOT_CONNECTED, 'The bound tab is no longer on Flow. Navigate back to Flow, then press Resume.');
    }
    return tab;
  }

  async function deliver(tabId, cmd, payload) {
    const message = { target: FLOW_TARGET, cmd, payload };
    try {
      return await chromeApi.tabs.sendMessage(tabId, message, { frameId: 0 });
    } catch (error) {
      if (!NO_RECEIVER.test(String(error?.message ?? error))) {
        throw new AutomationError(ERROR_CODES.FLOW_NO_RESPONSE, `Flow did not respond (${error?.message ?? 'no response'}).`);
      }
      // The page was open before the extension was installed or updated. Inject once and retry.
      try {
        await chromeApi.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: [FLOW_CONTENT_SCRIPT] });
      } catch (injectError) {
        throw new AutomationError(
          ERROR_CODES.FLOW_NO_RESPONSE,
          `Could not attach to the Flow page (${injectError?.message ?? 'injection failed'}). Reload the Flow tab.`,
        );
      }
      return chromeApi.tabs.sendMessage(tabId, message, { frameId: 0 });
    }
  }

  /** Send one command and unwrap the reply. */
  async function call(cmd, payload = null, { timeout = timeoutMs } = {}) {
    if (!FLOW_COMMANDS.includes(cmd)) {
      throw new AutomationError(ERROR_CODES.INVALID_INPUT, `Unknown Flow command "${cmd}".`, { recoverable: false });
    }
    const tab = await resolveTab();
    const reply = await withTimeout(
      deliver(tab.id, cmd, payload),
      timeout,
      `Flow did not answer "${cmd}" within ${Math.round(timeout / 1000)} seconds. The page may be busy or frozen.`,
    );
    if (!reply) {
      throw new AutomationError(ERROR_CODES.FLOW_NO_RESPONSE, `Flow returned no answer to "${cmd}".`);
    }
    if (!reply.ok) throw fromErrorPayload(reply.error);
    return reply.data;
  }

  /** Lightweight check used by the connection indicator (no tab binding needed). */
  const port = {};
  for (const method of FLOW_PORT_METHODS) {
    port[method] = (payload) => call(method, payload, { timeout: method === 'generationStatus' ? 15000 : timeoutMs });
  }
  port.diagnose = () => call('diagnose', null, { timeout: 15000 });
  /** Diagnostics for a specific tab (used before any tab is bound). */
  port.diagnoseTab = async (tabId) => {
    const reply = await withTimeout(deliver(tabId, 'diagnose', null), 15000, 'Flow did not answer the page check in time.');
    if (!reply?.ok) throw fromErrorPayload(reply?.error);
    return reply.data;
  };
  port.resolveTab = resolveTab;
  port.call = call;
  return port;
}
