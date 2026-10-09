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
 *
 * Prompt-composer detection never reads an element's text content: a composer's
 * text IS the user's prompt, so candidate names come from aria-label,
 * aria-labelledby, placeholder and title only (see fieldLabel).
 */

import { AutomationError, ERROR_CODES } from '../utils/errors.js';
import { accessibleName, isDisabled, isVisible, normalizeText, queryAllVisible, waitForValue } from './dom.js';

const PROMPT_HINT = /(prompt|describe|imagine|what do you want|what would you like|create|generate|write|ask|message)/i;
const GENERATE_NAME = /^(?:[a-z_]+\s+)?(generate|create|make)\b/i;
/** A chat-style layout starts its run with Send/Submit, not Generate. */
const SEND_NAME = /\b(send|submit)\b/i;
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
/**
 * Every element shape a prompt composer can take: textareas, text-like inputs
 * (a chat-style Agent composer is often a single-line input), any contenteditable
 * value ("true", "", "plaintext-only"), and any element with a textbox role.
 */
const TEXT_FIELD_SELECTOR = [
  'textarea',
  'input:not([type])',
  'input[type="text"]',
  'input[type="search"]',
  'input[type="email"]',
  'input[type="url"]',
  'input[type="tel"]',
  '[contenteditable]',
  '[role="textbox"]',
].join(',');
/** Regions that hold page furniture, never the workspace composer. */
const FURNITURE_SELECTOR = 'header, nav, aside, [role="banner"], [role="navigation"], [role="complementary"], [role="search"]';
/** Names that mark a field as unrelated to prompting, whatever its tag. */
const UNRELATED_NAME = /^(search|find|filter|sort|log ?in|sign ?in|email|password|username|query)\b/i;
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

/**
 * A field's identifying label. Deliberately excludes text content: for a composer
 * the text content IS the user's prompt, and diagnostics must never carry it.
 * Order: aria-label, aria-labelledby, placeholder, title.
 */
function fieldLabel(el) {
  const aria = el.getAttribute('aria-label');
  if (aria) return normalizeText(aria);
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ');
    if (normalizeText(text)) return normalizeText(text);
  }
  return normalizeText(el.getAttribute('placeholder') ?? '') || normalizeText(el.getAttribute('title') ?? '');
}

/**
 * Ancestors of `el`, crossing shadow-DOM boundaries (a composer inside a custom
 * element has its toolbar either inside the shadow tree or around the host).
 */
function composerAncestors(el, levels) {
  const out = [];
  let node = el;
  while (node && out.length < levels) {
    let parent = node.parentElement;
    if (!parent) {
      const root = node.getRootNode?.();
      parent = root && root.host ? root.host : null;
    }
    if (!parent) break;
    out.push(parent);
    node = parent;
  }
  return out;
}

/** Buttons and declared controls inside `node`, looking one shadow level deep. Bounded. */
function controlsWithin(node, cap = 24) {
  const out = Array.from(node.querySelectorAll(CONTROL_SELECTOR));
  if (out.length >= cap) return out;
  // A Document has no ownerDocument; an element's does. Support both as the walk root.
  const owner = node.ownerDocument ?? node;
  const walker = owner.createTreeWalker(node, 1);
  let scanned = 0;
  let current = walker.nextNode();
  while (current && scanned < 1500 && out.length < cap) {
    scanned += 1;
    if (current.tagName.includes('-') && current.shadowRoot) {
      for (const inner of current.shadowRoot.querySelectorAll(CONTROL_SELECTOR)) {
        out.push(inner);
        if (out.length >= cap) break;
      }
    }
    current = walker.nextNode();
  }
  return out;
}

/** The region that holds the prompt box, its settings button, Generate, and references. */
export function findPromptRegion(promptEl) {
  if (!promptEl) return null;
  for (const node of composerAncestors(promptEl, 8)) {
    if (controlsWithin(node).length >= 2) return node;
  }
  return promptEl.parentElement ?? null;
}

/** Same-origin iframe documents, so a composer rendered inside Flow's own frame is found. */
export function collectFrameDocs(doc, limit = 4) {
  const out = [];
  for (const frame of doc.querySelectorAll('iframe, frame')) {
    if (out.length >= limit) break;
    let frameDoc = null;
    try {
      frameDoc = frame.contentDocument;
    } catch {
      frameDoc = null;
    }
    if (frameDoc?.body) {
      const id = frame.id || frame.getAttribute('name') || frame.getAttribute('title') || '';
      out.push({ doc: frameDoc, label: id ? `iframe#${id}` : `iframe-${out.length + 1}` });
    }
  }
  return out;
}

