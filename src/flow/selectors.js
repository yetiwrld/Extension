/**
 * Google Flow DOM heuristics. This is the ONLY module that encodes assumptions
 * about Flow's page structure. Every finder returns `{ el, strategy }` or null,
 * so diagnostics can show which heuristic matched on the live page.
 *
 * STATUS: these heuristics are written from Flow's public help documentation
 * (prompt box, model selector, Add/upload entry, Generate button) and standard
 * accessibility conventions. They were NOT verified against the live Flow app,
 * which requires a signed-in Google account. Run "Check Flow page" in the side
 * panel on a real project to see which strategies match before relying on it.
 */

import { accessibleName, ancestors, isDisabled, isVisible, labelText, normalizeText, queryAllVisible } from './dom.js';

const PROMPT_HINT = /(prompt|describe|imagine|what do you want|what would you like|create|generate|write)/i;
const GENERATE_NAME = /^(?:[a-z_]+\s+)?(?:generate|generation|create|make)\b/i;
const ADD_NAME = /^(?:[a-z_]+\s+)?(add|attach|upload|\+)(?:\s|$)/i;
const REMOVE_NAME = /(remove|delete|clear|close|dismiss)/i;
const AGENT_NAME = /\bagent\b/i;
const ASPECT_RATIO_TEXT = /^\d{1,2}\s*:\s*\d{1,2}$/;
const POPOVER_SELECTOR = [
  '[role="dialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[data-radix-popper-content-wrapper]',
  '[data-state="open"][role]',
].join(',');
const OPTION_SELECTOR = [
  '[role="option"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitem"]',
  '[role="radio"]',
  '[role="tab"]',
  '[role="switch"]',
  'button',
  'li',
].join(',');

/** Find the prompt input. Prefers a visible textarea/contenteditable near the bottom of the page. */
export function findPromptBox(doc) {
  const textareas = queryAllVisible(doc, 'textarea');
  const editables = queryAllVisible(doc, '[contenteditable="true"], [contenteditable=""], [role="textbox"][contenteditable]');
  const all = [...textareas.map((el) => ({ el, kind: 'textarea' })), ...editables.map((el) => ({ el, kind: 'contenteditable' }))];
  if (!all.length) return null;

  const scored = all
    .map((candidate) => {
      const rect = candidate.el.getBoundingClientRect?.() ?? { top: 0, width: 0, height: 0 };
      const hint = PROMPT_HINT.test(labelText(candidate.el)) ? 1000 : 0;
      const width = rect.width || 0;
      const top = rect.top || 0;
      return { ...candidate, score: hint + Math.min(width, 1200) / 10 + top / 100 };
    })
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  const strategy = best.kind === 'textarea' ? 'visible-textarea' : 'visible-contenteditable';
  return { el: best.el, kind: best.kind, strategy };
}

/** The region that holds the prompt box, its settings button, Generate, and references. */
export function findPromptRegion(promptEl) {
  if (!promptEl) return null;

  // Flow has a stable composer host. Prefer it over the old "nearest ancestor
  // with two buttons" heuristic: after the first ingredient is attached, its
  // inner wrapper can itself contain multiple controls and was incorrectly
  // treated as the whole prompt region, hiding the real Add button.
  const composer = promptEl.closest('flow-base-prompt-box, .base-prompt-box, .prompt-box');
  if (composer) return composer;

  const candidates = ancestors(promptEl, 10).map((node, depth) => {
    const controls = Array.from(node.querySelectorAll('button, [role="button"], flow-generate-icon-button'));
    const names = controls.map(accessibleName).join(' ');
    let score = controls.length >= 2 ? 1 : 0;
    if (/\b(add|attach|upload|ingredient)\b/i.test(names)) score += 4;
    if (/\b(settings?|banana|veo|imagen|gemini)\b/i.test(names)) score += 3;
    if (/\b(generate|start generation)\b|arrow_forward/i.test(names)) score += 3;
    // When scores tie, prefer the broader ancestor rather than an attachment's
    // newly-created inner control wrapper.
    score += depth / 100;
    return { node, score };
  });
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.score >= 1 ? candidates[0].node : promptEl.parentElement ?? null;
}

