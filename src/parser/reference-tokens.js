import { truncate } from '../utils/text.js';

/**
 * Reference-list tokenizer.
 *
 * Input examples handled:
 *   "Aron.png, Vex.png, Factory.png"
 *   "Aron.png and Vex.png"
 *   "Aron.png; Vex.png."
 *   "Aron"                      -> bare name, resolved later against the library
 *   "none" / "N/A"              -> no references
 */

const NONE_PATTERN = /^(none|n\/a|na|no|nothing|no references?|-+|\u2014|\u2013|\(none\))$/i;
const FILE_EXTENSION_PATTERN = /\.[A-Za-z0-9]{1,5}$/;
const SEPARATOR_PATTERN = /\s*[,;|]\s*|\s+and\s+/i;
const MAX_WORDS_PER_TOKEN = 8;

/**
 * Strip wrapping quotes, markdown emphasis and trailing sentence punctuation.
 * Internal characters of the filename are never changed.
 */
export function cleanReferenceToken(raw) {
  let value = String(raw ?? '').replace(/\s+/g, ' ').trim();
  value = value.replace(/^[\s"'`\u201c\u201d\u2018\u2019(\[{*_]+/, '');
  value = value.replace(/[\s"'`\u201c\u201d\u2018\u2019)\]}*_]+$/, '');
  value = value.replace(/[.:!?]+$/, '');
  return value.trim();
}

/** @returns {'empty'|'none'|'file'|'name'} */
export function classifyReferenceToken(name) {
  if (!name) return 'empty';
  if (NONE_PATTERN.test(name)) return 'none';
  if (FILE_EXTENSION_PATTERN.test(name)) return 'file';
  return 'name';
}

/**
 * Split the value of a "Reference images:" line into tokens.
 * @param {string} value
 * @returns {{tokens: Array<{raw: string, name: string, kind: 'file'|'name', key: string}>, warnings: string[]}}
 */
export function parseReferenceList(value) {
  const tokens = [];
  const warnings = [];
  for (const part of String(value ?? '').split(SEPARATOR_PATTERN)) {
    const name = cleanReferenceToken(part);
    const kind = classifyReferenceToken(name);
    if (kind === 'empty' || kind === 'none') continue;
    if (name.split(' ').length > MAX_WORDS_PER_TOKEN) {
      warnings.push(`Could not read reference "${truncate(name, 60)}". Use a filename such as Aron.png.`);
      continue;
    }
    tokens.push({ raw: part.trim(), name, kind, key: name.toLowerCase() });
  }
  return { tokens, warnings };
}
