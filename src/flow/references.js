import { AutomationError, ERROR_CODES } from '../utils/errors.js';
import { base64ToBytes } from '../utils/binary.js';
import { clickElement, pressEscape, queryAllVisible, waitForValue } from './dom.js';
import {
  findAddButton,
  findFileInput,
  findOpenPopover,
  findPromptRegion,
  findReferenceRemoveButtons,
  findUploadMenuItem,
  inspectFileInputs,
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

  // 1) The page's own file input, searched across shadow scopes and frames. Flow's
  //    "Upload" item exists to open the OS file dialog, which an extension cannot
  //    fill, so the input is filled directly whenever one can be found.
  let input = findFileInput(ctx.doc, { promptEl: prompt.el });
  let openedMenu = false;
  let clickedUpload = false;
  if (!input) {
    const add = findAddButton(prompt.el);
    if (!add) {
      throw new AutomationError(
        ERROR_CODES.REFERENCE_UPLOAD_FAILED,
        'Could not find the "Add" control for uploads next to the prompt box.',
      );
    }
    // 2) Opening the Add menu is usually enough: Flow mounts the input with it.
    clickElement(add.el);
    openedMenu = true;
    input = await waitForValue(() => findFileInput(ctx.doc, { promptEl: prompt.el }), {
      timeoutMs: ctx.timings.popoverMs,
      intervalMs: 80,
      sleep: ctx.sleep,
    });
    if (!input) {
      // 3) Last resort: choose Upload. This may open the OS dialog, which cannot be
      //    filled from here — so it is only tried when nothing else produced an input.
      const item = findUploadMenuItem(ctx.doc);
      if (item) {
        clickElement(item.el);
        clickedUpload = true;
      }
      input = await waitForValue(() => findFileInput(ctx.doc, { promptEl: prompt.el }), {
        timeoutMs: ctx.timings.popoverMs * 4,
        intervalMs: 100,
        sleep: ctx.sleep,
      });
    }
    if (findOpenPopover(ctx.doc)) pressEscape(ctx.doc);
    if (!input) {
      const seen = inspectFileInputs(ctx.doc);
      const detail = seen.length
        ? ` The page has ${seen.length} file input(s), none usable: ${seen
            .map((item) => `${item.scope}${item.disabled ? ', disabled' : ''}${item.accept ? `, accepts ${item.accept}` : ''}`)
            .join('; ')}.`
        : ' No file input exists anywhere in the page, its shadow roots or its frames.';
      throw new AutomationError(
        ERROR_CODES.REFERENCE_UPLOAD_FAILED,
        `Flow did not expose a file input for the upload (Add control: found; menu opened: ${openedMenu ? 'yes' : 'no'}; ` +
          `"Upload" chosen: ${clickedUpload ? 'yes' : 'no'}).${detail} ` +
          'If Flow opened its own file dialog, close it and attach this reference in Flow by hand, then retry the scene. ' +
          'Run "Check Flow page" in Settings for the upload inspection.',
      );
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

