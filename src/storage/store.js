import { createSerialQueue } from '../utils/async.js';
import { defaultValue } from './schema.js';

/**
 * Service-worker side store.
 *
 * Keeps an in-memory cache of the keys this context owns and persists every
 * change. Updates are serialised, so two concurrent command handlers can never
 * interleave a read-modify-write on the same key.
 */
export class KeyValueStore {
  /**
   * @param {{get: Function, set: Function, remove: Function}} kv
   */
  constructor(kv) {
    this.kv = kv;
    this.cache = new Map();
    this.enqueue = createSerialQueue();
  }

  /** Load the given keys into the cache. Must be awaited before read(). */
  async load(keys) {
    const data = await this.kv.get(keys);
    for (const key of keys) {
      this.cache.set(key, data[key] === undefined ? defaultValue(key) : data[key]);
    }
  }

  /** Synchronous read of a key loaded with load(). Returns a defensive copy. */
  read(key) {
    if (!this.cache.has(key)) {
      throw new Error(`Store key "${key}" was read before it was loaded.`);
    }
    return structuredClone(this.cache.get(key));
  }

  /** Read a key directly from storage, bypassing the cache (for keys written by other contexts). */
  async fetch(key) {
    const data = await this.kv.get([key]);
    return data[key] === undefined ? defaultValue(key) : data[key];
  }

  /**
   * Apply `mutator` to a copy of the current value and persist the result.
   * The mutator may return a new value or mutate its argument. Throwing inside
   * the mutator aborts the write and rejects the returned promise.
   */
  update(key, mutator) {
    return this.enqueue(async () => {
      const current = this.cache.has(key) ? structuredClone(this.cache.get(key)) : defaultValue(key);
      const result = await mutator(current);
      const next = result === undefined ? current : result;
      this.cache.set(key, next);
      await this.kv.set({ [key]: next });
      return structuredClone(next);
    });
  }

  /** Replace a key outright. */
  set(key, value) {
    return this.update(key, () => value);
  }
}
