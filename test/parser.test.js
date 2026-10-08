import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScenes } from '../src/parser/parse-scenes.js';
import { readExampleDocument } from './helpers.js';

test('the example document yields exactly four scenes with the expected reference mapping', () => {
  const result = parseScenes(readExampleDocument());
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  assert.deepEqual(
    result.scenes.map((scene) => scene.number),
    [1, 2, 3, 4],
  );
  const refs = result.scenes.map((scene) => scene.referenceTokens.map((token) => token.name));
  assert.deepEqual(refs, [
    ['Aron.png', 'Laboratory.png'],
    ['Aron.png'],
    ['Vex.png', 'Mira.png'],
    ['Mira.png', 'Laboratory.png'],
  ]);
});

test('prompt text is kept verbatim and reference lines are removed from it', () => {
  const result = parseScenes(readExampleDocument());
  const first = result.scenes[0];
  assert.equal(
    first.prompt,
    'Wide establishing shot of a quiet harbour at dawn. Thin mist rolls over grey water while a single lantern swings on a wooden pier.',
  );
  assert.ok(!first.prompt.includes('Reference images'));
});

test('scene markers accept any digit count, case-insensitively', () => {
  const text = [
    '[Scene 1]',
    'One.',
    '[Scene 02]',
    'Two.',
    '[Scene 003]',
    'Three.',
    '[Scene 10]',
    'Ten.',
    '[scene 11]',
    'Eleven.',
  ].join('\n');
  const result = parseScenes(text);
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  assert.deepEqual(
    result.scenes.map((scene) => scene.number),
    [1, 2, 3, 10, 11],
  );
  assert.deepEqual(
    result.scenes.map((scene) => scene.numberLabel),
    ['01', '02', '03', '10', '11'],
  );
});

test('markdown wrappers and titles are recognised without leaking into the prompt', () => {
  const text = [
    '**[Scene 02]**: Vex arrives',
    'Vex walks down the pier.',
    '',
    '# [Scene 3 - Lab] ',
    'Mira studies the map.',
    'Reference images: Mira.png',
  ].join('\n');
  const result = parseScenes(text);
  assert.equal(result.scenes.length, 2);
  assert.equal(result.scenes[0].title, 'Vex arrives');
  assert.equal(result.scenes[0].prompt, 'Vex walks down the pier.');
  assert.equal(result.scenes[1].title, 'Lab');
  assert.equal(result.scenes[1].prompt, 'Mira studies the map.');
});

test('text after the marker on the same line is the first line of the prompt', () => {
  const result = parseScenes('[Scene 1] A harbour at dawn.\nSecond line.');
  assert.equal(result.scenes[0].prompt, 'A harbour at dawn.\nSecond line.');
  assert.equal(result.scenes[0].title, '');
});

test('reference bullet lists are consumed as references', () => {
  const text = ['[Scene 1]', 'A shot.', 'Reference images:', '- Aron.png', '- Vex.png', '', 'Trailing note.'].join('\n');
  const result = parseScenes(text);
  assert.deepEqual(
    result.scenes[0].referenceTokens.map((token) => token.name),
    ['Aron.png', 'Vex.png'],
  );
  assert.equal(result.scenes[0].prompt, 'A shot.\n\nTrailing note.');
});

test('"none" and empty reference lines produce no references', () => {
  const result = parseScenes('[Scene 1]\nA shot.\nReference images: none\n[Scene 2]\nB shot.\nReference images:');
  assert.equal(result.scenes[0].referenceTokens.length, 0);
  assert.equal(result.scenes[1].referenceTokens.length, 0);
});

test('bare names are kept as bare name tokens for later resolution', () => {
  const result = parseScenes('[Scene 1]\nA shot.\nReference images: Aron, Vex.png');
  assert.deepEqual(
    result.scenes[0].referenceTokens.map((token) => [token.name, token.kind]),
    [
      ['Aron', 'name'],
      ['Vex.png', 'file'],
    ],
  );
});

test('duplicate scene numbers are blocking errors that name both lines', () => {
  const result = parseScenes('[Scene 1]\nA.\n[Scene 1]\nB.');
  const duplicate = result.errors.find((item) => item.code === 'DUPLICATE_SCENE_NUMBER');
  assert.ok(duplicate, 'expected DUPLICATE_SCENE_NUMBER');
  assert.match(duplicate.message, /lines 1 and 3/);
});

test('an empty prompt is a blocking error', () => {
  const result = parseScenes('[Scene 1]\nReference images: Aron.png\n[Scene 2]\nReal prompt.');
  assert.ok(result.errors.some((item) => item.code === 'EMPTY_PROMPT' && item.sceneNumber === 1));
});

test('a document with no markers reports NO_SCENES', () => {
  const result = parseScenes('Just some text without markers.');
  assert.equal(result.scenes.length, 0);
  assert.equal(result.errors[0].code, 'NO_SCENES');
});

test('an empty document is not an error by itself', () => {
  const result = parseScenes('   \n  ');
  assert.equal(result.scenes.length, 0);
  assert.equal(result.errors.length, 0);
});

test('CRLF line endings parse identically to LF', () => {
  const lf = parseScenes(readExampleDocument());
  const crlf = parseScenes(readExampleDocument().replace(/\n/g, '\r\n'));
  assert.deepEqual(
    crlf.scenes.map((scene) => [scene.number, scene.prompt, scene.referenceTokens.map((t) => t.name)]),
    lf.scenes.map((scene) => [scene.number, scene.prompt, scene.referenceTokens.map((t) => t.name)]),
  );
});

test('scene ids are stable for the same content and change when the prompt changes', () => {
  const a = parseScenes('[Scene 1]\nSame prompt.\nReference images: Aron.png').scenes[0].id;
  const b = parseScenes('[Scene 1]\nSame prompt.\nReference images: Aron.png').scenes[0].id;
  const c = parseScenes('[Scene 1]\nEdited prompt.\nReference images: Aron.png').scenes[0].id;
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('text before the first marker is ignored with a warning', () => {
  const result = parseScenes('Notes for me.\n[Scene 1]\nA shot.');
  assert.equal(result.scenes.length, 1);
  assert.ok(result.warnings.some((item) => item.code === 'PREAMBLE_IGNORED'));
});