/** Generate / Create button. Must be visible; the caller decides what to do when it is disabled. */
export function findGenerateButton(doc, promptEl) {
  const region = findPromptRegion(promptEl);
  if (region) {
    const nearby = queryAllVisible(region, 'button, [role="button"]').filter((button) => GENERATE_NAME.test(accessibleName(button)));
    if (nearby.length) return { el: nearby[nearby.length - 1], strategy: 'generate-in-prompt-region' };

    // Current Flow renders an icon-only Angular host. Its accessible text can be
    // just "arrow_forward", so the old Generate-name check cannot see it.
    const iconHosts = queryAllVisible(region, 'flow-generate-icon-button, .generate-button, [class*="generate-button"]');
    if (iconHosts.length) {
      const host = iconHosts[iconHosts.length - 1];
      const nested = queryAllVisible(host, 'button, [role="button"]').pop();
      return { el: nested ?? host, strategy: 'generate-component-in-prompt-region' };
    }
  }
  // Document-wide fallback only accepts an explicit "Generate" label, never "Create project" style controls.
  const anywhere = queryAllVisible(doc, 'button, [role="button"]').filter((button) => /\b(generate|start generation)\b/i.test(accessibleName(button)));
  if (anywhere.length) return { el: anywhere[anywhere.length - 1], strategy: 'generate-in-document' };
  return null;
}

/** Button that opens the settings popover (model / mode / aspect ratio). */
export function findSettingsTrigger(doc, promptEl) {
  const region = findPromptRegion(promptEl) ?? doc;
  const buttons = queryAllVisible(region, 'button, [role="button"], [role="combobox"]').filter((button) => {
    const name = accessibleName(button);
    const rendered = normalizeText(button.textContent);
    if ((!name && !rendered) || GENERATE_NAME.test(name) || ADD_NAME.test(name) || REMOVE_NAME.test(name)) return false;
    return button.matches('.settings-trigger-button, [data-testid*="settings" i]')
      || button.hasAttribute('aria-haspopup')
      || button.hasAttribute('aria-expanded')
      || /arrow_drop_down|expand_more|unfold_more/i.test(`${name} ${rendered}`)
      || /\b(banana|veo|gemini|omni|imagen|image|video)\b/i.test(`${name} ${rendered}`);
  });
  const withPopup = buttons.find((button) => button.hasAttribute('aria-haspopup')) ?? buttons[0];
  if (!withPopup) return null;
  return {
    el: withPopup,
    strategy: withPopup.hasAttribute('aria-haspopup') ? 'settings-trigger-aria-haspopup' : 'settings-trigger-by-name',
  };
}

/** The popover that appeared most recently. */
export function findOpenPopover(doc) {
  const popovers = queryAllVisible(doc, POPOVER_SELECTOR);
  return popovers.length ? popovers[popovers.length - 1] : null;
}

/** Options inside a popover, with the heading that introduced each group (Mode, Model, Aspect ratio...). */
export function readPopoverOptions(popover) {
  const options = [];
  const seen = new Set();
  let currentGroup = null;
  const walker = popover.ownerDocument.createTreeWalker(popover, 1);
  let node = walker.currentNode;
  while (node) {
    if (node !== popover && isVisible(node)) {
      const role = node.getAttribute('role');
      const text = normalizeText(node.textContent);
      if (role === 'heading' || node.tagName === 'H2' || node.tagName === 'H3' || node.tagName === 'H4' || role === 'group') {
        const label = normalizeText(node.getAttribute('aria-label') || text);
        if (label && label.length <= 40) currentGroup = label;
      } else if (node.matches(OPTION_SELECTOR) && text && text.length <= 60) {
        const name = accessibleName(node) || text;
        const key = `${currentGroup ?? ''}|${name}`;
        if (!seen.has(key) && !isStructuralOnly(node)) {
          seen.add(key);
          options.push({
            el: node,
            name: normalizeText(name).replace(/\s*(check|done)\s*$/i, ''),
            group: currentGroup,
            selected: isSelected(node),
          });
        }
      }
    }
    node = walker.nextNode();
  }
  return options;
}

