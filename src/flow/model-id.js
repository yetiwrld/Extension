/**
 * One normalized mapping between the LIVE UI label of a model and the identifier
 * the extension stores for it.
 *
 * Why this exists: Flow renders a model in several shapes for the same thing —
 * the composer chip ("\u{1F34C} Nano Banana 2.1"), the menu row
 * ("Nano Banana 2.1  Fast image generation"), a selected row with a trailing
 * "check" ligature, a family row in brackets. Comparing those with a plain
 * string equality made a model that IS in the list be reported as unavailable.
 *
 * Rules here are STRUCTURAL only: no model name, family or version is hardcoded,
 * so a model Flow ships tomorrow normalizes the same way. The canonical key is
 * derived from whatever the page shows.
 */

/** Tokens the UI adds around a name that never belong to the name itself. */
const DECORATION_TOKENS = new Set([
  'check',
  'check_circle',
  'done',
  'selected',
  'current',
  'default',
  'new',
  'beta',
  'preview',
  'experimental',
  'recommended',
  'arrow_right',
  'chevron_right',
  'expand_more',
  'keyboard_arrow_right',
]);

/**
 * Split a UI label into comparable tokens.
 * - parenthesised / bracketed asides are dropped (they are tags, not the name);
 * - every character that is not a letter, digit or dot becomes a separator, which
 *   removes emoji, icon glyphs, dashes, middots and punctuation in one step;
 * - a trailing ".0" is dropped so "2.0" and "2" are the same version;
 * - decoration tokens are removed.
 * @param {string} label
 * @returns {string[]}
 */
export function modelTokens(label) {
  const text = String(label ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .toLowerCase();
  return text
    .split(/[^\p{Letter}\p{Number}.]+/u)
    .map((token) => token.replace(/^\.+|\.+$/g, ''))
    .map((token) => (/^\d+\.0$/.test(token) ? token.slice(0, -2) : token))
    .filter(Boolean)
    .filter((token) => !DECORATION_TOKENS.has(token));
}

/**
 * The extension's internal identifier for a model, derived from its live label.
 * @param {string} label
 * @returns {string} e.g. "nano banana 2.1" — '' when the label carries no name.
 */
export function modelKey(label) {
  return modelTokens(label).join(' ');
}

/** @returns {boolean} true when `tokens` starts with every token of `prefix`. */
function startsWithTokens(tokens, prefix) {
  if (prefix.length < 2 || prefix.length > tokens.length) return false;
  return prefix.every((token, index) => tokens[index] === token);
}

/**
 * Do two labels name the same model?
 *
 * Equal keys match. A shorter label also matches a longer one when it is a whole
 * leading token run of it ("Nano Banana 2.1" vs "Nano Banana 2.1 Fast image
 * generation"), which is how the menu row and the chip differ. A differing
 * version token ("2" vs "2.1") is NOT a prefix and never matches.
 * @param {string} a
 * @param {string} b
 */
export function modelLabelsMatch(a, b) {
  const left = modelTokens(a);
  const right = modelTokens(b);
  if (!left.length || !right.length) return false;
  if (left.join(' ') === right.join(' ')) return true;
  return startsWithTokens(left, right) || startsWithTokens(right, left);
}

/**
 * Find the one option naming `wanted`, refusing to guess when several could be it.
 *
 * Exact key equality wins outright (an exact "Nano Banana 2" is never shadowed by
 * "Nano Banana 2.1 Lite"). Only when nothing matches exactly are prefix matches
 * considered, and more than one of those is reported as AMBIGUOUS rather than
 * resolved by DOM order.
 *
 * @template T
 * @param {T[]} options
 * @param {string} wanted
 * @param {(option: T) => string} nameOf
 * @param {{allowPrefix?: boolean}} [opts] allowPrefix=false compares exact keys only
 *   (used where a shorter FAMILY row would otherwise prefix-match a model).
 * @returns {{match: T|null, ambiguous: boolean, candidates: string[], available: string[]}}
 */
export function matchModelOption(options, wanted, nameOf = (option) => option?.name ?? '', { allowPrefix = true } = {}) {
  const list = Array.isArray(options) ? options : [];
  const available = list.map((option) => String(nameOf(option) ?? '')).filter(Boolean);
  const key = modelKey(wanted);
  if (!key) return { match: null, ambiguous: false, candidates: [], available };
  const exact = list.filter((option) => modelKey(nameOf(option)) === key);
  if (exact.length === 1) return { match: exact[0], ambiguous: false, candidates: [String(nameOf(exact[0]))], available };
  if (exact.length > 1) {
    return { match: null, ambiguous: true, candidates: exact.map((option) => String(nameOf(option))), available };
  }
  if (!allowPrefix) return { match: null, ambiguous: false, candidates: [], available };
  const loose = list.filter((option) => modelLabelsMatch(nameOf(option), wanted));
  if (loose.length === 1) return { match: loose[0], ambiguous: false, candidates: [String(nameOf(loose[0]))], available };
  if (loose.length > 1) {
    return { match: null, ambiguous: true, candidates: loose.map((option) => String(nameOf(option))), available };
  }
  return { match: null, ambiguous: false, candidates: [], available };
}
