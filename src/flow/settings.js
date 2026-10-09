import { AutomationError, ERROR_CODES } from '../utils/errors.js';
import { accessibleName, clickElement, clickOutside, normalizeText, pressEscape, waitForValue } from './dom.js';
import {
  classifySettingOption,
  findDetectedSettings,
  findOpenPopover,
  findSettingsTrigger,
  findSettingsTriggerWhenReady,
  isSelected,
  listPromptControls,
  readPopoverOptions,
  requirePromptBox,
} from './selectors.js';

/**
 * Read and change Flow's own settings (Mode, Model, Aspect ratio).
 *
 * Values and options are always taken from the open settings popover in Flow.
 * Nothing is stored as fake local UI state, and nothing is offered that Flow
 * does not show. Every change is verified by re-reading Flow afterwards.
 *
 * @typedef {'mode'|'model'|'aspectRatio'} SettingKey
 */

export const SETTING_KEYS = Object.freeze(['mode', 'model', 'aspectRatio']);

/**
 * @param {{doc: Document, sleep: (ms:number)=>Promise<void>, timings: {popoverMs: number, settleMs: number}}} ctx
 * @returns {Promise<{current: Record<SettingKey, string|null>, options: Record<SettingKey, string[]>, strategy: string}>}
 */
export async function readFlowSettings(ctx) {
  const prompt = requirePromptBox(ctx.doc);
  const trigger = await requireSettingsTrigger(ctx, prompt);
  const chip = findDetectedSettings(ctx.doc, prompt.el);
  const popover = await openSettingsPopover(ctx, trigger.el, prompt.el);
  try {
    const options = readPopoverOptions(popover);
    const result = summarize(options, trigger, ctx.doc, prompt.el, trigger.strategy, chip);
    // A menu that is not the generation settings menu must never be summarised as
    // settings: without this check, an unrelated menu's selected option (a view
    // option like "dashboardGrid") would be reported as Flow's model.
    const recognized = SETTING_KEYS.filter((key) => (result.options[key] ?? []).length > 0);
    if (!recognized.length) {
      const offered = options.map((option) => option.name).filter(Boolean);
      throw new AutomationError(
        ERROR_CODES.FLOW_UI_CHANGED,
        `The menu that opened ("${accessibleName(trigger.el).slice(0, 40)}") is not Flow's generation settings menu. ` +
          `Its options: ${offered.length ? offered.join(', ') : '(none readable)'}. ` +
          `The model chip in the composer shows "${chip.model ?? 'unknown'}". Run "Check Flow page" in Settings for the full report.`,
      );
    }
    return result;
  } finally {
    await closePopover(ctx, popover);
  }
}

/**
 * Apply each requested setting through Flow's popover, verifying every step.
 * @param {Partial<Record<SettingKey, string>>} target
 */
export async function applyFlowSettings(ctx, target) {
  for (const key of SETTING_KEYS) {
    const wanted = target?.[key];
    if (!wanted) continue;

    const prompt = requirePromptBox(ctx.doc);
    const trigger = await requireSettingsTrigger(ctx, prompt);
    const chip = findDetectedSettings(ctx.doc, prompt.el);
    const popover = await openSettingsPopover(ctx, trigger.el, prompt.el);
    let applied = false;
    try {
      const options = readPopoverOptions(popover);
      const match = options.find((option) => classifySettingOption(option, { chipModel: chip.model }) === key && sameName(option.name, wanted));
      if (!match) {
        const available = options
          .filter((option) => classifySettingOption(option, { chipModel: chip.model }) === key)
          .map((option) => option.name);
        throw new AutomationError(
          ERROR_CODES.FLOW_SETTING_FAILED,
          `Flow does not offer "${wanted}" for ${labelFor(key)}.${available.length ? ` Available: ${available.join(', ')}.` : ''}`,
        );
      }
      if (!match.selected && !isSelected(match.el)) {
        clickElement(match.el);
        applied = true;
        await ctx.sleep(ctx.timings.settleMs);
      } else {
        applied = true;
      }
    } finally {
      // A menu that stays open would block the next step; close it either way.
      if (findOpenPopover(ctx.doc) === popover) await closePopover(ctx, popover);
      else await waitForClosed(ctx, popover);
    }
    if (!applied) {
      throw new AutomationError(ERROR_CODES.FLOW_SETTING_FAILED, `Could not select "${wanted}" for ${labelFor(key)}.`);
    }
  }
  const result = await readFlowSettings(ctx);
  for (const key of SETTING_KEYS) {
    const wanted = target?.[key];
    if (!wanted) continue;
    if (!sameName(result.current[key] ?? '', wanted)) {
      throw new AutomationError(
        ERROR_CODES.FLOW_SETTING_FAILED,
        `Flow shows ${result.current[key] ? `"${result.current[key]}"` : 'no value'} for ${labelFor(key)} after selecting "${wanted}".`,
      );
    }
  }
  return result;
}

