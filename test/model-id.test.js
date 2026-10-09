import test from 'node:test';
import assert from 'node:assert/strict';
import { matchModelOption, modelKey, modelLabelsMatch } from '../src/flow/model-id.js';

test('the chip label and the menu row map to the same model identifier', () => {
  assert.equal(modelKey('\u{1F34C} Nano Banana 2.1'), 'nano banana 2.1');
  assert.equal(modelKey('Nano Banana 2.1'), 'nano banana 2.1');
  assert.ok(modelLabelsMatch('\u{1F34C} Nano Banana 2.1', 'Nano Banana 2.1'));
  assert.ok(modelLabelsMatch('Nano Banana 2.1 Fast image generation', 'Nano Banana 2.1'));
  assert.ok(modelLabelsMatch('Nano Banana 2.1 check', 'Nano Banana 2.1'));
  assert.ok(modelLabelsMatch('Veo 3.1 - Lite [Lower Priority]', 'Veo 3.1 Lite'));
});

test('a different version is never the same model', () => {
  assert.ok(!modelLabelsMatch('Nano Banana 2', 'Nano Banana 2.1'));
  assert.ok(!modelLabelsMatch('Nano Banana 2.1 Lite', 'Nano Banana 2.1 Pro'));
  assert.ok(!modelLabelsMatch('', 'Nano Banana 2.1'));
  assert.equal(modelKey('2.0'), '2');
});

test('a model that is in the list is found, with decoration and a description around it', () => {
  const options = [{ name: '\u{1F34C} Nano Banana 2.1  Fast image generation' }, { name: 'Nano Banana Pro' }, { name: 'Veo 3.1' }];
  const picked = matchModelOption(options, 'Nano Banana 2.1');
  assert.equal(picked.ambiguous, false);
  assert.equal(picked.match, options[0]);
});

test('an exact label wins over a longer one that merely starts with it', () => {
  const options = [{ name: 'Nano Banana 2.1' }, { name: 'Nano Banana 2.1 Lite' }];
  assert.equal(matchModelOption(options, 'Nano Banana 2.1').match, options[0]);
});

test('several possible matches are reported as ambiguous instead of guessed', () => {
  const options = [{ name: 'Nano Banana 2.1 Lite' }, { name: 'Nano Banana 2.1 Pro' }];
  const picked = matchModelOption(options, 'Nano Banana 2.1');
  assert.equal(picked.match, null);
  assert.equal(picked.ambiguous, true);
  assert.deepEqual(picked.candidates, ['Nano Banana 2.1 Lite', 'Nano Banana 2.1 Pro']);
});

test('prefix matching can be switched off so a family row is not taken for a model', () => {
  const options = [{ name: 'Nano Banana' }];
  assert.equal(matchModelOption(options, 'Nano Banana 2.1', (o) => o.name, { allowPrefix: false }).match, null);
});
