import { esc, bytes, clock, plural, truncate } from './html.js';
import { hintFor } from './api.js';

/**
 * View functions. Each returns an HTML string built only from escaped values.
 * Labels and symbols follow the spec: ● ○ ✓ ⚠ ✕ ▶ ⏸ ■.
 */

export const STATUS = Object.freeze({
  waiting: { icon: '○', label: 'Waiting', active: false },
  preparing: { icon: '▶', label: 'Preparing', active: true },
  uploading: { icon: '▶', label: 'Uploading', active: true },
  inserting: { icon: '▶', label: 'Preparing', active: true },
  submitting: { icon: '▶', label: 'Generating', active: true },
  generating: { icon: '▶', label: 'Generating', active: true },
  completed: { icon: '✓', label: 'Completed', active: false },
  failed: { icon: '✕', label: 'Failed', active: false },
  retrying: { icon: '⚠', label: 'Retrying', active: false },
  paused: { icon: '⏸', label: 'Paused', active: false },
  skipped: { icon: '○', label: 'Skipped', active: false },
});

const PHASE = Object.freeze({
  idle: { label: 'Idle', icon: '○', cls: '' },
  connecting: { label: 'Connecting', icon: '●', cls: 'is-running' },
  running: { label: 'Running', icon: '▶', cls: 'is-running' },
  pausing: { label: 'Pausing', icon: '⏸', cls: 'is-paused' },
  paused: { label: 'Paused', icon: '⏸', cls: 'is-paused' },
  stopping: { label: 'Stopping', icon: '■', cls: '' },
  stopped: { label: 'Stopped', icon: '■', cls: '' },
  completed: { label: 'Completed', icon: '✓', cls: 'is-done' },
  error: { label: 'Error', icon: '✕', cls: 'is-error' },
});

const ACTIVE_PHASES = new Set(['connecting', 'running', 'pausing', 'stopping']);

export function isActive(automation) {
  return ACTIVE_PHASES.has(automation?.phase);
}

export function renderConnection(snapshot) {
  const connection = snapshot?.connection ?? { status: 'not_connected', message: 'Checking Flow connection\u2026' };
  const on = connection.status === 'connected';
  const message = connection.message ?? '';
  // The detail line is only useful when something needs the user's attention: a failed
  // check, no prompt box, or a connected tab whose settings control was not detected.
  const needsAttention = !on || connection.promptFound === false || connection.settingsFound === false;
  const detail = needsAttention ? truncate(message, 110) : '';
  return `
    <div class="conn-state ${on ? 'is-on' : 'is-off'}" data-connection="${on ? 'connected' : 'not-connected'}" title="${esc(message)}">${on ? '\u25cf Connected' : '\u25cb Not Connected'}</div>
    ${detail ? `<div class="conn-detail">${esc(detail)}</div>` : ''}`;
}

export function renderFlowSettings(snapshot, ui) {
  const settings = snapshot?.flowSettings ?? { current: {}, options: {} };
  const active = isActive(snapshot?.automation);
  const connected = snapshot?.connection?.status === 'connected';
  const readable = connected && !active;
  const readText = settings.readError
    ? `Read failed: ${settings.readError}`
    : settings.readAt
      ? `Last read ${clock(settings.readAt)}.`
      : 'Not read yet. Open a Flow project, then press Read from Flow.';
  // Ground truth straight from the composer: the model chip's own text.
  const chipModel = snapshot?.connection?.detectedSettings?.model ?? null;
  const chipNote = chipModel ? `<p class="settings-note">Flow's composer shows: model ${esc(chipModel)}.</p>` : '';
  return `
    <div class="card-head">
      <h2 id="h-flow-settings">Flow settings</h2>
      <button type="button" class="btn btn-secondary btn-sm" data-action="refresh-settings" ${readable && !ui.busy ? '' : 'disabled'}>Read from Flow</button>
    </div>
    <p class="settings-note">These are Flow's own settings. Changing a value here changes it in Flow.${active ? ' Locked while automation is running.' : ''}</p>
    <div class="field-grid">
      ${settingSelect('mode', 'Mode', settings, readable && !ui.busy)}
      ${settingSelect('model', 'Model', settings, readable && !ui.busy)}
      ${settingSelect('aspectRatio', 'Aspect ratio', settings, readable && !ui.busy)}
    </div>
    <p class="settings-note">${esc(readText)}</p>
    ${chipNote}`;
}

