import { AutomationError, ERROR_CODES } from '../utils/errors.js';
import { base64ToBytes } from '../utils/binary.js';
import { clickElement, pressEscape, queryAllVisible, waitForValue } from './dom.js';
import {
  findAddButton,
  findDropTargets,
  findFileInput,
  findOpenPopover,
  findPromptRegion,
  findReferenceRemoveButtons,
  findUploadMenuItem,
  inspectFileInputs,
  observeFileInputs,
  requirePromptBox,
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
/** How long one upload technique is given to show ANY reaction before the next is tried. */
const PROBE_TIMEOUT_MS = 3000;

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
  const prompt = requirePromptBox(ctx.doc);
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
  const prompt = requirePromptBox(ctx.doc);
  const baseline = countAttachedReferences(ctx.doc, prompt.el);
  const tried = [];

  // Flow's "Upload" item raises the OPERATING SYSTEM file dialog, which no
  // extension can fill. Every technique below hands the bytes to the page
  // directly, and each one is confirmed by Flow's own reference chips before it
  // is reported as done.
  //
  //   1. an input[type=file] already in the page (any shadow scope or frame)
  //   2. an input Flow creates only while its Add menu opens, captured even if it
  //      lives for a single frame (it keeps Flow's change listener)
  //   3. a real drag-and-drop onto the composer
  //   4. a paste carrying the files onto the prompt editor
  //
  // The OS dialog is never opened on purpose.
  // A technique that does nothing must not cost the full upload budget: each one is
  // probed briefly, and only a technique Flow reacts to is given the long wait.
  const attempt = async (label, run, { timeoutMs = PROBE_TIMEOUT_MS } = {}) => {
    const before = countAttachedReferences(ctx.doc, prompt.el);
    let error = null;
    try {
      await run();
    } catch (cause) {
      error = cause?.message ?? String(cause);
    }
    const confirmed = await waitForValue(() => countAttachedReferences(ctx.doc, prompt.el) > before, {
      timeoutMs,
      intervalMs: 150,
      sleep: ctx.sleep,
    });
    const attached = countAttachedReferences(ctx.doc, prompt.el) - baseline;
    tried.push(`${label}: ${confirmed ? 'accepted' : error ? `failed (${error})` : 'no change'}`);
    return { ok: Boolean(confirmed), attached };
  };

  const fillInput = async (input, batch) => {
    input.files = buildTransfer(batch).files;
    const view = input.ownerDocument.defaultView;
    input.dispatchEvent(new view.Event('input', { bubbles: true }));
    input.dispatchEvent(new view.Event('change', { bubbles: true }));
  };

  // Batch size follows the input when there is one; drops and pastes take them all.
  const existing = findFileInput(ctx.doc, { promptEl: prompt.el });
  let attached = 0;
  if (existing) {
    const batches = existing.multiple ? [payloads] : payloads.map((payload) => [payload]);
    let ok = true;
    for (const batch of batches) {
      const result = await attempt(`file input (${existing.multiple ? 'multiple' : 'single'})`, () => fillInput(existing, batch), {
        timeoutMs: ATTACH_TIMEOUT_MS,
      });
      attached = result.attached;
      if (!result.ok) {
        ok = false;
        break;
      }
    }
    if (ok) return { attached, expected: payloads.length, strategy: 'file input', tried };
  }

  // 2) Open the Add menu while watching for a transient input.
  const add = findAddButton(prompt.el);
  let menuOpened = false;
  let captured = null;
  if (add) {
    const watcher = observeFileInputs(ctx.doc);
    clickElement(add.el);
    menuOpened = true;
    captured = await waitForValue(() => watcher.found() ?? findFileInput(ctx.doc, { promptEl: prompt.el }), {
      timeoutMs: ctx.timings.popoverMs,
      intervalMs: 50,
      sleep: ctx.sleep,
    });
    watcher.stop();
    // The menu stays OPEN here: its "Upload" item is the next technique, and closing
    // it first is what made that step unreachable.
  }
  if (captured) {
    if (findOpenPopover(ctx.doc)) pressEscape(ctx.doc);
    const batches = captured.multiple ? [payloads] : payloads.map((payload) => [payload]);
    let ok = true;
    for (const batch of batches) {
      const result = await attempt('input created with the Add menu', () => fillInput(captured, batch), { timeoutMs: ATTACH_TIMEOUT_MS });
      attached = result.attached;
      if (!result.ok) {
        ok = false;
        break;
      }
    }
    if (ok) return { attached, expected: payloads.length, strategy: 'input created with the Add menu', tried };
  }

  // 2b) Still nothing: choose Flow's own "Upload" item while watching for the input
  //     it creates. Flow may also raise the OS file dialog here, which cannot be
  //     filled — but the input it creates first keeps Flow's change listener, so
  //     filling that still attaches the file. The dialog, if any, is left for the
  //     user to close; nothing is submitted while it is open.
  let chosenUpload = false;
  if (!captured && menuOpened) {
    const item = findUploadMenuItem(ctx.doc);
    if (item) {
      const watcher = observeFileInputs(ctx.doc);
      clickElement(item.el);
      chosenUpload = true;
      captured = await waitForValue(() => watcher.found() ?? findFileInput(ctx.doc, { promptEl: prompt.el }), {
        timeoutMs: ctx.timings.popoverMs * 4,
        intervalMs: 50,
        sleep: ctx.sleep,
      });
      watcher.stop();
      if (findOpenPopover(ctx.doc)) pressEscape(ctx.doc);
      if (captured) {
        const batches = captured.multiple ? [payloads] : payloads.map((payload) => [payload]);
        let ok = true;
        for (const batch of batches) {
          const result = await attempt('input created by "Upload"', () => fillInput(captured, batch), { timeoutMs: ATTACH_TIMEOUT_MS });
          attached = result.attached;
          if (!result.ok) {
            ok = false;
            break;
          }
        }
        if (ok) return { attached, expected: payloads.length, strategy: 'input created by "Upload"', tried };
      }
    }
  }

  // 3) Drag and drop onto the composer, target by target.
  for (const target of findDropTargets(ctx.doc, prompt.el)) {
    const result = await attempt(`drop on <${target.tagName?.toLowerCase?.() ?? 'node'}>`, () => dropFiles(target, payloads));
    attached = result.attached;
    if (result.ok) return { attached, expected: payloads.length, strategy: 'drag and drop', tried };
  }

  // 4) Paste onto the prompt editor.
  const pasted = await attempt('paste into the prompt', () => pasteFiles(prompt.el, payloads));
  attached = pasted.attached;
  if (pasted.ok) return { attached, expected: payloads.length, strategy: 'paste', tried };

  const seen = inspectFileInputs(ctx.doc);
  const inputNote = seen.length
    ? ` File inputs seen: ${seen.map((item) => `${item.scope}${item.disabled ? ', disabled' : ''}${item.accept ? `, accepts ${item.accept}` : ''}`).join('; ')}.`
    : ' No file input exists anywhere in the page, its shadow roots or its frames.';
  throw new AutomationError(
    ERROR_CODES.REFERENCE_UPLOAD_FAILED,
    `Flow did not accept the reference image. Add control: ${add ? 'found' : 'not found'}; Add menu opened: ${menuOpened ? 'yes' : 'no'}; "Upload" chosen: ${chosenUpload ? 'yes' : 'no'}.` +
      `${inputNote} Tried \u2014 ${tried.join(' | ')}. ` +
      'Flow may be using its own file dialog, which an extension cannot fill: attach this reference in Flow by hand, then retry the scene. ' +
      'Run "Check Flow page" in Settings for the upload inspection.',
  );
}

