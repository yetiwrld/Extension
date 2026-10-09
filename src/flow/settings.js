import { AutomationError, ERROR_CODES } from '../utils/errors.js';
import { matchModelOption, modelLabelsMatch } from './model-id.js';
import { accessibleName, clickElement, clickOutside, isVisible, normalizeText, pressEscape, waitForValue } from './dom.js';
import {
  classifyComposerState,
  classifySettingOption,
  diffSignatures,
  findActiveComposerHost,
  findAgentModeChip,
  findDetectedSettings,
  findModelChipText,
  findOpenPopover,
  findPromptBox,
  findOverlayBackdrops,
  findSettingsMenu,
  findSettingsTrigger,
  findSettingsTriggerWhenReady,
  isExpanded,
  isModelSubmenuTrigger,
  isSelected,
  listPromptControls,
  pickNewMenuSurface,
  readPopoverOptions,
  requirePromptBox,
  snapshotMenuish,
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
/**
 * Leave Flow's Agent mode safely, ONCE, and only when there is something to undo.
 *
 * The guard is the exact, state-guarded chip selector `button.agent-mode-chip[aria-pressed="true"]`:
 * it can only match when Agent mode is on, so the recovery can never click a healthy
 * composer INTO agent mode, and a generic `button[aria-pressed]` is never touched.
 * After the click the state change is VERIFIED (aria-pressed flips, the classic
 * composer returns and its prompt box and settings control become visible) before
 * the caller retries anything. Agent mode is never claimed exited without that proof.
 *
 * @returns {Promise<{attempted: boolean, chipFound: boolean, pressed: boolean, clicked: boolean, stateChanged: boolean, classicComposerBack: boolean, reason: string}>}
 */
async function exitAgentMode(ctx) {
  const chip = findAgentModeChip(ctx.doc);
  if (!chip) return { attempted: false, chipFound: false, pressed: false, clicked: false, stateChanged: false, classicComposerBack: false, reason: 'chip not found' };
  if (!chip.pressed) {
    return { attempted: false, chipFound: true, pressed: false, clicked: false, stateChanged: false, classicComposerBack: false, reason: 'chip is not pressed (nothing to undo)' };
  }
  if (!chip.visible || !chip.enabled) {
    return { attempted: true, chipFound: true, pressed: true, clicked: false, stateChanged: false, classicComposerBack: false, reason: `the chip is ${chip.visible ? 'disabled' : 'not visible'}, so the click is blocked` };
  }
  clickElement(chip.el);
  const stateChanged = await waitForValue(() => {
    const now = findAgentModeChip(ctx.doc);
    return now && now.pressed === false ? true : null;
  }, { timeoutMs: ctx.timings.popoverMs, intervalMs: 80, sleep: ctx.sleep });
  const classicComposerBack = await waitForValue(() => {
    const host = findActiveComposerHost(ctx.doc);
    return host?.kind === 'classic' ? true : null;
  }, { timeoutMs: ctx.timings.popoverMs, intervalMs: 80, sleep: ctx.sleep });
  // The classic composer's own prompt box and settings control must be visible before retrying.
  const controlsReady = await waitForValue(() => (findPromptBox(ctx.doc) ? true : null), {
    timeoutMs: ctx.timings.popoverMs,
    intervalMs: 80,
    sleep: ctx.sleep,
  });
  const triggerReady = Boolean(findSettingsTrigger(ctx.doc, null));
  return {
    attempted: true,
    chipFound: true,
    pressed: true,
    clicked: true,
    stateChanged: Boolean(stateChanged),
    classicComposerBack: Boolean(classicComposerBack && controlsReady && triggerReady),
    reason: stateChanged ? (classicComposerBack ? 'left agent mode; the classic composer is back' : 'the chip flipped but the classic composer did not return') : 'the chip did not change state after the click',
  };
}

/**
 * Run a settings operation, recovering from Agent mode when it fails. The recovery
 * runs AFTER the failure (probing first races the page's asynchronous mount), is
 * attempted at most once, and is only reported as done when verified. When the chip
 * was found pressed but could not be exited, the error names Agent mode explicitly
 * instead of blaming selector drift.
 */
async function runWithAgentRecovery(ctx, operation) {
  try {
    return await operation();
  } catch (error) {
    if (error?.code !== ERROR_CODES.FLOW_UI_CHANGED) throw error;
    const recovery = await exitAgentMode(ctx);
    if (!recovery.attempted || !recovery.stateChanged || !recovery.classicComposerBack) {
      const state = classifyComposerState(ctx.doc);
      if (state.state === 'B') {
        throw new AutomationError(
          ERROR_CODES.FLOW_AGENT_ONLY,
          'Flow is showing only its Agent composer (flow-creative-agent-prompt-box) and offers no agent toggle and no standard settings control ' +
            `(${state.evidence.join('; ')}). The extension cannot set the model, mode, aspect ratio or output count in this interface; ` +
            'set them in Flow itself, or open a project that shows the standard composer.',
        );
      }
      if (recovery.chipFound && recovery.pressed) {
        throw new AutomationError(
          ERROR_CODES.FLOW_AGENT_ON,
          `Agent mode is on in Flow (button.agent-mode-chip is pressed) and the extension could not leave it: ${recovery.reason}. ` +
            'Turn off Agent mode in Flow, then retry.',
        );
      }
      throw error;
    }
    const result = await operation();
    if (result && typeof result === 'object') result.agentModeRecovery = recovery;
    return result;
  }
}

export async function readFlowSettings(ctx) {
  return runWithAgentRecovery(ctx, () => readFlowSettingsOnce(ctx));
}

async function readFlowSettingsOnce(ctx) {
  const prompt = requirePromptBox(ctx.doc);
  const trigger = await requireSettingsTrigger(ctx, prompt);
  const chip = findDetectedSettings(ctx.doc, prompt.el);
  const trace = [
    { step: 'trigger-found', detail: `${trigger.strategy}: "${String(trigger.label ?? '').slice(0, 40)}" (${trigger.control?.tag ?? trigger.el.tagName.toLowerCase()}.${trigger.control?.classes ?? ''})` },
  ];
  const { popover, click } = await openSettingsPopover(ctx, trigger, prompt.el, chip);
  trace.push({ step: 'menu-opened', detail: `popover detected after clicking ${click.control}` });
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
      nested = await openNestedMenu(ctx, popover, modelTrigger.el, prompt.el, chip);
      if (nested) {
        modelRead = await readModelMenu(ctx, nested, chip, prompt.el);
        trace.push({ step: 'model-menu-read', detail: `${modelRead.options.length} model option(s) through the nested menu` });
      }
    }
    const result = summarize(options, modelRead.options, trigger, trigger.strategy, chip, modelTrigger);
    result.trace = trace;
    result.click = click;
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
 * Apply the requested settings through Flow's popover, verifying every step.
 *
 * - The menu is opened ONCE for all settings (not once per key).
 * - A key the model chip already confirms is SKIPPED: no menu interaction at all
 *   when the chip already reflects every requested setting.
 * - A click is never success by itself: after each change the observable state —
 *   the model chip's own text, or the menu's selected option for what the chip does
 *   not show (mode) — must agree with the requested value.
 * @param {Partial<Record<SettingKey, string>>} target
 */
export async function applyFlowSettings(ctx, target) {
  return runWithAgentRecovery(ctx, () => applyFlowSettingsOnce(ctx, target));
}

async function applyFlowSettingsOnce(ctx, target) {
  const trace = [];
  /** Keys Flow does not expose in the active mode: reported, never faked. */
  const notOffered = [];
  const prompt = requirePromptBox(ctx.doc);
  const chip = findDetectedSettings(ctx.doc, prompt.el);
  // Keys the chip already confirms need no interaction at all.
  const chipKeys = ['model', 'aspectRatio', 'outputs'];
  const skipped = SETTING_KEYS.filter(
    (key) => target?.[key] && chipKeys.includes(key) && chip[key] && valuesMatch(key, chip[key], target[key]),
  );
  const pending = SETTING_KEYS.filter((key) => target?.[key] && !skipped.includes(key));
  for (const key of skipped) trace.push({ step: 'already-correct', detail: `${labelFor(key)} "${target[key]}" is already what the chip shows — skipped` });
  if (!pending.length) {
    // Everything requested is already in place: no menu, no clicks.
    trace.push({ step: 'skipped-all', detail: 'the chip already reflects every requested setting' });
    return {
      current: { mode: null, model: chip.model, aspectRatio: chip.aspectRatio, outputs: chip.outputs },
      options: { mode: [], model: [], aspectRatio: [], outputs: [] },
      strategy: 'chip-verified; no menu interaction',
      skipped: true,
      trace,
      chipModel: chip.model ?? null,
      chipAspectRatio: chip.aspectRatio ?? null,
      chipOutputs: chip.outputs ?? null,
    };
  }
  const trigger = await requireSettingsTrigger(ctx, prompt);
  trace.push({ step: 'trigger-found', detail: `${trigger.strategy}: "${String(trigger.label ?? '').slice(0, 40)}"` });
  const { popover, click } = await openSettingsPopover(ctx, trigger, prompt.el, chip);
  trace.push({ step: 'menu-opened', detail: `popover detected after clicking ${click.control}` });
  let nested = null;
  let changed = false;
  try {
    const options = readPopoverOptions(popover);
    // Model last: its nested menu replaces the surface the other keys are read from.
    const ordered = [...pending.filter((key) => key !== 'model'), ...(pending.includes('model') ? ['model'] : [])];
    for (const key of ordered) {
      const wanted = target[key];
      if (key === 'model') {
        nested = await selectModel(ctx, popover, options, wanted, chip, prompt.el);
        changed = true;
      } else {
        const available = options
          .filter((option) => classifySettingOption(option, { chipModel: chip.model }) === key)
          .map((option) => option.name);
        // Flow does not expose this control in the active mode (measured: with
        // ingredients attached its menu offers no Mode rows at all). A control that
        // is not offered cannot be set — and must not fail the scene or be claimed
        // as set: it is reported as not offered and left exactly as Flow has it.
        if (!available.length) {
          notOffered.push(key);
          trace.push({ step: 'not-offered', detail: `Flow's menu offers no ${labelFor(key)} control here \u2014 left as Flow has it` });
          continue;
        }
        const match = options.find((option) => classifySettingOption(option, { chipModel: chip.model }) === key && sameName(option.name, wanted));
        if (!match) {
          throw new AutomationError(
            ERROR_CODES.FLOW_SETTING_FAILED,
            `Flow does not offer "${wanted}" for ${labelFor(key)}.${available.length ? ` Available: ${available.join(', ')}.` : ''}`,
          );
        }
        if (!match.selected && !isSelected(match.el)) {
          clickElement(match.el);
          await ctx.sleep(ctx.timings.settleMs);
          changed = true;
          trace.push({ step: 'clicked', detail: `${labelFor(key)} "${wanted}"` });
        } else {
          trace.push({ step: 'already-selected', detail: `${labelFor(key)} "${wanted}" is already selected` });
        }
      }
      // Verify THIS selection against observable UI state, not against the click.
      const verified = await verifySetting(ctx, key, wanted, prompt);
      if (!verified.ok) {
        throw new AutomationError(ERROR_CODES.FLOW_SETTING_FAILED, verified.message);
      }
      const chipNote = verified.chipMatches === false ? ' — the chip still shows a different value (reported)' : '';
      trace.push({ step: 'verified', detail: `${labelFor(key)} "${wanted}" confirmed by the settings state${chipNote}` });
    }
  } finally {
    // A menu that stays open would block the next step; close it either way.
    if (nested) await closePopover(ctx, nested);
    if (findOpenPopover(ctx.doc) === popover) await closePopover(ctx, popover);
    else await waitForClosed(ctx, popover);
  }
  const result = await readFlowSettings(ctx);
  result.notOffered = notOffered;
  result.trace = [...trace, ...(result.trace ?? []), { step: 'final-read', detail: changed ? 're-read after changes' : 're-read to confirm' }];
  result.click = click;
  for (const key of SETTING_KEYS) {
    const wanted = target?.[key];
    if (!wanted || notOffered.includes(key)) continue;
    if (!valuesMatch(key, result.current[key] ?? '', wanted)) {
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
    const modelOptions = options.filter((option) => classifySettingOption(option, { chipModel: chip.model }) === 'model');
    const picked = matchModelOption(modelOptions, wanted);
    if (picked.ambiguous) {
      throw new AutomationError(
        ERROR_CODES.FLOW_SETTING_FAILED,
        `"${wanted}" matches more than one model in Flow's menu (${picked.candidates.join(', ')}); the extension will not guess which one you meant.`,
      );
    }
    const direct = picked.match;
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
  let menu = await openNestedMenu(ctx, popover, modelTrigger.el, promptEl, chip);
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
    const leaves = models.filter((option) => !isModelSubmenuTrigger(option));
    // A family row ("Nano Banana") is a leading token run of a model name
    // ("Nano Banana 2.1"), so prefix matching is only allowed once no family can
    // be descended into — otherwise the family would be clicked as the model.
    const family = models.find((option) => isModelSubmenuTrigger(option) && containsName(wanted, option.name));
    const picked = matchModelOption(leaves, wanted, (option) => option.name, { allowPrefix: !family });
    if (picked.ambiguous) {
      throw new AutomationError(
        ERROR_CODES.FLOW_SETTING_FAILED,
        `"${wanted}" matches more than one model in Flow's list (${picked.candidates.join(', ')}); the extension will not guess which one you meant.`,
      );
    }
    const match = picked.match;
    if (match) {
      if (!match.selected && !isSelected(match.el)) {
        clickElement(match.el);
        await ctx.sleep(ctx.timings.settleMs);
      }
      return menu;
    }
    // The list shows families: descend into the one containing the wanted model.
    if (!family || depth === 2) {
      throw new AutomationError(
        ERROR_CODES.FLOW_SETTING_FAILED,
        `Flow does not offer model "${wanted}".${models.length ? ` The model list offers: ${models.map((option) => option.name).join(', ')}.` : ''}`,
      );
    }
    const next = await openNestedMenu(ctx, menu, family.el, promptEl, chip);
    if (!next) {
      throw new AutomationError(ERROR_CODES.FLOW_SETTING_FAILED, `The model family "${family.name}" did not open.`);
    }
    menu = next;
    depth += 1;
  }
  return menu;
}

/**
 * Verify one selection against observable UI state. PRIMARY: the settings state
 * itself — the menu's selected option (the chip text alone does not prove the
 * setting, e.g. the aspect ratio). FALLBACK: the model chip for what it shows
 * (the model, once its nested list has closed). The chip is always re-read and
 * cross-checked, so a disagreement is reported, never hidden.
 */
async function verifySetting(ctx, key, wanted, prompt) {
  const chip = findDetectedSettings(ctx.doc, prompt.el);
  const chipValue = key === 'model' ? chip.model : key === 'aspectRatio' ? chip.aspectRatio : key === 'outputs' ? chip.outputs : null;
  // 1) The settings state: what the menu marks as selected.
  const verdict = await readSelectedFromMenu(ctx, key, wanted, prompt);
  if (verdict.marked) {
    if (verdict.ok) {
      return { ok: true, chipValue, chipMatches: chipValue ? valuesMatch(key, chipValue, wanted) : null };
    }
    return {
      ok: false,
      message: `Flow still shows ${labelFor(key)} "${verdict.actual}" after selecting "${wanted}" (model chip: "${rawChipText(ctx, prompt) ?? 'unknown'}").`,
    };
  }
  // 2) The menu marks nothing: the chip is the observable state.
  if (chipValue) {
    if (valuesMatch(key, chipValue, wanted)) return { ok: true, chipValue, chipMatches: true };
    return {
      ok: false,
      message: `Flow's model chip still shows "${rawChipText(ctx, prompt) ?? chipText(chip)}" after selecting ${labelFor(key)} "${wanted}" (it shows ${key} "${chipValue}").`,
    };
  }
  return {
    ok: false,
    message: `Neither the settings menu nor the model chip confirms ${labelFor(key)} "${wanted}" after selecting it (model chip: "${rawChipText(ctx, prompt) ?? 'unknown'}").`,
  };
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
    const chip = findDetectedSettings(ctx.doc, prompt.el);
    ({ popover: menu } = await openSettingsPopover(ctx, trigger, prompt.el, chip));
    opened = true;
  }
  try {
    const options = readPopoverOptions(menu);
    const chip = findDetectedSettings(ctx.doc, prompt.el);
    const selected = options.find((option) => classifySettingOption(option, { chipModel: chip.model }) === key && option.selected);
    if (!selected) return { marked: false, ok: false, actual: null };
    return valuesMatch(key, selected.name, wanted)
      ? { marked: true, ok: true, actual: selected.name }
      : { marked: true, ok: false, actual: selected.name };
  } finally {
    if (opened) await closePopover(ctx, menu);
  }
}

/**
 * Open the generation settings menu by clicking the trigger's CONTROL (the visible
 * label is often a child of the real button), and wait for the menu in the WHOLE
 * document: role-based surfaces in any shadow root (three levels) and portals, then
 * a menu recognised by its CONTENT (Flow's menu can be a role-less custom element).
 *
 * A click is never assumed to have worked: when no menu appears, the trigger is
 * re-found once (Flow rerenders the composer, and a click on a detached element goes
 * nowhere) and clicked again — one bounded retry, not blind clicking. If the menu
 * still does not open, the DOM change the click caused is captured and reported, so
 * the blocker can be identified instead of guessed at.
 *
 * @returns {Promise<{popover: Element, click: object}>}
 */
async function openSettingsPopover(ctx, trigger, promptEl, chip = null) {
  const chipModel = chip?.model ?? null;
  const existing = findSettingsMenu(ctx.doc, { exclude: promptEl, chipModel });
  if (existing) {
    await closePopover(ctx, existing);
  }
  const control = trigger?.el ?? trigger;
  const label = trigger?.label ?? accessibleName(control).slice(0, 40) ?? '(no accessible name)';
  // A leftover CDK backdrop makes the NEXT press close the old overlay instead of
  // opening the menu (the press is consumed), which looks like a dead control. Wait
  // for the page to settle first; nothing is removed from Flow's DOM.
  const settled = await settleOverlays(ctx);
  const before = snapshotMenuish(ctx.doc, { chipModel });
  const wasConnected = control.isConnected;
  const expandedBefore = isExpanded(control);
  let popover = await clickAndWait(ctx, control, promptEl, chipModel);
  let retried = false;
  let reclicked = false;
  if (!popover) {
    // One bounded retry with a FRESH trigger: Flow replaces composer elements on
    // rerender, and a click on a detached node opens nothing.
    const fresh = findSettingsTrigger(ctx.doc, promptEl);
    const freshControl = fresh?.el ?? null;
    if (freshControl && freshControl !== control && freshControl.isConnected) {
      retried = true;
      popover = await clickAndWait(ctx, freshControl, promptEl, chipModel);
    }
  }
  if (!popover) {
    // The press was swallowed (a backdrop was dismissed by it, or the menu toggled
    // shut and open within one frame): let the overlays settle and press ONCE more.
    // Bounded at a single extra press, and only while no menu is open.
    await settleOverlays(ctx);
    const again = findSettingsTrigger(ctx.doc, promptEl)?.el ?? (control.isConnected ? control : null);
    if (again && !findSettingsMenu(ctx.doc, { exclude: promptEl, chipModel })) {
      reclicked = true;
      popover = await clickAndWait(ctx, again, promptEl, chipModel);
    }
  }
  const after = snapshotMenuish(ctx.doc, { chipModel });
  const diff = diffSignatures(before, after);
  const click = {
    control: `${control.tagName.toLowerCase()}.${(control.getAttribute('class') ?? '').slice(0, 40)}`,
    label: String(label).slice(0, 60),
    clicked: wasConnected,
    retried,
    reclicked,
    expandedBefore,
    expandedAfter: isExpanded(findSettingsTrigger(ctx.doc, promptEl)?.el ?? control),
    backdropsBefore: settled.backdropsBefore,
    backdropsCleared: settled.cleared,
    domAdded: diff.added.slice(0, 12),
    domRemoved: diff.removed.slice(0, 12),
  };
  if (!popover) {
    // Say WHICH control was clicked, and WHAT the click changed: "did not open" is
    // only actionable with that evidence.
    const changed = diff.added.length ? ` The click added to the DOM: ${diff.added.slice(0, 8).join('; ')}.` : ' The click changed nothing visible in the DOM.';
    const overlayNote = settled.backdropsBefore
      ? ` ${settled.backdropsBefore} overlay backdrop(s) were on the page before the click and ${settled.cleared ? 'were dismissed first' : 'did NOT go away'}.`
      : '';
    const ariaNote = click.expandedAfter ? ' The control now reports aria-expanded="true", so Flow thinks a menu is open but none could be found.' : '';
    throw new AutomationError(
      ERROR_CODES.FLOW_UI_CHANGED,
      `The Flow settings menu did not open after clicking "${label}" (${reclicked ? '2 presses' : '1 press'}). No menu appeared within ${Math.round(ctx.timings.popoverMs / 1000)}s.${changed}${overlayNote}${ariaNote} ` +
        'Run "Check Flow page" in Settings for the full report.',
    );
  }
  return { popover, click };
}

/**
 * Wait for leftover overlay backdrops to go away before pressing the trigger.
 * Escape, then an outside press — the two gestures a user would make. Nothing is
 * removed from the page; if the backdrops stay, the fact is reported, not hidden.
 * @returns {Promise<{backdropsBefore: number, cleared: boolean}>}
 */
async function settleOverlays(ctx) {
  const backdropsBefore = findOverlayBackdrops(ctx.doc).length;
  if (!backdropsBefore) return { backdropsBefore: 0, cleared: true };
  pressEscape(ctx.doc);
  let gone = await waitForValue(() => (findOverlayBackdrops(ctx.doc).length ? null : true), {
    timeoutMs: ctx.timings.popoverMs,
    intervalMs: 60,
    sleep: ctx.sleep,
  });
  if (!gone) {
    clickOutside(ctx.doc);
    gone = await waitForValue(() => (findOverlayBackdrops(ctx.doc).length ? null : true), {
      timeoutMs: ctx.timings.popoverMs,
      intervalMs: 60,
      sleep: ctx.sleep,
    });
  }
  return { backdropsBefore, cleared: Boolean(gone) };
}

/** Click the control and wait for a menu to appear anywhere in the document. */
async function clickAndWait(ctx, control, promptEl, chipModel) {
  if (!control.isConnected) return null;
  clickElement(control);
  return waitForValue(() => findSettingsMenu(ctx.doc, { exclude: promptEl, chipModel }), {
    timeoutMs: ctx.timings.popoverMs,
    intervalMs: 80,
    sleep: ctx.sleep,
  });
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
  // The menu can be gone while its backdrop is still fading out, and that backdrop
  // swallows the next press. Wait for it too (bounded), then carry on either way.
  await waitForValue(() => (findOverlayBackdrops(ctx.doc).length ? null : true), {
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
async function openNestedMenu(ctx, parentMenu, triggerEl, promptEl, chip = null) {
  clickElement(triggerEl);
  await ctx.sleep(ctx.timings.settleMs);
  return waitForValue(() => pickNewMenuSurface(ctx.doc, parentMenu, promptEl, { chipModel: chip?.model ?? null }), {
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
  // A family row ("Nano Banana") is a leading token run of the chip's model
  // ("Nano Banana 2.1"): only a LEAF row can be the selected model.
  const direct = models.find((option) => chip.model && !isModelSubmenuTrigger(option) && modelLabelsMatch(option.name, chip.model));
  if (direct) return { options: models, selected: direct.name };
  const family = models.find((option) => isModelSubmenuTrigger(option) && chip.model && containsName(chip.model, option.name));
  if (!family) return { options: models, selected: null };
  const nested = await openNestedMenu(ctx, menu, family.el, promptEl, chip);
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
  // Flow renders a material-symbol ligature next to some rows ("image" beside
  // "Image"), which reads as a second option for the same value. Fold values that
  // differ only by case into the displayed variant, so the panel offers one entry
  // and the current value is reported the way Flow writes it.
  for (const key of Object.keys(list)) {
    const canonical = new Map();
    for (const name of list[key]) {
      const id = name.toLowerCase();
      const kept = canonical.get(id);
      if (!kept || (/[A-Z]/.test(name) && !/[A-Z]/.test(kept))) canonical.set(id, name);
    }
    list[key] = [...canonical.values()];
    if (current[key]) current[key] = canonical.get(current[key].toLowerCase()) ?? current[key];
  }
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
    modelMatchesChip: chip.model ? modelLabelsMatch(current.model ?? '', chip.model) : null,
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

/**
 * Compare a requested value with what the UI shows. Models go through the single
 * normalized label<->identifier mapping (model-id.js), because Flow writes the same
 * model differently on the chip and in the menu; every other setting is an exact
 * label comparison.
 * @param {SettingKey} key
 */
function valuesMatch(key, a, b) {
  return key === 'model' ? modelLabelsMatch(a, b) : sameName(a, b);
}

function labelFor(key) {
  return { mode: 'Mode', model: 'Model', aspectRatio: 'Aspect ratio', outputs: 'output count' }[key] ?? key;
}