/** What an empty select shows: never read / read but unknown / not offered in this mode. */
function settingEmptyValue(key, settings, enabled) {
  if (settings.readAt) return key === 'aspectRatio' ? 'Not offered in this mode' : 'Unknown';
  return enabled ? 'Not read yet' : 'Unavailable';
}

function settingSelect(key, label, settings, enabled) {
  const options = Array.isArray(settings.options?.[key]) ? settings.options[key] : [];
  const current = settings.current?.[key] ?? '';
  if (!options.length) {
    // Flow exposed no choices: show its value (or the state), and offer nothing to pick.
    const shown = current || settingEmptyValue(key, settings, enabled);
    return `
    <label class="field">
      <span class="field-label">${esc(label)}</span>
      <select data-setting="${esc(key)}" disabled aria-label="${esc(label)}"><option value="">${esc(shown)}</option></select>
    </label>`;
  }
  const list = current && !options.includes(current) ? [current, ...options] : options;
  const body = list
    .map((name) => `<option value="${esc(name)}" ${name === current ? 'selected' : ''}>${esc(name)}</option>`)
    .join('');
  return `
    <label class="field">
      <span class="field-label">${esc(label)}</span>
      <select data-setting="${esc(key)}" ${enabled ? '' : 'disabled'} aria-label="${esc(label)}">${body}</select>
    </label>`;
}

export function renderDocumentCount(snapshot) {
  const count = snapshot?.document?.sceneCount ?? 0;
  return `<span class="badge">${esc(plural(count, 'scene'))}</span>`;
}

export function renderDocumentIssues(snapshot) {
  const doc = snapshot?.document ?? {};
  const errors = doc.errors ?? [];
  const warnings = doc.warnings ?? [];
  if (!doc.analyzedAt && !errors.length) {
    return `<p class="muted small">Paste your scene document, then press Analyze scenes. Each [Scene N] block becomes one queue item.</p>`;
  }
  const lines = [
    ...errors.map((item) => `<div class="issue issue-error"><span class="issue-icon">✕</span><span>${esc(item.message)}</span></div>`),
    ...warnings.map((item) => `<div class="issue issue-warning"><span class="issue-icon">⚠</span><span>${esc(item.message)}</span></div>`),
  ];
  if (doc.analyzedAt && !errors.length) {
    lines.unshift(`<div class="ok-line">✓ ${esc(plural(doc.sceneCount, 'scene'))} ready.</div>`);
  }
  return `<div class="issues">${lines.join('')}</div>`;
}

export function renderLibraryCount(library) {
  return `<span class="badge">${esc(plural(library.length, 'file'))}</span>`;
}

export function renderLibrary(library, snapshot) {
  if (!library.length) {
    return `<p class="muted small">No reference files yet. Add the images your scenes name, such as Aron.png.</p>`;
  }
  const locked = isActive(snapshot?.automation);
  const items = library
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .map(
      (item) => `
      <li class="ref-item">
        <span class="ref-name">${esc(item.name)}</span>
        <span class="ref-size">${esc(bytes(item.size))}</span>
        <button type="button" class="btn btn-ghost btn-sm" data-action="remove-ref" data-id="${esc(item.id)}" data-name="${esc(item.name)}" ${locked ? 'disabled' : ''} aria-label="Remove ${esc(item.name)}">Remove</button>
      </li>`,
    )
    .join('');
  return `<ul class="ref-list">${items}</ul>${locked ? '<p class="settings-note">Removing files is locked while automation runs.</p>' : ''}`;
}

export function renderQueueCounts(snapshot) {
  const counts = snapshot?.queue?.counts ?? { total: 0, completed: 0, failed: 0 };
  if (!counts.total) return '';
  const parts = [`${counts.completed} completed`];
  if (counts.failed) parts.push(`${counts.failed} failed`);
  parts.push(`${counts.total} total`);
  return `<span class="muted small">${esc(parts.join(' \u00b7 '))}</span>`;
}

export function renderBlockers(snapshot) {
  const readiness = snapshot?.readiness;
  if (!readiness || readiness.canStart || !(snapshot?.queue?.scenes ?? []).length) return '';
  const first = readiness.blockers.slice(0, 4);
  return `
    <div class="blockers" role="status">
      ${first.map((item) => `<div class="blocker"><span>\u26a0 ${esc(item.message)}</span></div>`).join('')}
      ${readiness.blockers.length > first.length ? `<p class="settings-note">${esc(`${readiness.blockers.length - first.length} more in the scene list below.`)}</p>` : ''}
    </div>`;
}

