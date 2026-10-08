import { normalizeKey, stemOf } from './filenames.js';
import { unique } from '../utils/text.js';

/**
 * Reference matching.
 *
 * Rules (applied per token, in this order):
 *  1. A saved user choice for this scene + token wins, if the file still exists.
 *  2. Token with an extension ("Aron.png"): exact filename match. Case-insensitive
 *     when that preference is on. No fuzzy fallback.
 *  3. Bare token ("Aron"): when strict filename matching is on it is "missing"
 *     (the full filename is required). Otherwise:
 *       - exactly one library file whose name (without extension) equals the token,
 *         and no other file that merely starts with it  -> matched;
 *       - anything else that resembles the token (e.g. Aron.png AND Aron_Closeup.png)
 *         -> ambiguous, the user must choose. Never selected silently.
 *  4. Nothing found -> missing, with a hint when a near-miss exists.
 */

export const MATCH_STATUS = Object.freeze({
  MATCHED: 'matched',
  MISSING: 'missing',
  AMBIGUOUS: 'ambiguous',
});

export const SCENE_REFERENCE_STATUS = Object.freeze({
  NONE: 'none',
  OK: 'ok',
  MISSING: 'missing',
  AMBIGUOUS: 'ambiguous',
});

/**
 * @typedef {{id: string, name: string}} LibraryEntry
 * @typedef {{
 *   token: string, raw: string, kind: 'file'|'name', line: number,
 *   status: 'matched'|'missing'|'ambiguous', fileId?: string, fileName?: string,
 *   source?: 'override'|'exact'|'stem', candidates?: Array<{id: string, name: string}>, hint?: string
 * }} ReferenceResolution
 */

/**
 * @param {Array<{key: string, name: string, kind: string, raw: string, line: number}>} tokens
 * @param {LibraryEntry[]} library
 * @param {{caseInsensitive?: boolean, strictFilenameMatching?: boolean}} [options]
 * @param {Record<string, string>} [overrides] token key -> chosen file id
 * @returns {ReferenceResolution[]}
 */
export function resolveReferenceTokens(tokens, library, options = {}, overrides = {}) {
  const caseInsensitive = options.caseInsensitive !== false;
  const strict = options.strictFilenameMatching === true;
  const entries = (library ?? []).map((entry) => ({
    id: entry.id,
    name: entry.name,
    nameKey: normalizeKey(entry.name, caseInsensitive),
    stemKey: normalizeKey(stemOf(entry.name), caseInsensitive),
    lowerNameKey: normalizeKey(entry.name, true),
  }));

  return (tokens ?? []).map((token) =>
    resolveOne(token, entries, { caseInsensitive, strict, overrideFileId: overrides?.[token.key] }),
  );
}

function resolveOne(token, entries, { caseInsensitive, strict, overrideFileId }) {
  const base = { token: token.name, raw: token.raw, kind: token.kind, line: token.line };

  if (overrideFileId) {
    const chosen = entries.find((entry) => entry.id === overrideFileId);
    if (chosen) {
      return { ...base, status: MATCH_STATUS.MATCHED, fileId: chosen.id, fileName: chosen.name, source: 'override' };
    }
  }

  const tokenKey = normalizeKey(token.name, caseInsensitive);

  if (token.kind === 'file') {
    const exact = entries.filter((entry) => entry.nameKey === tokenKey);
    if (exact.length === 1) {
      return matched(base, exact[0], 'exact');
    }
    if (exact.length > 1) {
      return ambiguous(base, exact, 'Several library files share this name.');
    }
    return missing(base, entries, token.name, caseInsensitive);
  }

  // Bare name, e.g. "Aron".
  if (strict) {
    return {
      ...base,
      status: MATCH_STATUS.MISSING,
      hint: 'Strict filename matching is on. Use the full filename, for example Aron.png.',
    };
  }

  const stemExact = entries.filter((entry) => entry.stemKey === tokenKey);
  const startsWith = entries.filter(
    (entry) => !stemExact.includes(entry) && isNamePrefix(entry.stemKey, tokenKey),
  );

  if (stemExact.length === 0 && startsWith.length === 0) {
    return { ...base, status: MATCH_STATUS.MISSING, hint: `No library file is named ${token.name}.` };
  }
  if (stemExact.length === 1 && startsWith.length === 0) {
    return matched(base, stemExact[0], 'stem');
  }
  return ambiguous(
    base,
    [...stemExact, ...startsWith],
    `"${token.name}" matches more than one library file. Choose the one to use.`,
  );
}

function matched(base, entry, source) {
  return { ...base, status: MATCH_STATUS.MATCHED, fileId: entry.id, fileName: entry.name, source };
}

function ambiguous(base, candidates, hint) {
  return {
    ...base,
    status: MATCH_STATUS.AMBIGUOUS,
    candidates: candidates.map((entry) => ({ id: entry.id, name: entry.name })),
    hint,
  };
}

function missing(base, entries, tokenName, caseInsensitive) {
  const stem = normalizeKey(stemOf(tokenName), caseInsensitive);
  const sameStem = entries.filter((entry) => entry.stemKey === stem);
  let hint = `${tokenName} is not in the reference library.`;
  if (sameStem.length) {
    hint = `Library has ${sameStem.map((entry) => entry.name).join(', ')}, but the extension must match exactly.`;
  } else if (!caseInsensitive && entries.some((entry) => entry.lowerNameKey === tokenName.toLowerCase())) {
    hint = `Only the letter case differs. Enable case-insensitive matching or rename the file.`;
  }
  return { ...base, status: MATCH_STATUS.MISSING, hint };
}

/** "Aron" is a prefix of "Aron_Closeup" when the next character is a separator. */
function isNamePrefix(longer, shorter) {
  return longer.length > shorter.length && longer.startsWith(shorter) && /[ _\-.]/.test(longer.charAt(shorter.length));
}

/**
 * Collapse per-token results into one status for the scene.
 * @param {ReferenceResolution[]} resolutions
 */
export function summarizeSceneReferences(resolutions) {
  if (!resolutions.length) {
    return { status: SCENE_REFERENCE_STATUS.NONE, matchedFileIds: [], missing: [], ambiguous: [] };
  }
  const missingItems = resolutions.filter((item) => item.status === MATCH_STATUS.MISSING);
  const ambiguousItems = resolutions.filter((item) => item.status === MATCH_STATUS.AMBIGUOUS);
  const matchedFileIds = unique(
    resolutions.filter((item) => item.status === MATCH_STATUS.MATCHED).map((item) => item.fileId),
  );
  let status = SCENE_REFERENCE_STATUS.OK;
  if (missingItems.length) status = SCENE_REFERENCE_STATUS.MISSING;
  else if (ambiguousItems.length) status = SCENE_REFERENCE_STATUS.AMBIGUOUS;
  return { status, matchedFileIds, missing: missingItems, ambiguous: ambiguousItems };
}
