import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { matchLibraryName, readLibraryItems, findUseFromProjectItem } from '../src/flow/project-library.js';

function surfaceWith(html) {
  const dom = new JSDOM(`<!doctype html><html><body><div id="s">${html}</div></body></html>`);
  const win = dom.window;
  const box = { width: 120, height: 120, top: 0, left: 0, right: 120, bottom: 120, x: 0, y: 0 };
  win.Element.prototype.getBoundingClientRect = () => box;
  win.Element.prototype.getClientRects = () => [box];
  return win.document.getElementById('s');
}

const tiles = (names) =>
  surfaceWith(
    names.map((name) => `<button role="option"><img alt="${name}"><span>${name}</span></button>`).join(''),
  );

test('the picker tiles are read by the name Flow shows', () => {
  const items = readLibraryItems(tiles(['ref_aron_sheet_v1.jpeg', 'loc_cityalley_sheet_day_v1.jpeg']));
  assert.deepEqual(
    items.map((item) => item.name),
    ['ref_aron_sheet_v1.jpeg', 'loc_cityalley_sheet_day_v1.jpeg'],
  );
});

test('a reference is matched by exact filename', () => {
  const items = readLibraryItems(tiles(['ref_aron_sheet_v1.jpeg', 'other.png']));
  const match = matchLibraryName('ref_aron_sheet_v1.jpeg', items);
  assert.equal(match.item.name, 'ref_aron_sheet_v1.jpeg');
});

test('a reference still matches when Flow dropped the extension or changed separators', () => {
  const items = readLibraryItems(tiles(['ref aron sheet v1', 'unrelated.png']));
  const match = matchLibraryName('ref_aron_sheet_v1.jpeg', items);
  assert.equal(match.item.name, 'ref aron sheet v1');
});

test('two equally good matches are refused by name, never picked by position', () => {
  const items = readLibraryItems(tiles(['ref_aron_sheet_v1.jpeg', 'ref_aron_sheet_v1.png']));
  const match = matchLibraryName('ref_aron_sheet_v1', items);
  assert.ok(match.ambiguous, 'ambiguity is reported');
  assert.equal(match.ambiguous.length, 2);
});

test('a reference the project does not hold matches nothing', () => {
  const items = readLibraryItems(tiles(['something_else.png']));
  assert.equal(matchLibraryName('ref_aron_sheet_v1.jpeg', items), null);
});

test('the Add menu item that opens the project library is found by its label', () => {
  const menu = surfaceWith(
    '<button role="menuitem">Upload image</button><button role="menuitem">Use from project</button>',
  );
  const found = findUseFromProjectItem(menu.ownerDocument, menu);
  assert.equal(found.label, 'Use from project');
});
