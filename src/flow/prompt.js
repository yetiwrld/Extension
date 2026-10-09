import { AutomationError, ERROR_CODES } from '../utils/errors.js';
import { normalizeText, readEditableText, replaceEditableText, setControlledValue } from './dom.js';
import { findPromptBox, requirePromptBox } from './selectors.js';

/**
 * Insert a scene's prompt into Flow's prompt box and verify what Flow holds.
 * The prompt text is inserted verbatim; only whitespace is compared loosely
 * for verification (rich editors may turn newlines into paragraphs).
 *
 * The composer is re-queried when verification fails: Flow replaces the element
 * on mode changes and rerenders, and a stale reference would write into a
 * detached node and report a false failure.
 */

function writeText(el, kind, text) {
  if (kind === 'textarea' || kind === 'input') setControlledValue(el, text);
  else replaceEditableText(el, text);
}

/**
 * @returns {{verified: boolean, strategy: string, length: number}}
 */
export async function insertPrompt(ctx, text) {
  let prompt = requirePromptBox(ctx.doc);
  if (prompt.enabled === false) {
    throw new AutomationError(
      ERROR_CODES.PROMPT_INSERT_FAILED,
      'The Flow prompt box is disabled, so the prompt cannot be entered. Check the prompt box in Flow, then retry the scene.',
    );
  }

  let verified = await writeAndVerify(ctx, prompt, text);
  if (!verified) {
    // The composer may have been replaced (mode change, rerender): re-query and retry once on the fresh element.
    const fresh = findPromptBox(ctx.doc);
    if (fresh && fresh.el !== prompt.el) {
      prompt = fresh;
      verified = await writeAndVerify(ctx, prompt, text);
    }
  }
  if (!verified) {
    // One more attempt through the other write path before reporting failure.
    const el = prompt.el;
    if (prompt.kind === 'textarea' || prompt.kind === 'input') {
      setControlledValue(el, text);
    } else {
      el.textContent = '';
      replaceEditableText(el, text);
    }
    await ctx.sleep(ctx.timings.settleMs);
    verified = el.isConnected && normalizeText(readEditableText(el)) === normalizeText(text);
  }
  return { verified, strategy: prompt.strategy, length: readEditableText(prompt.el).length };
}

async function writeAndVerify(ctx, prompt, text) {
  writeText(prompt.el, prompt.kind, text);
  await ctx.sleep(ctx.timings.settleMs);
  // A detached composer means Flow replaced it mid-write: the text went to a dead node.
  if (!prompt.el.isConnected) return false;
  return normalizeText(readEditableText(prompt.el)) === normalizeText(text);
}
