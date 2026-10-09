import { AutomationError, ERROR_CODES } from '../utils/errors.js';
import { accessibleName, clickElement, clickOutside, isVisible, normalizeText, pressEscape, waitForValue } from './dom.js';
import {
  classifySettingOption,
  collectOpenMenus,
  findDetectedSettings,
  findModelChipText,
  findOpenPopover,
  findSettingsTrigger,
  findSettingsTriggerWhenReady,
  isModelSubmenuTrigger,
  isSelected,
  listPromptControls,
  pickNewMenuSurface,
  readPopoverOptions,
  requirePromptBox,
} from './selectors.js';

/**
 * Read and change Flow's own settings (Mode, Model, Aspect ratio, output count).
 *
 * Values and options are always taken from the open settings popover in Flow.
 * Nothing is stored as fake local UI state, and nothing is offered that Flow
 * does not show. Every change is verified against observable UI state — the
 * model chip's own text first — never reported as done just because a click
 * happened.
 *
 * The model list can be NESTED ("Select model family" opens another menu): the
 * reader inspects it before choosing, and descends at most two levels.
 *
 * @typedef {'mode'|'model'|'aspectRatio'|'outputs'} SettingKey
 */

export const SETTING_KEYS = Object.freeze(['mode', 'model', 'aspectRatio', 'outputs']);

/**
 * @param {{doc: Document, sleep: (ms:number)=>Promise<void>, timings: {popoverMs: number, settleMs: number}}} ctx
 * @returns {Promise<{current: Record<SettingKey, string|null>, options: Record<SettingKey, string[]>, strategy: string}>}
 */
export async function readFlowSettings(ctx) {
  const prompt = requirePromptBox(ctx.doc);
  const trigger = await requireSettingsTrigger(ctx, prompt);
  const chip = findDetectedSettings(ctx.doc, prompt.el);
  const popover = await openSettingsPopover(ctx, trigger.el, prompt.el);
  let nested = null;
  try {
    const options = readPopoverOptions(popover);
    // The model list can be nested behind "Select model family": inspect it so the
    // model options and the current model are the real ones, not an empty list.
    const modelTrigger = options.find(
      (option) => classifySettingOption(option, { chipModel: chip.model }) === 'model' && isModelSubmenuTrigger(option),
    );
    let modelRead = { options: [], selected: null };
    if (modelTrigger) {
      nested = await openNestedMenu(ctx, popover, modelTrigger.el, prompt.el);
      if (nested) modelRead = await readModelMenu(ctx, nested, chip, prompt.el);
    }
    const result = summarize(options, modelRead.options, trigger, trigger.strategy, chip, modelTrigger);
    // A menu that is not the generation settings menu must never be summarised as
    // settings: without this check, an unrelated menu's selected option (a view
    // option like "dashboardGrid") would be reported as Flow's model. The live
    // generation menu is recognised by ANY of its real controls: mode, aspect
    // ratio, output count, model options or the model-list submenu.
    const recognized = SETTING_KEYS.filter((key) => (result.options[key] ?? []).length > 0);
    if (!recognized.length && !result.hasModelSubmenu) {
      const offered = options.map((option) => option.name).filter(Boolean);
      const visible = offered.length ? offered.join(', ') : visibleTextLines(popover).join(', ') || '(none readable)';
      throw new AutomationError(
        ERROR_CODES.FLOW_UI_CHANGED,
        `The menu that opened ("${accessibleName(trigger.el).slice(0, 40)}") is not Flow's generation settings menu. ` +
          `Its options: ${visible}. ` +
          `The model chip in the composer shows "${chipText(chip)}". Run "Check Flow page" in Settings for the full report.`,
      );
    }
    return result;
  } finally {
    if (nested) await closePopover(ctx, nested);
    await closePopover(ctx, popover);
  }
}