export function renderQueue(snapshot, ui) {
  const scenes = snapshot?.queue?.scenes ?? [];
  if (!scenes.length) {
    return `<p class="muted small">No scenes yet. Analyze a scene document to fill the queue.</p>`;
  }
  const locked = isActive(snapshot.automation);
  const paused = snapshot.automation?.phase === 'paused';
  const items = scenes.map((scene) => renderScene(scene, { locked, paused, busy: ui.busy })).join('');
  return `<ol class="scene-list" aria-label="Scenes">${items}</ol>`;
}

function renderScene(scene, { locked, paused, busy }) {
  const meta = STATUS[scene.status] ?? STATUS.waiting;
  const title = scene.title ? `${scene.numberLabel} \u00b7 ${scene.title}` : `Scene ${scene.numberLabel}`;
  const isFailed = scene.status === 'failed';
  const refs = (scene.references ?? []).map((ref) => renderChip(scene, ref)).join('');
  const chooser = (scene.references ?? [])
    .filter((ref) => ref.status === 'ambiguous')
    .map((ref) => renderChooser(scene, ref))
    .join('');
  const actions = sceneActions(scene, { locked, paused, busy });
  const detail = scene.detail ? `<p class="scene-detail ${isFailed ? 'is-error' : ''}">${esc(truncate(scene.detail, 240))}</p>` : '';
  const errorHint = isFailed && scene.error?.code ? `<p class="scene-detail is-error">${esc(hintFor(scene.error.code))}</p>` : '';
  const sceneClass = `scene s-${esc(scene.status)} ${meta.active ? 'is-active' : ''}`;
  return `
    <li class="${sceneClass}" data-scene-id="${esc(scene.id)}">
      <div class="scene-head">
        <span class="scene-icon" aria-hidden="true">${meta.icon}</span>
        <span class="scene-title">${esc(title)}</span>
        <span class="scene-status">${esc(meta.label)}</span>
      </div>
      <p class="scene-prompt">${esc(truncate(scene.prompt, 180))}</p>
      ${refs ? `<div class="chips" aria-label="References">${refs}</div>` : '<p class="faint small">No references.</p>'}
      ${chooser}
      ${detail}
      ${errorHint}
      ${actions ? `<div class="scene-actions">${actions}</div>` : ''}
    </li>`;
}

function renderChip(scene, ref) {
  const sceneNumber = scene.number;
  if (ref.status === 'matched') {
    const by = ref.source === 'stem' ? ' (matched by name)' : ref.source === 'override' ? ' (chosen)' : '';
    return `<span class="chip is-ok"><span class="chip-icon">✓</span>${esc(ref.fileName)}${esc(by)}</span>`;
  }
  if (ref.status === 'missing') {
    return `<span class="chip is-missing"><span class="chip-icon">✕</span>${esc(ref.token)}</span>
      <button type="button" class="btn btn-secondary btn-sm" data-action="add-refs" data-scene="${sceneNumber}" data-token="${esc(ref.token)}" aria-label="Add reference for ${esc(ref.token)}">Add reference</button>`;
  }
  return `<span class="chip is-ambiguous"><span class="chip-icon">\u26a0</span>${esc(ref.token)}</span>`;
}

function renderChooser(scene, ref) {
  const candidates = ref.candidates ?? [];
  const options = candidates.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
  return `
    <div class="choose-row" data-chooser>
      <span class="small muted">${esc(ref.hint || `Choose the file for ${ref.token}.`)}</span>
      <select data-override data-scene="${scene.number}" data-token="${esc(ref.key ?? ref.token.toLowerCase())}" aria-label="Choose file for ${esc(ref.token)} in scene ${esc(scene.numberLabel)}">
        <option value="">Choose a file\u2026</option>${options}
      </select>
    </div>`;
}