/** Frames whose document this frame cannot reach (cross-origin): counted, never guessed at. */
export function countUnreachableFrames(doc) {
  let count = 0;
  for (const frame of doc.querySelectorAll('iframe, frame')) {
    try {
      if (!frame.contentDocument) count += 1;
    } catch {
      count += 1;
    }
  }
  return count;
}

/** Text fields inside shadow roots (custom-element composers), bounded in depth and count. */
function collectShadowFields(scopeDoc, push, state) {
  const walk = (root, depth) => {
    // A Document has no ownerDocument; an element's does. Support both as the walk root.
    const owner = root.ownerDocument ?? root;
    const walker = owner.createTreeWalker(root, 1);
    let scanned = 0;
    let current = walker.nextNode();
    while (current && state.scanned < 2000 && !state.done) {
      state.scanned += 1;
      scanned += 1;
      if (current.tagName.includes('-') && current.shadowRoot) {
        state.hosts += 1;
        for (const field of current.shadowRoot.querySelectorAll(TEXT_FIELD_SELECTOR)) {
          push(field, { kind: 'shadow', label: `${current.tagName.toLowerCase()} shadow root` });
        }
        if (depth < 1) walk(current.shadowRoot, depth + 1);
        if (state.fields >= 8) state.done = true;
      }
      current = walker.nextNode();
    }
  };
  walk(scopeDoc, 0);
}

function candidateKind(el) {
  if (el.tagName === 'TEXTAREA') return 'textarea';
  if (el.tagName === 'INPUT') return 'input';
  const editable = el.getAttribute('contenteditable');
  if (editable && editable !== 'false') return 'contenteditable';
  return 'textbox';
}

/**
 * Why a text field is NOT the prompt composer. A disabled composer is not a
 * rejection: it is detected and reported as disabled, so the panel can say so.
 */
function rejectionReason(el) {
  if (el.hasAttribute('readonly')) return 'read-only';
  if (el.closest('[role="searchbox"]')) return 'search field';
  if (el.closest(FURNITURE_SELECTOR)) return 'page furniture (header, navigation or sidebar)';
  if (el.closest('[role="dialog"]')) return 'inside a dialog';
  const label = fieldLabel(el);
  if (UNRELATED_NAME.test(label)) return `unrelated field ("${label.slice(0, 30)}")`;
  return null;
}

function describeCandidate(el, scope) {
  const rect = el.getBoundingClientRect?.() ?? null;
  const candidate = {
    el,
    tag: el.tagName.toLowerCase(),
    kind: candidateKind(el),
    role: el.getAttribute('role') ?? '',
    name: fieldLabel(el).slice(0, 40),
    placeholder: (el.getAttribute('placeholder') ?? '').slice(0, 40),
    type: el.getAttribute('type') ?? '',
    contenteditable: el.getAttribute('contenteditable') ?? '',
    disabled: isDisabled(el),
    readonly: el.hasAttribute('readonly'),
    visible: isVisible(el),
    frame: scope.label,
    inShadowRoot: scope.kind === 'shadow',
    rect: rect
      ? {
          x: Math.round(rect.x ?? rect.left ?? 0),
          y: Math.round(rect.y ?? rect.top ?? 0),
          width: Math.round(rect.width ?? 0),
          height: Math.round(rect.height ?? 0),
        }
      : null,
    rejection: null,
    error: null,
  };
  candidate.rejection = candidate.visible ? rejectionReason(el) : 'not visible';
  return candidate;
}

/**
 * Every text-entry element the page offers, across the top document, same-origin
 * frames and shadow roots. Candidates carry their element for scoring; strip it
 * (candidateSummaries) before anything crosses the message boundary.
 */
export function collectPromptCandidates(doc, { limit = 16 } = {}) {
  const out = [];
  const seen = new Set();
  const state = { scanned: 0, hosts: 0, fields: 0, done: false };
  const push = (el, scope) => {
    if (seen.has(el) || out.length >= limit || state.done) return;
    seen.add(el);
    state.fields += 1;
    try {
      out.push(describeCandidate(el, scope));
    } catch (error) {
      // One unreadable field must not hide the others, and must not hide the failure.
      out.push({
        el,
        tag: el.tagName.toLowerCase(),
        kind: candidateKind(el),
        role: '',
        name: '',
        placeholder: '',
        type: '',
        contenteditable: '',
        disabled: true,
        readonly: false,
        visible: false,
        frame: scope.label,
        inShadowRoot: scope.kind === 'shadow',
        rect: null,
        rejection: 'unreadable',
        error: String(error?.message ?? error),
      });
    }
  };
  const scopes = [{ doc, label: 'top', kind: 'top' }, ...collectFrameDocs(doc)];
  for (const scope of scopes) {
    for (const el of scope.doc.querySelectorAll(TEXT_FIELD_SELECTOR)) push(el, scope);
    collectShadowFields(scope.doc, push, state);
  }
  return out;
}

