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

import { accessibleName, ancestors, isDisabled, isVisible, labelText, normalizeText, queryAllVisible, waitForValue } from './dom.js';

const PROMPT_HINT = /(prompt|describe|imagine|what do you want|what would you like|create|generate|write)/i;
const GENERATE_NAME = /^(?:[a-z_]+\s+)?(generate|create|make)\b/i;
const ADD_NAME = /^(?:[a-z_]+\s+)?(add|attach|upload|\+)(?:\s|$)/i;
const REMOVE_NAME = /(remove|delete|clear|close|dismiss)/i;
const AGENT_NAME = /\bagent\b/i;
const ASPECT_RATIO_TEXT = /^\d{1,2}\s*:\s*\d{1,2}$/;
/** The model-name control opens the menu with Mode, Model and Aspect ratio together. */
const MODEL_NAME = /\b(banana|veo|gemini|omni|imagen)\b/i;
/** Weak signals: a settings-like name, a chevron icon, a bare mode word or an aspect-ratio chip. */
const SETTINGS_NAME = /\b(settings?|preferences?|options?|tune|sliders?)\b|\u2699|arrow_drop_down|expand_more|unfold_more|keyboard_arrow_down|chevron_down/i;
const MODE_NAME = /^(image|video)$/i;
/** Menu triggers: real buttons, comboboxes, or any element that declares a popup. */
const TRIGGER_SELECTOR = 'button, [role="button"], [role="combobox"], [aria-haspopup], [aria-expanded]';
/** Every interactive control, including switches, for the "controls near the prompt" diagnostics. */
const CONTROL_SELECTOR = 'button, [role="button"], [role="combobox"], [role="switch"], [role="checkbox"], [aria-haspopup], [aria-expanded]';
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
  for (const node of ancestors(promptEl, 8)) {
    const buttons = node.querySelectorAll('button, [role="button"]');
    if (buttons.length >= 2) return node;
  }
  return promptEl.parentElement ?? null;
}

/** Generate / Create button. Must be visible; the caller decides what to do when it is disabled. */
export function findGenerateButton(doc, promptEl) {
  const region = findPromptRegion(promptEl);
  if (region) {
    const nearby = queryAllVisible(region, 'button, [role="button"]').filter((button) => GENERATE_NAME.test(accessibleName(button)));
    if (nearby.length) return { el: nearby[nearby.length - 1], strategy: 'generate-in-prompt-region' };
  }
  // Document-wide fallback only accepts an explicit "Generate" label, never "Create project" style controls.
  const anywhere = queryAllVisible(doc, 'button, [role="button"]').filter((button) => /\bgenerate\b/i.test(accessibleName(button)));
  if (anywhere.length) return { el: anywhere[anywhere.length - 1], strategy: 'generate-in-document' };
  return null;
}

/**
 * How strongly a control looks like Flow's model/settings trigger. Higher wins.
 * The model-name control ("Nano Banana Pro", "Veo 3.1", ...) opens the one menu that
 * holds Mode, Model and Aspect ratio together, so it outranks everything else.
 */
function settingsTriggerRank(el) {
  const name = accessibleName(el);
  if (!name || GENERATE_NAME.test(name) || ADD_NAME.test(name) || REMOVE_NAME.test(name)) return 0;
  if (MODEL_NAME.test(name)) return 3;
  if (el.hasAttribute('aria-haspopup') || el.hasAttribute('aria-expanded')) return 2;
  if (SETTINGS_NAME.test(name) || ASPECT_RATIO_TEXT.test(name) || MODE_NAME.test(name)) return 1;
  return 0;
}

function bestTrigger(candidates) {
  let best = null;
  for (const candidate of candidates) {
    if (!best || candidate.rank > best.rank) best = candidate;
  }
  return best;
}

/** True when several candidates share the top rank: the match is reported, not hidden. */
function isAmbiguous(candidates) {
  const best = bestTrigger(candidates);
  if (!best) return false;
  return candidates.filter((candidate) => candidate.rank === best.rank).length > 1;
}

/** Custom-element hosts (shadow DOM) are invisible to TRIGGER_SELECTOR; strong hosts qualify as triggers too. */
function collectHosts(scope, minRank) {
  const out = [];
  let scanned = 0;
  for (const el of scope.querySelectorAll('*')) {
    if (out.length >= 8 || scanned >= 3000) break;
    scanned += 1;
    if (!el.tagName.includes('-')) continue;
    const rank = settingsTriggerRank(el);
    if (rank >= minRank) out.push({ el, rank });
  }
  return out;
}

/**
 * The control that opens the settings popover (model / mode / aspect ratio).
 * The prompt region is searched first. If it holds no candidate, the whole document is
 * searched with stronger requirements only: the control can sit just outside the detected
 * region, but a weak match anywhere on the page (a bare "Video" tab, say) must never be
 * clicked blindly, so the fallback demands a model-like name or a declared popup.
 * When several controls match equally well, the first is used and `ambiguous` says so.
 */
