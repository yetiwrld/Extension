import { AutomationError, ERROR_CODES } from '../utils/errors.js';
import { bytesToBase64 } from '../utils/binary.js';
import { STORAGE_KEYS } from '../storage/schema.js';
import * as idbBlobs from '../storage/idb.js';

/**
 * Loads the reference files a scene needs. Only the scene's own matched files are
 * loaded; the rest of the library is never read or sent to Flow.
 *
 * @param {{get: Function}} kv chrome.storage.local adapter
 * @returns {{load: (ids: string[]) => Promise<Array<{id: string, name: string, mime: string, base64: string}>>}}
 */
/**
 * Each scene's files are sent to Flow's page in one message. Keep the total well inside the
 * browser's message limit so a scene with several large images fails with a clear reason
 * instead of failing inside the upload.
 */
export const MAX_SCENE_REFERENCE_BYTES = 40 * 1024 * 1024;

export function createFileLoader(kv, blobs = idbBlobs) {
  return {
    async load(ids) {
      const data = await kv.get([STORAGE_KEYS.library]);
      const library = Array.isArray(data[STORAGE_KEYS.library]) ? data[STORAGE_KEYS.library] : [];
      const chosen = ids.map((id) => library.find((entry) => entry.id === id));
      const total = chosen.reduce((sum, item) => sum + (item?.size ?? 0), 0);
      if (total > MAX_SCENE_REFERENCE_BYTES) {
        throw new AutomationError(
          ERROR_CODES.REFERENCE_UPLOAD_FAILED,
          `This scene's reference images total ${Math.round(total / (1024 * 1024))} MB. The limit is 40 MB per scene; use smaller images.`,
          { recoverable: false },
        );
      }
      const payloads = [];
      for (const id of ids) {
        const item = library.find((entry) => entry.id === id);
        if (!item) {
          throw new AutomationError(ERROR_CODES.REFERENCE_MISSING, `A reference needed by this scene was removed from the library. Add it again.`, {
            recoverable: false,
          });
        }
        const blob = await blobs.getReferenceBlob(id);
        if (!blob) {
          throw new AutomationError(ERROR_CODES.REFERENCE_MISSING, `The stored file for ${item.name} is missing. Remove it and add it again.`, {
            recoverable: false,
          });
        }
        const bytes = new Uint8Array(await blob.arrayBuffer());
        payloads.push({ id, name: item.name, mime: item.mime || blob.type || 'image/png', base64: bytesToBase64(bytes) });
      }
      return payloads;
    },
  };
}
