/**
 * Plain-text helpers. Nothing here changes the meaning of user text except
 * where explicitly documented.
 */

/** Normalise CRLF / CR line endings to LF. Content is otherwise untouched. */
export function normalizeNewlines(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n');
}

/** Shorten text to `max` characters, adding an ellipsis when cut. */
export function truncate(text, max) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}\u2026`;
}

/** "1 scene" / "2 scenes". */
export function pluralize(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Remove duplicates while keeping first-seen order. */
export function unique(values) {
  return [...new Set(values)];
}