/** A DataTransfer carrying the payloads as real File objects. */
function buildTransfer(payloads) {
  const transfer = new DataTransfer();
  for (const payload of payloads) {
    transfer.items.add(
      new File([base64ToBytes(payload.base64)], payload.name, { type: payload.mime || 'image/png', lastModified: Date.now() }),
    );
  }
  return transfer;
}

/**
 * A real drag-and-drop of the files onto `target`: the sequence a browser sends
 * (dragenter → dragover → drop), each carrying the same DataTransfer, so a page
 * that reads `event.dataTransfer.files` receives them.
 */
function dropFiles(target, payloads) {
  const view = target.ownerDocument.defaultView;
  const transfer = buildTransfer(payloads);
  for (const type of ['dragenter', 'dragover', 'drop']) {
    const event = makeDataEvent(view, type, transfer);
    target.dispatchEvent(event);
  }
}

/** A paste carrying the files, for composers that accept pasted images. */
function pasteFiles(target, payloads) {
  const view = target.ownerDocument.defaultView;
  const transfer = buildTransfer(payloads);
  target.focus?.({ preventScroll: true });
  target.dispatchEvent(makeDataEvent(view, 'paste', transfer, 'clipboardData'));
}

/**
 * Build an event carrying a DataTransfer. DragEvent/ClipboardEvent constructors are
 * used when the browser has them; otherwise the payload is attached to a plain event,
 * which is what page code reads either way.
 */
function makeDataEvent(view, type, transfer, property = 'dataTransfer') {
  const init = { bubbles: true, cancelable: true, composed: true };
  let event = null;
  try {
    if (property === 'dataTransfer' && view.DragEvent) event = new view.DragEvent(type, { ...init, dataTransfer: transfer });
    else if (property === 'clipboardData' && view.ClipboardEvent) event = new view.ClipboardEvent(type, { ...init, clipboardData: transfer });
  } catch {
    event = null;
  }
  if (!event) event = new view.Event(type, init);
  if (event[property] !== transfer) {
    try {
      Object.defineProperty(event, property, { value: transfer, configurable: true });
    } catch {
      // Some engines refuse: the event still fires, just without the payload.
    }
  }
  return event;
}

