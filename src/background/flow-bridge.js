import { AutomationError, ERROR_CODES, fromErrorPayload } from '../utils/errors.js';
import { withTimeout } from '../utils/async.js';
import { FLOW_COMMANDS, FLOW_PORT_METHODS, FLOW_TARGET } from '../shared/protocol.js';

/**
 * Service-worker side of the Flow port. Each call is routed to the content script
 * of the bound Flow tab (top frame only). Failures are mapped to stable codes so
 * the runner can pause (connection problems) or fail (UI problems) correctly.
 */

export const FLOW_CONTENT_SCRIPT = 'content/content-script.js';

/**
 * The longest each command may take before the worker gives up on it. Every limit is above the
 * slowest in-page wait for that command, so a step that is still working is not reported as failed.
 * A false failure pauses the run, and a retry could then repeat the step.
 */
export const COMMAND_TIMEOUTS_MS = Object.freeze({
  readSettings: 30000,
  applySettings: 90000,
  clearReferences: 45000,
  generationStatus: 15000,
});

/** Attaching files: the file picker, then one wait per file for Flow to show its thumbnail. */
export const ATTACH_BUDGET_MS = Object.freeze({ picker: 45000, perFile: 30000 });

/** The limit for one command. `payload` is used only to size the attach budget. */
export function commandTimeoutMs(cmd, payload, fallbackMs) {
  if (cmd === 'attachReferences') {
    const files = Array.isArray(payload) ? payload.length : 1;
    return ATTACH_BUDGET_MS.picker + files * ATTACH_BUDGET_MS.perFile;
  }
  return COMMAND_TIMEOUTS_MS[cmd] ?? fallbackMs;
}

/** Shown when the connector cannot be reached even after it has been injected. */
export const RELOAD_TAB_MESSAGE = 'Could not connect to this Flow tab. Reload the Flow tab (press F5) and try again.';

/** Shown when Chrome refuses to inject the connector into the tab. */
export const INJECT_FAILED_MESSAGE = 'Chrome would not load the Flow connector into this tab. Reload the Flow tab (press F5) and try again.';

// Chrome reports these when no content script is listening. Nothing was delivered, so a retry is safe.
const NOT_DELIVERED = /receiving end does not exist|could not establish connection/i;
// Chrome reports this when the connector was reached but its reply never arrived. The command may have run.
const REPLY_LOST = /message port closed/i;

const messageOf = (error) => String(error?.message ?? error ?? '');

/** True when no content script was listening, so the command was not delivered. */
export function isNotDeliveredError(error) {
  return NOT_DELIVERED.test(messageOf(error));
}

/**
 * True when a read-only check may retry after injecting the connector: either nothing was listening,
 * or the reply was lost. Commands never retry on a lost reply, because the command may already have run.
 */
export function isNoReceiverError(error) {
  return NOT_DELIVERED.test(messageOf(error)) || REPLY_LOST.test(messageOf(error));
}

/** Append Chrome's own reason, so a failure can be read from the panel instead of guessed at. */
export function withDetails(message, error) {
  const reason = messageOf(error).trim();
  return reason ? `${message} Details: ${reason}` : message;
}

/**
 * Inject the Flow connector into the top frame of a tab. Used when the tab was open before the
 * extension was loaded or reloaded. Throws a user-facing error, with Chrome's reason, if Chrome refuses.
 */
export async function attachConnector(chromeApi, tabId) {
  try {
    await chromeApi.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: [FLOW_CONTENT_SCRIPT] });
  } catch (error) {
    throw new AutomationError(ERROR_CODES.FLOW_NO_RESPONSE, withDetails(INJECT_FAILED_MESSAGE, error));
  }
}

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

  /** A reply that never arrived. If the reply was lost, the command may already have run, so say so. */
  function noReplyError(cmd, error) {
    if (REPLY_LOST.test(messageOf(error))) {
      return new AutomationError(
        ERROR_CODES.FLOW_NO_RESPONSE,
        `The connection to Flow closed before it replied to "${cmd}". The command may already have run in Flow, so check Flow before retrying.`,
      );
    }
    return new AutomationError(ERROR_CODES.FLOW_NO_RESPONSE, `Flow did not respond (${messageOf(error) || 'no response'}).`);
  }

  async function deliver(tabId, cmd, payload) {
    const message = { target: FLOW_TARGET, cmd, payload };
    try {
      return await chromeApi.tabs.sendMessage(tabId, message, { frameId: 0 });
    } catch (error) {
      if (!isNotDeliveredError(error)) throw noReplyError(cmd, error);
    }
    // Nothing was listening, so the command was not delivered. The page was open before the extension
    // was loaded or reloaded: attach the connector, then send the command once more.
    await attachConnector(chromeApi, tabId);
    try {
      return await chromeApi.tabs.sendMessage(tabId, message, { frameId: 0 });
    } catch (error) {
      if (isNotDeliveredError(error)) {
        throw new AutomationError(ERROR_CODES.FLOW_NO_RESPONSE, withDetails(RELOAD_TAB_MESSAGE, error));
      }
      throw noReplyError(cmd, error);
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
      `Flow did not answer "${cmd}" within ${Math.round(timeout / 1000)} seconds. The page may be busy or frozen, and the step may still finish in Flow. Check Flow before retrying.`,
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
    port[method] = (payload) => call(method, payload, { timeout: commandTimeoutMs(method, payload, timeoutMs) });
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