/** Candidates without their elements: safe to send to the service worker and the panel. */
export function candidateSummaries(candidates) {
  return (candidates ?? []).map(({ el, ...rest }) => rest);
}

/**
 * What the controls around a candidate say about it. The composer's own toolbar is
 * the strongest verified relationship: it holds the Generate/Send control, the
 * Add/upload entry and the model/settings trigger.
 */
function regionSignals(el) {
  const signals = { generate: false, add: false, model: false, agent: false, controls: 0 };
  for (const node of composerAncestors(el, 8)) {
    for (const control of controlsWithin(node, 40)) {
      signals.controls += 1;
      const name = accessibleName(control);
      if (!signals.generate && (GENERATE_NAME.test(name) || SEND_NAME.test(name) || /\bgenerate\b/i.test(name))) signals.generate = true;
      if (!signals.add && (ADD_NAME.test(name) || /\b(add|upload|attach)\b/i.test(name) || name === '+')) signals.add = true;
      if (!signals.model && (MODEL_NAME.test(name) || control.hasAttribute('aria-haspopup') || control.hasAttribute('aria-expanded'))) {
        signals.model = true;
      }
      if (!signals.agent && AGENT_NAME.test(name)) signals.agent = true;
    }
    if (signals.generate && signals.add) break;
  }
  return signals;
}

/** Score one candidate. Higher wins; the reasons are kept so the panel can say why. */
function scoreCandidate(candidate) {
  const el = candidate.el;
  const reasons = [];
  let score = 0;
  const label = candidate.name || candidate.placeholder;
  const hint = PROMPT_HINT.test(label);
  if (hint) {
    score += 1000;
    reasons.push('prompt-like label');
  }
  const signals = regionSignals(el);
  if (signals.generate) {
    score += 400;
    reasons.push('Generate/Send control in its region');
  }
  if (signals.add) {
    score += 200;
    reasons.push('Add/upload control in its region');
  }
  if (signals.model) {
    score += 100;
    reasons.push('model/settings control in its region');
  }
  const rect = candidate.rect ?? { width: 0, height: 0 };
  score += Math.min(rect.width, 1200) / 10;
  score += Math.min(rect.height, 400) / 20;
  reasons.push(`size ${rect.width}x${rect.height}px`);
  if (!candidate.disabled) {
    score += 50;
    reasons.push('enabled');
  }
  return { score, reasons, signals, hint };
}

/**
 * Pick the composer out of the candidates: visible, not rejected, best score.
 * Returns `{ el, kind, strategy, enabled, ambiguous, score, reasons, candidateCount }`
 * or null when nothing qualifies. Equal scores are reported as ambiguous, not hidden.
 */
