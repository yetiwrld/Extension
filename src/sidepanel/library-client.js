import { chromeStorageKv } from '../storage/kv.js';
import { clearLibrary, importReferenceFiles, listLibrary, removeReference } from '../references/library.js';

/**
 * The side panel is the single writer of the reference library (metadata in
 * chrome.storage.local, bytes in IndexedDB). The service worker only reads it.
 */
const kv = chromeStorageKv(chrome.storage.local);

export const libraryClient = {
  list: () => listLibrary(kv),
  add: (files) => importReferenceFiles(files, { kv }),
  remove: (id) => removeReference(id, { kv }),
  clear: () => clearLibrary({ kv }),
};
