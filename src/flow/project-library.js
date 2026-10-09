import { AutomationError, ERROR_CODES } from '../utils/errors.js';
import { accessibleName, clickElement, normalizeText, pressEscape, queryAllVisible, waitForValue } from './dom.js';
import { countAttachedReferences } from './references.js';
import { findAddButton, findPromptRegion, requirePromptBox, snapshotOpenMenus, pickNewMenuSurface } from './selectors.js';

/**
 * Attach references that are ALREADY in the Flow project.
 *
 * Flow's uploader is an operating-system file dialog, which no extension can fill,
 * and synthetic drops land late and duplicate. Flow's Add menu also offers
 * "Use from project": the ingredients already uploaded to this project, listed by
 * name. Matching the scene's reference FILENAMES against those names uses Flow's
 * own supported UI and needs no upload at all.
 *
 * Nothing here guesses: a name that matches nothing, or matches more than one
 * entry, is reported by name — a random tile is never clicked.
 */

/** How long Flow is given to show the picker, and to render a chip after a pick. */
const PICKER_TIMEOUT_MS = 6000;
const CHIP_TIMEOUT_MS = 20000;

const USE_FROM_PROJECT = /\b(use from project|from project|project (media|library|assets)|existing (media|image)s?|library)\b/i;

/** The Add-menu item that opens the project's existing ingredients. */
export function findUseFromProjectItem(doc, surface = null) {
  const scope = surface ?? doc;
  const item = queryAllVisible(scope, '[role="menuitem"], [role="option"], button, [role="button"], li').find((el) =>
    USE_FROM_PROJECT.test(accessibleName(el) || normalizeText(el.textContent ?? '')),
  );
  return item ? { el: item, label: accessibleName(item) || normalizeText(item.textContent ?? '') } : null;
}

/**
 * The named entries inside the picker. A tile's name can live in its accessible
 * name, an image's alt text, a title attribute or its own short text — all four are
 * read, and an entry with no readable name is reported as unnamed rather than used.
 */
export function readLibraryItems(surface) {
  const out = [];
  const seen = new Set();
  const candidates = queryAllVisible(surface, '[role="option"], [role="menuitem"], [role="listitem"], li, button, [role="button"], img');
  for (const el of candidates) {
    if (out.length >= 200) break;
    const host = el.tagName === 'IMG' ? (el.closest('[role="option"], [role="menuitem"], li, button, [role="button"]') ?? el) : el;
    if (seen.has(host)) continue;
    seen.add(host);
    const img = host.tagName === 'IMG' ? host : host.querySelector('img');
    const name =
      normalizeText(accessibleName(host) || '') ||
      normalizeText(img?.getAttribute('alt') ?? '') ||
      normalizeText(host.getAttribute('title') ?? '') ||
      normalizeText(img?.getAttribute('title') ?? '') ||
      normalizeText(host.textContent ?? '');
    if (!name || name.length > 120) continue;
    out.push({ el: host, name });
  }
  return out;
}

/** `ref_aron_sheet_v1.jpeg` -> `ref_aron_sheet_v1` */
function baseName(name) {
  return String(name).replace(/\.[A-Za-z0-9]{1,5}$/, '');
}

function normalizeKey(name) {
  return baseName(name).toLowerCase().replace(/[\s._-]+/g, '');
}

/**
 * Match one reference filename against the picker's entries.
 *
 * Exact filename first, then the filename without its extension, then a loose key
 * that ignores spaces, dots, dashes and underscores. More than one match at the
 * same strength is AMBIGUOUS and is refused, naming both — picking by DOM order
 * would silently attach the wrong image.
 *
 * @returns {{item: object}|{ambiguous: string[]}|null}
 */
export function matchLibraryName(wanted, items) {
  const rounds = [
    (item) => normalizeText(item.name).toLowerCase() === String(wanted).toLowerCase(),
    (item) => baseName(item.name).toLowerCase() === baseName(wanted).toLowerCase(),
    (item) => normalizeKey(item.name) === normalizeKey(wanted),
  ];
  for (const test of rounds) {
    const hits = items.filter(test);
    if (hits.length === 1) return { item: hits[0] };
    if (hits.length > 1) return { ambiguous: hits.map((hit) => hit.name).slice(0, 6) };
  }
  return null;
}

