import { AutomationError, ERROR_CODES } from '../utils/errors.js';
import { accessibleName, clickElement, clickOutside, normalizeText, pressEscape, waitForValue } from './dom.js';
import {
  classifySettingOption,
  findOpenPopover,
  findPromptBox,
  findSettingsTrigger,
  findSettingsTriggerWhenReady,
  isSelected,
  listPromptControls,
  readPopoverOptions,
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
  const prompt = requirePrompt(ctx.doc);
  const trigger = await requireSettingsTrigger(ctx, prompt);
  const popover = await openSettingsPopover(ctx, trigger.el);
  try {
    const options = readPopoverOptions(popover);
    return summarize(options, trigger, ctx.doc, prompt.el, trigger.strategy);
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

    const prompt = requirePrompt(ctx.doc);
    const trigger = await requireSettingsTrigger(ctx, prompt);
    const popover = await openSettingsPopover(ctx, trigger.el);
    let applied = false;
    try {
      const options = readPopoverOptions(popover);
      const match = options.find((option) => classifySettingOption(option) === key && sameName(option.name, wanted));
      if (!match) {
        const available = options
          .filter((option) => classifySettingOption(option) === key)
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

async function openSettingsPopover(ctx, triggerEl) {
  const existing = findOpenPopover(ctx.doc);
  if (existing) {
    await closePopover(ctx, existing);
  }
  clickElement(triggerEl);
  const popover = await waitForValue(() => findOpenPopover(ctx.doc), { timeoutMs: ctx.timings.popoverMs, intervalMs: 80, sleep: ctx.sleep });
  if (!popover) {
    throw new AutomationError(ERROR_CODES.FLOW_UI_CHANGED, 'The Flow settings menu did not open.');
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

function summarize(options, trigger, doc, promptEl, strategy) {
  const current = { mode: null, model: null, aspectRatio: null };
  const list = { mode: [], model: [], aspectRatio: [] };
  for (const option of options) {
    const key = classifySettingOption(option);
    if (!key) continue;
    if (!list[key].includes(option.name)) list[key].push(option.name);
    if (option.selected && !current[key]) current[key] = option.name;
  }
  if (!current.model) {
    // Flow shows the active model on the trigger button when no option is marked selected.
    const shown = normalizeText(accessibleName(trigger.el));
    const match = list.model.find((name) => shown.toLowerCase().includes(name.toLowerCase()));
    if (match) current.model = match;
  }
  return { current, options: list, strategy: `${strategy}; popover-options=${options.length}` };
}

function requirePrompt(doc) {
  const prompt = findPromptBox(doc);
  if (!prompt) {
    throw new AutomationError(ERROR_CODES.FLOW_UI_CHANGED, 'Flow prompt box not found. Open a Flow project and keep the prompt box visible.');
  }
  return prompt;
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
