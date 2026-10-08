import { STORAGE_KEYS } from '../storage/schema.js';
import * as idbBlobs from '../storage/idb.js';
import { uid } from '../utils/ids.js';
import { isImageFile, MAX_REFERENCE_BYTES, normalizeKey, sanitizeFileName } from './filenames.js';

/**
 * Reference library: metadata in chrome.storage.local, bytes in IndexedDB.
 * Written only by the side panel. The service worker reads it.
 *
 * Filenames are unique case-insensitively, so "Aron.png" and "aron.png" can never
 * both exist and a reference can never become ambiguous because of duplicates.
 *
 * @typedef {{id: string, name: string, mime: string, size: number, addedAt: number, updatedAt: number}} LibraryItem
 */

/**
 * @param {{get: Function, set: Function}} kv chrome.storage.local-compatible adapter
 * @returns {Promise<LibraryItem[]>}
 */
export async function listLibrary(kv) {
  const data = await kv.get([STORAGE_KEYS.library]);
  return Array.isArray(data[STORAGE_KEYS.library]) ? data[STORAGE_KEYS.library] : [];
}

/**
 * Add image files to the library. Files with the same (case-insensitive) name are replaced.
 *
 * @param {File[]|FileList} files
 * @param {{kv: any, blobs?: typeof idbBlobs, renameTo?: string, now?: () => number}} deps
 * @returns {Promise<{added: string[], replaced: string[], rejected: Array<{name: string, reason: string}>, items: LibraryItem[]}>}
 */
export async function importReferenceFiles(files, { kv, blobs = idbBlobs, renameTo, now = () => Date.now() }) {
  const list = Array.from(files ?? []);
  const library = await listLibrary(kv);
  const added = [];
  const replaced = [];
  const rejected = [];
  const seenInBatch = new Set();

  for (const file of list) {
    const originalName = file.name || 'untitled';
    if (!isImageFile(file)) {
      rejected.push({ name: originalName, reason: 'Not an image file. Pick PNG, JPG, WEBP or GIF files.' });
      continue;
    }
    if (file.size > MAX_REFERENCE_BYTES) {
      rejected.push({ name: originalName, reason: 'Larger than 25 MB. Compress the image first.' });
      continue;
    }
    const name = sanitizeFileName(list.length === 1 && renameTo ? renameTo : originalName);
    const key = normalizeKey(name, true);
    if (seenInBatch.has(key)) {
      rejected.push({ name, reason: 'Selected twice in the same batch.' });
      continue;
    }
    seenInBatch.add(key);

    const existingIndex = library.findIndex((item) => normalizeKey(item.name, true) === key);
    const timestamp = now();
    const id = existingIndex >= 0 ? library[existingIndex].id : uid('ref');
    // Bytes first: metadata must never point at a missing blob.
    await blobs.putReferenceBlob(id, file);
    const item = {
      id,
      name,
      mime: file.type || 'application/octet-stream',
      size: file.size,
      addedAt: existingIndex >= 0 ? library[existingIndex].addedAt : timestamp,
      updatedAt: timestamp,
    };
    if (existingIndex >= 0) {
      library[existingIndex] = item;
      replaced.push(name);
    } else {
      library.push(item);
      added.push(name);
    }
  }

  if (added.length || replaced.length) {
    await kv.set({ [STORAGE_KEYS.library]: library });
  }
  return { added, replaced, rejected, items: library };
}

/** Remove one item: metadata first, then bytes. */
export async function removeReference(id, { kv, blobs = idbBlobs }) {
  const library = await listLibrary(kv);
  const next = library.filter((item) => item.id !== id);
  await kv.set({ [STORAGE_KEYS.library]: next });
  await blobs.deleteReferenceBlob(id);
  return next;
}

export async function clearLibrary({ kv, blobs = idbBlobs }) {
  await kv.set({ [STORAGE_KEYS.library]: [] });
  await blobs.clearReferenceBlobs();
}
