import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { findGenerateButton } from '../src/flow/selectors.js';

function pageWith(html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: 'https://flow.google.com/project/abc',
    pretendToBeVisual: true,
  });
  // jsdom has no layout: give elements a size so the visibility check applies, as on a real page.
  dom.window.Element.prototype.getClientRects = function getClientRects() {
    return [{ width: 200, height: 40, top: 0, left: 0, right: 200, bottom: 40 }];
  };
  return dom.window.document;
}

/*
 * When the prompt box cannot be located, the Generate button is found anywhere on the page, but only
 * by an explicit "Generate" label. This regression test once failed silently: the word-boundary escape
 * in the pattern had been stored as a control character, so the pattern could never match.
 */

test('the document-wide fallback finds an explicit Generate button outside the prompt region', () => {
  const doc = pageWith('<main><button>Create project</button><button>Generate</button></main>');
  const found = findGenerateButton(doc, null);
  assert.ok(found, 'no Generate button was found');
  assert.equal(found.strategy, 'generate-in-document');
  assert.equal(found.el.textContent.trim(), 'Generate');
});

test('the fallback never accepts Create project or Regenerate', () => {
  const doc = pageWith('<button>Create project</button><button>Regenerate</button>');
  assert.equal(findGenerateButton(doc, null), null);
});
