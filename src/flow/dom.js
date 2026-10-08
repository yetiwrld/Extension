/**
 * Generic DOM helpers used by the Flow adapter. Nothing in this file knows
 * about Google Flow; Flow-specific selection lives in selectors.js.
 *
 * Interaction rules:
 *  - No coordinates. Elements are found by role, accessible name, and text.
 *  - Clicks are dispatched as the same event sequence a user agent produces,
 *    so both pointer-driven and click-driven components respond.
 *  - Text entry uses the native value setter (React-safe) or execCommand for
 *    rich-text editors.
 */

const NON_CONTENT_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'HEAD']);

export function normalizeText(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Visible to a user: rendered, not hidden by CSS or ARIA, and has layout.
 * Works in jsdom tests when getClientRects is stubbed.
 */
export function isVisible(el) {
  if (!el || !el.isConnected || NON_CONTENT_TAGS.has(el.tagName)) return false;
  const view = el.ownerDocument?.defaultView;
  if (view) {
    const style = view.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
  }
  if (el.hidden || el.closest('[hidden], [inert]')) return false;
  const rects = el.getClientRects ? el.getClientRects() : [];
  return rects.length > 0;
}

export function isDisabled(el) {
  if (!el) return true;
  return Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true';
}

/** Accessible name: aria-label, then aria-labelledby, title, alt, then visible text. */
export function accessibleName(el) {
  if (!el) return '';
  const label = el.getAttribute('aria-label');
  if (label) return normalizeText(label);
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
  if (el.tagName === 'IMG') return normalizeText(el.getAttribute('alt'));
  return normalizeText(el.textContent);
}

/** Text used to recognise an element: name plus placeholder, excluding nothing. */
export function labelText(el) {
  return normalizeText([accessibleName(el), el.getAttribute?.('placeholder') ?? ''].join(' '));
}

export function queryAllVisible(root, selector) {
  return Array.from(root.querySelectorAll(selector)).filter(isVisible);
}

/** Dispatch the pointer/mouse sequence a real click produces, then click(). */
export function clickElement(el) {
  const view = el.ownerDocument.defaultView;
  el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  el.focus?.({ preventScroll: true });
  const init = { bubbles: true, cancelable: true, composed: true, view, button: 0 };
  const PointerCtor = view.PointerEvent || view.MouseEvent;
  el.dispatchEvent(new PointerCtor('pointerdown', { ...init, pointerId: 1, pointerType: 'mouse' }));
  el.dispatchEvent(new view.MouseEvent('mousedown', init));
  el.dispatchEvent(new PointerCtor('pointerup', { ...init, pointerId: 1, pointerType: 'mouse' }));
  el.dispatchEvent(new view.MouseEvent('mouseup', init));
  el.click();
}

/** A press outside any menu. Most menus close on outside pointer-down. */
export function clickOutside(doc) {
  const body = doc.body;
  if (!body) return;
  const view = doc.defaultView;
  const init = { bubbles: true, cancelable: true, composed: true, view, button: 0 };
  body.dispatchEvent(new view.MouseEvent('mousedown', init));
  body.dispatchEvent(new view.MouseEvent('mouseup', init));
  body.dispatchEvent(new view.MouseEvent('click', init));
}

/** Set a controlled <input>/<textarea> value so React sees the change. */
export function setControlledValue(el, value) {
  const view = el.ownerDocument.defaultView;
  const proto = el.tagName === 'TEXTAREA' ? view.HTMLTextAreaElement.prototype : view.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new view.Event('input', { bubbles: true }));
  el.dispatchEvent(new view.Event('change', { bubbles: true }));
}

/**
 * Replace the content of a contenteditable element with plain text.
 * Uses execCommand so editor frameworks (Lexical, ProseMirror, Slate) receive
 * genuine input events; falls back to a DOM write plus input event.
 */
export function replaceEditableText(el, text) {
  const doc = el.ownerDocument;
  el.focus({ preventScroll: true });
  const selection = doc.getSelection();
  const range = doc.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);
  let inserted = false;
  try {
    inserted = doc.execCommand('insertText', false, text);
  } catch {
    inserted = false;
  }
  if (!inserted || normalizeText(el.textContent) !== normalizeText(text)) {
    el.textContent = text;
    el.dispatchEvent(new doc.defaultView.InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
  }
}

export function readEditableText(el) {
  if (!el) return '';
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') return el.value ?? '';
  return el.innerText ?? el.textContent ?? '';
}

export function pressEscape(doc) {
  const target = doc.activeElement || doc.body;
  const init = { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true };
  target.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', init));
  target.dispatchEvent(new doc.defaultView.KeyboardEvent('keyup', init));
}

/** Ancestors from `el` up to (and including) `levels` parents. */
export function ancestors(el, levels) {
  const out = [];
  let node = el?.parentElement ?? null;
  while (node && out.length < levels) {
    out.push(node);
    node = node.parentElement;
  }
  return out;
}

/** Poll `read` until it returns a truthy value or the timeout passes. */
export async function waitForValue(read, { timeoutMs, intervalMs, sleep }) {
  const started = Date.now();
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() - started >= timeoutMs) return null;
    await sleep(intervalMs);
  }
}
