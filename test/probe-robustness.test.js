import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createFlowAdapter } from '../src/flow/adapter.js';

/*
 * The connection check runs the page probe. One element the probe cannot read must not make the
 * whole page look disconnected: the other checks still run, and the failure is reported.
 */

test('one unreadable element does not stop the page check, and the failure is reported', async () => {
  const dom = new JSDOM(
    '<!doctype html><html><body><textarea placeholder="Describe the scene"></textarea><button>Generate</button></body></html>',
    { url: 'https://flow.google.com/project/abc', pretendToBeVisual: true },
  );
  const { window } = dom;
  // jsdom has no layout: give every element a size so the visibility checks apply, as on a real page.
  window.Element.prototype.getClientRects = function getClientRects() {
    return [{ width: 200, height: 200, top: 0, left: 0, right: 200, bottom: 200 }];
  };
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { width: 200, height: 200, top: 0, left: 0, right: 200, bottom: 200, x: 0, y: 0 };
  };
  // Only the prompt box's own label cannot be read. Other attributes, such as role for the selectors, still work.
  const textarea = window.document.querySelector('textarea');
  const readAttribute = textarea.getAttribute.bind(textarea);
  textarea.getAttribute = (name) => {
    if (name === 'aria-label') throw new Error('unreadable attribute');
    return readAttribute(name);
  };

  const adapter = createFlowAdapter({ doc: window.document, location: window.location });
  const probe = await adapter.probe();

  assert.equal(probe.promptFound, false);
  assert.equal(probe.generateFound, true, `the Generate button is still found: ${JSON.stringify(probe)}`);
  assert.ok(
    probe.issues.some((issue) => issue.startsWith('prompt box: unreadable attribute')),
    JSON.stringify(probe.issues),
  );

  const report = await adapter.diagnose();
  const pageChecks = report.checks.find((check) => check.label === 'Page checks');
  assert.equal(pageChecks.ok, false);
  assert.match(pageChecks.detail, /unreadable attribute/);
});