/** The first visible text lines of a menu surface, for errors when no option was readable. */
function visibleTextLines(popover) {
  const lines = [];
  const walker = popover.ownerDocument.createTreeWalker(popover, 1);
  let node = walker.currentNode;
  while (node && lines.length < 8) {
    if (node !== popover && isVisible(node)) {
      const own = normalizeText(node.textContent ?? '');
      if (own && own.length <= 40 && /[A-Za-z0-9]/.test(own) && !lines.includes(own)) lines.push(own);
    }
    node = walker.nextNode();
  }
  return lines;
}

/** The chip's values as one readable string ("Nano Banana 2.1 · 16:9 · x1"). */
function chipText(chip) {
  return [chip.model, chip.aspectRatio, chip.outputs].filter(Boolean).join(' \u00b7 ') || 'unknown';
}

/**
 * Apply each requested setting through Flow's popover, verifying every step.
 * A click is never success by itself: after each change the observable state —
 * the model chip's own text, or the menu's selected option for what the chip does
 * not show (mode) — must agree with the requested value.
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
    let nested = null;
    try {
      const options = readPopoverOptions(popover);
      if (key === 'model') {
        nested = await selectModel(ctx, popover, options, wanted, chip, prompt.el);
      } else {
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
          await ctx.sleep(ctx.timings.settleMs);
        }
      }
      // Verify THIS selection against observable UI state, not against the click.
      const verified = await verifySetting(ctx, key, wanted, prompt, popover);
      if (!verified.ok) {
        throw new AutomationError(ERROR_CODES.FLOW_SETTING_FAILED, verified.message);
      }
    } finally {
      // A menu that stays open would block the next step; close it either way.
      if (nested) await closePopover(ctx, nested);
      if (findOpenPopover(ctx.doc) === popover) await closePopover(ctx, popover);
      else await waitForClosed(ctx, popover);
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

/**
 * Choose a model through the (possibly nested) model list: open "Select model
 * family", read what it offers, descend into the family that contains the wanted
 * model when the list shows families, and click the model itself. Returns the
 * menu that is open after the choice (for closing), or null.
 */
async function selectModel(ctx, popover, options, wanted, chip, promptEl) {
  const modelTrigger = options.find(
    (option) => classifySettingOption(option, { chipModel: chip.model }) === 'model' && isModelSubmenuTrigger(option),
  );
  if (!modelTrigger) {
    // No submenu: the menu lists models directly.
    const direct = options.find((option) => classifySettingOption(option, { chipModel: chip.model }) === 'model' && sameName(option.name, wanted));
    if (!direct) {
      throw new AutomationError(
        ERROR_CODES.FLOW_SETTING_FAILED,
        `Flow does not offer model "${wanted}".${options.length ? ` Its menu offers: ${options.map((option) => option.name).join(', ')}.` : ''}`,
      );
    }
    if (!direct.selected && !isSelected(direct.el)) {
      clickElement(direct.el);
      await ctx.sleep(ctx.timings.settleMs);
    }
    return null;
  }
  let menu = await openNestedMenu(ctx, popover, modelTrigger.el, promptEl);
  if (!menu) {
    throw new AutomationError(
      ERROR_CODES.FLOW_SETTING_FAILED,
      'The model list ("Select model family") did not open. Run "Check Flow page" in Settings for the full report.',
    );
  }
  let depth = 0;
  while (depth <= 2) {
    const raw = readPopoverOptions(menu).map((option) => ({ ...option, group: option.group ?? 'Model' }));
    const models = raw.filter((option) => classifySettingOption(option, { chipModel: chip.model }) === 'model');
    const match = models.find((option) => !isModelSubmenuTrigger(option) && sameName(option.name, wanted));
    if (match) {
      if (!match.selected && !isSelected(match.el)) {
        clickElement(match.el);
        await ctx.sleep(ctx.timings.settleMs);
      }
      return menu;
    }
    // The list shows families: descend into the one containing the wanted model.
    const family = models.find((option) => isModelSubmenuTrigger(option) && containsName(wanted, option.name));
    if (!family || depth === 2) {
      throw new AutomationError(
        ERROR_CODES.FLOW_SETTING_FAILED,
        `Flow does not offer model "${wanted}".${models.length ? ` The model list offers: ${models.map((option) => option.name).join(', ')}.` : ''}`,
      );
    }
    const next = await openNestedMenu(ctx, menu, family.el, promptEl);
    if (!next) {
      throw new AutomationError(ERROR_CODES.FLOW_SETTING_FAILED, `The model family "${family.name}" did not open.`);
    }
    menu = next;
    depth += 1;
  }
  return menu;
}

