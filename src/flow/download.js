import { AutomationError, ERROR_CODES } from '../utils/errors.js';
import { accessibleName, clickElement, normalizeText, queryAllVisible, waitForValue } from './dom.js';
import { findOutputMedia, findPromptBox } from './selectors.js';

const DOWNLOAD_TIMEOUT_MS = 15000;

/** Trigger Flow's native 2K Upscaled download for the newly completed output. */
export async function downloadLatest2k(ctx, evidence = {}) {
  const prompt = findPromptBox(ctx.doc);
  const outputs = findOutputMedia(ctx.doc, prompt?.el ?? null);
  const wanted = new Set(evidence?.outputKeys ?? []);
  const output = wanted.size > 0
    ? [...outputs].reverse().find((item) => wanted.has(item.key))
    : outputs[outputs.length - 1];
  if (!output) {
    throw new AutomationError(ERROR_CODES.DOWNLOAD_FAILED, 'The generated image could not be found for its 2K download.');
  }

  // Start on the media itself so hover listeners on any wrapping card receive the
  // bubbling events before we decide which ancestor owns the controls.
  hover(output.el);
  await ctx.sleep(ctx.timings.settleMs);
  const card = findOutputCard(output.el);
  hover(card);
  await ctx.sleep(ctx.timings.settleMs);

  // Detail-view and some card variants expose Download media directly.
  let downloadControl = findDownloadMediaButton(ctx.doc, card);
  if (downloadControl) {
    clickElement(downloadControl);
  } else {
    const menuButton = await waitForValue(() => {
      hover(output.el);
      hover(card);
      return findCardMenuButton(card);
    }, {
      timeoutMs: ctx.timings.popoverMs * 2,
      intervalMs: 150,
      sleep: ctx.sleep,
    });
    if (menuButton) {
      clickElement(menuButton);
      await ctx.sleep(ctx.timings.settleMs);
      // Some Flow builds put 2K directly in this menu. Others first show a
      // Download row whose submenu opens on hover.
      const immediateUpscale = find2kUpscaled(ctx.doc);
      if (immediateUpscale) {
        downloadControl = immediateUpscale;
      } else {
        downloadControl = await waitForValue(() => findDownloadMenuItem(ctx.doc), {
          timeoutMs: ctx.timings.popoverMs * 2,
          intervalMs: 150,
          sleep: ctx.sleep,
        });
        if (!downloadControl) {
          throw new AutomationError(ERROR_CODES.DOWNLOAD_FAILED, 'Flow opened the image menu but did not show Download.');
        }
        // Do not click the parent Download row: that can immediately download 1K.
        // Hovering opens its quality submenu.
        hover(downloadControl);
      }
    } else {
      if (!evidence.trustedHover) {
        return { requested: false, retry: 'trusted-hover', hoverTarget: centerOf(output.el), outputKey: output.key };
      }
      // Some variants expose Download media only after opening the selected output.
      // Open the exact newly completed media first; only then is a page-level control safe.
      const priorControls = new Set(findGlobalDownloadMediaButtons(ctx.doc));
      clickElement(output.el);
      downloadControl = await waitForValue(
        () => findGlobalDownloadMediaButtons(ctx.doc).find((el) => !priorControls.has(el)) ?? null,
        {
          timeoutMs: ctx.timings.popoverMs * 2,
          intervalMs: 150,
          sleep: ctx.sleep,
        },
      );
      if (!downloadControl) {
        throw new AutomationError(ERROR_CODES.DOWNLOAD_FAILED, 'Could not find the generated image download controls.');
      }
      clickElement(downloadControl);
    }
  }

  const upscale = await waitForValue(() => find2kUpscaled(ctx.doc), {
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    intervalMs: 200,
    sleep: async (ms) => {
      if (downloadControl?.isConnected) hover(downloadControl);
      await ctx.sleep(ms);
    },
  });
  if (!upscale) {
    throw new AutomationError(ERROR_CODES.DOWNLOAD_FAILED, 'Flow did not offer the "2K Upscaled" download option for the generated image.');
  }

  clickElement(upscale);
  await ctx.sleep(Math.max(ctx.timings.settleMs, 2000));
  return { requested: true, quality: '2K Upscaled', outputKey: output.key };
}

function findOutputCard(media) {
  let node = media;
  for (let depth = 0; node && depth < 10; depth += 1, node = node.parentElement) {
    if (node !== media && node.querySelectorAll('button, [role="button"]').length > 0) return node;
  }
  return media.parentElement ?? media;
}

function findDownloadMediaButton(_doc, card) {
  // Never fall back to a page-global Download button: it may belong to an older output.
  return queryAllVisible(card, 'button, [role="button"]')
    .find((el) => /^download media$/i.test(accessibleName(el))) ?? null;
}