async function openSettingsPopover(ctx, triggerEl, promptEl = null) {
  const existing = findOpenPopover(ctx.doc, { exclude: promptEl });
  if (existing) {
    await closePopover(ctx, existing);
  }
  const name = accessibleName(triggerEl).slice(0, 40) || '(no accessible name)';
  clickElement(triggerEl);
  const popover = await waitForValue(() => findOpenPopover(ctx.doc, { exclude: promptEl }), {
    timeoutMs: ctx.timings.popoverMs,
    intervalMs: 80,
    sleep: ctx.sleep,
  });
  if (!popover) {
    // Say WHICH control was clicked: "did not open" is only actionable with that.
    throw new AutomationError(
      ERROR_CODES.FLOW_UI_CHANGED,
      `The Flow settings menu did not open after clicking "${name}". No dialog, menu or listbox appeared within ${Math.round(ctx.timings.popoverMs / 1000)}s. ` +
        'The control may not open the settings menu in this Flow layout. Run "Check Flow page" in Settings for the full report.',
    );
  }
  return popover;
}

async function closePopover(ctx, popover) {
  if (!popover || !popover.isConnected) return;
  pressEscape(ctx.doc);
  await waitForClosed(ctx, popover);
  if (popover.isConnected && findOpenPopover(ctx.doc) === popover) {
    // Some menus only close on an outside press.
    clickOutside(ctx.doc);
    await waitForClosed(ctx, popover);
  }
}

async function waitForClosed(ctx, popover) {
  await waitForValue(() => !popover.isConnected || findOpenPopover(ctx.doc) !== popover, {
    timeoutMs: ctx.timings.popoverMs,
    intervalMs: 60,
    sleep: ctx.sleep,
  });
}

function summarize(options, trigger, doc, promptEl, strategy, chip = { mode: null, model: null, aspectRatio: null }) {
  const current = { mode: null, model: null, aspectRatio: null };
  const list = { mode: [], model: [], aspectRatio: [] };
  for (const option of options) {
    const key = classifySettingOption(option, { chipModel: chip.model });
    if (!key) continue;
    if (!list[key].includes(option.name)) list[key].push(option.name);
    if (option.selected && !current[key]) current[key] = option.name;
  }
  if (!current.model && chip.model && list.model.includes(chip.model)) {
    // The chip in the composer shows the active model; the menu just does not mark it.
    current.model = chip.model;
  }
  if (!current.model) {
    // Flow shows the active model on the trigger button when no option is marked selected.
    const shown = normalizeText(accessibleName(trigger.el));
    const match = list.model.find((name) => shown.toLowerCase().includes(name.toLowerCase()));
    if (match) current.model = match;
  }
  return {
    current,
    options: list,
    strategy: `${strategy}; popover-options=${options.length}`,
    // Ground truth from the composer itself, for the report and the panel.
    chipModel: chip.model ?? null,
    modelMatchesChip: chip.model ? sameName(current.model ?? '', chip.model) : null,
  };
}

/**
 * The control that opens Flow's settings menu. Flow renders it asynchronously, so a missing
 * control is waited for briefly before failing. The error names the controls that ARE near
 * the prompt, so a layout change can be diagnosed from the message alone.
 */
async function requireSettingsTrigger(ctx, prompt) {
  const found =
    findSettingsTrigger(ctx.doc, prompt.el) ??
    (await findSettingsTriggerWhenReady(ctx.doc, prompt.el, { timeoutMs: ctx.timings.popoverMs, sleep: ctx.sleep }));
  if (!found) {
    const nearby = listPromptControls(ctx.doc, prompt.el, 6)
      .map((control) => `"${control.name || '(no accessible name)'}"`)
      .join(', ');
    throw new AutomationError(
      ERROR_CODES.FLOW_UI_CHANGED,
      `Could not find the model/settings control next to the Flow prompt box.${nearby ? ` Controls near the prompt: ${nearby}.` : ''} Run "Check Flow page" in Settings for the full report.`,
    );
  }
  return found;
}

function sameName(a, b) {
  return normalizeText(a).toLowerCase() === normalizeText(b).toLowerCase();
}

function labelFor(key) {
  return { mode: 'Mode', model: 'Model', aspectRatio: 'Aspect ratio' }[key];
}
