/**
 * SYNTHETIC Flow page used by the jsdom adapter tests.
 *
 * This is NOT a copy of Google Flow. It is a hand-written model of the controls the
 * adapter is designed to find (prompt box, settings popover, Add/Upload menu, Generate
 * button, results grid). Passing these tests shows the adapter logic works on this
 * model. It does NOT show that the live Flow page matches the model. That requires a
 * manual check with the "Check Flow page" button on a signed-in Flow project.
 *
 * Variants:
 *   'textarea'        prompt is a <textarea> (default)
 *   'contenteditable' prompt is a rich-text box (role=textbox)
 *   'plaintext-only'  prompt is contenteditable="plaintext-only"
 *   'input'           prompt is a single-line <input> (chat-style composer)
 *   'agent'           the Agent layout: a chat panel replaces the standard prompt box
 *   'late'            the standard composer is rendered ~60ms after install
 */

export const FIXTURE_CATALOG = Object.freeze({
  mode: ['Image', 'Video'],
  modelsByMode: {
    Image: ['Nano Banana Pro', 'Nano Banana'],
    Video: ['Veo 3.1', 'Gemini Omni'],
  },
  aspectRatio: ['16:9', '9:16', '1:1'],
});

/** 1x1 transparent GIF, so the synthetic thumbnails load without network access. */
const PLACEHOLDER_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRA7';

const COMPOSER_HTML = {
  textarea: '<textarea id="prompt" placeholder="Describe your image or video"></textarea>',
  contenteditable: '<div id="prompt" role="textbox" contenteditable="true" aria-label="Describe your image or video" class="editor"></div>',
  'plaintext-only': '<div id="prompt" role="textbox" contenteditable="plaintext-only" aria-label="Describe your image or video" class="editor"></div>',
  input: '<input id="prompt" type="text" placeholder="Describe your image or video">',
};