function sceneActions(scene, { locked, paused, busy }) {
  const buttons = [];
  const disabled = busy ? 'disabled' : '';
  const sceneAttr = `data-scene-id="${esc(scene.id)}"`;
  const btn = (action, label, cls = 'btn-secondary', extra = '') =>
    `<button type="button" class="btn btn-sm ${cls}" data-action="${action}" ${sceneAttr} ${extra} ${disabled}>${esc(label)}</button>`;

  if (locked && !paused) return '';
  switch (scene.status) {
    case 'waiting':
      buttons.push(btn('skip', 'Skip', 'btn-ghost'));
      break;
    case 'failed':
      buttons.push(btn('retry', 'Retry', 'btn-primary'));
      buttons.push(btn('skip', 'Skip', 'btn-secondary'));
      buttons.push(btn('mark-completed', 'Mark completed', 'btn-ghost'));
      break;
    case 'paused':
      buttons.push(btn('skip', 'Skip', 'btn-ghost'));
      if (scene.resumeStep === 'generating' || scene.resumeStep === 'submitting') {
        buttons.push(btn('mark-completed', 'Mark completed', 'btn-ghost'));
      }
      break;
    case 'completed':
      buttons.push(btn('regenerate', 'Regenerate', 'btn-ghost'));
      break;
    default:
      break;
  }
  return buttons.join('');
}

export function renderPhase(automation) {
  const meta = PHASE[automation?.phase] ?? PHASE.idle;
  return `<span class="phase ${meta.cls}" data-phase="${esc(automation?.phase ?? 'idle')}">${meta.icon} ${esc(meta.label)}</span>`;
}

export function renderAutomation(snapshot, ui) {
  const automation = snapshot?.automation ?? {};
  const readiness = snapshot?.readiness ?? { canStart: false, blockers: [] };
  const connected = snapshot?.connection?.status === 'connected';
  const phase = automation.phase ?? 'idle';
  const active = isActive(automation);
  const paused = phase === 'paused';
  const decision = automation.decision;
  const queueScenes = snapshot?.queue?.scenes ?? [];
  const current = queueScenes.find((scene) => scene.id === automation.currentSceneId);
  const pendingCount = readiness.pending ?? 0;

  const parts = [];
  if (automation.message) {
    parts.push(`<p class="status-line">${esc(automation.message)}</p>`);
  }
  if (current && active) {
    parts.push(`<p class="small muted">Scene ${esc(current.numberLabel)} \u00b7 ${esc(STATUS[current.status]?.label ?? current.status)}</p>`);
  }
  if (active && automation.progress) {
    parts.push(`<div class="progress-track" aria-hidden="true"><div class="progress-fill"></div></div>`);
    if (automation.progress.detail) parts.push(`<p class="small muted">${esc(automation.progress.detail)}</p>`);
  }

  if (decision && paused) {
    parts.push(renderDecision(decision, queueScenes, ui));
  }

  if (ui.confirmStart && !active) {
    const s = snapshot?.flowSettings?.current ?? {};
    const settingsText = [s.mode, s.model, s.aspectRatio].filter(Boolean).join(' \u00b7 ') || 'as currently set in Flow';
    parts.push(`
      <div class="confirm" role="dialog" aria-label="Confirm start">
        <h3>Start ${esc(plural(pendingCount, 'scene'))} in Flow?</h3>
        <p class="small muted">Settings: ${esc(settingsText)}. Each scene is submitted only after the previous one finishes in Flow.</p>
        <div class="row">
          <button type="button" class="btn btn-primary" data-action="confirm-start" ${ui.busy ? 'disabled' : ''}>\u25b6 Start queue</button>
          <button type="button" class="btn btn-ghost" data-action="cancel-start">Cancel</button>
        </div>
      </div>`);
  }

  const controls = [];
  const busy = ui.busy ? 'disabled' : '';
  if (!active && !paused) {
    const canStart = connected && readiness.canStart;
    controls.push(`<button type="button" class="btn btn-primary" data-action="start" ${canStart && !busy ? '' : 'disabled'}>\u25b6 Start queue</button>`);
  }
  if (phase === 'running' || phase === 'connecting') {
    controls.push(`<button type="button" class="btn btn-secondary" data-action="pause" ${busy}>\u23f8 Pause</button>`);
  }
  if (paused) {
    const resumable = !decision || (decision.actions ?? []).includes('resume') || (decision.actions ?? []).includes('continue');
    if (resumable) {
      controls.push(`<button type="button" class="btn btn-primary" data-action="resume" ${connected && !busy ? '' : 'disabled'}>\u25b6 Resume</button>`);
    }
  }
  if (active || paused) {
    controls.push(`<button type="button" class="btn btn-danger" data-action="stop" ${phase === 'stopping' || busy ? 'disabled' : ''}>\u25a0 Stop</button>`);
  }
  if (controls.length) {
    parts.push(`<div class="controls">${controls.join('')}</div>`);
  }

  const hints = [];
  if (!connected && !active) hints.push('Connect to Flow first: open a Flow project in the active tab.');
  if (!readiness.canStart && !active && queueScenes.length) {
    hints.push(`Start is disabled: ${readiness.blockers[0]?.message ?? 'resolve the issues above.'}`);
  }
  if (phase === 'completed' && !readiness.canStart) hints.push('Every scene is finished.');
  if (hints.length) {
    parts.push(hints.map((text) => `<p class="blocked-hint">${esc(text)}</p>`).join(''));
  }
  return parts.join('');
}