function isStructuralOnly(node) {
  // Skip containers whose only job is to wrap a more specific option.
  return node.tagName === 'LI' && node.querySelector('[role="option"],[role="menuitemradio"],[role="menuitem"],[role="radio"]');
}

export function isSelected(node) {
  if (node.getAttribute('aria-selected') === 'true') return true;
  if (node.getAttribute('aria-checked') === 'true') return true;
  if (node.getAttribute('aria-pressed') === 'true') return true;
  if (node.getAttribute('data-state') === 'checked' || node.getAttribute('data-state') === 'active') return true;
  return false;
}

/** Classify a settings option by its group heading first, then by shape. */
export function classifySettingOption(option) {
  const group = (option.group || '').toLowerCase();
  const name = option.name;
  if (/aspect|ratio/.test(group) || ASPECT_RATIO_TEXT.test(name)) return 'aspectRatio';
  if (/^mode$/.test(group) || /^(image|video)$/i.test(name)) return 'mode';
  if (/model/.test(group)) return 'model';
  if (/output|count|length|duration|quantity/.test(group)) return null;
  if (/^\d+$/.test(name) || /^x\d+$/i.test(name)) return null;
  if (ASPECT_RATIO_TEXT.test(name)) return 'aspectRatio';
  return 'model';
}

/** Agent switch in the prompt box. Returns { el, on } or null. */
export function findAgentToggle(doc, promptEl) {
  const region = findPromptRegion(promptEl) ?? doc;
  const candidates = queryAllVisible(region, 'button, [role="switch"], [role="checkbox"], [role="button"]').filter((el) => AGENT_NAME.test(accessibleName(el)));
  if (!candidates.length) return null;
  const el = candidates[0];
  const on = el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true' || el.getAttribute('data-state') === 'checked';
  return { el, on };
}

/** Remove buttons on attached reference chips within the prompt region. */
export function findReferenceRemoveButtons(promptEl) {
  const region = findPromptRegion(promptEl);
  if (!region) return [];
  return queryAllVisible(region, 'button, [role="button"]').filter((button) => REMOVE_NAME.test(accessibleName(button)) && !GENERATE_NAME.test(accessibleName(button)));
}

/** Entry point for attaching files: the "Add" / upload control near the prompt box. */
export function findAddButton(promptEl) {
  const region = findPromptRegion(promptEl);
  if (!region) return null;
  const match = queryAllVisible(region, 'button, [role="button"]').find((button) => {
    const name = accessibleName(button);
    return ADD_NAME.test(name) || /\b(add|upload|attach)\b/i.test(name) || name === '+';
  });
  return match ? { el: match, strategy: 'add-in-prompt-region' } : null;
}

export function findUploadMenuItem(doc) {
  const popover = findOpenPopover(doc) ?? doc;
  const item = queryAllVisible(popover, '[role="menuitem"], [role="option"], button, [role="button"], li').find((el) =>
    /\b(upload|from computer|browse|media|image)\b/i.test(accessibleName(el)),
  );
  return item ? { el: item, strategy: 'upload-menu-item' } : null;
}

/** Flow's supported route for attaching media that is already in the project. */
export function findUseFromProjectMenuItem(doc) {
  const popover = findOpenPopover(doc) ?? doc;
  const item = queryAllVisible(popover, '[role="menuitem"], [role="option"], button, [role="button"], li').find((el) =>
    /\b(use|add|choose|select)\b.*\b(project|media|ingredient)/i.test(accessibleName(el))
      || /\bfrom project\b/i.test(accessibleName(el)),
  );
  return item ? { el: item, strategy: 'use-from-project-menu-item' } : null;
}

