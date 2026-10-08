import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFileLoader } from '../src/background/files.js';
import { memoryKv } from '../src/storage/kv.js';

const MB = 1024 * 1024;

test('a scene whose references exceed the per-scene limit is refused before any file is read', async () => {
  const kv = memoryKv({
    referenceLibrary: [
      { id: 'a', name: 'Big1.png', size: 25 * MB, mime: 'image/png' },
      { id: 'b', name: 'Big2.png', size: 20 * MB, mime: 'image/png' },
    ],
  });
  let reads = 0;
  const loader = createFileLoader(kv, {
    getReferenceBlob: async () => {
      reads += 1;
      return new Blob(['x']);
    },
  });
  await assert.rejects(loader.load(['a', 'b']), (error) => {
    assert.equal(error.code, 'REFERENCE_UPLOAD_FAILED');
    assert.match(error.message, /40 MB/);
    return true;
  });
  assert.equal(reads, 0);
});

test('references within the limit are read and encoded for the page', async () => {
  const kv = memoryKv({ referenceLibrary: [{ id: 'a', name: 'Aron.png', size: 3, mime: 'image/png' }] });
  const loader = createFileLoader(kv, {
    getReferenceBlob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
  });
  const [payload] = await loader.load(['a']);
  assert.equal(payload.name, 'Aron.png');
  assert.equal(payload.mime, 'image/png');
  assert.equal(Buffer.from(payload.base64, 'base64').toString('hex'), '010203');
});

test('a reference removed from the library is reported as missing', async () => {
  const loader = createFileLoader(memoryKv({ referenceLibrary: [] }), { getReferenceBlob: async () => null });
  await assert.rejects(loader.load(['gone']), (error) => {
    assert.equal(error.code, 'REFERENCE_MISSING');
    return true;
  });
});

test('a library entry whose stored bytes are gone is reported as missing, naming the file', async () => {
  const kv = memoryKv({ referenceLibrary: [{ id: 'a', name: 'Vex.png', size: 3, mime: 'image/png' }] });
  const loader = createFileLoader(kv, { getReferenceBlob: async () => null });
  await assert.rejects(loader.load(['a']), (error) => {
    assert.equal(error.code, 'REFERENCE_MISSING');
    assert.match(error.message, /Vex\.png/);
    return true;
  });
});
