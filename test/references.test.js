import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveReferenceTokens, summarizeSceneReferences, SCENE_REFERENCE_STATUS } from '../src/references/match.js';
import { parseScenes } from '../src/parser/parse-scenes.js';
import { TEST_LIBRARY, readExampleDocument } from './helpers.js';

const LIB = [
  { id: 'a1', name: 'Aron.png' },
  { id: 'a2', name: 'Aron_Closeup.png' },
  { id: 'v1', name: 'Vex.png' },
  { id: 'l1', name: 'Laboratory.png' },
];

function tokens(text) {
  return parseScenes(`[Scene 1]\nPrompt.\nReference images: ${text}`).scenes[0].referenceTokens;
}

test('exact filename matches by default', () => {
  const [result] = resolveReferenceTokens(tokens('Vex.png'), LIB, { caseInsensitive: true });
  assert.equal(result.status, 'matched');
  assert.equal(result.fileId, 'v1');
  assert.equal(result.source, 'exact');
});

test('case-insensitive matching accepts a different letter case when enabled', () => {
  const [result] = resolveReferenceTokens(tokens('vex.PNG'), LIB, { caseInsensitive: true });
  assert.equal(result.status, 'matched');
  assert.equal(result.fileId, 'v1');
});

test('case-sensitive matching rejects a different letter case and explains why', () => {
  const [result] = resolveReferenceTokens(tokens('vex.png'), LIB, { caseInsensitive: false });
  assert.equal(result.status, 'missing');
  assert.match(result.hint, /letter case/i);
});

test('a bare name that matches exactly one file by stem is matched', () => {
  const [result] = resolveReferenceTokens(tokens('Vex'), LIB, { caseInsensitive: true });
  assert.equal(result.status, 'matched');
  assert.equal(result.fileName, 'Vex.png');
  assert.equal(result.source, 'stem');
});

test('a bare name shared by Aron.png and Aron_Closeup.png is ambiguous and never auto-selected', () => {
  const [result] = resolveReferenceTokens(tokens('Aron'), LIB, { caseInsensitive: true });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.fileId, undefined);
  assert.deepEqual(result.candidates.map((item) => item.name).sort(), ['Aron.png', 'Aron_Closeup.png']);
});

test('strict filename matching rejects bare names outright', () => {
  const [result] = resolveReferenceTokens(tokens('Vex'), LIB, { strictFilenameMatching: true });
  assert.equal(result.status, 'missing');
  assert.match(result.hint, /full filename/i);
});

test('an unknown file is missing and the scene reports it', () => {
  const resolutions = resolveReferenceTokens(tokens('Unknown.png, Vex.png'), LIB, {});
  const summary = summarizeSceneReferences(resolutions);
  assert.equal(summary.status, SCENE_REFERENCE_STATUS.MISSING);
  assert.deepEqual(summary.missing.map((item) => item.token), ['Unknown.png']);
  assert.deepEqual(summary.matchedFileIds, ['v1']);
});

test('an ambiguous reference takes priority over matched ones in the summary', () => {
  const resolutions = resolveReferenceTokens(tokens('Vex.png, Aron'), LIB, {});
  const summary = summarizeSceneReferences(resolutions);
  assert.equal(summary.status, SCENE_REFERENCE_STATUS.AMBIGUOUS);
});

test('a saved user choice resolves an ambiguous bare name', () => {
  const resolutions = resolveReferenceTokens(tokens('Aron'), LIB, {}, { aron: 'a2' });
  assert.equal(resolutions[0].status, 'matched');
  assert.equal(resolutions[0].fileId, 'a2');
  assert.equal(resolutions[0].source, 'override');
});

test('a saved choice pointing at a file that was removed is ignored', () => {
  const resolutions = resolveReferenceTokens(tokens('Aron'), LIB, {}, { aron: 'deleted-id' });
  assert.equal(resolutions[0].status, 'ambiguous');
});

test('a scene without references has status none', () => {
  const summary = summarizeSceneReferences([]);
  assert.equal(summary.status, SCENE_REFERENCE_STATUS.NONE);
});

test('the example document maps to the test library with every reference matched', () => {
  const parsed = parseScenes(readExampleDocument());
  const statuses = parsed.scenes.map((scene) => {
    const resolutions = resolveReferenceTokens(scene.referenceTokens, TEST_LIBRARY, { caseInsensitive: true });
    return summarizeSceneReferences(resolutions).status;
  });
  assert.deepEqual(statuses, ['ok', 'ok', 'ok', 'ok']);
});

test('the same file referenced twice in one scene is de-duplicated by the parser', () => {
  const parsed = parseScenes('[Scene 1]\nA.\nReference images: Vex.png, vex.png');
  assert.equal(parsed.scenes[0].referenceTokens.length, 1);
});
