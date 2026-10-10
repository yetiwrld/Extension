import { AutomationError, ERROR_CODES, toErrorPayload } from '../utils/errors.js';
import { sleep as defaultSleep } from '../utils/async.js';
import { FLOW_COMMANDS } from '../shared/protocol.js';
import { applyFlowSettings, readFlowSettings } from './settings.js';
import { insertPrompt } from './prompt.js';
import { attachReferences, clearReferences, countAttachedReferences } from './references.js';
import { generationStatus as readGenerationStatus, snapshotOutputs as takeOutputSnapshot } from './outputs.js';
import {
  findAgentToggle,
  findGenerateButton,
  findProgressIndicators,
  findPromptBox,
  findSettingsTrigger,
  isGenerateEnabled,
} from './selectors.js';
import { accessibleName, clickElement, normalizeText, readEditableText } from './dom.js';

/**
 * Flow adapter: the only place that turns automation intents into Flow DOM work.
 *
 * Commands map 1:1 onto FLOW_PORT_METHODS (used by the queue runner) plus
 * `ping`, `diagnose`, `readSettings` and `applySettings` for the side panel.
 * All failures are AutomationError with a stable code.
 */

export const ADAPTER_VERSION = '1.6.0';

export const DEFAULT_TIMINGS = Object.freeze({
  settleMs: 350,
  popoverMs: 2500,
});

/**
 * @param {{doc?: Document, sleep?: (ms: number) => Promise<void>, timings?: Partial<typeof DEFAULT_TIMINGS>, location?: {href: string}}} [options]
 */
export function createFlowAdapter(options = {}) {
  const doc = options.doc ?? globalThis.document;
  const sleep = options.sleep ?? defaultSleep;
  const timings = { ...DEFAULT_TIMINGS, ...(options.timings ?? {}) };
  const location = options.location ?? globalThis.location;
  const ctx = { doc, sleep, timings };

  function requirePrompt() {
    const prompt = findPromptBox(doc);
    if (!prompt) {
      throw new AutomationError(ERROR_CODES.FLOW_UI_CHANGED, 'Flow prompt box not found. Open a project and keep the prompt box visible.');
    }
    return prompt;
  }

  const adapter = {
    version: ADAPTER_VERSION,

    /** Snapshot of what this page offers. Never throws for missing controls; reports them instead. */
    async probe() {
      // Each lookup is guarded: one unexpected element must not hide the status of the whole page.
      const issues = [];
      const guarded = (label, read, fallback = null) => {
        try {
          return read();
        } catch (error) {
          issues.push(`${label}: ${error?.message || String(error)}`);
          return fallback;
        }
      };
      const prompt = guarded('prompt box', () => findPromptBox(doc));
      const generate = guarded('Generate button', () => (prompt ? findGenerateButton(doc, prompt.el) : findGenerateButton(doc, null)));
      const trigger = guarded('settings control', () => (prompt ? findSettingsTrigger(doc, prompt.el) : null));
      const agent = guarded('agent toggle', () => (prompt ? findAgentToggle(doc, prompt.el) : null));
      return {
        url: location?.href ?? '',
        isProjectPage: /\/project\//.test(location?.pathname ?? ''),
        promptFound: Boolean(prompt),
        promptStrategy: prompt?.strategy ?? null,
        generateFound: Boolean(generate),
        generateStrategy: generate?.strategy ?? null,
        generateEnabled: guarded('Generate state', () => (generate ? isGenerateEnabled(generate.el) : false), false),
        settingsFound: Boolean(trigger),
        settingsStrategy: trigger?.strategy ?? null,
        agentOn: Boolean(agent?.on),
        agentFound: Boolean(agent),
        referencesAttached: guarded('references', () => (prompt ? countAttachedReferences(doc, prompt.el) : 0), 0),
        outputsVisible: guarded('outputs', () => takeOutputSnapshot(doc).outputKeys.length, 0),
        issues,
      };
    },

    /** Human-readable checks for the side panel. */
    async diagnose() {
      const probe = await adapter.probe();
      const checks = [
        check('Flow page', Boolean(probe.url), probe.url || 'Unknown URL'),
        check('Project open', probe.isProjectPage, probe.isProjectPage ? 'URL is a project page.' : 'Open a project (URL contains /project/).'),
        check('Prompt box', probe.promptFound, probe.promptFound ? `Found (${probe.promptStrategy}).` : 'Not found. The prompt box is required.'),
        check('Generate button', probe.generateFound, probe.generateFound ? `Found (${probe.generateStrategy}), ${probe.generateEnabled ? 'enabled' : 'disabled'}.` : 'Not found.'),
        check('Settings control', probe.settingsFound, probe.settingsFound ? `Found (${probe.settingsStrategy}).` : 'Not found.'),
        check('Agent mode', !probe.agentOn, probe.agentFound ? (probe.agentOn ? 'Agent is ON. Turn it off.' : 'Off.') : 'No agent control detected.'),
        check('Page checks', probe.issues.length === 0, probe.issues.length ? probe.issues.join('; ') : 'All page checks ran.'),
      ];
      return { ...probe, checks, adapterVersion: ADAPTER_VERSION };
    },

    /** Read Flow's Mode / Model / Aspect ratio from its own popover. */
    async readSettings() {
      requirePrompt();
      return readFlowSettings(ctx);
    },

    async applySettings(target) {
      requirePrompt();
      const result = await applyFlowSettings(ctx, target);
      return result;
    },

    async clearReferences() {
      return clearReferences(ctx);
    },

    async attachReferences(payloads) {
      return attachReferences(ctx, payloads);
    },

    async insertPrompt(text) {
      return insertPrompt(ctx, text);
    },

    async snapshotOutputs() {
      requirePrompt();
      return takeOutputSnapshot(doc);
    },

    /** Click Generate. Verifies the button exists and is enabled first. */
    async submit() {
      const prompt = requirePrompt();
      const generate = findGenerateButton(doc, prompt.el);
      if (!generate) {
        throw new AutomationError(ERROR_CODES.GENERATE_UNAVAILABLE, 'Generate button not found next to the prompt box.');
      }
      if (!isGenerateEnabled(generate.el)) {
        throw new AutomationError(
          ERROR_CODES.GENERATE_UNAVAILABLE,
          `Flow's ${accessibleName(generate.el) || 'Generate'} button is disabled. Check that the prompt is not empty and the settings are valid.`,
        );
      }
      const promptBefore = normalizeText(readEditableText(prompt.el));
      clickElement(generate.el);
      await sleep(Math.max(timings.settleMs, 500));

      let accepted = submissionChanged(doc, prompt.el, generate.el, promptBefore);
      let fallback = null;
      if (!accepted) {
        // Current Flow automators use Enter on the ProseMirror editor as the
        // fallback when the icon button's click route does not reach Angular.
        // Only do this after the click showed no acceptance evidence, avoiding
        // a second submission when the first route worked.
        pressEnter(prompt.el);
        fallback = 'prompt-enter';
        await sleep(Math.max(timings.settleMs, 500));
        accepted = submissionChanged(doc, prompt.el, generate.el, promptBefore);
      }
      const rect = generate.el.getBoundingClientRect?.();
      const clickTarget = rect && rect.width > 0 && rect.height > 0
        ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
        : null;
      return { clicked: true, accepted, strategy: generate.strategy, fallback, clickTarget };
    },

    /** Output and progress state since `baseline`. */
    async generationStatus(baseline) {
      return readGenerationStatus(doc, baseline);
    },
  };

  return adapter;
}

