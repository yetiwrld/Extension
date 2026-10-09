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
 *
 * Options:
 *   chipPlain        the model chip is a plain <div> with no button semantics (as on
 *                    the live page, where it was missed by every semantic selector)
 *   gearMenu         a gear button in the top toolbar opens a WRONG menu (view
 *                    options like "dashboardGrid"), reproducing the misread
 *   chipOpensViewMenu the chip itself opens the view menu (wrong menu, right control)
 *   chipDead         the chip opens nothing at all (the "menu did not open" path)
 *   liveMenu         the LIVE menu shape: mode + aspect ratios + output counts +
 *                    a nested "Select model family" submenu, and a chip that shows
 *                    "🍌 Nano Banana 2.1 crop_16_9 x1" (model + ratio + outputs)
 *   liveMenuDeep     the model submenu lists FAMILIES first; a family opens the models
 *   chipStale        the chip never updates its text (verification must fail loudly)
 *   flowComponents   the community DOM reference's shape: a flow-base-prompt-box
 *                    custom element whose SHADOW holds div.submit-controls with
 *                    button.settings-trigger-button (the visible model label is a
 *                    CHILD of the button), a flow-rich-text-editor.prompt-input
 *                    custom element whose shadow holds div.ProseMirror, a
 *                    flow-generate-icon-button with button.generate-icon-button,
 *                    and a settings menu rendered in a PORTAL at the body level
 *                    with NO ARIA roles (content-based detection must find it)
 *   agentMode        the migrated Agent-mode state: flow-prompt-box stays in the DOM
 *                    with a HIDDEN .settings-trigger-button (display:none, never
 *                    hit-testable), flow-creative-agent-prompt-box is the visible
 *                    composer with its own prompt, a visible model chip that opens
 *                    NOTHING, and button.agent-mode-chip[aria-pressed="true"].
 *                    Clicking the chip leaves Agent mode: the classic composer and
 *   uploadInShadow   the live upload shape: opening the Add menu mounts the file
 *                    input inside a custom element's SHADOW root, and the "Upload"
 *                    item only opens the OS dialog (which an extension cannot fill),
 *                    so the input must be found and filled without clicking it.
 *   uploadByDrop     the measured live shape: NO file input exists at any point and
 *                    the Add menu offers no usable upload item; the composer accepts
 *                    dropped files instead (event.dataTransfer.files).
 *   modeIconOnly     the measured live menu once ingredients are attached: NO Mode
 *                    rows at all, only a <mat-icon> whose ligature text reads
 *                    "image" (it must never be read, or clicked, as a Mode option).
 *   cdkBackdrop      the Angular CDK shape: closing the menu leaves a full-page
 *                    .cdk-overlay-backdrop behind, and the next press on the
 *                    trigger is consumed dismissing it instead of opening the menu
 *                    (the measured "the click changed nothing" failure). Escape or
 *                    an outside press clears it.
 *                    its settings trigger return. agentOnly renders the same migrated
 *                    composer with NO agent-mode chip at all (state B: agent-only).
 *                    agentChipStuck makes the click a
 *                    no-op (the recovery must then report, not claim success).
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