/**
 * Verify one selection against observable UI state. The model chip is the ground
 * truth for model, aspect ratio and output count (it shows all three); mode is not
 * on the chip, so it is verified by re-reading the menu's selected option (opening
 * the menu again when the choice closed it).
 */
async function verifySetting(ctx, key, wanted, prompt, popover) {
  const chip = findDetectedSettings(ctx.doc, prompt.el);
  const chipValue = key === 'model' ? chip.model : key === 'aspectRatio' ? chip.aspectRatio : key === 'outputs' ? chip.outputs : null;
  if (chipValue) {
    if (sameName(chipValue, wanted)) return { ok: true };
    return {
      ok: false,
      message: `Flow's model chip still shows "${rawChipText(ctx, prompt) ?? chipText(chip)}" after selecting ${labelFor(key)} "${wanted}" (it shows ${key} "${chipValue}").`,
    };
  }
  // The chip does not show this setting (mode): verify in the menu.
  const verdict = await readSelectedFromMenu(ctx, key, wanted, prompt);
  if (!verdict.ok) {
    const raw = rawChipText(ctx, prompt);
    return {
      ok: false,
      message: verdict.actual
        ? `Flow still shows ${labelFor(key)} "${verdict.actual}" after selecting "${wanted}" (model chip: "${raw ?? 'unknown'}").`
        : `Flow does not mark ${labelFor(key)} "${wanted}" as selected after clicking it (model chip: "${raw ?? 'unknown'}").`,
    };
  }
  return { ok: true };
}

/** The chip's raw text at this moment, for error messages that must be verifiable. */
function rawChipText(ctx, prompt) {
  return findModelChipText(ctx.doc, prompt.el);
}

