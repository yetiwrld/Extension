/**
 * Minimal key-value adapters over chrome.storage, plus an in-memory variant
 * for tests. Both expose: get(keys) -> object, set(object), remove(keys).
 */

export function chromeStorageKv(area) {
  if (!area) throw new Error('A chrome.storage area is required.');
  return {
    get: (keys) => area.get(keys),
    set: (values) => area.set(values),
    remove: (keys) => area.remove(keys),
  };
}

export function memoryKv(initial = {}) {
  const data = structuredClone(initial);
  return {
    async get(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of list) {
        if (Object.prototype.hasOwnProperty.call(data, key)) out[key] = structuredClone(data[key]);
      }
      return out;
    },
    async set(values) {
      for (const [key, value] of Object.entries(values)) data[key] = structuredClone(value);
    },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key];
    },
    _dump: () => structuredClone(data),
  };
}
