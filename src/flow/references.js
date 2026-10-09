import { AutomationError, ERROR_CODES } from '../utils/errors.js';
import { base64ToBytes } from '../utils/binary.js';
import { clickElement, pressEscape, queryAllVisible, waitForValue } from './dom.js';
import {
  findAddButton,
  findFileInput,
  findOpenPopover,
  findPromptBox,
  findPromptRegion,
  findReferenceRemoveButtons,
  findUploadMenuItem,
} from './selectors.js';

/**
 * Reference images for the current scene.
 *
 * Clearing: remove every attached reference chip until none remain, so a scene
 * only ever carries its own references.
 * Attaching: hand the file(s) to Flow's own file input and wait until Flow shows
 * the expected number of attachments. A count that never reaches the target is
 * reported as a failure, never as success.
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
    return rect.width >= 24 && rect.width <= 160 && rect.height >= 24 && rect.height <= 160;
  });
  return Math.max(removeCount, thumbnails.length);
}

/**
 * @returns {Promise<{removed: number, remaining: number}>}
 */
export async function clearReferences(ctx) {
  const prompt = findPromptBox(ctx.doc);
  if (!prompt) {
    throw new AutomationError(ERROR_CODES.FLOW_UI_CHANGED, 'Flow prompt box not found.');
  }
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
 * Attach files to the prompt. Resolves with the number Flow confirmed.
 * @param {Array<{name: string, mime: string, base64: string}>} payloads
 */
export async function attachReferences(ctx, payloads) {
  if (!payloads.length) return { attached: 0, expected: 0 };
  const prompt = findPromptBox(ctx.doc);
  if (!prompt) {
    throw new AutomationError(ERROR_CODES.FLOW_UI_CHANGED, 'Flow prompt box not found.');
  }

  let input = findFileInput(ctx.doc);
  if (!input) {
    const add = findAddButton(prompt.el);
    if (!add) {
      throw new AutomationError(
        ERROR_CODES.REFERENCE_UPLOAD_FAILED,
        'Could not find the "Add" control for uploads next to the prompt box.',
      );
    }
    clickElement(add.el);
    await ctx.sleep(ctx.timings.settleMs);
    const item = findUploadMenuItem(ctx.doc);
    if (item) {
      clickElement(item.el);
    }
    input = await waitForValue(() => findFileInput(ctx.doc), { timeoutMs: ctx.timings.popoverMs * 10, intervalMs: 100, sleep: ctx.sleep });
    if (findOpenPopover(ctx.doc)) pressEscape(ctx.doc);
    if (!input) {
      throw new AutomationError(ERROR_CODES.REFERENCE_UPLOAD_FAILED, 'Flow did not open a file picker after choosing Upload.');
    }
  }

  const multiple = Boolean(input.multiple);
  const batches = multiple ? [payloads] : payloads.map((payload) => [payload]);
  const baseline = countAttachedReferences(ctx.doc, prompt.el);
  let attached = 0;

  for (const batch of batches) {
    const transfer = new DataTransfer();
    for (const payload of batch) {
      transfer.items.add(new File([base64ToBytes(payload.base64)], payload.name, { type: payload.mime || 'image/png', lastModified: Date.now() }));
    }
    input.files = transfer.files;
    const view = input.ownerDocument.defaultView;
    input.dispatchEvent(new view.Event('input', { bubbles: true }));
    input.dispatchEvent(new view.Event('change', { bubbles: true }));

    const expected = baseline + attached + batch.length;
    const confirmed = await waitForValue(() => countAttachedReferences(ctx.doc, prompt.el) >= expected, {
      timeoutMs: ATTACH_TIMEOUT_MS,
      intervalMs: 250,
      sleep: ctx.sleep,
    });
    if (!confirmed) break;
    attached += batch.length;
  }
  return { attached, expected: payloads.length };
}

