/** Short random identifier, e.g. "ref_3f9a0c1d2b4e5f60". */
export function uid(prefix = 'id') {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}
