import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createFlowAdapter } from '../src/flow/adapter.js';
import { findFileInput, inspectFileInputs } from '../src/flow/selectors.js';
import { installFlowFixture } from './fixtures/flow-fixture.js';

/*
 * Reference upload on the live page: Flow's "Upload" item opens the OS file dialog,
 * which no extension can fill. The page's own input[type=file] must be found and
 * filled directly — including when Flow mounts it inside a shadow root.
 */

const URL_ = 'https://flow.google.com/project/abc123';

/** jsdom has no DataTransfer; the adapter builds its FileList through one. */
class FakeDataTransfer {
  constructor() {
    this._files = [];
    const self = this;
    this.items = { add: (file) => self._files.push(file) };
  }

  get files() {
    return this._files;
  }
}
globalThis.DataTransfer = FakeDataTransfer;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5)));

function page(options = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: URL_, pretendToBeVisual: true });
  const { window } = dom;
  window.Element.prototype.getClientRects = () => [{ width: 200, height: 200, top: 0, left: 0, right: 200, bottom: 200 }];
  window.Element.prototype.getBoundingClientRect = () => ({ width: 200, height: 200, top: 0, left: 0, right: 200, bottom: 200, x: 0, y: 0 });
  const fixture = installFlowFixture(window, options);
  const adapter = createFlowAdapter({ doc: window.document, location: new URL(URL_), sleep, timings: { settleMs: 0, popoverMs: 200 } });
  return { window, fixture, adapter };
}

const file = (name) => ({ name, mime: 'image/png', base64: Buffer.from(name).toString('base64') });

test('a file input inside a shadow root is found and filled without clicking Upload', async () => {
  const { window, fixture, adapter } = page({ uploadInShadow: true });
  assert.equal(findFileInput(window.document), null, 'no input before the Add menu mounts one');
  const result = await adapter.attachReferences([file('Aron.png'), file('Vex.png')]);
  assert.equal(result.attached, 2);
  assert.deepEqual(fixture.state.references, ['Aron.png', 'Vex.png']);
  const inputs = inspectFileInputs(window.document);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].scope, 'shadow root');
  assert.equal(inputs[0].accept, 'image/*');
});

test('when no file input exists anywhere, the error says so instead of blaming the picker', async () => {
  const { adapter } = page({ variant: 'agent' });
  await assert.rejects(
    () => adapter.attachReferences([file('Aron.png')]),
    (error) => {
      assert.equal(error.code, 'REFERENCE_UPLOAD_FAILED');
      assert.match(error.message, /No file input exists anywhere|file input\(s\), none usable|"Add" control/);
      return true;
    },
  );
});

test('a page with frames is searched without throwing (the frame list holds wrappers, not documents)', async () => {
  const { window, fixture, adapter } = page({ uploadInShadow: true });
  // Flow's project page carries frames (the live report counts two). The search must
  // walk their documents, and must never be handed the {doc, label} wrapper itself.
  const frame = window.document.createElement('iframe');
  window.document.body.appendChild(frame);
  // A disabled input inside a frame: it must be SEEN (and reported) but never used.
  frame.contentDocument.body.innerHTML = '<input type="file" accept="image/*" disabled />';
  assert.doesNotThrow(() => inspectFileInputs(window.document));
  const scopes = inspectFileInputs(window.document).map((item) => item.scope);
  assert.ok(scopes.some((scope) => /iframe/.test(scope)), `a frame input is reported: ${scopes.join(', ')}`);
  // The composer's own input (mounted in a shadow root with the Add menu) is used.
  const result = await adapter.attachReferences([file('Aron.png')]);
  assert.equal(result.attached, 1);
  assert.deepEqual(fixture.state.references, ['Aron.png']);
});