function renderDecision(decision, scenes, ui) {
  const scene = scenes.find((item) => item.id === decision.sceneId);
  const busy = ui.busy ? 'disabled' : '';
  const buttons = (decision.actions ?? []).map((action) => {
    switch (action) {
      case 'resume':
        return `<button type="button" class="btn btn-primary" data-action="resume" ${busy}>\u25b6 Resume</button>`;
      case 'continue':
        return `<button type="button" class="btn btn-primary" data-action="resume" ${busy}>\u25b6 Continue</button>`;
      case 'retry':
        return `<button type="button" class="btn btn-primary" data-action="retry" data-scene-id="${esc(decision.sceneId ?? '')}" ${busy}>Retry${scene ? ` Scene ${esc(scene.numberLabel)}` : ''}</button>`;
      case 'skip':
        return `<button type="button" class="btn btn-secondary" data-action="skip" data-scene-id="${esc(decision.sceneId ?? '')}" ${busy}>Skip${scene ? ` Scene ${esc(scene.numberLabel)}` : ''}</button>`;
      case 'mark-completed':
        return `<button type="button" class="btn btn-secondary" data-action="mark-completed" data-scene-id="${esc(decision.sceneId ?? '')}" ${busy}>Mark completed</button>`;
      case 'stop':
        return `<button type="button" class="btn btn-danger" data-action="stop" ${busy}>\u25a0 Stop automation</button>`;
      default:
        return '';
    }
  });
  const hint = decision.code ? hintFor(decision.code) : '';
  return `
    <div class="decision" role="alert">
      <div class="decision-title">\u26a0 ${esc(decision.title || 'Needs attention')}</div>
      <div class="small">${esc(decision.message || '')}</div>
      ${hint ? `<div class="notice-hint">${esc(hint)}</div>` : ''}
      <div class="row">${buttons.join('')}</div>
    </div>`;
}

export function renderSettings(snapshot, ui) {
  const prefs = snapshot?.prefs ?? {};
  const active = isActive(snapshot?.automation);
  const toggles = [
    ['pauseOnFailure', 'Pause on failure', 'Stop the queue when a scene fails, so you can Retry, Skip, or Stop.'],
    ['requireConfirmation', 'Require confirmation before starting', 'Ask once before the queue starts running in Flow.'],
    ['continueAfterSuccess', 'Continue after successful generation', 'Off: pause after each completed scene for review.'],
    ['strictFilenameMatching', 'Strict filename matching', 'Bare names such as Aron must be written as Aron.png.'],
    ['caseInsensitiveMatching', 'Case-insensitive matching', 'aron.png matches Aron.png.'],
  ];
  const rows = toggles
    .map(
      ([key, label, hint]) => `
      <label class="toggle">
        <span class="toggle-text"><span>${esc(label)}</span><span class="toggle-hint">${esc(hint)}</span></span>
        <input type="checkbox" data-pref="${esc(key)}" ${prefs[key] ? 'checked' : ''} ${ui.busy ? 'disabled' : ''} />
      </label>`,
    )
    .join('');
  const diagnostics = ui.diagnostics
    ? `<div class="checks" aria-label="Flow page check">${ui.diagnostics.checks
        .map((check) => {
          const cls = check.ok ? 'is-ok' : check.warn ? 'is-warn' : 'is-bad';
          const icon = check.ok ? '\u2713' : check.warn ? '\u26a0' : '\u2715';
          return `<div class="check ${cls}"><span class="check-icon">${icon}</span><span><span class="check-label">${esc(check.label)}</span> <span class="check-detail">${esc(check.detail)}</span></span></div>`;
        })
        .join('')}</div>${renderDiagnosticsExtras(ui.diagnostics)}`
    : '';
  return `
    <div class="settings-list">${rows}</div>
    <label class="field" style="margin-top:8px">
      <span class="field-label">Generation timeout (minutes)</span>
      <input type="number" min="1" max="120" step="1" data-pref-number="generationTimeoutMinutes" value="${esc(prefs.generationTimeoutMinutes ?? 10)}" ${active ? 'disabled' : ''} />
    </label>
    <div class="divider"></div>
    <div class="row">
      <button type="button" class="btn btn-secondary btn-sm" data-action="diagnose" ${ui.busy ? 'disabled' : ''}>Check Flow page</button>
      <button type="button" class="btn btn-danger btn-sm" data-action="clear-project" ${active || ui.busy ? 'disabled' : ''}>Clear current project</button>
      <button type="button" class="btn btn-danger btn-sm" data-action="clear-library" ${active || ui.busy ? 'disabled' : ''}>Clear reference library</button>
    </div>
    ${diagnostics}`;
}