/** Open Add -> "Use from project" and return the picker surface. */
async function openPicker(ctx, promptEl) {
  const add = findAddButton(promptEl);
  if (!add) return { surface: null, reason: 'the Add ingredients control was not found' };
  const beforeMenu = snapshotOpenMenus(ctx.doc, { exclude: promptEl });
  clickElement(add.el);
  const menu = await waitForValue(() => pickNewMenuSurface(ctx.doc, null, promptEl, { ignore: beforeMenu }), {
    timeoutMs: ctx.timings.popoverMs,
    intervalMs: 80,
    sleep: ctx.sleep,
  });
  if (!menu) return { surface: null, reason: 'the Add menu did not open' };
  const entry = findUseFromProjectItem(ctx.doc, menu);
  if (!entry) {
    const offered = readLibraryItems(menu)
      .map((item) => item.name)
      .slice(0, 6)
      .join(', ');
    return { surface: null, reason: `the Add menu offers no "Use from project" item${offered ? ` (it offers: ${offered})` : ''}` };
  }
  const beforePicker = snapshotOpenMenus(ctx.doc, { exclude: promptEl });
  clickElement(entry.el);
  const picker = await waitForValue(() => pickNewMenuSurface(ctx.doc, menu, promptEl, { ignore: beforePicker }), {
    timeoutMs: PICKER_TIMEOUT_MS,
    intervalMs: 100,
    sleep: ctx.sleep,
  });
  if (!picker) return { surface: null, reason: '"Use from project" opened nothing' };
  return { surface: picker, reason: null };
}

/**
 * Attach the named references from the project library.
 *
 * @param {object} ctx
 * @param {string[]} names reference filenames for the scene
 * @returns {Promise<{attached: number, picked: string[], missing: string[], ambiguous: object[], available: string[], reason: string|null}>}
 */
export async function attachFromProject(ctx, names) {
  const prompt = requirePromptBox(ctx.doc);
  if (!names?.length) return { attached: 0, picked: [], missing: [], ambiguous: [], available: [], reason: null };
  const { surface, reason } = await openPicker(ctx, prompt.el);
  if (!surface) return { attached: 0, picked: [], missing: [...names], ambiguous: [], available: [], reason };

  const picked = [];
  const missing = [];
  const ambiguous = [];
  try {
    for (const name of names) {
      // The list is re-read before every pick: Flow re-renders the picker after one.
      const items = readLibraryItems(surface);
      const match = matchLibraryName(name, items);
      if (!match) {
        missing.push(name);
        continue;
      }
      if (match.ambiguous) {
        ambiguous.push({ name, matches: match.ambiguous });
        continue;
      }
      const before = countAttachedReferences(ctx.doc, prompt.el);
      clickElement(match.item.el);
      // Flow renders the ingredient chip only after its own round-trip: wait for the
      // chip, do not assume the click worked and do not click anything else meanwhile.
      const confirmed = await waitForValue(() => countAttachedReferences(ctx.doc, prompt.el) > before, {
        timeoutMs: CHIP_TIMEOUT_MS,
        intervalMs: 200,
        sleep: ctx.sleep,
      });
      if (confirmed) picked.push(match.item.name);
      else missing.push(name);
    }
  } finally {
    // Leave Flow as it was found: close the picker without touching its content.
    pressEscape(surface.ownerDocument ?? ctx.doc);
    await ctx.sleep(ctx.timings.settleMs);
  }
  const available = readLibraryItems(surface)
    .map((item) => item.name)
    .slice(0, 12);
  return {
    attached: countAttachedReferences(ctx.doc, prompt.el),
    picked,
    missing,
    ambiguous,
    available,
    reason: null,
  };
}

/** Names of the references Flow currently shows on the composer, when it names them. */
export function readAttachedReferenceNames(doc, promptEl) {
  const region = findPromptRegion(promptEl);
  if (!region) return [];
  const names = [];
  for (const img of queryAllVisible(region, 'img')) {
    if (img.closest('[role="dialog"], [role="menu"], [role="listbox"]')) continue;
    const name = normalizeText(img.getAttribute('alt') ?? img.getAttribute('title') ?? '');
    if (name && name.length <= 120) names.push(name);
  }
  return names;
}

/** Thrown when the project library cannot supply a named reference. */
export function libraryShortfallError(sceneLabel, result, names) {
  const parts = [];
  if (result.ambiguous?.length) {
    parts.push(
      result.ambiguous
        .map((entry) => `"${entry.name}" matches ${entry.matches.length} items in the project (${entry.matches.join(', ')})`)
        .join('; '),
    );
  }
  if (result.missing?.length) parts.push(`not in the project: ${result.missing.join(', ')}`);
  if (result.reason) parts.push(result.reason);
  return new AutomationError(
    ERROR_CODES.REFERENCE_MANUAL_REQUIRED,
    `Scene ${sceneLabel}: could not take ${names.join(', ')} from the Flow project — ${parts.join('; ') || 'no match'}. ` +
      `${result.available?.length ? `The project offers: ${result.available.join(', ')}. ` : ''}` +
      'Upload the file(s) to the project (or attach them to the prompt) in Flow, then press Resume.',
  );
}