export function selectPromptCandidate(candidates) {
  const scored = [];
  for (const candidate of candidates ?? []) {
    if (!candidate.visible || candidate.rejection || candidate.error) continue;
    try {
      scored.push({ ...candidate, ...scoreCandidate(candidate) });
    } catch (error) {
      candidate.rejection = 'unreadable';
      candidate.error = String(error?.message ?? error);
    }
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const tied = scored.filter((candidate) => candidate !== best && candidate.score === best.score);
  const basis = best.signals.generate || best.signals.add ? 'by-region' : best.hint ? 'by-label' : 'only-candidate';
  const scope = best.inShadowRoot ? 'in-shadow-root' : best.frame !== 'top' ? 'in-frame' : null;
  return {
    el: best.el,
    kind: best.kind,
    strategy: ['composer', best.kind, scope, basis].filter(Boolean).join('-'),
    enabled: !best.disabled,
    ambiguous: tied.length > 0,
    score: best.score,
    reasons: best.reasons,
    candidateCount: (candidates ?? []).length,
  };
}

/**
 * Find the prompt composer: every text-entry shape, in the top document, in
 * same-origin frames and in shadow roots, disambiguated by label, size and the
 * controls in its region. Never picks an unrelated search or chat field: those
 * are rejected (or outranked) by role, ancestry and name.
 */
export function findPromptBox(doc) {
  return selectPromptCandidate(collectPromptCandidates(doc));
}

/** One line per rejected candidate, so a "not found" error says what the page offered. */
export function summarizePromptRejections(candidates, limit = 5) {
  const rejected = (candidates ?? []).filter((candidate) => candidate.rejection || candidate.error);
  if (!rejected.length) return 'no text-entry element exists on this page';
  return rejected
    .slice(0, limit)
    .map((candidate) => {
      const label = candidate.name || candidate.placeholder || '(unnamed)';
      return `${candidate.tag}${candidate.role ? `[${candidate.role}]` : ''} "${label}" (${candidate.rejection || candidate.error})`;
    })
    .join('; ');
}

/** The prompt composer, or an error that names the text fields the page actually offers. */
export function requirePromptBox(doc) {
  const prompt = findPromptBox(doc);
  if (prompt) return prompt;
  const candidates = collectPromptCandidates(doc);
  throw new AutomationError(
    ERROR_CODES.FLOW_UI_CHANGED,
    `Flow prompt box not found. Text fields on this page: ${summarizePromptRejections(candidates)}. ` +
      'Open a project and keep the prompt box visible, or run "Check Flow page" in Settings for the full report.',
  );
}

/** Which composer selectors matched, per scope, so the report shows what was tried. */
export function selectorResults(doc) {
  const rows = [];
  const probes = [
    ['textarea', 'textarea'],
    ['text-like input', 'input:not([type]), input[type="text"], input[type="search"], input[type="email"], input[type="url"], input[type="tel"]'],
    ['contenteditable', '[contenteditable]'],
    ['role=textbox', '[role="textbox"]'],
  ];
  const scopes = [{ label: 'top', doc }, ...collectFrameDocs(doc)];
  for (const scope of scopes) {
    for (const [name, selector] of probes) {
      let matched = 0;
      let visible = 0;
      try {
        const els = scope.doc.querySelectorAll(selector);
        matched = els.length;
        for (const el of els) if (isVisible(el)) visible += 1;
      } catch {
        // Keep the zeros: the report shows the selector ran and matched nothing.
      }
      rows.push({ selector: name, scope: scope.label, matched, visible });
    }
  }
  const shadow = { matched: 0, visible: 0 };
  const state = { scanned: 0, hosts: 0, fields: 0, done: false };
  const count = (el) => {
    shadow.matched += 1;
    if (isVisible(el)) shadow.visible += 1;
  };
  collectShadowFields(doc, count, state);
  rows.push({ selector: 'inside shadow roots', scope: 'top', matched: shadow.matched, visible: shadow.visible });
  return rows;
}

/** True when the URL is a page this extension supports (mirrors the bridge's isFlowUrl). */
export function isFlowPageUrl(location) {
  try {
    const url = new URL(location?.href ?? '');
    if (url.protocol !== 'https:') return false;
    if (url.hostname === 'flow.google.com') return true;
    return url.hostname === 'labs.google' && url.pathname.startsWith('/fx/tools/flow');
  } catch {
    return false;
  }
}

/** Visible controls inside `node`, looking one shadow level deep (custom-element toolbars). */
function visibleControlsWithin(node, cap = 40) {
  return controlsWithin(node, cap).filter(isVisible);
}

/**
 * The control that starts a generation. In the standard layout it is labelled
 * Generate; a chat-style (Agent) layout starts it with Send/Submit. The region
 * search accepts both, the document-wide fallback only an explicit "Generate"
 * label, so a "Create project" or unrelated "Send" is never clicked.
 */
export function findGenerateButton(doc, promptEl) {
  const region = findPromptRegion(promptEl);
  if (region) {
    const nearby = visibleControlsWithin(region).filter((button) => {
      const name = accessibleName(button);
      return GENERATE_NAME.test(name) || SEND_NAME.test(name);
    });
    if (nearby.length) {
      const generate = nearby.find((button) => GENERATE_NAME.test(accessibleName(button)));
      const el = generate ?? nearby[nearby.length - 1];
      return { el, strategy: generate ? 'generate-in-prompt-region' : 'send-in-prompt-region' };
    }
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
    // Shadow-aware: a custom-element toolbar's trigger is invisible to a plain querySelectorAll.
    ...visibleControlsWithin(scope).map((el) => ({ el, rank: settingsTriggerRank(el) })),
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
  for (const el of visibleControlsWithin(region)) {
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
  for (const el of visibleControlsWithin(region)) push(el);
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
  const candidates = visibleControlsWithin(region).filter((el) => AGENT_NAME.test(accessibleName(el)));
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