/** Below the checks: the settings the controls themselves show, the nearby controls, and a copy button. */
function renderDiagnosticsExtras(diagnostics) {
  const detected = diagnostics.detectedSettings ?? {};
  const detectedParts = [
    detected.mode ? `mode ${esc(detected.mode)}` : '',
    detected.model ? `model ${esc(detected.model)}` : '',
    detected.aspectRatio ? `aspect ratio ${esc(detected.aspectRatio)}` : '',
  ].filter(Boolean);
  const detectedLine = detectedParts.length
    ? `<div class="check is-ok"><span class="check-icon">\u2713</span><span><span class="check-label">Detected in Flow</span> <span class="check-detail">${detectedParts.join(' \u00b7 ')}</span></span></div>`
    : '';
  // The composer's own model chip: ground truth, independent of any menu.
  const chipModel = diagnostics.modelChip ?? detected.model ?? null;
  const chipLine = chipModel
    ? `<div class="check is-ok"><span class="check-icon">\u2713</span><span><span class="check-label">Model chip</span> <span class="check-detail">the composer shows ${esc(chipModel)}</span></span></div>`
    : '';
  // The settings-read attempt: which control was clicked, whether the menu opened.
  const read = diagnostics.settingsRead;
  const readLine = read?.attempted
    ? read.ok
      ? (() => {
          const current = read.current ?? {};
          const bits = ['mode', 'model', 'aspectRatio'].map((key) => `${key}=${current[key] ?? 'unknown'}`);
          return `<div class="check is-ok"><span class="check-icon">\u2713</span><span><span class="check-label">Settings read</span> <span class="check-detail">${esc(bits.join(', '))}${read.chipModel ? ` · chip shows ${esc(read.chipModel)}` : ''}</span></span></div>`;
        })()
      : `<div class="check is-bad"><span class="check-icon">\u2715</span><span><span class="check-label">Settings read</span> <span class="check-detail">failed: ${esc(read.error ?? 'unknown error')}</span></span></div>`
    : '';
  const frames = diagnostics.frames;
  const framesLine = frames
    ? `<div class="check"><span class="check-icon">\u2139</span><span><span class="check-label">Frames</span> <span class="check-detail">${esc(
        `${frames.inspected ?? 1} inspected${frames.unreachable ? `, ${frames.unreachable} unreachable from this frame` : ''}`,
      )}</span></span></div>`
    : '';
  const selectors = Array.isArray(diagnostics.selectorResults) ? diagnostics.selectorResults : [];
  const selectorsBlock = selectors.length
    ? `<details class="controls-list"><summary>Composer selectors (${selectors.length})</summary><ul>${selectors
        .map((row) => `<li><code>${esc(row.selector)}</code> [${esc(row.scope)}] ${esc(`${row.matched} matched, ${row.visible} visible`)}</li>`)
        .join('')}</ul></details>`
    : '';
  const candidates = Array.isArray(diagnostics.promptCandidates) ? diagnostics.promptCandidates : [];
  const candidatesBlock = candidates.length
    ? `<details class="controls-list"><summary>Prompt field candidates (${candidates.length})</summary><ul>${candidates
        .map((candidate) => {
          const bits = [esc(candidate.tag)];
          if (candidate.role) bits.push(`[${esc(candidate.role)}]`);
          if (candidate.type) bits.push(`type=${esc(candidate.type)}`);
          if (candidate.contenteditable) bits.push(`contenteditable=${esc(candidate.contenteditable)}`);
          if (candidate.frame && candidate.frame !== 'top') bits.push(`frame=${esc(candidate.frame)}`);
          if (candidate.inShadowRoot) bits.push('shadow root');
          bits.push(candidate.visible ? 'visible' : 'hidden');
          bits.push(candidate.disabled ? 'disabled' : 'enabled');
          const rect = candidate.rect ? `${candidate.rect.width}\u00d7${candidate.rect.height} at (${candidate.rect.x}, ${candidate.rect.y})` : 'no box';
          const label = candidate.name || candidate.placeholder || '(unnamed)';
          const verdict = candidate.rejection
            ? `\u2014 rejected: ${esc(candidate.rejection)}`
            : candidate.error
              ? `\u2014 unreadable: ${esc(candidate.error)}`
              : ' \u2014 usable';
          return `<li><code>${bits.join(' ')}</code> ${esc(label)} ${esc(rect)}${verdict}</li>`;
        })
        .join('')}</ul></details>`
    : '';
  const controls = Array.isArray(diagnostics.promptControls) ? diagnostics.promptControls : [];
  const controlsBlock = controls.length
    ? `<details class="controls-list"><summary>Controls near the prompt (${controls.length})</summary><ul>${controls
        .map((control) => {
          const bits = [esc(control.tag)];
          if (control.role) bits.push(`[${esc(control.role)}]`);
          if (control.popup) bits.push(`[${esc(control.popup)}]`);
          if (control.disabled) bits.push('disabled');
          const purpose = control.purpose && control.purpose !== 'other' ? ` \u2014 ${esc(control.purpose)}` : '';
          return `<li><code>${bits.join(' ')}</code> ${esc(control.name || '(no accessible name)')}${purpose}</li>`;
        })
        .join('')}</ul></details>`
    : '';
  const exceptions = Array.isArray(diagnostics.exceptions) ? diagnostics.exceptions : [];
  const exceptionsBlock = exceptions.length
    ? `<details class="controls-list"><summary>Exceptions (${exceptions.length})</summary><ul>${exceptions
        .map(
          (exception) =>
            `<li><code>${esc(exception.label ?? 'check')}</code> ${esc(exception.message ?? '')}${exception.stack ? `<div class="stack">${esc(exception.stack)}</div>` : ''}</li>`,
        )
        .join('')}</ul></details>`
    : '';
  return `${detectedLine}${chipLine}${readLine}${framesLine}${selectorsBlock}${candidatesBlock}${controlsBlock}${exceptionsBlock}
    <div class="row"><button type="button" class="btn btn-secondary btn-sm" data-action="copy-diagnostics">Copy report</button></div>`;
}

