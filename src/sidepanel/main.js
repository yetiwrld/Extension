/**
 * Side panel entry point.
 *
 * The panel holds no automation state of its own: it renders the service
 * worker's snapshot and sends commands. Only UI state (notices, confirmations,
 * busy flag, open log) lives here.
 */
import { send, PanelError, hintFor } from './api.js';
import { libraryClient } from './library-client.js';
import { EXAMPLE_DOCUMENT } from './example.js';
import { copyTextToClipboard, formatDiagnosticsReport } from './diagnostics.js';
import * as R from './render.js';

const POLL_MS = 1500;
const CONNECTION_EVERY_N_POLLS = 2;

const ui = {
  busy: false,
  notice: null,
  confirmStart: false,
  logOpen: false,
  diagnostics: null,
  pendingAdd: null,
  docDirty: false,
};

let snapshot = null;
let library = [];
let refreshing = false;
let refreshQueued = false;
let pollCount = 0;
const cache = new Map();

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Replace a region's markup only when it changed. Never replace a region while
 * a text field inside it has focus, so typing is not interrupted. Keeps keyboard
 * focus on the same action button across re-renders.
 */
function mount(id, html) {
  const el = $(id);
  if (!el) return;
  const focused = document.activeElement;
  const typing = focused && el.contains(focused) && isTextEntry(focused);
  if (typing) return;
  if (cache.get(id) === html) return;

  const restore = focusSignature(focused, el);
  el.innerHTML = html;
  cache.set(id, html);
  if (restore) restoreFocus(el, restore);
}