export function installFlowFixture(window, { variant = 'textarea', flowWithMissingUpload = false, lateComposerMs = 60 } = {}) {
  const doc = window.document;
  const state = {
    mode: 'Image',
    model: 'Nano Banana Pro',
    aspectRatio: '16:9',
    references: [],
    generating: 0,
    outputs: 0,
    alerts: [],
    submitted: [],
  };

  const agentLayout = variant === 'agent';
  doc.body.innerHTML = agentLayout
    ? `
    <main>
      <header class="top"><button type="button" aria-label="Create new project">New project</button></header>
      <section class="results" id="results" aria-label="Results"></section>
      <div class="agent-panel" id="prompt-box">
        <div class="agent-head">
          <button type="button" id="agent" role="switch" aria-checked="true">Agent</button>
          <button type="button" id="settings-btn" aria-haspopup="menu" aria-expanded="false">${state.model} \u25be</button>
        </div>
        <div class="messages" id="messages" aria-label="Agent messages"></div>
        <div class="chat-bar">
          <input id="prompt" type="text" aria-label="Message the agent" placeholder="Ask the agent to create something">
          <button type="button" id="generate" aria-label="Send">
            <span class="material-symbols">arrow_forward</span> Send
          </button>
        </div>
      </div>
      <div id="overlay-root"></div>
    </main>`
    : `
    <main>
      <header class="top"><button type="button" aria-label="Create new project">New project</button></header>
      <section class="results" id="results" aria-label="Results"></section>
      <div class="prompt-box" id="prompt-box">
        <div class="refs" id="refs"></div>
        <div class="controls-row">
          <button type="button" id="add-btn" aria-haspopup="menu">+ Add</button>
          <button type="button" id="settings-btn" aria-haspopup="menu" aria-expanded="false">${state.model} \u25be</button>
          <button type="button" id="agent" role="switch" aria-checked="false">Agent</button>
        </div>
        <div id="prompt-slot"></div>
        <button type="button" id="generate" aria-label="Generate">
          <span class="material-symbols">arrow_forward</span> Generate
        </button>
      </div>
      <div id="overlay-root"></div>
    </main>`;

  const $ = (sel) => doc.querySelector(sel);
  const slot = $('#prompt-slot');
  const generateBtn = $('#generate');
  const settingsBtn = $('#settings-btn');
  const addBtn = $('#add-btn');
  const agentBtn = $('#agent');
  const overlay = $('#overlay-root');
  const refsEl = $('#refs');
  const resultsEl = $('#results');
  let promptEl = null;

  /** Insert the composer for this variant (standard layouts) and wire its events. */
  function attachComposer() {
    if (agentLayout) return; // the Agent chat input is already the composer
    slot.innerHTML = COMPOSER_HTML[variant] ?? COMPOSER_HTML.textarea;
    promptEl = $('#prompt');
    if (!promptEl) return;
    promptEl.addEventListener('input', syncGenerate);
    promptEl.addEventListener('keyup', syncGenerate);
    syncGenerate();
  }

  // The Upload control exists only while the Add menu is open, like a real menu.
  function closePopover() {
    overlay.innerHTML = '';
    settingsBtn.setAttribute('aria-expanded', 'false');
    if (addBtn) addBtn.setAttribute('aria-expanded', 'false');
  }

  function renderSettingsButton() {
    settingsBtn.textContent = `${state.model} \u25be`;
  }

  function option(group, name, selected) {
    return `<div role="menuitemradio" data-group="${group}" data-value="${name}" aria-checked="${selected ? 'true' : 'false'}" tabindex="0">${name}</div>`;
  }

  function openSettings() {
    closePopover();
    const modelOptions = FIXTURE_CATALOG.modelsByMode[state.mode];
    overlay.innerHTML = `
      <div role="menu" aria-label="Settings" data-popover="settings">
        <h3>Mode</h3>
        ${FIXTURE_CATALOG.mode.map((name) => option('Mode', name, name === state.mode)).join('')}
        <h3>Model</h3>
        ${modelOptions.map((name) => option('Model', name, name === state.model)).join('')}
        <h3>Aspect ratio</h3>
        ${FIXTURE_CATALOG.aspectRatio.map((name) => option('Aspect ratio', name, name === state.aspectRatio)).join('')}
      </div>`;
    settingsBtn.setAttribute('aria-expanded', 'true');
    for (const item of overlay.querySelectorAll('[role="menuitemradio"]')) {
      item.addEventListener('click', () => {
        const group = item.dataset.group;
        const value = item.dataset.value;
        if (group === 'Mode') {
          state.mode = value;
          // Changing the mode resets the model to the first model of that mode.
          state.model = FIXTURE_CATALOG.modelsByMode[value][0];
        } else if (group === 'Model') {
          state.model = value;
        } else {
          state.aspectRatio = value;
        }
        renderSettingsButton();
        closePopover();
      });
    }
  }

  doc.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePopover();
  });

  settingsBtn.addEventListener('click', () => {
    if (settingsBtn.getAttribute('aria-expanded') === 'true') closePopover();
    else openSettings();
  });

  if (addBtn) {
    addBtn.addEventListener('click', () => {
      closePopover();
      overlay.innerHTML = `
        <div role="menu" aria-label="Add">
          <button type="button" role="menuitem" id="upload-item">Upload image</button>
          <button type="button" role="menuitem">Use from project</button>
        </div>`;
      addBtn.setAttribute('aria-expanded', 'true');
      overlay.querySelector('#upload-item').addEventListener('click', () => {
        if (!doc.querySelector('input[type="file"]')) {
          const input = doc.createElement('input');
          input.type = 'file';
          input.accept = 'image/*';
          input.multiple = true;
          input.hidden = true;
          // jsdom does not model the files setter for arbitrary objects; keep the value the adapter sets.
          let files = null;
          Object.defineProperty(input, 'files', {
            configurable: true,
            get: () => files,
            set: (value) => {
              files = value;
            },
          });
          input.addEventListener('change', () => {
            for (const file of Array.from(input.files ?? [])) {
              addChip(file.name);
            }
          });
          $('#prompt-box').appendChild(input);
        }
        closePopover();
      });
    });
  }

  function addChip(name) {
    state.references.push(name);
    const chip = doc.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `<img alt="${name}" src="${PLACEHOLDER_IMAGE}"><button type="button" aria-label="Remove ${name}">\u00d7</button>`;
    chip.querySelector('button').addEventListener('click', () => {
      state.references = state.references.filter((item) => item !== name);
      chip.remove();
    });
    refsEl.appendChild(chip);
  }

  agentBtn.addEventListener('click', () => {
    const on = agentBtn.getAttribute('aria-checked') !== 'true';
    agentBtn.setAttribute('aria-checked', on ? 'true' : 'false');
  });

  function syncGenerate() {
    if (!promptEl) return;
    const empty = !(promptEl.value ?? promptEl.textContent ?? '').trim();
    generateBtn.disabled = empty;
  }

  if (agentLayout) {
    promptEl = $('#prompt');
    promptEl.addEventListener('input', syncGenerate);
    promptEl.addEventListener('keyup', syncGenerate);
  }

  generateBtn.addEventListener('click', () => {
    if (generateBtn.disabled || !promptEl) return;
    const text = (promptEl.value ?? promptEl.textContent ?? '').trim();
    state.submitted.push(text);
    state.generating += 1;
    const bar = doc.createElement('div');
    bar.setAttribute('role', 'progressbar');
    bar.className = 'progress';
    bar.dataset.gen = String(state.submitted.length);
    resultsEl.appendChild(bar);
  });

  function finishGeneration() {
    const bars = resultsEl.querySelectorAll('[role="progressbar"]');
    bars.forEach((bar) => bar.remove());
    state.generating = 0;
    state.outputs += 1;
    const img = doc.createElement('img');
    img.setAttribute('src', `https://lh3.example.test/output-${state.outputs}.png`);
    img.setAttribute('alt', `Generated ${state.outputs}`);
    resultsEl.appendChild(img);
  }

  function failGeneration(message) {
    resultsEl.querySelectorAll('[role="progressbar"]').forEach((bar) => bar.remove());
    state.generating = 0;
    const alert = doc.createElement('div');
    alert.setAttribute('role', 'alert');
    alert.textContent = message;
    resultsEl.appendChild(alert);
  }

  renderSettingsButton();
  if (variant === 'late') {
    // The composer renders after the page: detection must wait for it.
    setTimeout(attachComposer, lateComposerMs);
  } else {
    attachComposer();
  }
  syncGenerate();
  void flowWithMissingUpload;

  return {
    state,
    doc,
    get promptEl() {
      return promptEl;
    },
    generateBtn,
    settingsBtn,
    finishGeneration,
    failGeneration,
    closePopover,
  };
}