/** Re-read the menu's selected option for `key`: re-open the menu only when the choice closed it. */
async function readSelectedFromMenu(ctx, key, wanted, prompt) {
  let menu = findOpenPopover(ctx.doc, { exclude: prompt.el });
  let opened = false;
  if (!menu) {
    const trigger = await requireSettingsTrigger(ctx, prompt);
    menu = await openSettingsPopover(ctx, trigger.el, prompt.el);
    opened = true;
  }
  try {
    const options = readPopoverOptions(menu);
    const chip = findDetectedSettings(ctx.doc, prompt.el);
    const selected = options.find((option) => classifySettingOption(option, { chipModel: chip.model }) === key && option.selected);
    if (!selected) return { ok: false, actual: null };
    return sameName(selected.name, wanted) ? { ok: true, actual: selected.name } : { ok: false, actual: selected.name };
  } finally {
    if (opened) await closePopover(ctx, menu);
  }
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

/**
 * Click a submenu trigger ("Select model family") and wait for the menu it opens.
 * The nested surface can sit beside the parent menu or inside it; pickNewMenuSurface
 * resolves either shape. Returns null when nothing new opens.
 */
async function openNestedMenu(ctx, parentMenu, triggerEl, promptEl) {
  clickElement(triggerEl);
  await ctx.sleep(ctx.timings.settleMs);
  return waitForValue(() => pickNewMenuSurface(ctx.doc, parentMenu, promptEl), {
    timeoutMs: ctx.timings.popoverMs,
    intervalMs: 80,
    sleep: ctx.sleep,
  });
}

/**
 * Read the model list, descending into a family submenu when the list shows
 * families rather than models (bounded at two levels). The options are read with
 * their group forced to "Model" so every model in the list classifies as a model.
 *
 * @returns {Promise<{options: object[], selected: string|null}>}
 */
async function readModelMenu(ctx, menu, chip, promptEl, depth = 0) {
  const raw = readPopoverOptions(menu).map((option) => ({ ...option, group: option.group ?? 'Model' }));
  const models = raw.filter((option) => classifySettingOption(option, { chipModel: chip.model }) === 'model');
  const selected = models.find((option) => option.selected && !isModelSubmenuTrigger(option));
  if (selected || depth >= 2) return { options: models, selected: selected?.name ?? null };
  // No model marked: the list shows families. Descend into the family that contains
  // the chip's model (or the chip's model is itself an option).
  const direct = models.find((option) => chip.model && sameName(option.name, chip.model));
  if (direct) return { options: models, selected: direct.name };
  const family = models.find((option) => isModelSubmenuTrigger(option) && chip.model && containsName(chip.model, option.name));
  if (!family) return { options: models, selected: null };
  const nested = await openNestedMenu(ctx, menu, family.el, promptEl);
  if (!nested) return { options: models, selected: null };
  return readModelMenu(ctx, nested, chip, promptEl, depth + 1);
}

/** True when `haystack` contains `needle` as a word ("Nano Banana" in "Nano Banana 2.1"). */
function containsName(haystack, needle) {
  return new RegExp(`\\b${escapeRegExp(normalizeText(needle))}\\b`, 'i').test(normalizeText(haystack));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Summarise what Flow shows. The composer's chip is the ground truth for model,
 * aspect ratio and output count; the menu supplies the options and the selected
 * mode. A value the menu does not mark is taken from the chip, and every chip value
 * is cross-checked so a mismatch is reported instead of hidden.
 */
function summarize(topOptions, modelOptions, trigger, strategy, chip, modelTrigger) {
  const current = { mode: null, model: null, aspectRatio: null, outputs: null };
  const list = { mode: [], model: [], aspectRatio: [], outputs: [] };
  const collect = (options, { skipModelTriggers = false } = {}) => {
    for (const option of options) {
      const key = classifySettingOption(option, { chipModel: chip.model });
      if (!key) continue;
      // "Select model family" opens the model list; it is evidence, never a value.
      if (skipModelTriggers && key === 'model' && isModelSubmenuTrigger(option)) continue;
      if (!list[key].includes(option.name)) list[key].push(option.name);
      if (option.selected && !current[key]) current[key] = option.name;
    }
  };
  collect(topOptions, { skipModelTriggers: true });
  collect(modelOptions);
  // The chip is what Flow actually shows right now.
  if (!current.model && chip.model) current.model = chip.model;
  if (!current.aspectRatio && chip.aspectRatio) current.aspectRatio = chip.aspectRatio;
  if (!current.outputs && chip.outputs) current.outputs = chip.outputs;
  if (!current.model) {
    // Flow shows the active model on the trigger button when nothing else marks it.
    const shown = normalizeText(accessibleName(trigger.el));
    const match = list.model.find((name) => shown.toLowerCase().includes(name.toLowerCase()));
    if (match) current.model = match;
  }
  return {
    current,
    options: list,
    strategy: `${strategy}; popover-options=${topOptions.length}${modelOptions.length ? `; model-menu-options=${modelOptions.length}` : ''}`,
    hasModelSubmenu: Boolean(modelTrigger),
    // Ground truth from the composer itself, for the report and the panel.
    chipModel: chip.model ?? null,
    chipAspectRatio: chip.aspectRatio ?? null,
    chipOutputs: chip.outputs ?? null,
    modelMatchesChip: chip.model ? sameName(current.model ?? '', chip.model) : null,
    aspectMatchesChip: chip.aspectRatio ? sameName(current.aspectRatio ?? '', chip.aspectRatio) : null,
    outputsMatchesChip: chip.outputs ? sameName(current.outputs ?? '', chip.outputs) : null,
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
  return { mode: 'Mode', model: 'Model', aspectRatio: 'Aspect ratio', outputs: 'output count' }[key] ?? key;
}
