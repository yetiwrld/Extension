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
/**
 * Flow's Agent-mode chip. PRESSED (`aria-pressed="true"`) means Agent mode is on:
 * Flow then swaps the classic composer (`flow-prompt-box`) for
 * `flow-creative-agent-prompt-box` and puts a bare `hidden` on the classic
 * `.settings-trigger-button` (display:none, 0x0, never hit-testable) — which is why
 * clicking the old settings trigger changes nothing. The class + aria-pressed carry
 * the chip's identity in every locale (verified against the live DOM by an
 * independent automation project), so no translated label is used.
 */
const AGENT_CHIP_SELECTOR = 'button.agent-mode-chip';
const AGENT_CHIP_PRESSED_SELECTOR = 'button.agent-mode-chip[aria-pressed="true"]';
/** The classic (standard) composer custom elements. */
const CLASSIC_COMPOSER_TAGS = ['flow-prompt-box', 'flow-base-prompt-box'];
/** The Agent-mode composer that replaces the classic one while the chip is pressed. */
const AGENT_COMPOSER_TAG = 'flow-creative-agent-prompt-box';
/** The classic settings trigger's class (it stays in the DOM, hidden, in Agent mode). */
const SETTINGS_TRIGGER_CLASS = 'settings-trigger-button';
/** Output-count options as Flow shows them in the settings menu and on the chip ("x1"…"x4"). */
const OUTPUT_TEXT = /^x\s?\d{1,2}$/i;
/**
 * An aspect-ratio token inside the model chip's text, e.g. "crop_16_9" or "16:9".
 * The chip concatenates model name, ratio and output count ("🍌 Nano Banana 2.1 crop_16_9 x1"),
 * so the ratio is found as a word, not just at the start.
 */
const ASPECT_IN_CHIP = /(?:^|\s)(?:[a-z]+_)?(\d{1,2})\s*[_:x\u00d7]\s*(\d{1,2})(?=\s|$)/i;
/** An output-count token inside the chip's text ("x1"). */
const OUTPUTS_IN_CHIP = /\bx\s?(\d{1,2})\b/i;
/** The menu item that opens the (nested) model list: "Select model family". */
const MODEL_SUBMENU_NAME = /\b(select|choose)\b[^|]*\bmodel\b|\bmodel\b[^|]*\b(famil|librar)/i;
/** The model-name control opens the menu with Mode, Model and Aspect ratio together. */
const MODEL_NAME = /\b(banana|veo|gemini|omni|imagen)\b/i;
/** Weak signals: a settings-like name, a chevron icon, a bare mode word or an aspect-ratio chip. */
const SETTINGS_NAME = /\b(settings?|preferences?|options?|tune|sliders?)\b|\u2699|arrow_drop_down|expand_more|unfold_more|keyboard_arrow_down|chevron_down/i;
const MODE_NAME = /^(image|video)$/i;
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
/**
 * What a generation-settings menu can look like. Detection is deliberately wider
 * than POPOVER_SELECTOR: a menu surface without ARIA roles (a custom popover, a
 * Material menu, a shadow-DOM menu) must still be recognised, or a menu that DID
 * open is reported as "did not open".
 */