/** Visible project-media chooser opened from Add > Use from project. */
export function findProjectMediaPicker(doc) {
  const candidates = queryAllVisible(doc, '[role="dialog"], [role="listbox"], [role="grid"], [role="menu"], mat-dialog-container')
    .map((el) => {
      const text = normalizeText(`${el.getAttribute?.('aria-label') ?? ''} ${el.textContent ?? ''}`);
      const itemCount = queryAllVisible(el, '[role="option"], [role="gridcell"], [role="listitem"], img').length;
      return { el, text, itemCount };
    })
    .filter(({ text, itemCount }) => /\b(project|media|ingredient|asset|reference)\b/i.test(text) && itemCount > 0)
    // Prefer the enclosing dialog over an inner grid so confirmation controls
    // remain in scope. A real picker also has more media descendants than tabs.
    .sort((a, b) => b.itemCount - a.itemCount);
  return candidates[0]?.el ?? null;
}

/** Selectable entries and their readable names in the project-media chooser. */
export function readProjectMediaItems(picker) {
  const nodes = queryAllVisible(picker, '[role="option"], [role="gridcell"], [role="listitem"], [data-testid*="tile" i], [class*="tile"]');
  const items = [];
  const seen = new Set();
  for (const node of nodes) {
    // Keep leaf-most selectable tiles; containers otherwise create duplicate matches.
    if (node.querySelector('[role="option"], [role="gridcell"], [role="listitem"]')) continue;
    const image = node.matches('img') ? node : node.querySelector('img');
    const name = cleanProjectMediaName(normalizeText(
      node.getAttribute('aria-label')
      || node.getAttribute('title')
      || image?.getAttribute('alt')
      || node.textContent,
    ));
    if (!name || seen.has(node)) continue;
    seen.add(node);
    items.push({ el: node, name });
  }
  return items;
}

function cleanProjectMediaName(name) {
  // Flow appends the media type directly to accessible tile text, producing
  // labels such as "ref_aron_sheet_v1.jpegImage". It is metadata, not part of
  // the uploaded filename.
  return normalizeText(name)
    .replace(/(\.(?:jpe?g|png|webp|gif|avif|heic|mp4|mov|webm))(?:image|video)$/i, '$1')
    .replace(/\s+(?:image|video)$/i, '');
}

/** Hidden or visible file input used for uploads. */
export function findFileInput(doc, { includeHidden = true } = {}) {
  const inputs = Array.from(doc.querySelectorAll('input[type="file"]'));
  const accepting = inputs.filter((input) => !input.disabled);
  if (!accepting.length) return null;
  return includeHidden ? accepting[accepting.length - 1] : accepting.find(isVisible) ?? null;
}

/** Tiles that look like generated outputs: large images/videos outside the prompt region and popovers. */
export function findOutputMedia(doc, promptEl) {
  const region = findPromptRegion(promptEl);
  const media = Array.from(doc.querySelectorAll('img, video')).filter((el) => {
    if (!isVisible(el)) return false;
    if (region && region.contains(el)) return false;
    if (el.closest(POPOVER_SELECTOR)) return false;
    const rect = el.getBoundingClientRect();
    return rect.width >= 96 && rect.height >= 96;
  });
  return media.map((el, index) => ({ el, key: outputKey(el, index) }));
}

function outputKey(el, index) {
  const src = el.currentSrc || el.getAttribute('src') || '';
  if (src && !src.startsWith('data:image/gif')) return `${el.tagName.toLowerCase()}:${src}`;
  return `${el.tagName.toLowerCase()}:#${index}:${normalizeText(el.getAttribute('alt')).slice(0, 40)}`;
}

/** Elements that show a generation in progress (spinners, progress bars, busy tiles). */
export function findProgressIndicators(doc, promptEl) {
  const region = findPromptRegion(promptEl);
  return queryAllVisible(doc, '[role="progressbar"], [aria-busy="true"]').filter((el) => !(region && region.contains(el)));
}

/** Visible alert or error messages on the page. */
export function findAlertTexts(doc) {
  const alerts = queryAllVisible(doc, '[role="alert"]').map((el) => normalizeText(el.textContent)).filter(Boolean);
  return Array.from(new Set(alerts));
}

export function isGenerateEnabled(button) {
  return Boolean(button) && !isDisabled(button);
}
