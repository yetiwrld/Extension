import { AutomationError, ERROR_CODES } from '../utils/errors.js';
import { accessibleName, clickElement, clickOutside, normalizeText, pressEscape, waitForValue } from './dom.js';
import {
  classifySettingOption,
  findOpenPopover,
  findPromptBox,
  findSettingsTrigger,
  isSelected,
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
  const trigger = findSettingsTrigger(ctx.doc, prompt.el);
  if (!trigger) {
    throw new AutomationError(
      ERROR_CODES.FLOW_UI_CHANGED,
      'Could not find the model/settings control next to the Flow prompt box.',
    );
  }

  // Flow's October 2026 composer no longer opens a generation-settings menu for
  // every account. The chip itself is still authoritative and contains the model,
  // aspect ratio and output count (for example "Nano Banana 2.1 · 16:9 · x1").
  // Read it before attempting the menu so an inert chip remains usable.
  const chip = readSettingsChip(trigger.el);
  if (isChipOnlyTrigger(trigger.el) && hasChipSettings(chip)) {
    return chipResult(chip, trigger.strategy);
  }
  let popover;
  try {
    popover = await openSettingsPopover(ctx, trigger.el);
  } catch (error) {
    if (hasChipSettings(chip)) return chipResult(chip, trigger.strategy);
    throw error;
  }

  try {
    const options = readPopoverOptions(popover);
    // Do not mistake Flow's media/Add menu (All media, Images, Characters,
    // Scenes, Uploads, Tools) for generation settings. This was previously the
    // cause of bogus models and a FLOW_UI_CHANGED failure.
    if (!isGenerationSettingsMenu(popover, options)) {
      if (hasChipSettings(chip)) return chipResult(chip, trigger.strategy);
      throw new AutomationError(ERROR_CODES.FLOW_UI_CHANGED, 'Flow opened a menu, but it was not the generation settings menu.');
    }
    return mergeChipSettings(summarize(options, trigger, ctx.doc, prompt.el, trigger.strategy), chip);
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
    const trigger = findSettingsTrigger(ctx.doc, prompt.el);
    if (!trigger) {
      throw new AutomationError(ERROR_CODES.FLOW_UI_CHANGED, 'Could not find the model/settings control next to the Flow prompt box.');
    }
    const shown = readSettingsChip(trigger.el);
    if (sameName(shown.current[key] ?? '', wanted)) continue;
    if (isChipOnlyTrigger(trigger.el) && hasChipSettings(shown)) {
      throw new AutomationError(
        ERROR_CODES.FLOW_SETTING_FAILED,
        `Flow currently shows "${shown.current[key] ?? 'unknown'}" for ${labelFor(key)}, but this composer does not expose a generation settings menu. Change it in Flow, then try again.`,
      );
    }

    let popover;
    try {
      popover = await openSettingsPopover(ctx, trigger.el);
    } catch (error) {
      if (hasChipSettings(shown)) {
        throw new AutomationError(
          ERROR_CODES.FLOW_SETTING_FAILED,
          `Flow currently shows "${shown.current[key] ?? 'unknown'}" for ${labelFor(key)}, but this composer does not expose a generation settings menu. Change it in Flow, then try again.`,
        );
      }
      throw error;
    }
    let applied = false;
    try {
      const options = readPopoverOptions(popover);
      if (!isGenerationSettingsMenu(popover, options)) {
        throw new AutomationError(
          ERROR_CODES.FLOW_SETTING_FAILED,
          'Flow opened its media menu instead of generation settings. Change the setting in Flow, then try again.',
        );
      }
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

/** Read values rendered directly in the compact composer chip. */
function readSettingsChip(triggerEl) {
  const pieces = [triggerEl.textContent ?? ''];
  for (const el of triggerEl.querySelectorAll('[aria-label], mat-icon, [role="img"]')) {
    pieces.push(el.getAttribute('aria-label') ?? '', el.textContent ?? '');
  }
  const raw = normalizeText(pieces.join(' '));
  const ratioMatch = raw.match(/(?:crop[_\s-]*)?(\d{1,2})\s*[:_]\s*(\d{1,2})/i);
  const aspectRatio = ratioMatch ? `${ratioMatch[1]}:${ratioMatch[2]}` : null;

  // textContent normally has the cleanest model label. Remove the other chip
  // fields and generic accessibility labels without maintaining a model list.
  let model = normalizeText(triggerEl.textContent)
    .replace(/(?:crop[_\s-]*)?\d{1,2}\s*[:_]\s*\d{1,2}/gi, ' ')
    .replace(/\bx\s*\d+\b/gi, ' ')
    .replace(/\b(settings?\s+trigger|aspect\s+ratio|outputs?)\b/gi, ' ')
    .replace(/[·•|▾▼]/g, ' ')
    .replace(/^\s*[^\p{L}\p{N}]+/u, ' ');
  model = normalizeText(model) || null;
  const mode = inferMode(model);
  return { current: { mode, model, aspectRatio } };
}

function inferMode(model) {
  if (!model) return null;
  if (/\b(?:veo|video)\b/i.test(model)) return 'Video';
  if (/\b(?:banana|imagen|image)\b/i.test(model)) return 'Image';
  return null;
}

function isChipOnlyTrigger(triggerEl) {
  return triggerEl.matches?.('.settings-trigger-button')
    && !triggerEl.hasAttribute('aria-haspopup')
    && !triggerEl.hasAttribute('aria-expanded');
}

function hasChipSettings(chip) {
  return Boolean(chip?.current?.model || chip?.current?.aspectRatio);
}

function chipResult(chip, strategy) {
  const options = { mode: [], model: [], aspectRatio: [] };
  for (const key of SETTING_KEYS) {
    if (chip.current[key]) options[key].push(chip.current[key]);
  }
  return { current: chip.current, options, strategy: `${strategy}; composer-chip` };
}

function mergeChipSettings(result, chip) {
  for (const key of SETTING_KEYS) {
    if (!result.current[key] && chip.current[key]) result.current[key] = chip.current[key];
    if (chip.current[key] && !result.options[key].some((value) => sameName(value, chip.current[key]))) {
      result.options[key].push(chip.current[key]);
    }
  }
  return result;
}

function isGenerationSettingsMenu(popover, options) {
  const groups = new Set(options.map(classifySettingOption).filter(Boolean));
  const text = normalizeText(`${popover.getAttribute?.('aria-label') ?? ''} ${popover.textContent ?? ''}`);
  const hasSettingsHeading = /\b(model|aspect\s*ratio|mode|output\s*count)\b/i.test(text);
  const hasRatio = options.some((option) => classifySettingOption(option) === 'aspectRatio');
  return hasRatio || (hasSettingsHeading && groups.size >= 2);
}

function requirePrompt(doc) {
  const prompt = findPromptBox(doc);
  if (!prompt) {
    throw new AutomationError(ERROR_CODES.FLOW_UI_CHANGED, 'Flow prompt box not found. Open a Flow project and keep the prompt box visible.');
  }
  return prompt;
}

function sameName(a, b) {
  return normalizeText(a).toLowerCase() === normalizeText(b).toLowerCase();
}

function labelFor(key) {
  return { mode: 'Mode', model: 'Model', aspectRatio: 'Aspect ratio' }[key];
}
