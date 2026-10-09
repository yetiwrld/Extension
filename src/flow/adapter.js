import { AutomationError, ERROR_CODES, toErrorPayload } from '../utils/errors.js';
import { sleep as defaultSleep } from '../utils/async.js';
import { FLOW_COMMANDS } from '../shared/protocol.js';
import { applyFlowSettings, readFlowSettings } from './settings.js';
import { insertPrompt } from './prompt.js';
import { attachReferences, clearReferences, countAttachedReferences } from './references.js';
import { generationStatus as readGenerationStatus, snapshotOutputs as takeOutputSnapshot } from './outputs.js';
import {
  findAgentToggle,
  findDetectedSettings,
  findGenerateButton,
  findPromptBox,
  findPromptBoxWhenReady,
  findSettingsTrigger,
  findSettingsTriggerWhenReady,
  isGenerateEnabled,
  listPromptControls,
} from './selectors.js';
import { accessibleName, clickElement, normalizeText } from './dom.js';

/**
 * Flow adapter: the only place that turns automation intents into Flow DOM work.
 *
 * Commands map 1:1 onto FLOW_PORT_METHODS (used by the queue runner) plus
 * `ping`, `diagnose`, `readSettings` and `applySettings` for the side panel.
 * All failures are AutomationError with a stable code.
 */

export const ADAPTER_VERSION = '1.0.0';

export const DEFAULT_TIMINGS = Object.freeze({
  settleMs: 350,
  popoverMs: 2500,
});

/** Bounded waits for Flow's asynchronous UI. Waiting replaces failing on a half-rendered page. */
export const DEFAULT_WAITS = Object.freeze({
  composerMs: 2500,
  triggerMs: 2000,
});

/**
 * @param {{doc?: Document, sleep?: (ms: number) => Promise<void>, timings?: Partial<typeof DEFAULT_TIMINGS>, waits?: Partial<typeof DEFAULT_WAITS>, location?: {href: string}}} [options]
 */
export function createFlowAdapter(options = {}) {
  const doc = options.doc ?? globalThis.document;
  const sleep = options.sleep ?? defaultSleep;
  const timings = { ...DEFAULT_TIMINGS, ...(options.timings ?? {}) };
  const waits = { ...DEFAULT_WAITS, ...(options.waits ?? {}) };
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
      const isProjectPage = /\/project\//.test(location?.pathname ?? '');
      const guardedAsync = async (label, read, fallback = null) => {
        try {
          return await read();
        } catch (error) {
          issues.push(`${label}: ${error?.message || String(error)}`);
          return fallback;
        }
      };
      let prompt = guarded('prompt box', () => findPromptBox(doc));
      if (!prompt && isProjectPage) {
        // Flow renders the project UI asynchronously: wait briefly for the composer
        // instead of reporting a missing prompt on a page that is still loading.
        prompt = await guardedAsync('prompt box (after waiting)', () =>
          findPromptBoxWhenReady(doc, { timeoutMs: waits.composerMs, sleep }),
        );
      }
      const generate = guarded('Generate button', () => (prompt ? findGenerateButton(doc, prompt.el) : findGenerateButton(doc, null)));
      let trigger = guarded('settings control', () => (prompt ? findSettingsTrigger(doc, prompt.el) : null));
      if (!trigger && prompt) {
        trigger = await guardedAsync('settings control (after waiting)', () =>
          findSettingsTriggerWhenReady(doc, prompt.el, { timeoutMs: waits.triggerMs, sleep }),
        );
      }
      const agent = guarded('agent toggle', () => (prompt ? findAgentToggle(doc, prompt.el) : null));
      return {
        url: location?.href ?? '',
        isProjectPage,
        promptFound: Boolean(prompt),
        promptStrategy: prompt?.strategy ?? null,
        generateFound: Boolean(generate),
        generateStrategy: generate?.strategy ?? null,
        generateEnabled: guarded('Generate state', () => (generate ? isGenerateEnabled(generate.el) : false), false),
        settingsFound: Boolean(trigger),
        settingsStrategy: trigger?.strategy ?? null,
        settingsAmbiguous: Boolean(trigger?.ambiguous),
        // The controls near the prompt and the settings they show, so a mismatch with the
        // live page can be diagnosed from the panel instead of a bare "Not found".
        promptControls: guarded('prompt controls', () => (prompt ? listPromptControls(doc, prompt.el) : []), []),
        detectedSettings: guarded(
          'detected settings',
          () => (prompt ? findDetectedSettings(doc, prompt.el) : { mode: null, model: null, aspectRatio: null }),
          { mode: null, model: null, aspectRatio: null },
        ),
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
        check(
          'Settings control',
          probe.settingsFound,
          probe.settingsFound
            ? `Found (${probe.settingsStrategy}).${probe.settingsAmbiguous ? ' Several controls match; the first was used.' : ''}`
            : settingsNotFoundDetail(probe.promptControls),
        ),
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
      clickElement(generate.el);
      await sleep(timings.settleMs);
      return { clicked: true, strategy: generate.strategy };
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

/** When the settings control is missing, name the controls that are near the prompt box. */
function settingsNotFoundDetail(candidates) {
  if (!candidates?.length) return 'Not found. No buttons or menu triggers are visible near the prompt box.';
  const list = candidates
    .map((control) => `${control.tag}${control.role ? `[${control.role}]` : ''}${control.popup ? `[${control.popup}]` : ''} "${control.name}"`)
    .join('; ');
  return `Not found. Controls near the prompt: ${list}.`;
}

