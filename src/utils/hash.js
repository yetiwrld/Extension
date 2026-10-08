/**
 * Deterministic, non-cryptographic 32-bit FNV-1a hash rendered as 8 hex chars.
 * Used to derive stable scene IDs from scene content.
 */
export function fnv1a(input) {
  const text = String(input ?? '');
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
