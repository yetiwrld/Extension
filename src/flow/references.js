import { AutomationError, ERROR_CODES } from '../utils/errors.js';
import { accessibleName, clickElement, isVisible, pressEscape, queryAllVisible, setControlledValue, waitForValue } from './dom.js';
import {
  findAddButton,
  findOpenPopover,
  findProjectMediaPicker,
  findPromptBox,
  findPromptRegion,
  findReferenceRemoveButtons,
  findUseFromProjectMenuItem,
  readProjectMediaItems,
} from './selectors.js';

/**
 * Reference images for the current scene.
 *
 * Reference files are uploaded to the Flow project once by the user. Per scene,
 * the extension uses Flow's supported Add > Use from project picker. It never
 * operates an OS file dialog or synthesises a file drop.
 */

const MAX_CLEAR_ROUNDS = 25;
export const ATTACH_TIMEOUT_MS = 20000;

/** Number of reference attachments Flow currently shows near the prompt. */
export function countAttachedReferences(doc, promptEl) {
  const region = findPromptRegion(promptEl);
  if (!region) return 0;
  const removeCount = findReferenceRemoveButtons(promptEl).length;
  const thumbnails = queryAllVisible(region, 'img').filter((img) => {
    if (img.closest('[role="dialog"], [role="menu"], [role="listbox"]')) return false;
    const rect = img.getBoundingClientRect();
    return rect.width >= 24 && rect.height >= 24;
  });
  const ingredientHosts = queryAllVisible(
    region,
    '[class*="ingredient" i], [class*="reference-chip" i], [data-testid*="ingredient" i], [data-testid*="reference" i], flow-ingredient, flow-reference',
  ).filter((el) => !el.querySelector('[class*="ingredient" i], [class*="reference-chip" i], flow-ingredient, flow-reference'));
  return Math.max(removeCount, thumbnails.length, ingredientHosts.length);
}

/** @returns {Promise<{removed: number, remaining: number}>} */
export async function clearReferences(ctx) {
  const prompt = findPromptBox(ctx.doc);
  if (!prompt) throw new AutomationError(ERROR_CODES.FLOW_UI_CHANGED, 'Flow prompt box not found.');

  let removed = 0;
  for (let round = 0; round < MAX_CLEAR_ROUNDS; round += 1) {
    const buttons = findReferenceRemoveButtons(prompt.el);
    if (!buttons.length) break;
    clickElement(buttons[0]);
    removed += 1;
    await ctx.sleep(ctx.timings.settleMs);
  }
  return { removed, remaining: countAttachedReferences(ctx.doc, prompt.el) };
}

/**
 * Attach project media whose displayed names match the library filenames.
 * Exact filename matches win. If there is no exact match, compare a
 * case-insensitive basename with extension and trailing version removed.
 * Missing and ambiguous names fail explicitly rather than choosing a tile.
 *
 * @param {Array<{name: string, mime?: string, base64?: string}>} payloads
 */
export async function attachReferences(ctx, payloads) {
  if (!payloads.length) return { attached: 0, expected: 0, strategy: 'use-from-project' };
  const prompt = findPromptBox(ctx.doc);
  if (!prompt) throw new AutomationError(ERROR_CODES.FLOW_UI_CHANGED, 'Flow prompt box not found.');

  const baseline = countAttachedReferences(ctx.doc, prompt.el);
  let attached = 0;

  // Flow's desktop picker is effectively single-select in the current UI:
  // selecting a second tile can replace the first. Confirm each ingredient,
  // then reopen the narrowly-labelled Add ingredients control for the next.
  for (const payload of payloads) {
    const picker = await openProjectPicker(ctx, prompt.el);
    let items = readProjectMediaItems(picker);
    let match = matchProjectItem(payload.name, items);
    if (match.missing) {
      const search = findPickerSearch(picker);
      if (search) {
        setControlledValue(search, payload.name);
        await ctx.sleep(ctx.timings.settleMs);
        items = readProjectMediaItems(picker);
        match = matchProjectItem(payload.name, items);
      }
    }
    if (match.error) {
      await closePicker(ctx, picker);
      throw new AutomationError(ERROR_CODES.REFERENCE_UPLOAD_FAILED, match.error);
    }
    clickElement(match.item.el);
    await ctx.sleep(ctx.timings.settleMs);

    const accepted = () => countAttachedReferences(ctx.doc, prompt.el) >= baseline + attached + 1
      || !picker.isConnected
      || !isVisible(picker);

    // Flow has two live picker variants. One selects a tile and requires an
    // explicit "Add to prompt" press; the other attaches immediately and closes
    // the picker. Check for the immediate path before requiring a button.
    let confirmed = accepted();
    if (!confirmed) {
      const confirm = findPickerConfirm(picker, ctx.doc);
      if (confirm) {
        clickElement(confirm);
        await ctx.sleep(ctx.timings.settleMs);
      } else {
        // Give an auto-attached ingredient time to mount in the composer before
        // deciding that this picker variant supplied neither confirmation path.
        confirmed = await waitForValue(accepted, {
          timeoutMs: ctx.timings.popoverMs,
          intervalMs: 100,
          sleep: ctx.sleep,
        });
      }
    }
    if (!confirmed) {
      confirmed = await waitForValue(accepted, {
        timeoutMs: ATTACH_TIMEOUT_MS,
        intervalMs: 250,
        sleep: ctx.sleep,
      });
    }
    await closePicker(ctx, picker);
    if (!confirmed) {
      throw new AutomationError(
        ERROR_CODES.REFERENCE_UPLOAD_FAILED,
        `Flow did not accept "${payload.name}" from the project picker. No ingredient appeared and no usable "Add to prompt" action was available.`,
      );
    }
    attached += 1;
  }

  return { attached, expected: payloads.length, strategy: 'use-from-project-sequential' };
}

