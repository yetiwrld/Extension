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
const PLACEHOLDER_IMAGE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

export function installFlowFixture(window, {
  variant = 'textarea',
  flowWithMissingUpload = false,
  opaqueReferenceChips = false,
  projectPickerMode = 'confirm',
} = {}) {
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
    downloads: [],
    savedToProject: [],
  };

  doc.body.innerHTML = `
    <main>
      <header class="top"><button type="button" aria-label="Create new project">New project</button></header>
      <section class="results" id="results" aria-label="Results"></section>
      <div class="prompt-box" id="prompt-box">
        <div class="refs" id="refs"></div>
        <div class="controls-row">
          <button type="button" id="add-btn" aria-haspopup="menu" aria-label="Add ingredients to the prompt box">+ Add</button>
          <button type="button" id="settings-btn" aria-haspopup="menu" aria-expanded="false">${state.model} \u25be</button>
          <button type="button" id="agent" role="switch" aria-checked="false">Agent</button>
        </div>
        ${
          variant === 'contenteditable'
            ? '<div id="prompt" role="textbox" contenteditable="true" aria-label="Describe your image or video" class="editor"></div>'
            : '<textarea id="prompt" placeholder="Describe your image or video"></textarea>'
        }
        <button type="button" id="generate" aria-label="Generate">
          <span class="material-symbols">arrow_forward</span> Generate
        </button>
      </div>
      <div id="overlay-root"></div>
    </main>`;

  const $ = (sel) => doc.querySelector(sel);
  const promptEl = $('#prompt');
  const generateBtn = $('#generate');
  const settingsBtn = $('#settings-btn');
  const addBtn = $('#add-btn');
  const agentBtn = $('#agent');
  const overlay = $('#overlay-root');
  const refsEl = $('#refs');
  const resultsEl = $('#results');

  // The Upload control exists only while the Add menu is open, like a real menu.
  function closePopover() {
    overlay.innerHTML = '';
    settingsBtn.setAttribute('aria-expanded', 'false');
    addBtn.setAttribute('aria-expanded', 'false');
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

  addBtn.addEventListener('click', () => {
    closePopover();
    overlay.innerHTML = `
      <div role="menu" aria-label="Add">
        <button type="button" role="menuitem" id="upload-item">Upload image</button>
        <button type="button" role="menuitem" id="project-item">Use from project</button>
      </div>`;
    addBtn.setAttribute('aria-expanded', 'true');
    overlay.querySelector('#project-item').addEventListener('click', () => {
      overlay.innerHTML = `
        <div role="dialog" aria-label="Project media">
          <h3>Use from project</h3>
          ${['Aron.png', 'Laboratory.png', 'Vex.png', 'Dropped.png', 'hero_sheet_v1.jpeg', 'hero_sheet_v2.jpeg']
            .map((name) => `<button type="button" role="option" data-project-name="${name}" aria-label="${name}Image" aria-selected="false"><img alt="${name}" src="${PLACEHOLDER_IMAGE}">${name}Image</button>`)
            .join('')}
          ${projectPickerMode === 'confirm' ? '<button type="button" id="add-to-prompt">Add to prompt</button>' : ''}
        </div>`;
      const selectedProjectNames = new Set();
      for (const item of overlay.querySelectorAll('[data-project-name]')) {
        item.addEventListener('click', () => {
          if (projectPickerMode === 'auto') {
            addChip(item.dataset.projectName);
            closePopover();
            return;
          }
          const selected = item.getAttribute('aria-selected') !== 'true';
          item.setAttribute('aria-selected', selected ? 'true' : 'false');
          if (selected) selectedProjectNames.add(item.dataset.projectName);
          else selectedProjectNames.delete(item.dataset.projectName);
        });
      }
      overlay.querySelector('#add-to-prompt')?.addEventListener('click', () => {
        for (const name of selectedProjectNames) addChip(name);
        closePopover();
      });
    });
    overlay.querySelector('#upload-item').addEventListener('click', () => {
      if (flowWithMissingUpload) {
        closePopover();
        return;
      }
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

  function addChip(name) {
    state.references.push(name);
    const chip = doc.createElement('span');
    chip.className = opaqueReferenceChips ? 'opaque-token' : 'chip';
    if (!opaqueReferenceChips) {
      chip.innerHTML = `<img alt="${name}" src="${PLACEHOLDER_IMAGE}"><button type="button" aria-label="Remove ${name}">\u00d7</button>`;
      chip.querySelector('button').addEventListener('click', () => {
        state.references = state.references.filter((item) => item !== name);
        chip.remove();
      });
    }
    refsEl.appendChild(chip);
  }

  agentBtn.addEventListener('click', () => {
    const on = agentBtn.getAttribute('aria-checked') !== 'true';
    agentBtn.setAttribute('aria-checked', on ? 'true' : 'false');
  });

  function syncGenerate() {
    const empty = !(promptEl.value ?? promptEl.textContent ?? '').trim();
    generateBtn.disabled = empty;
  }
  promptEl.addEventListener('input', syncGenerate);
  promptEl.addEventListener('keyup', syncGenerate);

  generateBtn.addEventListener('click', () => {
    if (generateBtn.disabled) return;
    const text = (promptEl.value ?? promptEl.textContent ?? '').trim();
    state.submitted.push(text);
    state.generating += 1;
    const bar = doc.createElement('div');
    bar.setAttribute('role', 'progressbar');
    bar.className = 'progress';
    bar.dataset.gen = String(state.submitted.length);
    resultsEl.appendChild(bar);
  });

  function finishGeneration({ downloadVariant = 'direct' } = {}) {
    const bars = resultsEl.querySelectorAll('[role="progressbar"]');
    bars.forEach((bar) => bar.remove());
    state.generating = 0;
    state.outputs += 1;
    const outputNumber = state.outputs;
    const card = doc.createElement('article');
    card.className = 'output-card';
    const img = doc.createElement('img');
    img.setAttribute('src', `https://lh3.example.test/output-${outputNumber}.png`);
    img.setAttribute('alt', `Generated ${outputNumber}`);
    const showQuality = () => {
      overlay.innerHTML = '<div role="menu" aria-label="Download quality"><button type="button" role="menuitem">1K Original</button><flow-menu-item><button type="button" role="menuitem">2K Upscaled</button></flow-menu-item></div>';
      const options = overlay.querySelectorAll('[role="menuitem"]');
      options[0].addEventListener('click', () => state.downloads.push(`1K-${outputNumber}`));
      options[1].addEventListener('click', () => {
        state.downloads.push(outputNumber);
        closePopover();
      });
    };
    const control = doc.createElement('button');
    control.type = 'button';
    if (['menu', 'plain-menu', 'trusted-submenu', 'ambiguous-icons'].includes(downloadVariant)) {
      if (downloadVariant === 'ambiguous-icons') {
        control.innerHTML = '<svg><circle></circle><circle></circle><circle></circle></svg>';
      } else {
        control.setAttribute('aria-label', 'More actions');
        control.textContent = '⋮';
      }
      control.addEventListener('click', () => {
        overlay.innerHTML = downloadVariant === 'plain-menu'
          ? '<div class="floating-menu"><div class="download-row">Download image</div></div>'
          : '<div role="menu"><button type="button" role="menuitem">Download</button></div>';
        const row = overlay.querySelector(downloadVariant === 'plain-menu' ? '.download-row' : '[role="menuitem"]');
        row.addEventListener('click', () => state.downloads.push(`1K-${outputNumber}`));
        if (downloadVariant !== 'trusted-submenu') row.addEventListener('mouseover', showQuality);
      });
    } else {
      control.setAttribute('aria-label', 'Download media');
      control.textContent = 'Download media';
      control.addEventListener('click', showQuality);
    }
    if (downloadVariant === 'ambiguous-icons') {
      const save = doc.createElement('button');
      save.type = 'button';
      save.innerHTML = '<svg><path d="save-project-icon"></path></svg>';
      save.addEventListener('click', () => state.savedToProject.push(outputNumber));
      card.append(img, save, control);
    } else {
      card.append(img, control);
    }
    resultsEl.appendChild(card);
  }

  function failGeneration(message) {
    resultsEl.querySelectorAll('[role="progressbar"]').forEach((bar) => bar.remove());
    state.generating = 0;
    const alert = doc.createElement('div');
    alert.setAttribute('role', 'alert');
    alert.textContent = message;
    resultsEl.appendChild(alert);
  }

  if (flowWithMissingUpload) {
    promptEl.addEventListener('drop', (event) => {
      for (const file of Array.from(event.dataTransfer?.files ?? [])) addChip(file.name);
    });
  }

  renderSettingsButton();
  syncGenerate();

  return {
    state,
    doc,
    promptEl,
    generateBtn,
    settingsBtn,
    finishGeneration,
    failGeneration,
    closePopover,
  };
}