function findGlobalDownloadMediaButtons(doc) {
  return queryAllVisible(doc, 'button[aria-label], [role="button"][aria-label]')
    .filter((el) => /^download media$/i.test(accessibleName(el)));
}

function findCardMenuButton(card) {
  hover(card);
  const buttons = queryAllVisible(card, 'button, [role="button"], [tabindex="0"]');
  return buttons.find((el) => {
    const name = normalizeText(`${accessibleName(el)} ${el.getAttribute('title') ?? ''} ${el.getAttribute('data-testid') ?? ''}`);
    const text = normalizeText(el.textContent);
    return /\b(more|menu|actions?|options?|overflow)\b/i.test(name)
      || /^(?:⋮|\.\.\.|···|⋯)$/.test(text);
  }) ?? buttons.find((el) => el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().width < 56 && el.querySelector('svg, mat-icon')) ?? null;
}

function findDownloadMenuItem(doc) {
  const candidates = queryAllVisible(
    doc,
    'flow-menu-item, [role="menuitem"], [role="option"], [role="button"], button, a, li, div, span',
  ).filter((el) => {
    const name = normalizeText(accessibleName(el));
    if (!name || name.length > 60) return false;
    if (/\b2\s*k\b|upscal/i.test(name)) return false;
    // A card's direct control is not the hover-only menu row and clicking it may
    // start the original-quality download. It is handled separately above.
    if (/^download media$/i.test(name)) return false;
    return /^download(?:\b|\s)/i.test(name) || /\bdownload\b/i.test(name);
  });
  return candidates.sort((a, b) => downloadItemScore(b) - downloadItemScore(a))[0] ?? null;
}

function downloadItemScore(el) {
  const name = normalizeText(accessibleName(el));
  let score = /^download$/i.test(name) ? 100 : /^download\b/i.test(name) ? 70 : 30;
  if (el.matches('flow-menu-item, [role="menuitem"], [role="option"]')) score += 25;
  if (el.matches('button, a, [role="button"]')) score += 10;
  if (el.closest('[role="menu"], [role="listbox"], flow-menu')) score += 15;
  // Prefer the innermost row over a large wrapper containing the whole menu.
  score -= el.querySelectorAll('flow-menu-item, [role="menuitem"], button, a, li, div, span').length * 5;
  score -= Math.min(name.length, 60) / 10;
  return score;
}

function find2kUpscaled(doc) {
  const candidates = queryAllVisible(
    doc,
    'flow-menu-item, flow-menu-item button, [role="menuitem"], [role="option"], button, [role="button"], a, li, div, span',
  ).filter((el) => {
    const name = normalizeText(accessibleName(el));
    return name.length <= 80 && /\b2\s*k\b/i.test(name) && /upscal/i.test(name) && !isDisabledLike(el);
  });
  return candidates.sort((a, b) => upscaleItemScore(b) - upscaleItemScore(a))[0] ?? null;
}

function upscaleItemScore(el) {
  let score = 0;
  if (el.matches('button, a, [role="button"], [role="menuitem"], [role="option"]')) score += 100;
  if (el.closest('[role="menu"], [role="listbox"], flow-menu')) score += 20;
  score -= el.querySelectorAll('button, a, [role="button"], [role="menuitem"], [role="option"], div, span').length * 5;
  return score;
}

function isDisabledLike(el) {
  return Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true' || el.closest('[aria-disabled="true"]');
}

function centerOf(el) {
  const rect = el.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function hover(el) {
  if (!el) return;
  el.scrollIntoView?.({ block: 'center', inline: 'nearest' });
  const view = el.ownerDocument.defaultView;
  const rect = el.getBoundingClientRect();
  const clientX = rect.left + rect.width / 2;
  const clientY = rect.top + rect.height / 2;
  const init = { bubbles: true, cancelable: true, composed: true, view, clientX, clientY, screenX: clientX, screenY: clientY };
  const PointerCtor = view.PointerEvent || view.MouseEvent;
  el.dispatchEvent(new PointerCtor('pointerover', { ...init, pointerType: 'mouse' }));
  el.dispatchEvent(new PointerCtor('pointerenter', { ...init, bubbles: false, pointerType: 'mouse' }));
  el.dispatchEvent(new PointerCtor('pointermove', { ...init, pointerType: 'mouse' }));
  el.dispatchEvent(new view.MouseEvent('mouseover', init));
  el.dispatchEvent(new view.MouseEvent('mouseenter', { ...init, bubbles: false }));
  el.dispatchEvent(new view.MouseEvent('mousemove', init));
  el.focus?.({ preventScroll: true });
}

