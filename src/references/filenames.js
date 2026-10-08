/** Filename helpers used by matching and by the library. */

export const MAX_REFERENCE_BYTES = 25 * 1024 * 1024;
export const IMAGE_FILE_PATTERN = /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif|tiff?)$/i;

/** Unicode-normalised comparison key. Lower-cased when case-insensitive matching is on. */
export function normalizeKey(name, caseInsensitive = true) {
  const value = String(name ?? '').normalize('NFC');
  return caseInsensitive ? value.toLowerCase() : value;
}

/** "Aron.png" -> "Aron"; "archive.v2.png" -> "archive.v2". */
export function stemOf(name) {
  const value = String(name ?? '');
  const dot = value.lastIndexOf('.');
  return dot > 0 ? value.slice(0, dot) : value;
}

export function isImageFile(file) {
  if (file?.type && file.type.startsWith('image/')) return true;
  return IMAGE_FILE_PATTERN.test(String(file?.name ?? ''));
}

/** Remove characters that are not allowed in filenames on common platforms. */
export function sanitizeFileName(name) {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 180);
  return cleaned || 'reference';
}
