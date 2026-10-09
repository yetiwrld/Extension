import { AutomationError, ERROR_CODES, toErrorPayload } from '../utils/errors.js';
import { sleep as defaultSleep } from '../utils/async.js';
import { FLOW_COMMANDS } from '../shared/protocol.js';
import { applyFlowSettings, readFlowSettings } from './settings.js';
import { insertPrompt } from './prompt.js';
import { attachReferences, clearReferences, countAttachedReferences, probeDropAcceptance } from './references.js';
import { attachFromProject } from './project-library.js';
import { generationStatus as readGenerationStatus, snapshotOutputs as takeOutputSnapshot } from './outputs.js';
import {
  candidateSummaries,
  classifyComposerState,
  collectFrameDocs,
  collectPromptCandidates,
  countUnreachableFrames,
  findAgentModeChip,
  findAgentToggle,
  findComposerHosts,
  composerHostSummaries,
  findDetectedSettings,
  findProgressIndicators,
  findPromptBox,
  inspectComposerArea,
  inspectFileInputs,
  inspectSettingsTrigger,
  findGenerateButton,
  findPromptBoxWhenReady,
  findSettingsTrigger,
  findSettingsTriggerWhenReady,
  isFlowPageUrl,
  isGenerateEnabled,
  listPromptControls,
  requirePromptBox,
  selectPromptCandidate,
  selectorResults,
  summarizePromptRejections,
} from './selectors.js';
import { accessibleName, clickElement, normalizeText, readEditableText, waitForValue } from './dom.js';

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
    return requirePromptBox(doc);
  }

  const adapter = {
    version: ADAPTER_VERSION,

    /** Snapshot of what this page offers. Never throws for missing controls; reports them instead. */
    async probe() {
      // Each lookup is guarded: one unexpected element must not hide the status of the whole page.
      const issues = [];
      const exceptions = [];
      const note = (label, error) => {
        const message = String(error?.message ?? error);
        issues.push(`${label}: ${message}`);
        exceptions.push({ label, message, stack: trimStack(error) });
      };
      const guarded = (label, read, fallback = null) => {
        try {
          return read();
        } catch (error) {
          note(label, error);
          return fallback;
        }
      };
      const isProjectPage = /\/project\//.test(location?.pathname ?? '');
      const flowPage = isFlowPageUrl(location);
      const guardedAsync = async (label, read, fallback = null) => {
        try {
          return await read();
        } catch (error) {
          note(label, error);
          return fallback;
        }
      };
      // Every text field the page offers, with why each is or is not the composer.
      let candidates = guarded('prompt candidates', () => collectPromptCandidates(doc), []);
      for (const candidate of candidates) {
        if (candidate.error) issues.push(`prompt candidate: ${candidate.error}`);
      }
      let prompt = guarded('prompt box', () => selectPromptCandidate(candidates));
      if (!prompt && flowPage && (isProjectPage || doc.readyState !== 'complete')) {
        // Flow renders the project UI asynchronously: wait briefly for the composer
        // instead of reporting a missing prompt on a page that is still loading.
        // Off a project URL the wait is shorter: a settled page reports at once.
        const composerWaitMs = isProjectPage ? waits.composerMs : Math.min(waits.composerMs, 800);
        prompt = await guardedAsync('prompt box (after waiting)', () =>
          findPromptBoxWhenReady(doc, { timeoutMs: composerWaitMs, sleep }),
        );
        if (prompt) candidates = guarded('prompt candidates (after waiting)', () => collectPromptCandidates(doc), candidates);
      }
      const generate = guarded('Generate button', () => (prompt ? findGenerateButton(doc, prompt.el) : findGenerateButton(doc, null)));
      let trigger = guarded('settings control', () => (prompt ? findSettingsTrigger(doc, prompt.el) : null));
      if (!trigger && prompt) {
        trigger = await guardedAsync('settings control (after waiting)', () =>
          findSettingsTriggerWhenReady(doc, prompt.el, { timeoutMs: waits.triggerMs, sleep }),
        );
      }
      const agent = guarded('agent toggle', () => (prompt ? findAgentToggle(doc, prompt.el) : null));
      // Agent mode, from the verified chip (button.agent-mode-chip + aria-pressed) and
      // the composer custom elements — existence is not enough, visibility is checked.
      const agentMode = guarded('agent mode', () => {
        const chip = findAgentModeChip(doc);
        const hosts = findComposerHosts(doc);
        return {
          chipFound: Boolean(chip),
          chipPressed: Boolean(chip?.pressed),
          composer: hosts.classic?.visible ? 'classic' : hosts.agent?.visible ? 'agent' : null,
          classicVisible: Boolean(hosts.classic?.visible),
          agentVisible: Boolean(hosts.agent?.visible),
          composerHosts: composerHostSummaries(hosts),
        };
      }, null);
      return {
        url: location?.href ?? '',
        flowPage,
        isProjectPage,
        workspaceDetected: Boolean(prompt),
        promptFound: Boolean(prompt),
        promptStrategy: prompt?.strategy ?? null,
        promptEnabled: prompt ? prompt.enabled !== false : false,
        promptAmbiguous: Boolean(prompt?.ambiguous),
        promptReasons: prompt?.reasons ?? [],
        // The text fields the page offers, so a missing composer can be diagnosed
        // from the panel: each candidate's shape, label, visibility, size, frame and
        // rejection reason. Never the field's content.
        promptCandidates: candidateSummaries(candidates),
        frames: guarded(
          'frames',
          () => ({ inspected: 1 + collectFrameDocs(doc).length, unreachable: countUnreachableFrames(doc) }),
          { inspected: 1, unreachable: 0 },
        ),
        selectorResults: guarded('selector results', () => selectorResults(doc), []),
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
          () => (prompt ? findDetectedSettings(doc, prompt.el) : { mode: null, model: null, aspectRatio: null, outputs: null }),
          { mode: null, model: null, aspectRatio: null, outputs: null },
        ),
        // Read-only map of the composer area (chip, its ancestor chain, text fields,
        // controls, generate candidates, shadow hosts) — the evidence for finding the
        // prompt editor when the composer is NOT detected.
        composerArea: guarded('composer area', () => inspectComposerArea(doc), null),
        // Read-only inspection of the settings trigger: the expected button (the
        // community reference's shape, as a candidate), the actual control's
        // tag/classes/name/rect, visibility, enabled state, what covers it, and
        // whether it is the control associated with the visible model chip.
        settingsTrigger: guarded('settings trigger', () => inspectSettingsTrigger(doc, prompt?.el ?? null), null),
        agentOn: Boolean(agentMode?.chipPressed || agent?.on),
        agentFound: Boolean(agent || agentMode?.chipFound),
        agentMode,
        // Which of the three known composer states this page is in (A/B/C/standard),
        // classified from measured facts so the next action is evidence-led.
        composerState: guarded('composer state', () => classifyComposerState(doc), null),
        composerLayout: prompt ? (agent?.on ? 'agent' : 'standard') : null,
        // The upload surface: how many file inputs the page exposes and where.
        // Flow's "Upload" item opens the OS dialog, which no extension can fill, so
        // this is what decides whether references can be attached at all.
        fileInputs: guarded('file inputs', () => inspectFileInputs(doc), []),
        // Does the page accept dropped files, and where? Read-only: dragover only,
        // never a drop, so nothing is uploaded by the diagnostic.
        dropTargets: guarded('drop targets', () => (prompt ? probeDropAcceptance(doc, prompt.el) : []), []),
        referencesAttached: guarded('references', () => (prompt ? countAttachedReferences(doc, prompt.el) : 0), 0),
        outputsVisible: guarded('outputs', () => takeOutputSnapshot(doc).outputKeys.length, 0),
        issues,
        exceptions,
      };
    },

    /** Human-readable checks for the side panel. */
    async diagnose() {
      const probe = await adapter.probe();
      // Attempt the settings read. This is the step that fails on a mismatched page,
      // so the report must show exactly what happened: which control was clicked,
      // whether a menu opened, and which options it offered. Opening the settings
      // menu is read-only: it never submits a prompt and never spends credits.
      let settingsRead = { attempted: false, ok: false, error: null, code: null };
      const readExceptions = [];
      if (probe.promptFound) {
        try {
          const result = await readFlowSettings(ctx);
          settingsRead = {
            attempted: true,
            ok: true,
            current: result.current,
            options: result.options,
            strategy: result.strategy,
            chipModel: result.chipModel,
            chipAspectRatio: result.chipAspectRatio,
            chipOutputs: result.chipOutputs,
            modelMatchesChip: result.modelMatchesChip,
            aspectMatchesChip: result.aspectMatchesChip,
            outputsMatchesChip: result.outputsMatchesChip,
            hasModelSubmenu: result.hasModelSubmenu,
            trace: result.trace ?? [],
            click: result.click ?? null,
          };
        } catch (error) {
          const payload = toErrorPayload(error);
          settingsRead = { attempted: true, ok: false, error: payload.message, code: payload.code };
          readExceptions.push({ label: 'settings read', message: payload.message, stack: trimStack(error) });
        }
      }
      const chipModel = probe.detectedSettings?.model ?? null;
      const checks = [
        check(
          'Flow page',
          probe.flowPage,
          probe.flowPage ? 'This is a supported Flow page.' : `Not a supported Flow page (${probe.url || 'unknown URL'}).`,
        ),
        check(
          'Project open',
          probe.isProjectPage,
          probe.isProjectPage
            ? 'URL is a project page.'
            : `Not a /project/ URL. Workspace composer detected: ${probe.workspaceDetected ? 'yes' : 'no'}.`,
          !probe.isProjectPage && probe.workspaceDetected,
        ),
        check('Prompt box', probe.promptFound, promptFoundDetail(probe)),
        check(
          'Model chip',
          Boolean(chipModel),
          chipModel
            ? `The composer's model chip shows "${chipModel}".`
            : probe.promptFound
              ? 'No model chip identified in the composer; the controls list below shows what is there.'
              : 'No composer to read a chip from.',
          !chipModel && probe.promptFound,
        ),
        check('Generate button', probe.generateFound, probe.generateFound ? `Found (${probe.generateStrategy}), ${probe.generateEnabled ? 'enabled' : 'disabled'}.` : 'Not found.'),
        // A found control whose menu cannot be read is NOT ok: a failed capability
        // must be visible, not hidden behind a green check.
        check('Settings control', settingsRead.ok || (!settingsRead.attempted && probe.settingsFound), settingsControlDetail(probe, settingsRead)),
        check(
          'Agent mode',
          !probe.agentMode?.chipPressed,
          probe.agentMode?.chipPressed
            ? 'Agent mode is ON (button.agent-mode-chip is pressed): the classic composer is hidden. The extension leaves Agent mode automatically before changing settings.'
            : probe.agentMode?.composer === 'classic'
              ? 'Off (the classic composer is active).'
              : 'No agent-mode chip detected.',
        ),
        check(
          'Composer state',
          probe.composerState?.state === 'standard' || probe.composerState?.state === 'A',
          probe.composerState
            ? `${probe.composerState.label} — ${probe.composerState.evidence.join('; ')}.` +
              (probe.composerState.state === 'B'
                ? ' The extension cannot set model, mode, aspect ratio or output count in this interface.'
                : probe.composerState.state === 'C'
                  ? ' Inspect the visible settings control and its click behaviour below before changing selectors.'
                  : '')
            : 'Could not be classified.',
          probe.composerState?.state === 'A',
        ),
        check('Page checks', probe.issues.length === 0, probe.issues.length ? probe.issues.join('; ') : 'All page checks ran.'),
      ];
      return {
        ...probe,
        checks,
        settingsRead,
        modelChip: chipModel,
        exceptions: [...(probe.exceptions ?? []), ...readExceptions],
        adapterVersion: ADAPTER_VERSION,
      };
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

    /** How many reference ("ingredient") chips Flow shows right now. */
    async countReferences() {
      const prompt = findPromptBox(doc);
      return { attached: prompt ? countAttachedReferences(doc, prompt.el) : 0, promptFound: Boolean(prompt) };
    },

    async clearReferences() {
      return clearReferences(ctx);
    },

    async attachFromProject(names) {
      return attachFromProject(ctx, names);
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
      const before = {
        outputs: takeOutputSnapshot(doc).outputKeys.length,
        progress: findProgressIndicators(doc, prompt.el).length,
        promptText: normalizeText(readEditableText(prompt.el)),
      };
      clickElement(generate.el);
      // A click is not a generation: look for observable start evidence (a progress
      // indicator, a new output, or the prompt clearing). The result reports whether
      // any was seen; the runner keeps the authoritative, longer acceptance wait.
      const verified = await waitForValue(() => {
        const outputs = takeOutputSnapshot(doc).outputKeys.length;
        const progress = findProgressIndicators(doc, prompt.el).length;
        const text = normalizeText(readEditableText(prompt.el));
        return outputs > before.outputs || progress > before.progress || (before.promptText && !text) ? true : null;
      }, { timeoutMs: 4000, intervalMs: 150, sleep });
      return { clicked: true, verified: Boolean(verified), strategy: generate.strategy };
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

function check(label, ok, detail, warn = false) {
  return { label, ok: Boolean(ok), warn, detail: normalizeText(detail) };
}

/** The stack helps pin a failing heuristic; it is trimmed so the report stays small. */
function trimStack(error) {
  return String(error?.stack ?? '')
    .split('\n')
    .slice(0, 3)
    .join(' | ')
    .slice(0, 300);
}

/**
 * What the settings-control check says: a successful read with the values, a missing
 * control with the controls that ARE near the prompt, or a found control whose menu
 * could not be read (with the exact error).
 */
function settingsControlDetail(probe, settingsRead) {
  if (settingsRead.ok) {
    const current = settingsRead.current ?? {};
    const bits = ['mode', 'model', 'aspectRatio', 'outputs'].map((key) => `${key}=${current[key] ?? 'unknown'}`).join(', ');
    const chip = settingsRead.chipModel
      ? ` The composer's chip shows "${settingsRead.chipModel}"${settingsRead.modelMatchesChip ? '' : ' — differs from the menu!'}.`
      : '';
    return `Read OK: ${bits}.${chip}`;
  }
  if (!probe.settingsFound) return settingsNotFoundDetail(probe.promptControls);
  return `Found (${probe.settingsStrategy ?? 'unknown strategy'}), but reading it failed: ${settingsRead.error ?? 'unknown error'}`;
}

/** What the prompt-box check says, including why the composer was selected (or why none was). */
function promptFoundDetail(probe) {
  if (!probe.promptFound) {
    const candidates = probe.promptCandidates ?? [];
    const visible = candidates.filter((candidate) => candidate.visible && !candidate.rejection && !candidate.error).length;
    const detail = candidates.length
      ? `${candidates.length} text field(s) on the page (${visible} usable): ${summarizePromptRejections(candidates)}.`
      : 'No text-entry element exists on this page.';
    return `Not found. ${detail} Open a project and keep the prompt box visible.`;
  }
  const parts = [`Found (${probe.promptStrategy})`];
  if (probe.promptEnabled === false) parts.push('disabled');
  if (probe.promptAmbiguous) parts.push('several fields match equally');
  if (probe.composerLayout) parts.push(`${probe.composerLayout} layout`);
  if (Array.isArray(probe.promptReasons) && probe.promptReasons.length) parts.push(`why: ${probe.promptReasons.join('; ')}`);
  return `${parts.join(', ')}.`;
}

/** When the settings control is missing, name the controls that are near the prompt box. */
function settingsNotFoundDetail(candidates) {
  if (!candidates?.length) return 'Not found. No buttons or menu triggers are visible near the prompt box.';
  const list = candidates
    .map((control) => `${control.tag}${control.role ? `[${control.role}]` : ''}${control.popup ? `[${control.popup}]` : ''} "${control.name}"`)
    .join('; ');
  return `Not found. Controls near the prompt: ${list}.`;
}