export function installFlowFixture(
  window,
  {
    variant = 'textarea',
    flowWithMissingUpload = false,
    lateComposerMs = 60,
    chipPlain = false,
    gearMenu = false,
    chipOpensViewMenu = false,
    chipDead = false,
    liveMenu = false,
    liveMenuDeep = false,
    chipStale = false,
    flowComponents = false,
    agentMode = false,
    agentChipStuck = false,
    agentOnly = false,
    decoratedModelRows = false,
    triggerNamedSettings = false,
    modeIconRow = false,
    cdkBackdrop = false,
    uploadInShadow = false,
    uploadByDrop = false,
    modeIconOnly = false,
  } = {},
) {
  const doc = window.document;
  const state = {
    mode: 'Image',
    model: liveMenu ? 'Nano Banana 2.1' : 'Nano Banana Pro',
    aspectRatio: '16:9',
    outputCount: 'x1',
    references: [],
    generating: 0,
    outputs: 0,
    alerts: [],
    submitted: [],
  };

  const agentLayout = variant === 'agent';
  const chipText = () =>
    liveMenu
      ? `\uD83C\uDF4C ${state.model} crop_${state.aspectRatio.replace(':', '_')} ${state.outputCount}`
      : `${state.model} \u25be`;
  const chip = liveMenu || chipPlain
    ? `<div id="settings-btn" class="model-chip">${chipText()}</div>`
    : `<button type="button" id="settings-btn" aria-haspopup="menu" aria-expanded="false">${chipText()}</button>`;
  const gear = gearMenu ? '<button type="button" id="gear" aria-haspopup="menu" aria-label="Settings">\u2699</button>' : '';
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
      <header class="top"><button type="button" aria-label="Create new project">New project</button>${gear}</header>
      <section class="results" id="results" aria-label="Results"></section>
      <div class="prompt-box" id="prompt-box">
        <div class="refs" id="refs"></div>
        <div class="controls-row">
          <button type="button" id="add-btn" aria-haspopup="menu">+ Add</button>
          ${chip}
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
  let slot = $('#prompt-slot');
  let generateBtn = $('#generate');
  let settingsBtn = $('#settings-btn');
  let addBtn = $('#add-btn');
  let agentBtn = $('#agent');
  let overlay = $('#overlay-root');
  let refsEl = $('#refs');
  let resultsEl = $('#results');
  let promptEl = null;

  // The community DOM reference's shape: custom elements with shadow roots, the
  // model label INSIDE the settings button, and the menu in a body-level portal.
  let componentShadow = null;
  if (flowComponents) {
    doc.body.innerHTML = `
    <main>
      <header class="top"><button type="button" aria-label="Create new project">New project</button>${gear}</header>
      <section class="results" id="results" aria-label="Results"></section>
      <flow-base-prompt-box id="prompt-box"></flow-base-prompt-box>
      <div id="overlay-root"></div>
    </main>`;
    const box = doc.getElementById('prompt-box');
    componentShadow = box.attachShadow({ mode: 'open' });
    componentShadow.innerHTML = `
      <div class="composer">
        <flow-rich-text-editor class="prompt-input"></flow-rich-text-editor>
        <div class="submit-controls">
          <button type="button" id="settings-btn" class="settings-trigger-button" aria-haspopup="menu" aria-expanded="false">
            <span class="model-chip">${chipText()}</span>
          </button>
          <flow-generate-icon-button></flow-generate-icon-button>
        </div>
      </div>`;
    const editorHost = componentShadow.querySelector('flow-rich-text-editor');
    const editorShadow = editorHost.attachShadow({ mode: 'open' });
    editorShadow.innerHTML = `<div class="ProseMirror" id="prompt" contenteditable="true" role="textbox" aria-placeholder="What do you want to create?"></div>`;
    const generateHost = componentShadow.querySelector('flow-generate-icon-button');
    const generateShadow = generateHost.attachShadow({ mode: 'open' });
    generateShadow.innerHTML = `<button type="button" id="generate" class="generate-icon-button" aria-label="Generate"><span class="material-symbols">arrow_forward</span></button>`;
    settingsBtn = componentShadow.getElementById('settings-btn');
    generateBtn = generateShadow.getElementById('generate');
    promptEl = editorShadow.getElementById('prompt');
    // body.innerHTML was replaced: re-resolve the document-level elements.
    overlay = doc.getElementById('overlay-root');
    resultsEl = doc.getElementById('results');
    refsEl = doc.getElementById('refs');
    promptEl.addEventListener('input', syncGenerate);
    promptEl.addEventListener('keyup', syncGenerate);
    addBtn = null;
    agentBtn = null;
    syncGenerate();
  }

  // ---------------------------------------------------------------------------
  // The migrated Agent-mode state: the classic composer stays in the DOM with a
  // HIDDEN settings trigger; flow-creative-agent-prompt-box is the visible composer
  // and carries button.agent-mode-chip[aria-pressed="true"]. Clicking the chip leaves
  // Agent mode and the classic composer (and its settings trigger) return.
  // ---------------------------------------------------------------------------
  let agentChipClicks = 0;
  const migrated = agentMode || agentOnly;
  if (migrated) {
    doc.body.innerHTML = `
    <main>
      <header class="top"><button type="button" aria-label="Create new project">New project</button>${gear}</header>
      <section class="results" id="results" aria-label="Results"></section>
      <flow-prompt-box id="classic-box" hidden>
        <div class="prompt-box" id="prompt-box">
          <div class="refs" id="refs"></div>
          <div class="controls-row">
            <button type="button" id="add-btn" aria-haspopup="menu">+ Add</button>
            <button type="button" id="settings-btn" class="settings-trigger-button" hidden aria-haspopup="menu" aria-expanded="false"><span class="model-chip">${chipText()}</span></button>
            <button type="button" id="agent" role="switch" aria-checked="false">Agent</button>
          </div>
          <div id="prompt-slot"></div>
          <button type="button" id="generate" aria-label="Generate"><span class="material-symbols">arrow_forward</span> Generate</button>
        </div>
      </flow-prompt-box>
      <flow-creative-agent-prompt-box id="agent-box">
        <div class="agent-composer">
          <div id="agent-prompt" contenteditable="true" role="textbox" aria-placeholder="Ask the agent to create something"></div>
          <span class="model-chip" id="agent-chip-label">${chipText()}</span>
          <div class="agent-footer-actions">
            <button type="button" class="agent-action-button" aria-label="Settings"><span class="material-symbols">tune</span></button>
          </div>
          <button type="button" class="agent-mode-chip" id="agent-mode-chip" aria-pressed="true" aria-label="Agent">Agent</button>
        </div>
      </flow-creative-agent-prompt-box>
      <div id="overlay-root"></div>
    </main>`;
    // Re-resolve the document-level elements (body.innerHTML was replaced).
    overlay = doc.getElementById('overlay-root');
    resultsEl = doc.getElementById('results');
    refsEl = doc.getElementById('refs');
    slot = doc.getElementById('prompt-slot');
    settingsBtn = doc.getElementById('settings-btn');
    generateBtn = doc.getElementById('generate');
    addBtn = doc.getElementById('add-btn');
    agentBtn = doc.getElementById('agent');
    promptEl = doc.getElementById('agent-prompt');
    const classicBox = doc.getElementById('classic-box');
    const agentBox = doc.getElementById('agent-box');
    if (agentOnly) doc.getElementById('agent-mode-chip')?.remove();
    const chip = doc.getElementById('agent-mode-chip');
    const agentLabel = doc.getElementById('agent-chip-label');
    promptEl.addEventListener('input', syncGenerate);
    promptEl.addEventListener('keyup', syncGenerate);
    chip?.addEventListener('click', () => {
      agentChipClicks += 1;
      if (agentChipStuck) return; // the click is a no-op: the recovery must report
      chip.setAttribute('aria-pressed', 'false');
      agentBox.hidden = true;
      classicBox.hidden = false;
      settingsBtn.hidden = false;
      settingsBtn.setAttribute('aria-expanded', 'false');
      attachComposer();
      promptEl = $('#prompt');
      promptEl.addEventListener('input', syncGenerate);
      promptEl.addEventListener('keyup', syncGenerate);
      syncGenerate();
    });
    // The visible model chip in the AGENT composer opens NOTHING (the live failure).
    agentLabel.addEventListener('click', () => {});
    // Expose the click counter for the recovery tests.
    state.agentChipClicks = () => agentChipClicks;
  }

  /** Insert the composer for this variant (standard layouts) and wire its events. */
  function attachComposer() {
    if (agentLayout || flowComponents) return; // the composer is already in place
    // Agent mode: the classic composer is hidden; attach only once it returns.
    if (migrated && doc.getElementById('classic-box')?.hidden) return;
    slot.innerHTML = COMPOSER_HTML[variant] ?? COMPOSER_HTML.textarea;
    promptEl = $('#prompt');
    if (!promptEl) return;
    promptEl.addEventListener('input', syncGenerate);
    promptEl.addEventListener('keyup', syncGenerate);
    syncGenerate();
  }

  // The Upload control exists only while the Add menu is open, like a real menu.
  /** @returns {boolean} true when a backdrop was present and this press consumed it. */
  function dismissBackdrop() {
    const backdrop = doc.querySelector('.cdk-overlay-backdrop');
    if (!backdrop) return false;
    backdrop.remove();
    return true;
  }

  function closePopover() {
    const hadMenu = Boolean(overlay.innerHTML);
    overlay.innerHTML = '';
    if (cdkBackdrop && hadMenu && !doc.querySelector('.cdk-overlay-backdrop')) {
      const backdrop = doc.createElement('div');
      backdrop.className = 'cdk-overlay-backdrop';
      doc.body.appendChild(backdrop);
    }
    settingsBtn.setAttribute('aria-expanded', 'false');
    if (addBtn) addBtn.setAttribute('aria-expanded', 'false');
  }

  function renderSettingsButton() {
    if (chipStale) return; // the chip never updates: verification must fail loudly
    const chipEl = settingsBtn.querySelector?.('.model-chip');
    if (chipEl) chipEl.textContent = chipText(); // the label lives inside the button
    else settingsBtn.textContent = chipText();
  }

  // ---------------------------------------------------------------------------
  // The LIVE menu shape: mode, aspect ratios, output counts, and the model list
  // nested behind "Select model family". The chip shows model + ratio + outputs.
  // ---------------------------------------------------------------------------

  const LIVE_MODELS = {
    'Nano Banana': ['Nano Banana 2.1', 'Nano Banana Pro'],
    Veo: ['Veo 3.1', 'Veo 3'],
  };

  function liveRadio(key, value) {
    const role = flowComponents ? '' : ' role="menuitemradio"';
    return `<div${role} data-key="${key}" data-value="${value}" aria-checked="${state[key] === value ? 'true' : 'false'}">${value}</div>`;
  }

  function wireLiveRadios() {
    for (const item of overlay.querySelectorAll('[data-key]')) {
      item.addEventListener('click', () => {
        const key = item.dataset.key;
        if (key === 'outputCount') state.outputCount = item.dataset.value;
        else state[key] = item.dataset.value;
        for (const sibling of overlay.querySelectorAll(`[data-key="${key}"]`)) {
          sibling.setAttribute('aria-checked', sibling === item ? 'true' : 'false');
        }
        renderSettingsButton();
      });
    }
  }

  function openModelList(family) {
    overlay.innerHTML = `
      ${flowComponents ? '<div class="flow-settings-menu model-menu">' : '<div role="menu" aria-label="Model family" data-popover="model-list">'}
        ${LIVE_MODELS[family].map((name) => `<div${flowComponents ? '' : ' role="menuitemradio"'} data-key="model" data-value="${name}" aria-checked="${state.model === name ? 'true' : 'false'}">${decoratedModelRows ? `\u{1F34C} ${name} Fast image generation` : name}</div>`).join('')}
      </div>`;
    for (const item of overlay.querySelectorAll('[data-key="model"]')) {
      item.addEventListener('click', () => {
        state.model = item.dataset.value;
        renderSettingsButton();
        closePopover(); // a leaf model choice closes the menu, as Flow does
      });
    }
  }

  function openModelFamilyMenu() {
    if (!liveMenuDeep) {
      // Flat shape: the nested menu lists every model directly.
      overlay.innerHTML = `
        ${flowComponents ? '<div class="flow-settings-menu model-menu">' : '<div role="menu" aria-label="Model family" data-popover="model-list">'}
          ${Object.values(LIVE_MODELS)
            .flat()
            .map((name) => `<div${flowComponents ? '' : ' role="menuitemradio"'} data-key="model" data-value="${name}" aria-checked="${state.model === name ? 'true' : 'false'}">${name}</div>`)
            .join('')}
        </div>`;
      for (const item of overlay.querySelectorAll('[data-key="model"]')) {
        item.addEventListener('click', () => {
          state.model = item.dataset.value;
          renderSettingsButton();
          closePopover(); // a leaf model choice closes the menu, as Flow does
        });
      }
      return;
    }
    overlay.innerHTML = `
      ${flowComponents ? '<div class="flow-settings-menu family-menu">' : '<div role="menu" aria-label="Model family" data-popover="model-family">'}
        ${Object.keys(LIVE_MODELS)
          .map((family) => `<div class="family" role="menuitem" aria-haspopup="menu" data-family="${family}">${family}</div>`)
          .join('')}
      </div>`;
    for (const item of overlay.querySelectorAll('.family')) {
      item.addEventListener('click', () => openModelList(item.dataset.family));
    }
  }

  function openLiveSettings() {
    closePopover();
    // The component shape renders the menu in a body-level portal with NO ARIA roles:
    // it must be found by its content, not by role-based selectors.
    const surface = flowComponents
      ? '<div class="flow-settings-menu">'
      : '<div role="menu" aria-label="Generation settings" data-popover="settings">';
    overlay.innerHTML = `
      ${surface}
        ${modeIconRow || modeIconOnly ? '<mat-icon role="img" class="material-symbols">image</mat-icon>' : ''}
        ${modeIconOnly ? '' : `${liveRadio('mode', 'Image')}\n        ${liveRadio('mode', 'Video')}`}
        ${liveRadio('aspectRatio', '16:9')}
        ${liveRadio('aspectRatio', '4:3')}
        ${liveRadio('aspectRatio', '1:1')}
        ${liveRadio('aspectRatio', '3:4')}
        ${liveRadio('aspectRatio', '9:16')}
        <div id="model-family" role="menuitem" aria-haspopup="menu">Select model family</div>
        ${liveRadio('outputCount', 'x1')}
        ${liveRadio('outputCount', 'x2')}
        ${liveRadio('outputCount', 'x3')}
        ${liveRadio('outputCount', 'x4')}
      </div>`;
    settingsBtn.setAttribute('aria-expanded', 'true');
    wireLiveRadios();
    const familyTrigger = overlay.querySelector('#model-family') ?? doc.getElementById('model-family');
    familyTrigger.addEventListener('click', openModelFamilyMenu);
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
    if (event.key === 'Escape') {
      if (cdkBackdrop && dismissBackdrop()) return;
      closePopover();
    }
  });

  settingsBtn.addEventListener('click', () => {
    if (chipDead) return; // the control opens nothing
    // A leftover CDK backdrop consumes the press: the overlay is dismissed and the
    // menu does NOT open. This is what made a mid-run click look like a dead control.
    if (cdkBackdrop && dismissBackdrop()) return;
    if (liveMenu) {
      if (settingsBtn.getAttribute('aria-expanded') === 'true') closePopover();
      else openLiveSettings();
      return;
    }
    if (chipOpensViewMenu) {
      // The right control, the wrong menu: a view menu, not generation settings.
      closePopover();
      overlay.innerHTML = `
        <div role="menu" aria-label="View">
          <div role="menuitemradio" data-value="dashboardGrid" aria-checked="true">dashboardGrid</div>
          <div role="menuitemradio" data-value="listView" aria-checked="false">listView</div>
        </div>`;
      settingsBtn.setAttribute('aria-expanded', 'true');
      return;
    }
    if (settingsBtn.getAttribute('aria-expanded') === 'true') closePopover();
    else openSettings();
  });

  // The gear opens a DIFFERENT menu (view options), like a toolbar settings control
  // that has nothing to do with generation settings.
  const gearBtn = $('#gear');
  if (gearBtn) {
    gearBtn.addEventListener('click', () => {
      closePopover();
      overlay.innerHTML = `
        <div role="menu" aria-label="View">
          <div role="menuitemradio" data-value="dashboardGrid" aria-checked="true">dashboardGrid</div>
          <div role="menuitemradio" data-value="listView" aria-checked="false">listView</div>
        </div>`;
      gearBtn.setAttribute('aria-expanded', 'true');
    });
  }

  if (addBtn) {
    addBtn.addEventListener('click', () => {
      closePopover();
      overlay.innerHTML = uploadByDrop
        ? `
        <div role="menu" aria-label="Add">
          <button type="button" role="menuitem">Use from project</button>
        </div>`
        : `
        <div role="menu" aria-label="Add">
          <button type="button" role="menuitem" id="upload-item">Upload image</button>
          <button type="button" role="menuitem">Use from project</button>
        </div>`;
      addBtn.setAttribute('aria-expanded', 'true');
      const mountFileInput = (parent) => {
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
        parent.appendChild(input);
        return input;
      };
      if (uploadInShadow && !doc.querySelector('flow-upload-host')) {
        // Flow mounts the input WITH the menu, inside a shadow root.
        const host = doc.createElement('flow-upload-host');
        doc.body.appendChild(host);
        mountFileInput(host.attachShadow({ mode: 'open' }));
      }
      overlay.querySelector('#upload-item')?.addEventListener('click', () => {
        // The live item opens the OS file dialog: nothing changes in the page.
        if (uploadInShadow) return;
        if (!doc.querySelector('input[type="file"]')) mountFileInput($('#prompt-box'));
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

  if (agentBtn) {
    agentBtn.addEventListener('click', () => {
      const on = agentBtn.getAttribute('aria-checked') !== 'true';
      agentBtn.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }

  function syncGenerate() {
    if (!promptEl || !generateBtn) return;
    const empty = !(promptEl.value ?? promptEl.textContent ?? '').trim();
    generateBtn.disabled = empty;
  }

  if (agentLayout) {
    promptEl = $('#prompt');
    promptEl.addEventListener('input', syncGenerate);
    promptEl.addEventListener('keyup', syncGenerate);
  }

  if (generateBtn) {
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
  }

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
  if (uploadByDrop) {
    // The composer accepts dropped files, like the live page does.
    const dropTarget = doc.getElementById('prompt-box') ?? doc.body;
    // A real drop target must preventDefault on dragover; that is what makes it one.
    dropTarget.addEventListener('dragover', (event) => event.preventDefault());
    dropTarget.addEventListener('drop', (event) => {
      for (const file of Array.from(event.dataTransfer?.files ?? [])) addChip(file.name);
    });
  }

  // The live page names the trigger BUTTON "Settings trigger" and shows the value in
  // a child span: the accessible name is the control's name, not the chip's value.
  if (triggerNamedSettings && settingsBtn) settingsBtn.setAttribute('aria-label', 'Settings trigger');
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