const MENU_SELECTOR = [
  '[role="menu"]',
  '[role="listbox"]',
  '[role="dialog"]',
  '[aria-modal="true"]',
  '[popover]',
  '[data-radix-popper-content-wrapper]',
  '[data-state="open"]',
  '[data-radix-menu-content]',
  '[data-mdc-menu-surface]',
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
 * Order: aria-label, aria-labelledby, placeholder (the attribute rich-text editors
 * use: aria-placeholder / data-placeholder), title.
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
  return (
    normalizeText(el.getAttribute('placeholder') ?? '') ||
    normalizeText(el.getAttribute('aria-placeholder') ?? '') ||
    normalizeText(el.getAttribute('data-placeholder') ?? '') ||
    normalizeText(el.getAttribute('title') ?? '')
  );
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
    let current = walker.nextNode();
    while (current && state.scanned < 2000 && !state.done) {
      state.scanned += 1;
      if (current.tagName.includes('-') && current.shadowRoot) {
        state.hosts += 1;
        for (const field of current.shadowRoot.querySelectorAll(TEXT_FIELD_SELECTOR)) {
          push(field, { kind: 'shadow', label: `${current.tagName.toLowerCase()} shadow root${depth ? ` (level ${depth + 1})` : ''}` });
        }
        // Flow's composer UI nests custom elements: descend two shadow levels, bounded.
        if (depth < 2) walk(current.shadowRoot, depth + 1);
        if (state.fields >= 12) state.done = true;
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
    placeholder: (el.getAttribute('placeholder') ?? el.getAttribute('aria-placeholder') ?? el.getAttribute('data-placeholder') ?? '').slice(0, 40),
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
export function collectPromptCandidates(doc, { limit = 24 } = {}) {
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
  return (candidates ?? []).map((candidate) => {
    const { el: _el, ...rest } = candidate;
    return rest;
  });
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
/** Icon ligatures a Generate/Submit control can be made of when it has no text label. */
const GO_ICON_NAME = /(arrow_forward|arrow_upward|arrow_outward|play_arrow|send|\u25b6|\u27a4|\u2192|\u21e8|\u2191)/i;

export function findGenerateButton(doc, promptEl) {
  const region = findPromptRegion(promptEl);
  if (region) {
    // Deep and shadow-aware: Flow's composer is built from custom elements, so the
    // Generate control can sit inside a custom element's shadow root.
    const regionControls = deepControlsWithin(region, { cap: 60 });
    const nearby = regionControls.filter((button) => {
      const name = accessibleName(button);
      return GENERATE_NAME.test(name) || SEND_NAME.test(name);
    });
    if (nearby.length) {
      const generate = nearby.find((button) => GENERATE_NAME.test(accessibleName(button)));
      const el = generate ?? nearby[nearby.length - 1];
      return { el, strategy: generate ? 'generate-in-prompt-region' : 'send-in-prompt-region' };
    }
    // A Generate control named by its class (Flow's icon button: button.generate-icon-button
    // inside flow-generate-icon-button), in-region only.
    const classed = regionControls.filter((button) => /generate/i.test(button.getAttribute('class') ?? ''));
    if (classed.length) return { el: classed[classed.length - 1], strategy: 'generate-class-in-prompt-region' };
    // An icon-only Generate control (a material ligature, no text) still counts, in-region only.
    const icons = regionControls.filter((button) => GO_ICON_NAME.test(accessibleName(button) || ''));
    if (icons.length) return { el: icons[icons.length - 1], strategy: 'generate-icon-in-prompt-region' };
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

const INTERACTIVE_SELECTOR = 'button, a, [role="button"], [role="combobox"], [role="menuitem"], [aria-haspopup], [aria-expanded], [tabindex]';

/** Elements that are a control in their own right: clicking them is meaningful. */
const REAL_CONTROL_SELECTOR = 'button, [role="button"], [role="combobox"], [aria-haspopup], [aria-expanded], a[href]';

/**
 * Resolve a found trigger element to the control that actually opens the menu.
 * Flow's visible model label is often a CHILD of the clickable button (a community
 * DOM reference shows `flow-base-prompt-box div.submit-controls button.settings-trigger-button`
 * with the label inside): clicking the label only works when it sits inside the
 * button, and clicking a bare non-interactive element does nothing. The walk goes
 * up through the light DOM and across shadow hosts, so a label inside a custom
 * element's shadow resolves to the button within that same shadow tree.
 *
 * @returns {{el: Element, via: string}|null} the control, or null when no ancestor is one.
 */
export function resolveInteractiveControl(el, maxLevels = 8) {
  let node = el;
  for (let level = 0; node && level <= maxLevels; level += 1) {
    if (node.matches?.(REAL_CONTROL_SELECTOR)) return { el: node, via: level === 0 ? 'self' : `ancestor-${level}` };
    let parent = node.parentElement;
    if (!parent) {
      const root = node.getRootNode?.();
      parent = root && root.host ? root.host : null;
    }
    if (!parent) break;
    node = parent;
  }
  return null;
}

/** Whether an element is a control in its own right (not a label inside one). */
export function isRealControl(el) {
  return Boolean(el?.matches?.(REAL_CONTROL_SELECTOR));
}

/** Buttons and controls inside `node`, descending into shadow roots up to `levels` deep. Bounded. */
function deepControlsWithin(node, { levels = 3, cap = 40, scanCap = 4000 } = {}) {
  const out = [];
  const seen = new Set();
  const consider = (el) => {
    if (out.length >= cap || seen.has(el)) return;
    seen.add(el);
    if (isVisible(el) && el.matches(CONTROL_SELECTOR)) out.push(el);
  };
  const walk = (root, depth) => {
    if (out.length >= cap || depth > levels) return;
    for (const el of root.querySelectorAll(CONTROL_SELECTOR)) consider(el);
    if (out.length >= cap) return;
    // Descend into custom-element hosts, bounded.
    const owner = root.ownerDocument ?? root;
    const walker = owner.createTreeWalker(root, 1);
    let scanned = 0;
    let current = walker.nextNode();
    while (current && scanned < scanCap && out.length < cap) {
      scanned += 1;
      if (current.tagName.includes('-') && current.shadowRoot) walk(current.shadowRoot, depth + 1);
      current = walker.nextNode();
    }
  };
  walk(node, 0);
  return out;
}

/** An element's own text: its direct text nodes only, never its descendants'. */
function ownText(el) {
  let text = '';
  for (const node of el.childNodes) {
    if (node.nodeType === 3) text += node.nodeValue;
  }
  return normalizeText(text);
}

/**
 * A control's label without the textContent fallback: aria-label, aria-labelledby,
 * title, then the element's OWN text. The fallback matters: a container wrapping a
 * chip has the chip's text in its textContent, and must not be mistaken for the
 * chip itself.
 */
function controlLabel(el) {
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
  const title = el.getAttribute('title');
  if (title) return normalizeText(title);
  return ownText(el);
}

/**
 * Controls that DISPLAY a model name ("Nano Banana 2.1", "Veo 3.1", …). The model
 * chip in the composer is the control that opens the generation settings menu, but
 * it is often a plain element with no button semantics at all, so neither
 * CONTROL_SELECTOR nor TRIGGER_SELECTOR sees it. Name is the verified signal.
 *
 * `interactiveOnly` restricts the document-wide search: a model name in a project
 * card title must never be clicked, while the chip inside the composer (always
 * interactive in practice) is found even as a plain element.
 */
export function collectModelNamedControls(scope, { interactiveOnly = false, limit = 8, scanCap = 2500 } = {}) {
  const out = [];
  const seen = new Set();
  const consider = (el) => {
    if (seen.has(el) || out.length >= limit) return;
    seen.add(el);
    if (!isVisible(el)) return;
    // Own-text label, not textContent: a container wrapping the chip must not match.
    const name = controlLabel(el);
    if (!MODEL_NAME.test(name)) return;
    if (interactiveOnly && !el.matches(INTERACTIVE_SELECTOR) && !el.tagName.includes('-')) return;
    out.push({ el, rank: 3, name });
  };
  // One bounded walk; custom-element hosts are descended into one shadow level.
  const walk = (root) => {
    const walker = (root.ownerDocument ?? root).createTreeWalker(root, 1);
    let scanned = 0;
    let current = walker.nextNode();
    while (current && scanned < scanCap && out.length < limit) {
      scanned += 1;
      consider(current);
      if (current.tagName.includes('-') && current.shadowRoot) {
        for (const inner of current.shadowRoot.querySelectorAll('*')) consider(inner);
      }
      current = walker.nextNode();
    }
  };
  walk(scope);
  return out;
}

/**
 * The control that opens the generation settings menu (Mode / Model / Aspect ratio /
 * output count).
 *
 * The verified control is the model chip in the prompt composer: Google's own help
 * says to "click the model name" in the prompt box, and that menu holds the settings.
 * The chip is often a plain element with no button semantics, so besides the
 * semantic controls it is found BY ITS MODEL NAME (collectModelNamedControls). A
 * community DOM reference also names the control directly
 * (`flow-base-prompt-box div.submit-controls button.settings-trigger-button`): a
 * button whose class says "settings trigger" is accepted IN REGION as a candidate,
 * never trusted blindly — the menu validation still rejects a wrong menu.
 *
 * When the found element is only the visible LABEL (a child of the real button), it
 * is resolved to the control (resolveInteractiveControl) so the click lands on the
 * element that opens the menu, and the label is kept for messages.
 *
 * Outside the prompt region the search accepts ONLY model-named controls: a generic
 * popup elsewhere on the page (a toolbar gear, a view switcher) is not verified to
 * open the generation settings, and clicking one reads a different menu — which is
 * how an unrelated option can be mistaken for the model.
 */
export function findSettingsTrigger(doc, promptEl) {
  return findSettingsTriggerCandidates(doc, promptEl)[0] ?? null;
}

/**
 * Every plausible settings trigger, best first.
 *
 * Measured live (2026-10-09): the top-ranked control named "Settings trigger" opened
 * Flow's MEDIA LIBRARY filter menu (All media, Images, Characters, Scenes, Uploads,
 * Tools) — not the generation settings. A single best guess is therefore not enough:
 * the caller opens candidates in order and keeps the one whose menu really is the
 * generation menu, instead of failing the scene on the first wrong menu.
 *
 * Ranking puts the composer's MODEL CHIP first, because that is the control Google's
 * own help names ("in the prompt box, click the model name").
 */
export function findSettingsTriggerCandidates(doc, promptEl, { limit = 4 } = {}) {
  const region = findPromptRegion(promptEl) ?? doc;
  // The ACTIVE composer wins: in Agent mode the classic composer is hidden and the
  // prompt box may be found in the Agent composer, whose controls do not open the
  // generation settings. Search the visible classic composer first, then the prompt's
  // own region, then the document (model-named interactive controls only).
  const activeHost = findActiveComposerHost(doc);
  const scopes = [];
  if (activeHost?.visible) scopes.push(activeHost.el ?? null);
  scopes.push(region);
  const seenScopes = new Set();
  const regionControls = [];
  for (const scope of scopes) {
    if (!scope || seenScopes.has(scope)) continue;
    seenScopes.add(scope);
    for (const control of deepControlsWithin(scope)) regionControls.push(control);
  }
  const inRegionList = [
    ...regionControls.map((el) => ({ el, rank: settingsTriggerRank(el) })),
    // The community reference's shape: a button whose class names it as the settings trigger.
    ...regionControls
      .filter((el) => el.tagName === 'BUTTON' && /settings(-trigger|-button)?/i.test(el.getAttribute('class') ?? ''))
      .map((el) => ({ el, rank: 3, named: 'settings-class' })),
    ...collectHosts(region, 1),
    // The model chip outranks every other in-region candidate: it is the control
    // Flow's own help tells you to click, and it was the one that worked live.
    ...collectModelNamedControls(region).map((item) => ({ ...item, rank: Math.max(item.rank ?? 0, 4) })),
  ].filter((item) => item.rank >= 1);
  // Document-wide fallback: model-named controls only, and only interactive ones —
  // a model name in a project-card title must never be clicked.
  const docList = collectModelNamedControls(doc, { interactiveOnly: true });
  // One element can be collected twice (semantic control AND model-named): dedupe by element.
  const seen = new Set();
  const all = [...inRegionList, ...docList].filter((item) => {
    if (seen.has(item.el)) return false;
    seen.add(item.el);
    return true;
  });
  const ambiguous = isAmbiguous(all);
  const ordered = [...all].sort((a, b) => b.rank - a.rank);
  const out = [];
  const seenControls = new Set();
  for (const found of ordered) {
    if (out.length >= limit) break;
    const inRegion = inRegionList.some((item) => item.el === found.el);
    const opensPopup = found.el.hasAttribute('aria-haspopup') || found.el.hasAttribute('aria-expanded');
    const base = opensPopup ? 'settings-trigger-aria-haspopup' : 'settings-trigger-by-name';
    const named = found.name && !opensPopup ? 'settings-trigger-model-name' : base;
    const strategy = inRegion ? named : `${named}-in-document`;
    // The visible label is often a child of the real button: click the control, keep the label.
    const resolved = resolveInteractiveControl(found.el);
    const control = resolved?.el ?? found.el;
    // Two labels can resolve to the SAME button: clicking it twice would only retry
    // the identical menu, so each control appears once.
    if (seenControls.has(control)) continue;
    seenControls.add(control);
    out.push({
      el: control,
      label: found.name ?? accessibleName(found.el) ?? controlLabel(found.el),
      control: {
        el: control,
        tag: control.tagName.toLowerCase(),
        classes: (control.getAttribute('class') ?? '').slice(0, 80),
        via: resolved?.via ?? 'self',
      },
      foundElement: { tag: found.el.tagName.toLowerCase(), classes: (found.el.getAttribute('class') ?? '').slice(0, 80), interactive: isRealControl(found.el) },
      strategy,
      rank: found.rank,
      ambiguous,
    });
  }
  return out;
}

/** Find the settings trigger, waiting a bounded time for Flow's asynchronous UI to render it. */
export async function findSettingsTriggerWhenReady(doc, promptEl, { timeoutMs = 2000, intervalMs = 150, sleep } = {}) {
  return waitForValue(() => findSettingsTrigger(doc, promptEl), { timeoutMs, intervalMs, sleep });
}

/** Find the prompt composer, waiting a bounded time for Flow's asynchronous UI to render it. */
export async function findPromptBoxWhenReady(doc, { timeoutMs = 2500, intervalMs = 150, sleep } = {}) {
  return waitForValue(() => findPromptBox(doc), { timeoutMs, intervalMs, sleep });
}

/**
 * Parse the model chip's text. Flow's chip concatenates the current model, the
 * aspect ratio and the output count — e.g. "🍌 Nano Banana 2.1 crop_16_9 x1" — so
 * the chip alone is the ground truth for three settings, read without opening
 * any menu and without hardcoding a single model name.
 *
 * @returns {{model: string|null, aspectRatio: string|null, outputs: string|null}}
 */
export function parseModelChip(text) {
  const raw = normalizeText(text);
  if (!raw) return { model: null, aspectRatio: null, outputs: null };
  const aspect = raw.match(ASPECT_IN_CHIP);
  const outputs = raw.match(OUTPUTS_IN_CHIP);
  // The model name is everything before the earliest settings token.
  let end = raw.length;
  for (const match of [aspect, outputs]) {
    if (match && match.index < end) end = match.index;
  }
  // Strip decoration (emoji, chevrons, separators) from the ends; keep inner dots ("2.1").
  const model = raw
    .slice(0, end)
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/[^A-Za-z0-9.]+$/, '')
    .trim();
  return {
    model: model || null,
    aspectRatio: aspect ? `${aspect[1]}:${aspect[2]}` : null,
    outputs: outputs ? `x${outputs[1]}` : null,
  };
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

/** A short, clone-safe description of an element for diagnostics: tag, classes, role, name. */
function describeElement(el) {
  if (!el) return null;
  const rect = el.getBoundingClientRect?.();
  return {
    tag: el.tagName.toLowerCase(),
    classes: (el.getAttribute('class') ?? '').slice(0, 80),
    role: el.getAttribute('role') ?? '',
    name: (accessibleName(el) || controlLabel(el) || '').slice(0, 60),
    rect: rect && (rect.width || rect.height) ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : null,
  };
}

/** Custom-element (flow-*) ancestors of an element, crossing shadow hosts, bounded. */
function customAncestorsOf(el, limit = 6) {
  const out = [];
  let node = el;
  for (let level = 0; node && out.length < limit; level += 1) {
    let parent = node.parentElement;
    if (!parent) {
      const root = node.getRootNode?.();
      parent = root && root.host ? root.host : null;
    }
    if (!parent) break;
    if (parent.tagName.includes('-')) out.push(parent.tagName.toLowerCase());
    node = parent;
  }
  return out;
}

/** The Agent-mode chip's state for diagnostics: found / pressed / visible / enabled. */
function chipState(doc) {
  const chip = findAgentModeChip(doc);
  return chip ? { exists: true, pressed: chip.pressed, visible: chip.visible, enabled: chip.enabled, name: chip.name } : { exists: false, pressed: false, visible: false, enabled: false, name: '' };
}

/**
 * Inspect the settings trigger for the "Check Flow page" report: whether the expected
 * settings button exists (the community reference's shape, as a CANDIDATE), the actual
 * control's tag/classes/name/rect, whether it is visible, enabled, connected, inside the
 * composer, associated with the visible model chip, and what covers it at its centre.
 */
export function inspectSettingsTrigger(doc, promptEl) {
  const region = findPromptRegion(promptEl) ?? doc;
  const trigger = findSettingsTrigger(doc, promptEl);
  const chip = promptEl ? findDetectedSettings(doc, promptEl) : { model: null };
  const control = trigger?.el ?? null;
  const hosts = findComposerHosts(doc);
  const report = {
    found: Boolean(trigger),
    strategy: trigger?.strategy ?? null,
    ambiguous: trigger?.ambiguous ?? null,
    label: trigger?.label ?? null,
    control: null,
    expectedButton: null,
    associatedWithChip: null,
    coveredBy: null,
    customAncestors: control ? customAncestorsOf(control) : [],
    composer: hosts.classic?.visible ? 'classic' : hosts.agent?.visible ? 'agent' : null,
    composerHosts: composerHostSummaries(hosts),
    agentChip: chipState(doc),
    settingsButton: findSettingsTriggerButton(doc),
  };
  if (control) {
    const rect = control.getBoundingClientRect?.();
    const cx = rect ? Math.round(rect.x + rect.width / 2) : 0;
    const cy = rect ? Math.round(rect.y + rect.height / 2) : 0;
    let coveredBy = null;
    if (rect && rect.width && rect.height && doc.elementFromPoint) {
      const top = doc.elementFromPoint(cx, cy);
      if (top && top !== control && !control.contains(top) && !(top.shadowRoot && control.getRootNode() === top.shadowRoot)) {
        coveredBy = describeElement(top);
      }
    }
    report.control = {
      ...describeElement(control),
      visible: isVisible(control),
      enabled: !isDisabled(control),
      connected: control.isConnected,
      inComposer: Boolean(region && region !== doc && region.contains(control)),
      via: trigger.control?.via ?? 'self',
    };
    report.coveredBy = coveredBy;
    // Associated with the chip: the control's composed subtree shows the chip's model.
    const subtreeText = normalizeText(control.textContent ?? '');
    report.associatedWithChip = chip.model ? subtreeText.toLowerCase().includes(chip.model.toLowerCase()) : null;
  }
  // The community reference's candidate: a button whose class names it as the settings
  // trigger, inside the composer. Reported as a candidate, never trusted blindly.
  const candidate = deepControlsWithin(region).find(
    (el) => el.tagName === 'BUTTON' && /settings(-trigger|-button)?/i.test(el.getAttribute('class') ?? ''),
  );
  report.expectedButton = candidate ? { ...describeElement(candidate), exists: true, visible: isVisible(candidate), enabled: !isDisabled(candidate) } : { exists: false };
  return report;
}

/**
 * A bounded, clone-safe signature of everything menu-like in the document (and its
 * shadow roots): role-based surfaces, Flow-named custom elements, and visible rows
 * that classify as generation settings. Used to diff the DOM before and after a click,
 * so a menu that opened without any recognised role still shows up as a change.
 */
export function snapshotMenuish(doc, { chipModel = null, cap = 60 } = {}) {
  const entries = new Set();
  const add = (text) => {
    if (entries.size < cap) entries.add(text);
  };
  for (const scope of collectMenuScopes(doc)) {
    for (const el of scope.querySelectorAll(MENU_SELECTOR)) {
      if (isVisible(el)) add(`surface:${describeElement(el)?.tag}.${(el.getAttribute('class') ?? '').slice(0, 40)}`);
    }
    for (const el of scope.querySelectorAll('*')) {
      if (entries.size >= cap) break;
      const tag = el.tagName.toLowerCase();
      const cls = el.getAttribute('class') ?? '';
      if ((tag.includes('menu') || tag.includes('popover') || /menu|popover|settings/i.test(cls)) && isVisible(el)) {
        add(`flow:${tag}.${cls.slice(0, 40)}`);
      }
    }
  }
  // Visible setting rows anywhere (the menu's content, wherever it lives).
  for (const scope of collectMenuScopes(doc)) {
    const walker = (scope.ownerDocument ?? scope).createTreeWalker(scope, 1);
    let scanned = 0;
    let node = walker.nextNode();
    while (node && scanned < 2500 && entries.size < cap) {
      scanned += 1;
      if (isVisible(node)) {
        const own = normalizeText(ownText(node));
        if (own.length >= 2 && own.length <= 40 && /[A-Za-z0-9]/.test(own) && !node.querySelector('*')) {
          if (classifySettingOption({ name: own, group: null }, { chipModel })) add(`row:${own}`);
        }
      }
      node = walker.nextNode();
    }
  }
  return Array.from(entries).sort();
}

/** The entries added/removed between two snapshots (the DOM change a click caused). */
export function diffSignatures(before, after) {
  const beforeSet = new Set(before ?? []);
  const afterSet = new Set(after ?? []);
  return {
    added: Array.from(afterSet).filter((entry) => !beforeSet.has(entry)),
    removed: Array.from(beforeSet).filter((entry) => !afterSet.has(entry)),
  };
}

/** The model chip's raw text ("🍌 Nano Banana 2.1 crop_16_9 x1"), or null when no chip is identifiable. */
/** Tokens that only a settings chip carries: an aspect ("crop_16_9", "16:9") or a count ("x1"). */
const CHIP_SETTINGS_TOKEN = /(?:^|\s)(?:[a-z]+_)?\d{1,2}\s*[_:x\u00d7]\s*\d{1,2}(?=\s|$)|\bx\s?\d{1,2}\b/i;

/**
 * The text of the composer's settings chip.
 *
 * Measured on the live page (2026-10-09): Flow's trigger is
 * `<button aria-label="Settings trigger"><span>\u{1F34C} Nano Banana 2.1 crop_16_9 x1</span></button>`.
 * The accessible name is therefore the name of the CONTROL, not the value it shows,
 * and reading it made the extension report the model as "Settings trigger".
 *
 * So the candidates (the button's own text and its accessible name) are ranked by
 * evidence: a text carrying a settings token (aspect/count) is the chip's value, a
 * text carrying a known model family is next, and a bare control name is used only
 * when nothing better exists. Nothing is hardcoded to one model.
 */
function chipLabel(el) {
  const aria = normalizeText(el.getAttribute?.('aria-label') ?? '');
  const text = normalizeText(el.textContent ?? '').slice(0, 160);
  const score = (value) => (!value ? -1 : CHIP_SETTINGS_TOKEN.test(value) ? 2 : MODEL_NAME.test(value) ? 1 : 0);
  const best = [text, aria, controlLabel(el)].reduce(
    (winner, value) => (score(value) > score(winner) ? value : winner),
    '',
  );
  return best || controlLabel(el);
}

export function findModelChipText(doc, promptEl) {
  const region = findPromptRegion(promptEl) ?? doc;
  const chipEls = new Set();
  const trigger = findSettingsTrigger(doc, promptEl);
  if (trigger) chipEls.add(trigger.el);
  for (const item of collectModelNamedControls(region)) chipEls.add(item.el);
  let fallback = null;
  for (const el of chipEls) {
    const text = chipLabel(el);
    if (!text) continue;
    // A text that carries the chip's own settings tokens is the chip; a bare
    // control name ("Settings trigger") is only used when nothing better exists.
    if (CHIP_SETTINGS_TOKEN.test(text) || MODEL_NAME.test(text)) return text;
    fallback = fallback ?? text;
  }
  if (fallback) return fallback;
  return null;
}

/**
 * The current Mode / Model / Aspect ratio / output count as shown by the composer's
 * own controls, when identifiable. The model chip is the ground truth: Flow's chip
 * concatenates model, ratio and output count ("🍌 Nano Banana 2.1 crop_16_9 x1"),
 * so parseModelChip reads three settings from it without opening any menu. The chip
 * may be a plain element (no button semantics), so it is collected by name and also
 * considered as the settings trigger's own text.
 */
export function findDetectedSettings(doc, promptEl) {
  const region = findPromptRegion(promptEl) ?? doc;
  let model = null;
  let aspectRatio = null;
  let mode = null;
  let outputs = null;
  // 1) The chip: parse its full text (model + aspect ratio + output count).
  const chipEls = new Set();
  const trigger = findSettingsTrigger(doc, promptEl);
  if (trigger) chipEls.add(trigger.el);
  for (const item of collectModelNamedControls(region)) chipEls.add(item.el);
  for (const el of chipEls) {
    const label = chipLabel(el);
    const parsed = parseModelChip(label);
    // A control name with no settings token and no model name is NOT a model value
    // ("Settings trigger" must never be reported as the model).
    const namesAModel = CHIP_SETTINGS_TOKEN.test(label) || MODEL_NAME.test(label);
    if (!model && parsed.model && namesAModel) model = parsed.model;
    if (!aspectRatio && parsed.aspectRatio) aspectRatio = parsed.aspectRatio;
    if (!outputs && parsed.outputs) outputs = parsed.outputs;
  }
  // 2) Semantic controls (a labelled aspect chip, a mode chip, an outputs chip).
  for (const el of visibleControlsWithin(region)) {
    const name = accessibleName(el);
    if (!name) continue;
    if (!model && MODEL_NAME.test(name)) {
      // The model-name control shows the active model ("Nano Banana Pro \u25be").
      model = parseModelChip(name).model ?? model;
    }
    if (!aspectRatio && ASPECT_RATIO_TEXT.test(name)) aspectRatio = name;
    if (!mode && MODE_NAME.test(name)) mode = name;
    if (!outputs && OUTPUT_TEXT.test(name)) outputs = normalizeText(name);
  }
  return { mode, model, aspectRatio, outputs };
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
  // The model chip (and any mode/aspect chip) may be a plain element with no
  // semantics: list it by name so the report shows the real settings controls.
  if (out.length < limit) {
    const named = [
      ...collectModelNamedControls(region, { limit: limit - out.length }),
      ...collectNamedControlsBy(region, [ASPECT_RATIO_TEXT, MODE_NAME], limit - out.length),
    ];
    for (const item of named) push(item.el);
  }
  // Custom-element hosts (shadow DOM) are not matched by CONTROL_SELECTOR; list them too.
  if (out.length < limit) {
    for (const el of region.querySelectorAll('*')) {
      if (out.length >= limit) break;
      if (el.tagName.includes('-') && isVisible(el)) push(el);
    }
  }
  return out;
}

/**
 * A read-only map of the composer area, for the "Check Flow page" report when the
 * prompt box is NOT found: the model chip and its ancestor chain, every text-entry
 * shape in the chip's region, the interactive controls there, document-wide
 * generate-button candidates, and the custom-element hosts that can hide a shadow
 * DOM. No element and no text content crosses the message boundary — the composer's
 * text IS the user's prompt — only tags, roles, labels and geometry.
 */
export function inspectComposerArea(doc) {
  const chip = collectModelNamedControls(doc, { limit: 4 })[0] ?? null;
  const area = {
    chip: null,
    chipChain: [],
    regionFields: [],
    regionControls: [],
    generateCandidates: [],
    shadowHosts: [],
    composerHosts: composerHostSummaries(findComposerHosts(doc)),
    agentChip: null,
    settingsButton: null,
  };
  const chipState = findAgentModeChip(doc);
  if (chipState) {
    area.agentChip = { exists: true, pressed: chipState.pressed, visible: chipState.visible, enabled: chipState.enabled, name: chipState.name };
  }
  area.settingsButton = findSettingsTriggerButton(doc);
  if (chip) {
    const rect = chip.el.getBoundingClientRect?.();
    area.chip = {
      tag: chip.el.tagName.toLowerCase(),
      role: chip.el.getAttribute('role') ?? '',
      name: chip.name.slice(0, 60),
      rect: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } : null,
    };
    area.chipChain = composerAncestors(chip.el, 10).map((el) => ({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') ?? '',
      label: normalizeText(el.getAttribute('aria-label') ?? '').slice(0, 40),
      childTags: Array.from(new Set(Array.from(el.children).map((child) => child.tagName.toLowerCase()))).slice(0, 12).join(','),
    }));
    // Text fields can live inside a custom element's shadow root (Flow's composer is
    // built from flow-* elements), and the chip's own region may be a sibling strip
    // (submit-controls) rather than the whole composer: scan the chip's ancestor
    // chain and one shadow level of each custom host, deduped and bounded.
    const fields = [];
    const seenFields = new Set();
    const addFields = (root) => {
      for (const field of root.querySelectorAll(TEXT_FIELD_SELECTOR)) {
        if (!seenFields.has(field) && fields.length < 12) {
          seenFields.add(field);
          fields.push(field);
        }
      }
    };
    for (const ancestor of composerAncestors(chip.el, 6)) {
      if (fields.length >= 12) break;
      addFields(ancestor);
      for (const el of ancestor.querySelectorAll('*')) {
        if (fields.length >= 12) break;
        if (el.tagName.includes('-') && el.shadowRoot) addFields(el.shadowRoot);
      }
    }
    if (fields.length < 12) addFields(doc);
    for (const el of fields) {
      const r = el.getBoundingClientRect?.();
      area.regionFields.push({
        tag: el.tagName.toLowerCase(),
        classes: (el.getAttribute('class') ?? '').slice(0, 60),
        customAncestors: customAncestorsOf(el, 4),
        role: el.getAttribute('role') ?? '',
        kind: candidateKind(el),
        name: fieldLabel(el).slice(0, 40),
        readonly: el.hasAttribute('readonly'),
        disabled: isDisabled(el),
        visible: isVisible(el),
        rect: r ? { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) } : null,
      });
    }
    for (const control of listPromptControls(doc, chip.el, 12)) {
      area.regionControls.push(control);
    }
  }
  // Generate candidates anywhere in the document AND its shadow roots (Flow's icon
  // button lives inside flow-generate-icon-button's shadow root).
  const buttons = [];
  const seenButtons = new Set();
  for (const scope of collectMenuScopes(doc)) {
    for (const button of scope.querySelectorAll('button, [role="button"]')) {
      if (!seenButtons.has(button) && buttons.length < 12) {
        seenButtons.add(button);
        buttons.push(button);
      }
    }
  }
  for (const button of buttons) {
    area.generateCandidates.push({
      tag: button.tagName.toLowerCase(),
      classes: (button.getAttribute('class') ?? '').slice(0, 60),
      customAncestors: customAncestorsOf(button, 4),
      name: accessibleName(button).slice(0, 40),
      title: (button.getAttribute('title') ?? '').slice(0, 40),
      labelled: Boolean(GENERATE_NAME.test(accessibleName(button)) || SEND_NAME.test(accessibleName(button)) || GO_ICON_NAME.test(accessibleName(button)) || /generate/i.test(button.getAttribute('class') ?? '')),
    });
  }
  const hosts = [];
  for (const el of doc.querySelectorAll('*')) {
    if (hosts.length >= 12) break;
    if (el.tagName.includes('-') && el.shadowRoot) hosts.push({ tag: el.tagName.toLowerCase() });
  }
  area.shadowHosts = hosts;
  return area;
}

/** Visible elements whose accessible name matches any of `patterns` (bounded walk). */
function collectNamedControlsBy(scope, patterns, limit) {
  const out = [];
  const seen = new Set();
  const walker = (scope.ownerDocument ?? scope).createTreeWalker(scope, 1);
  let scanned = 0;
  let current = walker.nextNode();
  while (current && scanned < 1500 && out.length < limit) {
    scanned += 1;
    if (seen.has(current)) {
      current = walker.nextNode();
      continue;
    }
    seen.add(current);
    if (!isVisible(current)) {
      current = walker.nextNode();
      continue;
    }
    const name = accessibleName(current);
    if (name && patterns.some((pattern) => pattern.test(name))) out.push({ el: current, rank: 1, name });
    current = walker.nextNode();
  }
  return out;
}

/**
 * Shadow roots reachable from `doc`, up to three levels deep, bounded. Flow renders
 * its composer AND its settings menu inside custom elements (flow-base-prompt-box,
 * flow-rich-text-editor, …), and the menu can be two shadow levels down or in a
 * portal at the document body — a one-level walk misses it and reports "did not open"
 * for a menu that IS open.
 */
function collectMenuScopes(doc, { levels = 3, scopeCap = 12, scanCap = 4000 } = {}) {
  // Only a Document or a ShadowRoot can be walked: a wrapper object would throw
  // deep inside the walk, far from the caller that passed it.
  if (!doc || typeof doc.querySelectorAll !== 'function' || typeof (doc.ownerDocument ?? doc).createTreeWalker !== 'function') return [];
  const scopes = [doc];
  const walk = (root, depth) => {
    if (scopes.length >= scopeCap || depth >= levels) return;
    const walker = (root.ownerDocument ?? root).createTreeWalker(root, 1);
    let scanned = 0;
    let current = walker.nextNode();
    while (current && scanned < scanCap && scopes.length < scopeCap) {
      scanned += 1;
      if (current.tagName.includes('-') && current.shadowRoot) {
        scopes.push(current.shadowRoot);
        walk(current.shadowRoot, depth + 1);
      }
      current = walker.nextNode();
    }
  };
  walk(doc, 0);
  return scopes;
}

/**
 * The menu that is open now. Detection is deliberately wider than POPOVER_SELECTOR:
 * a menu surface without ARIA roles must still be found, or a menu that DID open is
 * reported as "did not open". Matches that contain the composer are not menus (the
 * composer is not inside its own menu), and a real menu/listbox beats a dialog or a
 * bare open-state wrapper when several match.
 *
 * @param {Document} doc
 * @param {{exclude?: Element|null}} [options] `exclude`: the composer; matches containing it are skipped.
 */
export function findOpenPopover(doc, { exclude = null } = {}) {
  const all = collectOpenMenus(doc, { exclude });
  const menus = all.filter((item) => item.isMenu);
  const pool = menus.length ? menus : all;
  return pool.length ? pool[pool.length - 1].el : null;
}

/** What a surface shows right now, used to tell "already open" from "just opened". */
export function surfaceSignature(el) {
  return normalizeText(el.textContent ?? '').slice(0, 200);
}

/**
 * A read-only description of every menu-ish surface currently open: what it is,
 * where it lives and the first rows it shows. This is the evidence needed to tell
 * "the menu never opened" from "a different surface was read as the menu".
 */
export function inspectMenuSurfaces(doc, promptEl = null) {
  const out = [];
  for (const scope of collectMenuScopes(doc)) {
    for (const el of scope.querySelectorAll(MENU_SELECTOR)) {
      if (!isVisible(el)) continue;
      if (out.length >= 10) break;
      const rows = [];
      for (const node of el.querySelectorAll('*')) {
        if (rows.length >= 6) break;
        if (!isVisible(node) || node.querySelector('*')) continue;
        const text = normalizeText(ownText(node));
        if (text && text.length <= 40 && !rows.includes(text)) rows.push(text);
      }
      out.push({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') ?? null,
        classes: (el.getAttribute('class') ?? '').slice(0, 60),
        status: isStatusSurface(el),
        inOverlay: Boolean(el.closest?.('.cdk-overlay-container, .cdk-overlay-pane')),
        inComposer: Boolean(promptEl && findPromptRegion(promptEl)?.contains(el)),
        rows,
      });
    }
  }
  return out;
}

/** Snapshot of the surfaces open BEFORE a trigger is clicked: element -> content. */
export function snapshotOpenMenus(doc, { exclude = null } = {}) {
  const map = new Map();
  for (const item of collectOpenMenus(doc, { exclude })) map.set(item.el, surfaceSignature(item.el));
  return map;
}

/**
 * A transient status surface (snackbar / toast / live region), never a menu.
 * Measured live: Flow's undo snackbar after deleting items was picked up as the
 * "menu that opened" and its buttons were read as settings options.
 */
export function isStatusSurface(el) {
  const role = el.getAttribute('role');
  if (role === 'status' || role === 'alert' || role === 'log' || role === 'marquee' || role === 'timer') return true;
  if (el.hasAttribute('aria-live')) return true;
  const tag = el.tagName.toLowerCase();
  const classes = el.getAttribute('class') ?? '';
  if (/snack-?bar|toast/i.test(tag) || /snack-?bar|toast/i.test(classes)) return true;
  return Boolean(el.closest?.('[role="status"], [role="alert"], [aria-live], mat-snack-bar-container, .mat-mdc-snack-bar-container'));
}

/**
 * Every open menu surface, in document order, as `{ el, isMenu }`. A real menu or
 * listbox beats a bare open-state wrapper or a dialog when several match.
 */
export function collectOpenMenus(doc, { exclude = null, ignore = null } = {}) {
  const out = [];
  for (const scope of collectMenuScopes(doc)) {
    for (const el of scope.querySelectorAll(MENU_SELECTOR)) {
      if (!isVisible(el)) continue;
      if (exclude && (el === exclude || el.contains(exclude))) continue;
      // A status surface is never a menu. Measured live: Flow's "6 items moved to
      // bin / Undo / View in bin / Dismiss" snackbar was read as the settings menu.
      if (isStatusSurface(el)) continue;
      // A surface that was already open before the trigger was clicked, AND still
      // shows exactly the same content, cannot be the menu the click opened (live:
      // the media library filter rail). A persistent overlay CONTAINER whose content
      // changed is still a candidate, which is how portal menus render.
      if (ignore && ignore.get(el) === surfaceSignature(el)) continue;
      const role = el.getAttribute('role');
      out.push({ el, isMenu: role === 'menu' || role === 'listbox' });
    }
  }
  return out;
}

/**
 * The menu surface that a click just opened: every open surface except `previous`
 * itself, its ancestors, and the composer. Nested submenus (Flow's "Select model
 * family") appear either beside the parent menu or inside it; surfaces outside the
 * previous menu win, otherwise the last surface inside it. Content-based surfaces
 * (a role-less menu) are included: a menu Flow renders without ARIA roles must not
 * be invisible to the reader.
 */
export function pickNewMenuSurface(doc, previous, promptEl = null, { chipModel = null, ignore = null } = {}) {
  const candidates = collectOpenMenus(doc, { ignore }).filter(({ el }) => {
    if (previous && (el === previous || el.contains(previous))) return false;
    if (promptEl && (el === promptEl || el.contains(promptEl))) return false;
    return true;
  });
  const outside = candidates.filter(({ el }) => !previous || !previous.contains(el));
  const menus = (outside.length ? outside : candidates).filter((item) => item.isMenu);
  const pool = menus.length ? menus : outside.length ? outside : candidates;
  if (pool.length) return pool[pool.length - 1].el;
  // Nothing role-based: fall back to a menu recognised by its CONTENT.
  return findSettingsMenuByContent(doc, { exclude: previous ?? promptEl, chipModel, ignore });
}

/**
 * Find Flow's generation-settings menu by WHAT IT SHOWS, not by its role. Flow's menu
 * can be a role-less custom element in a portal; the rows inside it are short labels
 * that classify as generation settings (Image/Video, aspect ratios, x-counts, the
 * model-list trigger). A container with at least three such rows spanning at least two
 * different settings is the menu; the smallest such container wins (the surface, not
 * a huge wrapper). The composer's own controls never qualify: its rows do not
 * classify as settings.
 */
export function findSettingsMenuByContent(doc, { exclude = null, chipModel = null, ignore = null } = {}) {
  const rows = [];
  for (const scope of collectMenuScopes(doc)) {
    const walker = (scope.ownerDocument ?? scope).createTreeWalker(scope, 1);
    let scanned = 0;
    let node = walker.nextNode();
    while (node && scanned < 3000 && rows.length < 200) {
      scanned += 1;
      if (!isVisible(node)) {
        node = walker.nextNode();
        continue;
      }
      const own = normalizeText(ownText(node));
      if (own.length >= 2 && own.length <= 40 && /[A-Za-z0-9]/.test(own) && !node.querySelector('*')) {
        const key = classifySettingOption({ name: own, group: null }, { chipModel });
        rows.push({ el: node, key });
      }
      node = walker.nextNode();
    }
  }
  // A container is the menu when it holds at least three short label rows and either
  // two different settings among them, or (for a nested list like the model menu,
  // whose rows only classify through the chip) at least one recognised row.
  const tally = new Map();
  for (const row of rows) {
    let node = row.el.parentElement;
    for (let level = 0; node && level < 8; level += 1) {
      if (exclude && (node === exclude || node.contains(exclude))) break;
      const entry = tally.get(node) ?? { keys: new Set(), rowish: 0, classified: 0 };
      entry.rowish += 1;
      if (row.key) {
        entry.keys.add(row.key);
        entry.classified += 1;
      }
      tally.set(node, entry);
      let parent = node.parentElement;
      if (!parent) {
        const root = node.getRootNode?.();
        parent = root && root.host ? root.host : null;
      }
      node = parent;
    }
  }
  let best = null;
  for (const [container, entry] of tally) {
    const qualifies = entry.rowish >= 3 && (entry.keys.size >= 2 || (chipModel && entry.classified >= 1));
    if (!qualifies) continue;
    // The tightest qualifying wrapper is the menu surface, not a portal ancestor.
    const size = countDescendants(container);
    if (!best || size < best.size || (size === best.size && entry.rowish > best.entry.rowish)) {
      best = { container, entry, size };
    }
  }
  return best?.container ?? null;
}

/** Bounded descendant-element count (the tightness of a wrapper), capped. */
function countDescendants(el, cap = 500) {
  let count = 0;
  const walker = (el.ownerDocument ?? el).createTreeWalker(el, 1);
  let node = walker.nextNode();
  while (node && count < cap) {
    count += 1;
    node = walker.nextNode();
  }
  return count;
}

/**
 * The open generation-settings menu: role-based surfaces first (a real menu or
 * listbox beats a bare wrapper), then a menu recognised by its content. Portals and
 * overlay containers anywhere in the document (and inside shadow roots) are searched.
 */
/**
 * Overlay backdrops that are still on the page.
 *
 * Angular CDK (which Flow's composer menu uses — `div.cdk-overlay-popover` was
 * measured on the live page) lays a full-page backdrop over everything while a menu
 * is open, and closes the menu when that backdrop is pressed. If one is left behind,
 * the next press on the trigger both closes the old overlay and opens the new one,
 * so the net DOM change is nothing and the menu never appears — exactly the
 * "the click changed nothing visible in the DOM" failure. They are detected so they
 * can be waited out, never removed: the extension does not mutate Flow's DOM.
 */
export function findOverlayBackdrops(doc) {
  const found = [];
  for (const scope of collectMenuScopes(doc)) {
    for (const el of scope.querySelectorAll('.cdk-overlay-backdrop, [class*="overlay-backdrop"]')) {
      if (isVisible(el) && !found.includes(el)) found.push(el);
    }
  }
  return found;
}

/** True when the control reports an open menu through ARIA. */
export function isExpanded(el) {
  return el?.getAttribute?.('aria-expanded') === 'true';
}

export function findSettingsMenu(doc, { exclude = null, chipModel = null, ignore = null } = {}) {
  const all = collectOpenMenus(doc, { exclude, ignore });
  const menus = all.filter((item) => item.isMenu);
  const pool = menus.length ? menus : all;
  if (pool.length) return pool[pool.length - 1].el;
  return findSettingsMenuByContent(doc, { exclude, chipModel, ignore });
}

/**
 * Options inside a popover, with the heading that introduced each group (Mode, Model,
 * Aspect ratio...). Structure-agnostic on purpose: Flow's menu rows are sometimes
 * plain elements with no ARIA role at all, and a reader that only accepted
 * role="menuitem*" found NOTHING in the real menu — which made the real
 * generation-settings menu look like the wrong menu. An option is any visible
 * interactive element with an accessible name, or any visible element whose OWN
 * text (never an aggregate of its children) is short enough to be a label.
 *
 * Each option also reports `submenu`: the item opens another menu (e.g. Flow's
 * "Select model family"), which the reader must inspect before choosing a model.
 */
/**
 * Is this element an icon rather than a label? Icon fonts put their ligature in the
 * element's text, so the text alone cannot tell them apart — the element does:
 * <mat-icon>, a material/google-symbols class, or anything marked role="img" /
 * aria-hidden. Flow's own menu rows carry their label in a sibling element.
 */
function isIconElement(el) {
  if (el.tagName === 'MAT-ICON' || el.tagName === 'I') return true;
  if (el.getAttribute('role') === 'img') return true;
  if (el.getAttribute('aria-hidden') === 'true' && !el.matches(INTERACTIVE_SELECTOR)) return true;
  const classes = el.getAttribute('class') ?? '';
  return /\b(material-symbols|material-icons|google-symbols|mat-icon)\b/.test(classes);
}

export function readPopoverOptions(popover) {
  const options = [];
  const seen = new Set();
  const nodes = [];
  const walker = popover.ownerDocument.createTreeWalker(popover, 1);
  let node = walker.currentNode;
  while (node) {
    nodes.push(node);
    node = walker.nextNode();
  }
  let currentGroup = null;
  for (const el of nodes) {
    if (el === popover || !isVisible(el)) continue;
    // A material-symbol ligature renders as text ("image", "crop_16_9", "check"):
    // it is the PICTURE next to an option, never an option. Reading it as one made
    // the apply step click an icon and then find nothing to confirm.
    if (isIconElement(el)) continue;
    const role = el.getAttribute('role');
    const isHeading = role === 'heading' || el.tagName === 'H2' || el.tagName === 'H3' || el.tagName === 'H4' || role === 'group';
    if (isHeading) {
      const label = normalizeText(el.getAttribute('aria-label') || ownText(el) || el.textContent);
      if (label && label.length <= 40) currentGroup = label;
      continue;
    }
    const interactive = el.matches(OPTION_SELECTOR) || el.matches(INTERACTIVE_SELECTOR);
    const own = normalizeText(ownText(el));
    const name = (interactive ? accessibleName(el) : own) || '';
    // A pure wrapper (no own text, not interactive) is not an option; its children are.
    // A name with no letter or digit is decoration (a chevron span), not an option.
    if (!name || name.length > 60 || (!own && !interactive) || !/[A-Za-z0-9]/.test(name)) continue;
    const key = `${currentGroup ?? ''}|${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    options.push({
      el,
      name: normalizeText(name)
        .replace(/\s*(check|done)\s*$/i, '')
        .replace(/[\s\u203a\u00bb\u2039\u25b8\u2032>]+$/, ''),
      group: currentGroup,
      selected: isSelectedWithin(el, popover),
      submenu: el.hasAttribute('aria-haspopup') || el.getAttribute('aria-expanded') != null,
    });
  }
  return options;
}

/**
 * Selected state, looking at the element and its ancestors up to the menu surface:
 * Flow marks the row (aria-checked on a wrapper), not always the innermost label.
 */
function isSelectedWithin(el, boundary) {
  let node = el;
  while (node && node !== boundary) {
    if (isSelected(node)) return true;
    node = node.parentElement;
  }
  return false;
}

export function isSelected(node) {
  if (node.getAttribute('aria-selected') === 'true') return true;
  if (node.getAttribute('aria-checked') === 'true') return true;
  if (node.getAttribute('aria-pressed') === 'true') return true;
  if (node.getAttribute('aria-current') === 'true') return true;
  if (node.getAttribute('data-state') === 'checked' || node.getAttribute('data-state') === 'active') return true;
  return false;
}

/** Classify a settings option by its group heading first, then by shape. */
/**
 * Classify a settings option by its group heading first, then by shape. An option
 * with no positive evidence is UNKNOWN (null) — never guessed as a model: the old
 * default classified any unrecognised option (a view option like "dashboardGrid"
 * in an unrelated menu) as the model, and the panel displayed it as Flow's model.
 *
 * Recognised keys: mode, model, aspectRatio, outputs. "Select model family" is the
 * model list's SUBMENU trigger, not a model itself: it counts as model evidence (the
 * menu IS the generation settings) but is never reported as the current model.
 *
 * `chipModel` is the model the composer's own chip displays. An option showing the
 * same name is the model even when the menu has no "Model" heading — that is how a
 * heading-less model list is still recognised without hardcoding model names.
 */
export function classifySettingOption(option, { chipModel = null } = {}) {
  const group = (option.group || '').toLowerCase();
  const name = option.name;
  if (/aspect|ratio/.test(group) || ASPECT_RATIO_TEXT.test(name)) return 'aspectRatio';
  if (/^mode$/.test(group) || /^(image|video)$/i.test(name)) return 'mode';
  if (/model/.test(group)) return 'model';
  if (chipModel && normalizeText(name).toLowerCase() === normalizeText(chipModel).toLowerCase()) return 'model';
  if (MODEL_SUBMENU_NAME.test(name)) return 'model';
  if (OUTPUT_TEXT.test(name)) return 'outputs';
  if (/^\d+$/.test(name) && /output|count|quantity|number/i.test(group)) return 'outputs';
  if (/output|count|length|duration|quantity/.test(group)) return null;
  return null;
}

/** True for the item that opens the (nested) model list rather than a model itself. */
export function isModelSubmenuTrigger(option) {
  return Boolean(option) && (option.submenu || MODEL_SUBMENU_NAME.test(option.name ?? ''));
}

/**
 * Flow's Agent-mode chip, found by its component class and state — never by a
 * translated label. Returns `{ el, pressed, visible, enabled, name }` or null.
 * `pressed` is read from `aria-pressed`, so the chip is only ever reported as
 * active when there is actually something to undo.
 */
export function findAgentModeChip(doc) {
  let best = null;
  for (const scope of collectMenuScopes(doc)) {
    for (const el of scope.querySelectorAll(AGENT_CHIP_SELECTOR)) {
      const chip = {
        el,
        pressed: el.getAttribute('aria-pressed') === 'true',
        visible: isVisible(el),
        enabled: !isDisabled(el),
        name: accessibleName(el).slice(0, 40),
      };
      if (!best || (chip.visible && !best.visible)) best = chip;
    }
  }
  return best;
}

/** True when the EXACT, state-guarded Agent-mode chip is pressed (something to undo). */
export function isAgentModeOn(doc) {
  for (const scope of collectMenuScopes(doc)) {
    if (scope.querySelector(AGENT_CHIP_PRESSED_SELECTOR)) return true;
  }
  return false;
}

/**
 * The composer custom elements and their visibility: the classic composer
 * (`flow-prompt-box` / `flow-base-prompt-box`) and the Agent-mode composer that
 * replaces it while the chip is pressed. Existence alone proves nothing —
 * visibility and dimensions are checked too.
 */
export function findComposerHosts(doc) {
  const find = (tags) => {
    for (const scope of collectMenuScopes(doc)) {
      for (const el of scope.querySelectorAll(tags.join(','))) {
        if (isVisible(el)) return { exists: true, visible: true, tag: el.tagName.toLowerCase(), el };
      }
    }
    for (const scope of collectMenuScopes(doc)) {
      for (const el of scope.querySelectorAll(tags.join(','))) {
        return { exists: true, visible: false, tag: el.tagName.toLowerCase(), el };
      }
    }
    return { exists: false, visible: false, tag: null, el: null };
  };
  return { classic: find(CLASSIC_COMPOSER_TAGS), agent: find([AGENT_COMPOSER_TAG]) };
}

/** Clone-safe composer-host summaries (no elements cross the message boundary). */
export function composerHostSummaries(hosts) {
  const map = (host) => (host ? { exists: host.exists, visible: host.visible, tag: host.tag } : null);
  return { classic: map(hosts?.classic), agent: map(hosts?.agent) };
}

/** The active composer: the classic one when visible, else the Agent-mode one. */
export function findActiveComposerHost(doc) {
  const hosts = findComposerHosts(doc);
  if (hosts.classic.visible) return { ...hosts.classic, kind: 'classic' };
  if (hosts.agent.visible) return { ...hosts.agent, kind: 'agent' };
  return null;
}

/**
 * The classic settings trigger button (`.settings-trigger-button`) and whether it
 * is hidden. In Agent mode it stays in the DOM with a bare `hidden` attribute
 * (display:none, 0x0) — present but impossible to interact with.
 */
/**
 * Which of the three known Flow composer states the page is in.
 *
 * This is a READ-ONLY classification made from measured facts (component tags,
 * the state-guarded agent chip, the classic trigger's visibility) so the next
 * action is chosen from evidence rather than from another selector guess:
 *
 * - `standard`  the classic composer and its settings trigger are usable.
 * - `A` recoverable migrated composer: a usable `button.agent-mode-chip[aria-pressed="true"]`
 *       exists and the classic `.settings-trigger-button` is present but hidden —
 *       turning Agent mode off is expected to restore the standard composer.
 * - `B` agent-only composer: the settings trigger is not usable, the only visible
 *       composer is `flow-creative-agent-prompt-box`, and there is no usable agent
 *       toggle to leave it. The classic automation cannot set those controls here.
 * - `C` something else: the standard composer is present but its control does not
 *       behave — inspect the control and the click, do not change selectors blindly.
 *
 * @returns {{state: 'standard'|'A'|'B'|'C', label: string, chip: object|null, settingsButton: object, composerHosts: object, activeComposer: string|null, evidence: string[]}}
 */
export function classifyComposerState(doc) {
  const hosts = findComposerHosts(doc);
  const chip = findAgentModeChip(doc);
  const button = findSettingsTriggerButton(doc);
  const active = findActiveComposerHost(doc);
  // The classic `.settings-trigger-button` is one shape of the trigger; the generic
  // resolver covers the composers that do not use that class. Either one being
  // usable means the standard automation has a control to drive.
  const resolved = findSettingsTrigger(doc, null);
  const triggerUsable = Boolean((button.exists && button.visible) || resolved);
  const chipUsable = Boolean(chip && chip.visible && chip.enabled);
  const evidence = [
    `agent chip: ${chip ? `found, aria-pressed=${chip.pressed}, ${chip.visible ? 'visible' : 'hidden'}, ${chip.enabled ? 'enabled' : 'disabled'}` : 'not found'}`,
    `.${SETTINGS_TRIGGER_CLASS}: ${button.exists ? (button.visible ? 'visible' : 'present but hidden') : 'absent'}`,
    `resolved settings trigger: ${resolved ? `found (${resolved.strategy})` : 'none'}`,
    `composer: classic ${hosts.classic.exists ? (hosts.classic.visible ? 'visible' : 'hidden') : 'absent'}, agent ${hosts.agent.exists ? (hosts.agent.visible ? 'visible' : 'hidden') : 'absent'}`,
  ];
  // Order matters: the classic trigger being visible is what makes a page standard.
  // A resolved trigger inside the AGENT composer is not that control (on the measured
  // migrated page it opens nothing), so Agent-mode states are classified first.
  const classicTriggerVisible = button.exists && button.visible;
  let state;
  if (!classicTriggerVisible && chipUsable && chip.pressed) state = 'A';
  else if (!classicTriggerVisible && !hosts.classic.visible && hosts.agent.visible && !chipUsable) state = 'B';
  else if (triggerUsable) state = 'standard';
  else state = 'C';
  const label = {
    standard: 'standard composer (a usable settings trigger is visible)',
    A: 'recoverable migrated composer (Agent mode is on; the classic trigger is hidden)',
    B: 'agent-only composer (no usable agent toggle; the classic trigger is not available)',
    C: 'standard composer with another cause (the trigger is not visible and Agent mode does not explain it)',
  }[state];
  return {
    state,
    label,
    chip: chip ? { pressed: chip.pressed, visible: chip.visible, enabled: chip.enabled, name: chip.name } : null,
    settingsButton: button,
    composerHosts: composerHostSummaries(hosts),
    activeComposer: active?.kind ?? null,
    evidence,
  };
}

export function findSettingsTriggerButton(doc) {
  for (const scope of collectMenuScopes(doc)) {
    for (const el of scope.querySelectorAll(`.${SETTINGS_TRIGGER_CLASS}`)) {
      const rect = el.getBoundingClientRect?.();
      return {
        exists: true,
        hidden: el.hidden || el.getAttribute('hidden') != null || !isVisible(el),
        visible: isVisible(el),
        rect: rect && (rect.width || rect.height) ? { width: Math.round(rect.width), height: Math.round(rect.height) } : null,
        tag: el.tagName.toLowerCase(),
        classes: (el.getAttribute('class') ?? '').slice(0, 80),
        name: accessibleName(el).slice(0, 60),
      };
    }
  }
  return { exists: false, hidden: null, visible: false, rect: null, tag: null, classes: '', name: '' };
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

/**
 * The file input Flow uploads through.
 *
 * Flow never needs its "Upload" item clicked: that item exists to open the OS file
 * dialog, which no extension can fill. The page's own `input[type="file"]` can be
 * filled directly — but on the live page it lives inside the composer's custom
 * elements (and can sit in a CDK overlay), so a top-level `querySelectorAll` misses
 * it. Every shadow scope and every reachable frame is searched, and the candidates
 * are ranked: accepts images first, then one inside the composer, then the last one
 * added (Flow mounts a fresh input per menu).
 */
export function findFileInput(doc, { includeHidden = true, promptEl = null } = {}) {
  const found = collectFileInputs(doc);
  const usable = found.filter((item) => !item.el.disabled && (includeHidden || isVisible(item.el)));
  if (!usable.length) return null;
  const region = promptEl ? findPromptRegion(promptEl) : null;
  const score = (item) => {
    let value = 0;
    if (region && region.contains(item.el)) value += 4;
    if (/image|video|\*\/\*/i.test(item.el.getAttribute('accept') ?? '')) value += 2;
    // An input in this document (light DOM or shadow) beats one in a frame: the
    // composer's own uploader is here, a frame's belongs to something else.
    if (item.el.ownerDocument === doc) value += 1;
    return value;
  };
  return usable.reduce((best, item) => (score(item) >= score(best) ? item : best), usable[0]).el;
}

/** Every file input reachable from this document: light DOM, shadow scopes, frames. */
function collectFileInputs(doc) {
  const found = [];
  const add = (el, scope) => {
    if (!found.some((item) => item.el === el)) found.push({ el, scope });
  };
  for (const scope of collectMenuScopes(doc)) {
    for (const el of scope.querySelectorAll('input[type="file"]')) add(el, scope === doc ? 'document' : 'shadow root');
  }
  // collectFrameDocs yields {doc, label} wrappers, not documents.
  for (const frame of collectFrameDocs(doc)) {
    const frameDoc = frame?.doc;
    if (!frameDoc?.querySelectorAll) continue;
    for (const scope of collectMenuScopes(frameDoc)) {
      for (const el of scope.querySelectorAll('input[type="file"]')) add(el, frame.label ?? 'frame');
    }
  }
  return found;
}

/**
 * Read-only inspection of the upload surface, for the diagnostic report: how many
 * file inputs exist, where, and what each accepts. No file names, no page text.
 */
export function inspectFileInputs(doc) {
  return collectFileInputs(doc)
    .slice(0, 8)
    .map((item) => ({
      scope: item.scope,
      accept: (item.el.getAttribute('accept') ?? '').slice(0, 60),
      multiple: Boolean(item.el.multiple),
      disabled: Boolean(item.el.disabled),
      visible: isVisible(item.el),
      inComposer: Boolean(item.el.closest?.('flow-prompt-box, flow-base-prompt-box')),
    }));
}

/**
 * Where a dropped file would land: the prompt editor, its composer region, any
 * element that names itself a drop zone, then the body. Ordered most specific
 * first; every one is tried in turn and the result is verified by Flow's own chips.
 */
export function findDropTargets(doc, promptEl) {
  const targets = [];
  const push = (el) => {
    if (el && !targets.includes(el)) targets.push(el);
  };
  push(promptEl);
  push(findPromptRegion(promptEl));
  for (const scope of collectMenuScopes(doc)) {
    for (const el of scope.querySelectorAll('[data-dropzone], [class*="dropzone" i], [class*="drop-target" i], [class*="drag" i]')) {
      if (isVisible(el)) push(el);
      if (targets.length >= 6) break;
    }
  }
  push(doc.body);
  return targets.slice(0, 6);
}

/**
 * Watch every scope for an `input[type="file"]` that appears — even for one frame.
 *
 * Angular apps commonly create an input, call `.click()` on it to raise the OS
 * dialog and remove it again in the same task, so polling never sees it. The
 * captured element keeps Flow's own change listener, so it can still be filled
 * after it leaves the DOM.
 * @returns {{found: () => HTMLInputElement|null, stop: () => void}}
 */
export function observeFileInputs(doc) {
  let captured = null;
  const observers = [];
  const inspect = (node) => {
    if (captured || !node || node.nodeType !== 1) return;
    if (node.matches?.('input[type="file"]')) captured = node;
    else captured = node.querySelector?.('input[type="file"]') ?? captured;
  };
  const view = doc.defaultView;
  if (view?.MutationObserver) {
    for (const scope of collectMenuScopes(doc)) {
      const observer = new view.MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) inspect(node);
        }
      });
      try {
        observer.observe(scope === doc ? doc.documentElement ?? doc : scope, { childList: true, subtree: true });
        observers.push(observer);
      } catch {
        // A scope that cannot be observed is skipped; the others still watch.
      }
    }
  }
  return {
    found: () => captured,
    stop: () => {
      for (const observer of observers) observer.disconnect();
    },
  };
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