export function renderNotice(notice) {
  if (!notice) return '';
  const icon = notice.tone === 'error' ? '\u2715' : notice.tone === 'warn' ? '\u26a0' : '\u2713';
  return `
    <div class="notice tone-${esc(notice.tone)}" role="${notice.tone === 'error' ? 'alert' : 'status'}">
      <span class="notice-icon" aria-hidden="true">${icon}</span>
      <div class="notice-body">
        <span class="notice-title">${esc(notice.title)}</span>
        ${notice.hint ? `<span class="notice-hint">${esc(notice.hint)}</span>` : ''}
      </div>
      <button type="button" class="btn btn-ghost btn-sm" data-action="dismiss-notice" aria-label="Dismiss message">\u2715</button>
    </div>`;
}

export function renderLogCount(logs) {
  return `<span class="badge">${esc(plural(logs.length, 'entry', 'entries'))}</span>`;
}

export function renderLog(logs, ui) {
  const lines = logs
    .slice()
    .reverse()
    .map(
      (entry) => `
      <div class="log-line log-${esc(entry.level)}">
        <span class="log-time">${esc(clock(entry.at))}</span>
        <span class="log-msg">${esc(entry.message)}</span>
      </div>`,
    )
    .join('');
  return `
    <details class="log-details" data-log-details ${ui.logOpen ? 'open' : ''}>
      <summary>${ui.logOpen ? 'Hide' : 'Show'} activity (${esc(plural(logs.length, 'entry', 'entries'))})</summary>
      <div class="row" style="margin-top:8px"><button type="button" class="btn btn-ghost btn-sm" data-action="clear-logs">Clear log</button></div>
      <div class="log" role="log" aria-live="off">${lines || '<p class="muted small">Nothing yet.</p>'}</div>
    </details>`;
}
