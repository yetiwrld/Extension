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
    const match = await findProjectItem(ctx, picker, payload.name);
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

async function findProjectItem(ctx, picker, wanted) {
  const seen = new Map();
  const remember = (items, location = null) => {
    for (const item of items) {
      const key = item.name.toLocaleLowerCase();
      if (!seen.has(key)) seen.set(key, { name: item.name, location });
    }
  };
  const inspect = () => {
    const items = readProjectMediaItems(picker);
    remember(items);
    const exact = items.filter((item) => sameName(item.name, wanted));
    if (exact.length === 1) return { item: exact[0] };
    if (exact.length > 1) return { error: ambiguousMessage(wanted, exact) };
    return null;
  };

  let found = inspect();
  if (found) return found;

  // Prefer Flow's own search when this picker variant exposes it.
  const search = findPickerSearch(picker, ctx.doc);
  if (search) {
    setControlledValue(search, wanted);
    await ctx.sleep(Math.max(ctx.timings.settleMs, 800));
    found = inspect();
    if (found) return found;
    setControlledValue(search, '');
    await ctx.sleep(Math.max(ctx.timings.settleMs, 500));
  }

  // Flow virtualizes the project grid: only on-screen tiles exist in the DOM.
  // First drive the last rendered tile into view. This lets the browser locate
  // the real scrolling ancestor even when Flow's custom viewport reports no
  // useful scrollHeight to page scripts.
  let stagnantRounds = 0;
  for (let round = 0; round < 80 && stagnantRounds < 6; round += 1) {
    const items = readProjectMediaItems(picker);
    remember(items);
    const exact = items.filter((item) => sameName(item.name, wanted));
    if (exact.length === 1) return { item: exact[0] };
    if (exact.length > 1) return { error: ambiguousMessage(wanted, exact) };
    const before = seen.size;
    const last = items[items.length - 1]?.el;
    if (!last) break;
    last.scrollIntoView?.({ block: 'end', inline: 'nearest' });
    dispatchScroll(last);
    await ctx.sleep(Math.max(ctx.timings.settleMs, 400));
    const nextItems = readProjectMediaItems(picker);
    remember(nextItems);
    stagnantRounds = seen.size === before ? stagnantRounds + 1 : 0;
  }

  // Also walk every viewport that exposes normal scroll metrics.
  const fallbackCandidates = [];
  for (const scroller of projectScrollers(picker)) {
    const original = scroller.scrollTop;
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const step = Math.max(240, Math.floor(scroller.clientHeight * 0.8));
    for (let top = 0, rounds = 0; top <= max && rounds < 100; top += step, rounds += 1) {
      scroller.scrollTop = Math.min(top, max);
      dispatchScroll(scroller);
      await ctx.sleep(ctx.timings.settleMs);
      const items = readProjectMediaItems(picker);
      remember(items, { scroller, top: scroller.scrollTop });
      const exact = items.filter((item) => sameName(item.name, wanted));
      if (exact.length === 1) return { item: exact[0] };
      if (exact.length > 1) return { error: ambiguousMessage(wanted, exact) };
      for (const item of items) {
        if (comparableBasename(item.name) === comparableBasename(wanted)) {
          fallbackCandidates.push({ name: item.name, location: { scroller, top: scroller.scrollTop } });
        }
      }
      if (scroller.scrollTop >= max) break;
    }
    scroller.scrollTop = original;
    dispatchScroll(scroller);
  }

  const uniqueFallback = Array.from(new Map(fallbackCandidates.map((item) => [item.name.toLocaleLowerCase(), item])).values());
  if (uniqueFallback.length > 1) return { error: ambiguousMessage(wanted, uniqueFallback) };
  if (uniqueFallback.length === 1) {
    const candidate = uniqueFallback[0];
    candidate.location.scroller.scrollTop = candidate.location.top;
    dispatchScroll(candidate.location.scroller);
    await ctx.sleep(ctx.timings.settleMs);
    const item = readProjectMediaItems(picker).find((entry) => sameName(entry.name, candidate.name));
    if (item) return { item };
  }

  const currentFallback = readProjectMediaItems(picker).filter(
    (item) => comparableBasename(item.name) === comparableBasename(wanted),
  );
  if (currentFallback.length === 1) return { item: currentFallback[0] };
  if (currentFallback.length > 1) return { error: ambiguousMessage(wanted, currentFallback) };

  const allFallbackNames = Array.from(seen.values()).filter(
    (item) => comparableBasename(item.name) === comparableBasename(wanted),
  );
  if (allFallbackNames.length > 1) return { error: ambiguousMessage(wanted, allFallbackNames) };

  const available = Array.from(seen.values()).map((entry) => entry.name).slice(0, 30);
  return {
    error: `No project media matches "${wanted}" after checking ${seen.size} project item${seen.size === 1 ? '' : 's'}.${available.length ? ` Items checked: ${available.join(', ')}.` : ' No named project items were available.'}`,
  };
}

function projectScrollers(picker) {
  const candidates = [picker, ...picker.querySelectorAll('*')];
  let ancestor = picker.parentElement;
  while (ancestor) {
    candidates.push(ancestor);
    ancestor = ancestor.parentElement;
  }
  if (picker.ownerDocument.scrollingElement) candidates.push(picker.ownerDocument.scrollingElement);
  return Array.from(new Set(candidates))
    .filter((el) => Number(el.scrollHeight) > Number(el.clientHeight) + 8)
    .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
}

function dispatchScroll(el) {
  const view = el.ownerDocument.defaultView;
  el.dispatchEvent(new view.Event('scroll', { bubbles: true }));
  try {
    el.dispatchEvent(new view.WheelEvent('wheel', { bubbles: true, deltaY: 400 }));
  } catch {
    // Scroll itself is enough for browsers without a constructible WheelEvent.
  }
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

function findPickerSearch(picker, doc = picker.ownerDocument) {
  const selector = 'input[type="search"], input[type="text"], input:not([type])';
  const isSearch = (el) => /\b(search|find|filter)\b/i.test(`${accessibleName(el)} ${el.getAttribute('placeholder') ?? ''}`);
  const local = queryAllVisible(picker, selector).find(isSearch);
  if (local) return local;

  // In Flow's side-drawer variant the project search bar is a sibling of the
  // virtualized grid, not a descendant of the element identified as picker.
  // Prefer the visible search field geometrically closest to that grid.
  const rect = picker.getBoundingClientRect();
  const global = queryAllVisible(doc, selector).filter(isSearch);
  global.sort((a, b) => distanceToRect(a.getBoundingClientRect(), rect) - distanceToRect(b.getBoundingClientRect(), rect));
  return global[0] ?? null;
}

function distanceToRect(a, b) {
  const ax = a.left + a.width / 2;
  const ay = a.top + a.height / 2;
  const bx = b.left + b.width / 2;
  const by = b.top + b.height / 2;
  return Math.hypot(ax - bx, ay - by);
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