export function findSettingsTrigger(doc, promptEl) {
  const region = findPromptRegion(promptEl) ?? doc;
  const collect = (scope, minRank) => [
    ...queryAllVisible(scope, TRIGGER_SELECTOR).map((el) => ({ el, rank: settingsTriggerRank(el) })),
    ...collectHosts(scope, minRank),
  ].filter((item) => item.rank >= minRank);
  const inRegionList = collect(region, 1);
  const inRegion = bestTrigger(inRegionList);
  const found = inRegion ?? bestTrigger(collect(doc, 2));
  if (!found) return null;
  const opensPopup = found.el.hasAttribute('aria-haspopup') || found.el.hasAttribute('aria-expanded');
  const base = opensPopup ? 'settings-trigger-aria-haspopup' : 'settings-trigger-by-name';
  return { el: found.el, strategy: inRegion ? base : `${base}-in-document`, ambiguous: isAmbiguous(inRegionList) };
}

/** Find the settings trigger, waiting a bounded time for Flow's asynchronous UI to render it. */
export async function findSettingsTriggerWhenReady(doc, promptEl, { timeoutMs = 2000, intervalMs = 150, sleep } = {}) {
  return waitForValue(() => findSettingsTrigger(doc, promptEl), { timeoutMs, intervalMs, sleep });
}

/** Find the prompt composer, waiting a bounded time for Flow's asynchronous UI to render it. */
export async function findPromptBoxWhenReady(doc, { timeoutMs = 2500, intervalMs = 150, sleep } = {}) {
  return waitForValue(() => findPromptBox(doc), { timeoutMs, intervalMs, sleep });
}

/** What a control is for, from its accessible name and attributes. Used for diagnostics and prioritisation. */
export function classifyControl(el) {
  const name = accessibleName(el);
  if (!name) return 'other';
  if (GENERATE_NAME.test(name) || /\bgenerate\b/i.test(name)) return 'generate';
  if (ADD_NAME.test(name) || /\b(add|upload|attach)\b/i.test(name)) return 'add';
  if (REMOVE_NAME.test(name)) return 'remove';
  if (AGENT_NAME.test(name)) return 'agent';
  if (MODEL_NAME.test(name)) return 'model';
  if (ASPECT_RATIO_TEXT.test(name)) return 'aspect-ratio';
  if (MODE_NAME.test(name)) return 'mode';
  if (SETTINGS_NAME.test(name)) return 'settings';
  return 'other';
}

/** The current Mode / Model / Aspect ratio as shown by the controls themselves, when identifiable. */
export function findDetectedSettings(doc, promptEl) {
  const region = findPromptRegion(promptEl) ?? doc;
  let model = null;
  let aspectRatio = null;
  let mode = null;
  for (const el of queryAllVisible(region, CONTROL_SELECTOR)) {
    const name = accessibleName(el);
    if (!name) continue;
    if (!model && MODEL_NAME.test(name)) {
      // The model-name control shows the active model ("Nano Banana Pro \u25be").
      model = normalizeText(name).replace(/[\u25be\u25b4\u25bc\u25c5\u2304\u2305\u2193]+\s*$/g, '').trim() || null;
    }
    if (!aspectRatio && ASPECT_RATIO_TEXT.test(name)) aspectRatio = name;
    if (!mode && MODE_NAME.test(name)) mode = name;
  }
  return { mode, model, aspectRatio };
}

/**
 * The visible interactive controls near the prompt box, for diagnostics. When a control
 * cannot be found, this list says what the page actually offers, so the "Check Flow page"
 * report can name the real controls instead of only reporting "Not found".
 */
export function listPromptControls(doc, promptEl, limit = 10) {
  const region = findPromptRegion(promptEl) ?? doc;
  const out = [];
  const seen = new Set();
  const push = (el) => {
    if (seen.has(el) || out.length >= limit) return;
    seen.add(el);
    out.push({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') ?? '',
      name: accessibleName(el).slice(0, 40),
      title: (el.getAttribute('title') ?? '').slice(0, 40),
      popup: el.getAttribute('aria-haspopup') ?? '',
      disabled: isDisabled(el),
      purpose: classifyControl(el),
    });
  };
  for (const el of queryAllVisible(region, CONTROL_SELECTOR)) push(el);
  // Custom-element hosts (shadow DOM) are not matched by CONTROL_SELECTOR; list them too.
  if (out.length < limit) {
    for (const el of region.querySelectorAll('*')) {
      if (out.length >= limit) break;
      if (el.tagName.includes('-') && isVisible(el)) push(el);
    }
  }
  return out;
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