async function openProjectPicker(ctx, promptEl) {
  const open = findOpenPopover(ctx.doc);
  if (open) {
    pressEscape(ctx.doc);
    await ctx.sleep(ctx.timings.settleMs);
  }

  const add = findAddButton(promptEl);
  if (!add) {
    throw new AutomationError(ERROR_CODES.REFERENCE_UPLOAD_FAILED, 'Could not find the "Add" control next to the Flow prompt box.');
  }
  clickElement(add.el);
  await ctx.sleep(ctx.timings.settleMs);

  // Some Flow variants open the project-media browser directly. Others first
  // show a small menu containing "Use from project".
  let picker = findProjectMediaPicker(ctx.doc);
  if (!picker) {
    const projectItem = await waitForValue(
      () => findUseFromProjectMenuItem(ctx.doc),
      { timeoutMs: ctx.timings.popoverMs, intervalMs: 100, sleep: ctx.sleep },
    );
    if (!projectItem) {
      throw new AutomationError(
        ERROR_CODES.REFERENCE_UPLOAD_FAILED,
        'Flow did not show "Use from project" in the Add menu. Upload the references to this Flow project first.',
      );
    }
    clickElement(projectItem.el);
  }

  picker ??= await waitForValue(
    () => findProjectMediaPicker(ctx.doc),
    { timeoutMs: ctx.timings.popoverMs * 2, intervalMs: 100, sleep: ctx.sleep },
  );
  if (!picker) {
    throw new AutomationError(ERROR_CODES.REFERENCE_UPLOAD_FAILED, 'Flow did not open the project media picker.');
  }
  return picker;
}

function matchProjectItem(wanted, items) {
  const exact = items.filter((item) => sameName(item.name, wanted));
  if (exact.length === 1) return { item: exact[0] };
  if (exact.length > 1) return { error: ambiguousMessage(wanted, exact) };

  const wantedBase = comparableBasename(wanted);
  const fallback = items.filter((item) => comparableBasename(item.name) === wantedBase);
  if (fallback.length === 1) return { item: fallback[0] };
  if (fallback.length > 1) return { error: ambiguousMessage(wanted, fallback) };

  const available = items.map((item) => item.name).slice(0, 12);
  return {
    missing: true,
    error: `No project media matches "${wanted}".${available.length ? ` Visible project items: ${available.join(', ')}.` : ' No named project items were visible.'}`,
  };
}

function sameName(a, b) {
  return String(a).trim().toLocaleLowerCase() === String(b).trim().toLocaleLowerCase();
}

function comparableBasename(value) {
  return String(value)
    .trim()
    .replace(/^.*[\\/]/, '')
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/(?:[\s_.-]+(?:v|ver|version)\s*\d+|[\s_.-]+\d+)$/i, '')
    .replace(/[\s_.-]+/g, '')
    .toLocaleLowerCase();
}

function ambiguousMessage(wanted, matches) {
  return `Project media "${wanted}" is ambiguous. Matches: ${matches.map((item) => item.name).join(', ')}.`;
}

function findPickerSearch(picker) {
  return queryAllVisible(picker, 'input[type="search"], input[type="text"], input:not([type])').find((el) =>
    /\b(search|find|filter)\b/i.test(`${accessibleName(el)} ${el.getAttribute('placeholder') ?? ''}`),
  ) ?? null;
}

function findPickerConfirm(picker, doc) {
  // Flow currently labels this action "Add to prompt" and may render it in a
  // dialog footer outside the inner media grid.
  const addToPrompt = queryAllVisible(doc, 'button, [role="button"]').find((el) => {
    const name = accessibleName(el);
    // Do not confuse the composer's "Add ingredients to the prompt box"
    // launcher with the picker's "Add to prompt" confirmation action.
    return /^add(?:\s+\d+)?(?:\s+(?:selected\s+)?(?:items?|media|images?))?\s+to\s+(?:the\s+)?prompt\b/i.test(name)
      && !/\bingredients?\b/i.test(name);
  });
  if (addToPrompt) return addToPrompt;
  return queryAllVisible(picker, 'button, [role="button"]').find((el) =>
    /^(?:add|attach|insert|use|select|done)(?:\s+(?:\d+|selected|item(?:s)?))?$/i.test(accessibleName(el)),
  ) ?? null;
}

async function closePicker(ctx, picker) {
  if (!picker?.isConnected) return;
  pressEscape(ctx.doc);
  await ctx.sleep(ctx.timings.settleMs);
}
