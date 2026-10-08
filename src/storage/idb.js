/**
 * IndexedDB store for reference image bytes.
 *
 * chrome.storage is unsuitable for image data (small quota, JSON encoding), so
 * reference files are stored as Blobs here. Both the side panel (which writes
 * them when the user picks files) and the service worker (which reads them to
 * upload to Flow) use this module; they share the same extension origin.
 */

const DB_NAME = 'flow-scene-queue';
const DB_VERSION = 1;
const STORE_NAME = 'reference-files';

let dbPromise = null;

function openDatabase() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        dbPromise = null;
        reject(request.error || new Error('Could not open reference storage.'));
      };
      request.onblocked = () => {
        dbPromise = null;
        reject(new Error('Reference storage is blocked by another open version of the extension. Reload the extension.'));
      };
    });
  }
  return dbPromise;
}

function run(mode, action) {
  return openDatabase().then(
    (db) =>
      new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, mode);
        const store = transaction.objectStore(STORE_NAME);
        const request = action(store);
        transaction.oncomplete = () => resolve(request?.result);
        transaction.onerror = () => reject(transaction.error || new Error('Reference storage transaction failed.'));
        transaction.onabort = () => reject(transaction.error || new Error('Reference storage transaction aborted.'));
      }),
  );
}

/** @returns {Promise<void>} */
export function putReferenceBlob(id, blob) {
  return run('readwrite', (store) => store.put({ id, blob, savedAt: Date.now() })).then(() => undefined);
}

/** @returns {Promise<Blob|null>} */
export async function getReferenceBlob(id) {
  const record = await run('readonly', (store) => store.get(id));
  return record?.blob ?? null;
}

/** @returns {Promise<void>} */
export function deleteReferenceBlob(id) {
  return run('readwrite', (store) => store.delete(id)).then(() => undefined);
}

/** @returns {Promise<void>} */
export function clearReferenceBlobs() {
  return run('readwrite', (store) => store.clear()).then(() => undefined);
}