/**
 * Dispatch a command received from the service worker.
 * @returns {Promise<{ok: true, data: unknown} | {ok: false, error: object}>}
 */
export async function handleFlowCommand(adapter, command, payload) {
  if (command === 'ping') {
    return { ok: true, data: { ready: true, version: adapter.version } };
  }
  if (!FLOW_COMMANDS.includes(command)) {
    return { ok: false, error: { code: ERROR_CODES.INVALID_INPUT, message: `Unknown Flow command "${command}".`, recoverable: false } };
  }
  try {
    const handler = adapter[command];
    const data = await handler(payload);
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: toErrorPayload(error) };
  }
}

function check(label, ok, detail) {
  return { label, ok: Boolean(ok), detail: normalizeText(detail) };
}

function submissionChanged(doc, promptEl, originalButton, promptBefore) {
  const current = findGenerateButton(doc, promptEl);
  if (!originalButton.isConnected) return true;
  if (current && !isGenerateEnabled(current.el)) return true;
  if (findProgressIndicators(doc, promptEl).length > 0) return true;
  const promptAfter = normalizeText(readEditableText(promptEl));
  return Boolean(promptBefore) && promptAfter !== promptBefore;
}

function pressEnter(target) {
  target.focus?.({ preventScroll: true });
  const view = target.ownerDocument.defaultView;
  const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
  target.dispatchEvent(new view.KeyboardEvent('keydown', init));
  target.dispatchEvent(new view.KeyboardEvent('keypress', init));
  target.dispatchEvent(new view.KeyboardEvent('keyup', init));
}