/** Text entry only: a select or checkbox may re-render, its focus is restored afterwards. */
function isTextEntry(el) {
  if (el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && ['text', 'number', 'search', 'email', 'url'].includes(el.type);
}

function focusSignature(focused, region) {
  if (!focused || !region.contains(focused)) return null;
  const { action, sceneId, setting, pref, token, scene } = focused.dataset ?? {};
  return { tag: focused.tagName, action, sceneId, setting, pref, token, scene };
}

function restoreFocus(region, sig) {
  let selector = sig.tag === 'BUTTON' ? 'button' : sig.tag.toLowerCase();
  if (sig.action) selector += `[data-action="${cssEscape(sig.action)}"]`;
  if (sig.sceneId) selector += `[data-scene-id="${cssEscape(sig.sceneId)}"]`;
  if (sig.token) selector += `[data-token="${cssEscape(sig.token)}"]`;
  if (sig.setting) selector += `[data-setting="${cssEscape(sig.setting)}"]`;
  if (sig.pref) selector += `[data-pref="${cssEscape(sig.pref)}"]`;
  const target = region.querySelector(selector);
  if (target && !target.disabled) target.focus({ preventScroll: true });
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

function render() {
  if (!snapshot) return;
  mount('region-connection', R.renderConnection(snapshot));
  mount('region-notice', R.renderNotice(ui.notice));
  mount('region-flow-settings', R.renderFlowSettings(snapshot, ui));
  mount('region-document-count', R.renderDocumentCount(snapshot));
  mount('region-document-issues', R.renderDocumentIssues(snapshot));
  mount('region-library-count', R.renderLibraryCount(library));
  mount('region-library', R.renderLibrary(library, snapshot));
  mount('region-queue-counts', R.renderQueueCounts(snapshot));
  mount('region-queue-blockers', R.renderBlockers(snapshot));
  mount('region-queue', R.renderQueue(snapshot, ui));
  mount('region-phase', R.renderPhase(snapshot.automation));
  mount('region-automation', R.renderAutomation(snapshot, ui));
  mount('region-settings', R.renderSettings(snapshot, ui));
  mount('region-log-count', R.renderLogCount(snapshot.logs ?? []));
  mount('region-log', R.renderLog(snapshot.logs ?? [], ui));
  syncDocumentEditor();
}

/** Show the stored document in the editor unless the user is editing it. */
function syncDocumentEditor() {
  const editor = $('doc-input');
  if (!editor || ui.docDirty || document.activeElement === editor) return;
  const text = snapshot?.document?.text ?? '';
  if (editor.value !== text) editor.value = text;
}

function setNotice(notice) {
  ui.notice = notice;
  render();
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function refresh() {
  if (refreshing) {
    refreshQueued = true;
    return;
  }
  refreshing = true;
  try {
    snapshot = await send('getState');
    library = await libraryClient.list();
    render();
  } catch (error) {
    setNotice(noticeFor(error, 'The panel could not read the extension state.'));
  } finally {
    refreshing = false;
    if (refreshQueued) {
      refreshQueued = false;
      refresh();
    }
  }
}

function noticeFor(error, fallbackTitle) {
  if (error instanceof PanelError) {
    return {
      tone: 'error',
      title: error.message,
      hint: error.code && error.code !== 'UNKNOWN' ? hintFor(error.code) : '',
    };
  }
  return { tone: 'error', title: fallbackTitle, hint: error?.message ?? '' };
}

/**
 * Run a user action with a busy state, a visible result, and a recovery hint on failure.
 * `task` may return a notice to show on success.
 */
async function runAction(task) {
  ui.busy = true;
  render();
  try {
    const result = await task();
    if (result) {
      ui.notice = result;
    }
  } catch (error) {
    ui.notice = noticeFor(error, 'That did not work.');
  } finally {
    ui.busy = false;
    await refresh();
  }
}

const ok = (title, hint = '') => ({ tone: 'ok', title, hint });
const warn = (title, hint = '') => ({ tone: 'warn', title, hint });

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const ACTIONS = {
  analyze: () =>
    runAction(async () => {
      const text = $('doc-input').value;
      const result = await send('analyze', { text });
      ui.docDirty = false;
      if (result.errors.length) {
        return warn(
          `Analyzed ${result.sceneCount} scenes with ${result.errors.length} problem${result.errors.length === 1 ? '' : 's'}.`,
          'Fix the items listed under the document. Start stays disabled until they are resolved.',
        );
      }
      return ok(`Analyzed ${result.sceneCount} scenes.`, result.readiness.canStart ? 'Ready to start once Flow is connected.' : result.readiness.blockers[0]?.message ?? '');
    }),

  'load-example': () => {
    const editor = $('doc-input');
    if (editor.value.trim() && editor.value !== EXAMPLE_DOCUMENT && !window.confirm('Replace the scene document with the example?')) {
      return undefined;
    }
    editor.value = EXAMPLE_DOCUMENT;
    ui.docDirty = true;
    setNotice(ok('Example loaded.', 'Press Analyze scenes to build the queue.'));
    return undefined;
  },

  'add-refs': (dataset) => {
    ui.pendingAdd = dataset.token ? { token: dataset.token, scene: dataset.scene } : null;
    $('ref-input').click();
    return undefined;
  },

  'remove-ref': (dataset) =>
    runAction(async () => {
      await libraryClient.remove(dataset.id);
      await send('refreshReferences');
      return ok(`Removed ${dataset.name}.`);
    }),

  start: () => {
    if (snapshot?.prefs?.requireConfirmation) {
      ui.confirmStart = true;
      render();
      return undefined;
    }
    return startNow();
  },

  'confirm-start': () => {
    ui.confirmStart = false;
    return startNow();
  },

  'cancel-start': () => {
    ui.confirmStart = false;
    render();
    return undefined;
  },

  pause: () => runAction(async () => {
    await send('pause');
    return ok('Pausing after the current step.', 'The queue pauses at a safe point. Resume continues from there.');
  }),

  resume: () => runAction(async () => {
    await send('resume');
    return ok('Resuming.');
  }),

  stop: () => runAction(async () => {
    await send('stop');
    return warn('Stopping.', 'Generations already running in Flow keep running there. Start resumes waiting for them.');
  }),

  retry: (dataset) => runAction(async () => {
    await send('retry', { sceneId: dataset.sceneId });
    return ok('Retrying the scene.');
  }),

  skip: (dataset) => runAction(async () => {
    await send('skip', { sceneId: dataset.sceneId });
    return warn('Scene skipped.', 'Skipped scenes are not generated. You can regenerate them later from the document.');
  }),

  'mark-completed': (dataset) => {
    if (!window.confirm('Mark this scene completed? Only do this if its output is visible in Flow.')) return undefined;
    return runAction(async () => {
      await send('markCompleted', { sceneId: dataset.sceneId });
      return ok('Scene marked completed.');
    });
  },

  regenerate: (dataset) => {
    if (!window.confirm('Queue this completed scene to generate again? It runs when you start the queue.')) return undefined;
    return runAction(async () => {
      await send('regenerate', { sceneId: dataset.sceneId });
      return ok('Scene queued to regenerate.');
    });
  },

  'refresh-settings': () =>
    runAction(async () => {
      await send('refreshFlowSettings');
      return ok('Read Flow settings.');
    }),

  diagnose: () =>
    runAction(async () => {
      ui.diagnostics = await send('diagnoseFlow');
      const failing = (ui.diagnostics.checks ?? []).filter((check) => !check.ok && !check.warn).length;
      return failing
        ? warn(`${failing} check${failing === 1 ? '' : 's'} need attention.`, 'See the Flow page check below.')
        : ok('Flow page check passed.');
    }),

  'clear-project': () => {
    if (!window.confirm('Clear the scene document and queue? The reference library and settings are kept.')) return undefined;
    return runAction(async () => {
      ui.docDirty = false;
      await send('clearProject');
      return ok('Project cleared.');
    });
  },

  'clear-library': () => {
    if (!window.confirm('Remove every reference image from this browser? Scenes will show missing references until you add them again.')) return undefined;
    return runAction(async () => {
      await libraryClient.clear();
      await send('refreshReferences');
      return ok('Reference library cleared.');
    });
  },

  'copy-diagnostics': () =>
    runAction(async () => {
      const copied = await copyTextToClipboard(formatDiagnosticsReport(ui.diagnostics));
      return copied
        ? ok('Diagnostic report copied.', 'Paste it into a message or file to inspect it.')
        : warn('The report could not be copied automatically.', 'The report is shown above; select and copy it manually.');
    }),

  'clear-logs': () => runAction(async () => {
    await send('clearLogs');
    return null;
  }),

  'dismiss-notice': () => {
    ui.notice = null;
    render();
    return undefined;
  },
};

function startNow() {
  return runAction(async () => {
    await send('start');
    return ok('Automation started.', 'Each scene waits for Flow to finish before the next one begins.');
  });
}

async function onFilesChosen(files) {
  const pending = ui.pendingAdd;
  ui.pendingAdd = null;
  $('ref-input').value = '';
  if (!files.length) return;
  await runAction(async () => {
    const result = await libraryClient.add(files);
    await send('refreshReferences');
    const added = [...result.added, ...result.replaced];
    const rejected = result.rejected;
    if (!added.length) {
      return {
        tone: 'error',
        title: rejected.map((item) => `${item.name}: ${item.reason}`).join(' '),
        hint: 'Choose PNG, JPG, WEBP or GIF files under 25 MB.',
      };
    }
    let hint = rejected.length ? `Skipped: ${rejected.map((item) => item.name).join(', ')}.` : '';
    if (pending?.token) {
      const wanted = pending.token.toLowerCase();
      const found = library.some((item) => item.name.toLowerCase() === wanted) || result.items.some((item) => item.name.toLowerCase() === wanted);
      hint = found
        ? `${hint} Scene ${pending.scene ?? ''} can use ${pending.token} now.`.trim()
        : `${hint} Scene ${pending.scene ?? ''} still needs a file named exactly ${pending.token}.`.trim();
    }
    return { tone: rejected.length ? 'warn' : 'ok', title: `Added ${added.join(', ')}.`, hint };
  });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function onClick(event) {
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;
  const handler = ACTIONS[target.dataset.action];
  if (!handler) return;
  const result = handler(target.dataset);
  if (result && typeof result.then === 'function') result.catch(() => {});
}

function onChange(event) {
  const target = event.target;
  if (target.matches('select[data-setting]')) {
    const key = target.dataset.setting;
    const value = target.value;
    if (!value) return;
    runAction(async () => {
      await send('setFlowSetting', { key, value });
      return ok(`Set ${labelOfSetting(key)} to ${value} in Flow.`);
    });
    return;
  }
  if (target.matches('select[data-override]')) {
    const fileId = target.value;
    if (!fileId) return;
    runAction(async () => {
      await send('setOverride', { sceneNumber: Number(target.dataset.scene), tokenKey: target.dataset.token, fileId });
      const chosen = (snapshot?.queue?.scenes ?? [])
        .flatMap((scene) => scene.references ?? [])
        .find((ref) => ref.candidates?.some((item) => item.id === fileId));
      return ok(`Reference choice saved${chosen ? ` for ${chosen.token}` : ''}.`);
    });
    return;
  }
  if (target.matches('input[data-pref]')) {
    const key = target.dataset.pref;
    runAction(async () => {
      await send('setPrefs', { [key]: target.checked });
      return null;
    });
    return;
  }
  if (target.matches('input[data-pref-number]')) {
    const minutes = Number(target.value);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) {
      setNotice({ tone: 'error', title: 'Timeout must be between 1 and 120 minutes.', hint: 'Enter a whole number of minutes.' });
      return;
    }
    runAction(async () => {
      await send('setPrefs', { generationTimeoutMinutes: Math.round(minutes) });
      return ok(`Generation timeout set to ${Math.round(minutes)} min.`);
    });
  }
}

function labelOfSetting(key) {
  return { mode: 'Mode', model: 'Model', aspectRatio: 'Aspect ratio' }[key] ?? key;
}

function onInput(event) {
  if (event.target.id === 'doc-input') ui.docDirty = true;
}

function onToggle(event) {
  const details = event.target;
  if (details?.matches?.('[data-log-details]')) {
    ui.logOpen = details.open;
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 150);
}

async function poll() {
  pollCount += 1;
  if (pollCount % CONNECTION_EVERY_N_POLLS === 0) {
    try {
      await send('checkFlow');
    } catch {
      // The next getState reports the problem.
    }
  }
  await refresh();
}

function boot() {
  document.addEventListener('click', onClick);
  document.addEventListener('change', onChange);
  document.addEventListener('input', onInput);
  document.addEventListener('toggle', onToggle, true);
  $('ref-input').addEventListener('change', (event) => onFilesChosen(Array.from(event.target.files ?? [])));

  try {
    // Keeps the service worker alive while the panel is open.
    chrome.runtime.connect({ name: 'panel-heartbeat' });
  } catch {
    // Non-fatal: the worker still starts on each command.
  }

  chrome.storage?.onChanged?.addListener(scheduleRefresh);
  refresh().then(() => send('checkFlow').catch(() => {}));
  setInterval(poll, POLL_MS);
}

boot();
