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
    input = await waitForValue(() => findFileInput(ctx.doc), { timeoutMs: ctx.timings.popoverMs, intervalMs: 100, sleep: ctx.sleep });
    if (findOpenPopover(ctx.doc)) pressEscape(ctx.doc);
    if (!input) {
      // The current Flow composer opens the browser's native picker without
      // leaving an <input type=file> in the DOM. Extensions cannot operate that
      // OS dialog, but Flow's composer also accepts the same files by drop.
      return attachReferencesByDrop(ctx, prompt.el, payloads);
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

async function attachReferencesByDrop(ctx, promptEl, payloads) {
  const baseline = countAttachedReferences(ctx.doc, promptEl);
  const transfer = makeTransfer(ctx.doc, payloads);
  const region = findPromptRegion(promptEl);
  const candidates = uniqueElements([
    promptEl,
    promptEl.closest?.('.base-prompt-box, flow-base-prompt-box'),
    region,
    ctx.doc.body,
  ]);

  for (const target of candidates) {
    dispatchFileDrop(target, transfer);
    const confirmed = await waitForValue(() => countAttachedReferences(ctx.doc, promptEl) >= baseline + payloads.length, {
      timeoutMs: ATTACH_TIMEOUT_MS,
      intervalMs: 250,
      sleep: ctx.sleep,
    });
    if (confirmed) return { attached: payloads.length, expected: payloads.length, strategy: 'drag-and-drop' };

    // If Flow accepted only part of a multi-file drop, do not risk duplicating
    // it on another target. Report the observed count to the runner instead.
    const observed = Math.max(0, countAttachedReferences(ctx.doc, promptEl) - baseline);
    if (observed > 0) return { attached: observed, expected: payloads.length, strategy: 'drag-and-drop' };
  }

  throw new AutomationError(
    ERROR_CODES.REFERENCE_UPLOAD_FAILED,
    'Flow did not accept the reference files through its Upload control or by dropping them on the prompt box.',
  );
}

function makeTransfer(doc, payloads) {
  const view = doc.defaultView;
  const Transfer = view?.DataTransfer ?? globalThis.DataTransfer;
  const FileCtor = view?.File ?? globalThis.File;
  const transfer = new Transfer();
  for (const payload of payloads) {
    transfer.items.add(new FileCtor(
      [base64ToBytes(payload.base64)],
      payload.name,
      { type: payload.mime || 'image/png', lastModified: Date.now() },
    ));
  }
  return transfer;
}

function dispatchFileDrop(target, transfer) {
  const view = target.ownerDocument.defaultView;
  for (const type of ['dragenter', 'dragover', 'drop']) {
    let event;
    try {
      event = new view.DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: transfer });
    } catch {
      event = new view.Event(type, { bubbles: true, cancelable: true, composed: true });
      Object.defineProperty(event, 'dataTransfer', { value: transfer });
    }
    target.dispatchEvent(event);
  }
}

function uniqueElements(elements) {
  return elements.filter((element, index) => element && elements.indexOf(element) === index);
}

