import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryKv } from '../src/storage/kv.js';
import { KeyValueStore } from '../src/storage/store.js';
import { mergePrefs, DEFAULT_PREFS, STORAGE_KEYS } from '../src/storage/schema.js';
import { importReferenceFiles, listLibrary, removeReference, clearLibrary } from '../src/references/library.js';
import { isImageFile, sanitizeFileName, MAX_REFERENCE_BYTES } from '../src/references/filenames.js';
import { fnv1a } from '../src/utils/hash.js';
import { parseScenes } from '../src/parser/parse-scenes.js';

function memoryBlobs() {
  const map = new Map();
  return {
    map,
    async putReferenceBlob(id, blob) {
      map.set(id, blob);
    },
    async getReferenceBlob(id) {
      return map.get(id) ?? null;
    },
    async deleteReferenceBlob(id) {
      map.delete(id);
    },
    async clearReferenceBlobs() {
      map.clear();
    },
  };
}

function fakeFile(name, { type = 'image/png', size = 100 } = {}) {
  return { name, type, size };
}

test('the store serialises concurrent updates so no increment is lost', async () => {
  const store = new KeyValueStore(memoryKv({ counter: 0 }));
  await store.load(['counter']);
  await Promise.all(
    Array.from({ length: 25 }, () =>
      store.update('counter', async (value) => {
        await new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
        return value + 1;
      }),
    ),
  );
  assert.equal(store.read('counter'), 25);
});

test('reading a key that was not loaded is an error, not a silent default', () => {
  const store = new KeyValueStore(memoryKv());
  assert.throws(() => store.read('prefs'), /before it was loaded/);
});

test('a failing update leaves the stored value unchanged', async () => {
  const kv = memoryKv({ prefs: { pauseOnFailure: true } });
  const store = new KeyValueStore(kv);
  await store.load(['prefs']);
  await assert.rejects(
    store.update('prefs', () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.equal(store.read('prefs').pauseOnFailure, true);
});

test('preferences merge defaults, coerce booleans, and clamp the timeout', () => {
  const merged = mergePrefs({ pauseOnFailure: 0, generationTimeoutMinutes: 9999 });
  assert.equal(merged.pauseOnFailure, false);
  assert.equal(merged.generationTimeoutMinutes, 120);
  assert.equal(merged.caseInsensitiveMatching, DEFAULT_PREFS.caseInsensitiveMatching);
  assert.equal(mergePrefs({ generationTimeoutMinutes: 'x' }).generationTimeoutMinutes, DEFAULT_PREFS.generationTimeoutMinutes);
});

test('default preferences match the specification', () => {
  assert.deepEqual(DEFAULT_PREFS, {
    pauseOnFailure: true,
    requireConfirmation: true,
    continueAfterSuccess: true,
    caseInsensitiveMatching: true,
    strictFilenameMatching: false,
    generationTimeoutMinutes: 10,
  });
});

test('importing images stores metadata and bytes; non-images and oversize files are rejected with reasons', async () => {
  const kv = memoryKv();
  const blobs = memoryBlobs();
  const result = await importReferenceFiles(
    [
      fakeFile('Aron.png'),
      fakeFile('notes.txt', { type: 'text/plain' }),
      fakeFile('huge.png', { size: MAX_REFERENCE_BYTES + 1 }),
    ],
    { kv, blobs },
  );
  assert.deepEqual(result.added, ['Aron.png']);
  assert.equal(result.rejected.length, 2);
  assert.match(result.rejected[0].reason, /Not an image/);
  assert.match(result.rejected[1].reason, /25 MB/);
  const library = await listLibrary(kv);
  assert.equal(library.length, 1);
  assert.ok(blobs.map.get(library[0].id), 'bytes must be stored for the library entry');
});

test('a file with the same name in any letter case replaces the existing entry and keeps its id', async () => {
  const kv = memoryKv();
  const blobs = memoryBlobs();
  const first = await importReferenceFiles([fakeFile('Aron.png', { size: 10 })], { kv, blobs, now: () => 1 });
  const id = first.items[0].id;
  const second = await importReferenceFiles([fakeFile('aron.PNG', { size: 20 })], { kv, blobs, now: () => 2 });
  assert.deepEqual(second.replaced, ['aron.PNG']);
  const library = await listLibrary(kv);
  assert.equal(library.length, 1);
  assert.equal(library[0].id, id);
  assert.equal(library[0].size, 20);
});

test('the same name selected twice in one batch is rejected the second time', async () => {
  const kv = memoryKv();
  const result = await importReferenceFiles([fakeFile('Vex.png'), fakeFile('vex.png')], { kv, blobs: memoryBlobs() });
  assert.deepEqual(result.added, ['Vex.png']);
  assert.match(result.rejected[0].reason, /same batch/);
});

test('removing a reference deletes its metadata and its bytes', async () => {
  const kv = memoryKv();
  const blobs = memoryBlobs();
  const { items } = await importReferenceFiles([fakeFile('Mira.png'), fakeFile('Vex.png')], { kv, blobs });
  await removeReference(items[0].id, { kv, blobs });
  assert.deepEqual((await listLibrary(kv)).map((item) => item.name), ['Vex.png']);
  assert.equal(blobs.map.has(items[0].id), false);
});

test('clearing the library removes every entry and every stored file', async () => {
  const kv = memoryKv();
  const blobs = memoryBlobs();
  await importReferenceFiles([fakeFile('Aron.png'), fakeFile('Laboratory.png')], { kv, blobs });
  await clearLibrary({ kv, blobs });
  assert.deepEqual(await listLibrary(kv), []);
  assert.equal(blobs.map.size, 0);
});

test('a single renamed upload uses the requested name', async () => {
  const kv = memoryKv();
  const result = await importReferenceFiles([fakeFile('IMG_2231.png')], { kv, blobs: memoryBlobs(), renameTo: 'Aron.png' });
  assert.deepEqual(result.added, ['Aron.png']);
});

test('image detection uses MIME type or extension', () => {
  assert.equal(isImageFile({ name: 'x.webp', type: '' }), true);
  assert.equal(isImageFile({ name: 'x.bin', type: 'image/jpeg' }), true);
  assert.equal(isImageFile({ name: 'x.pdf', type: 'application/pdf' }), false);
});

test('filenames are sanitised for storage without changing ordinary names', () => {
  assert.equal(sanitizeFileName('Aron.png'), 'Aron.png');
  assert.equal(sanitizeFileName('a/b:c*.png'), 'a_b_c_.png');
  assert.equal(sanitizeFileName('   '), 'reference');
});

test('fnv1a is deterministic and 8 hex characters', () => {
  assert.equal(fnv1a('scene'), fnv1a('scene'));
  assert.match(fnv1a('scene'), /^[0-9a-f]{8}$/);
  assert.notEqual(fnv1a('a'), fnv1a('b'));
});

test('the example document parses without blocking errors', () => {
  const sample = `[Scene 1]\nOne.\nReference images: Aron.png\n[Scene 2]\nTwo.`;
  assert.equal(parseScenes(sample).errors.length, 0);
  assert.equal(STORAGE_KEYS.library, 'referenceLibrary');
});
