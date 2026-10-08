import { AutomationError, ERROR_CODES } from '../utils/errors.js';
import { normalizeText, readEditableText, replaceEditableText, setControlledValue } from './dom.js';
import { findPromptBox } from './selectors.js';

/**
 * Insert a scene's prompt into Flow's prompt box and verify what Flow holds.
 * The prompt text is inserted verbatim; only whitespace is compared loosely
 * for verification (rich editors may turn newlines into paragraphs).
 */

/**
 * @returns {{verified: boolean, strategy: string, length: number}}
 */
export async function insertPrompt(ctx, text) {
  const prompt = findPromptBox(ctx.doc);
  if (!prompt) {
    throw new AutomationError(ERROR_CODES.FLOW_UI_CHANGED, 'Flow prompt box not found.');
  }
  if (prompt.kind === 'textarea') {
    setControlledValue(prompt.el, text);
  } else {
    replaceEditableText(prompt.el, text);
  }
  await ctx.sleep(ctx.timings.settleMs);

  let readBack = readEditableText(prompt.el);
  let verified = normalizeText(readBack) === normalizeText(text);
  if (!verified) {
    // One more attempt through the other write path before reporting failure.
    if (prompt.kind === 'contenteditable') {
      prompt.el.textContent = '';
      replaceEditableText(prompt.el, text);
    } else {
      setControlledValue(prompt.el, text);
    }
    await ctx.sleep(ctx.timings.settleMs);
    readBack = readEditableText(prompt.el);
    verified = normalizeText(readBack) === normalizeText(text);
  }
  return { verified, strategy: prompt.strategy, length: readBack.length };
}
