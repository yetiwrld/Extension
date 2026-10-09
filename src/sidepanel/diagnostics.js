/**
 * The "Check Flow page" report: assembled in the panel from the diagnostic the service
 * worker returned, formatted for copying, and put on the clipboard.
 *
 * Privacy: the report contains page structure only — which fields and controls exist,
 * their roles, labels, geometry and which checks passed. It never contains the user's
 * prompt text (a composer's text content is never read), page text content, account
 * information, cookies or tokens.
 */

const yesNo = (value) => (value === true ? 'yes' : value === false ? 'no' : 'unknown');

/**
 * @param {object|null} d The `diagnoseFlow` result: probe fields, checks, candidates.
 * @returns {string} A plain-text report, one finding per line.
 */
export function formatDiagnosticsReport(d) {
  if (!d) return 'No Flow page check has run yet. Press "Check Flow page" first.';
  const lines = [
    'Flow Scene Queue — Flow page check',
    `Checked: ${d.checkedAt ? new Date(d.checkedAt).toISOString() : 'unknown time'}`,
    `URL: ${d.url ?? 'unknown'}`,
    `Flow page: ${yesNo(d.flowPage)}`,
    `Flow connector: ${
      d.contentScript === 'responding' ? 'responding' : d.contentScript === 'not responding' ? `NOT RESPONDING${d.contentScriptDetail ? ` — ${d.contentScriptDetail}` : ''}` : 'unknown'
    }`,
    `Adapter: ${d.adapterVersion ?? 'unknown'}`,
    `Frames inspected: ${d.frames?.inspected ?? 1}${d.frames?.unreachable ? ` (${d.frames.unreachable} more frame(s) unreachable from this one)` : ''}`,
    `Flow project page: ${yesNo(d.isProjectPage)}`,
    `Workspace composer: ${d.workspaceDetected ? 'detected' : d.workspaceDetected === false ? 'not detected' : 'unknown'}`,
    `Prompt box: ${
      d.promptFound
        ? `found (${d.promptStrategy ?? 'unknown strategy'})${d.promptEnabled === false ? ', disabled' : ''}${d.promptAmbiguous ? ', several fields match equally' : ''}`
        : 'NOT FOUND'
    }`,
    `Prompt layout: ${d.composerLayout ?? 'unknown'}`,
  ];
  if (Array.isArray(d.promptReasons) && d.promptReasons.length) {
    lines.push(`Selected because: ${d.promptReasons.join('; ')}`);
  }
  lines.push(
    `Generate button: ${
      d.generateFound
        ? `found (${d.generateStrategy ?? 'unknown strategy'}), ${d.generateEnabled ? 'enabled' : 'disabled'}`
        : 'NOT FOUND'
    }`,
    `Settings control: ${
      d.settingsFound ? `found (${d.settingsStrategy ?? 'unknown strategy'})` : 'NOT FOUND'
    }${d.settingsAmbiguous ? ' (several controls match; the first was used)' : ''}`,
    `Agent control: ${d.agentFound ? (d.agentOn ? 'found, ON' : 'found, off') : 'not found'}`,
    `References attached: ${d.referencesAttached ?? 0}`,
    `Outputs visible: ${d.outputsVisible ?? 0}`,
  );
  const detected = d.detectedSettings ?? {};
  const detectedParts = [
    detected.mode ? `mode=${detected.mode}` : null,
    detected.model ? `model=${detected.model}` : null,
    detected.aspectRatio ? `aspectRatio=${detected.aspectRatio}` : null,
    detected.outputs ? `outputs=${detected.outputs}` : null,
  ].filter(Boolean);
  lines.push(`Detected in Flow: ${detectedParts.length ? detectedParts.join(', ') : 'not identifiable without opening the settings menu'}`);
  const chipModel = d.modelChip ?? detected.model ?? null;
  lines.push(`Model chip in the composer: ${chipModel ? `"${chipModel}"` : 'not identified'}`);
  if (detected.aspectRatio || detected.outputs) {
    lines.push(`Chip settings: ${[detected.aspectRatio, detected.outputs].filter(Boolean).join(' \u00b7 ')}`);
  }

  // The settings-read attempt: which control was clicked, whether a menu opened,
  // and which options it offered. This is the evidence for "did not open" and for
  // any value the panel shows.
  const read = d.settingsRead;
  if (read?.attempted) {
    lines.push('', 'Settings read attempt:');
    if (read.ok) {
      const current = read.current ?? {};
      const bits = ['mode', 'model', 'aspectRatio', 'outputs'].map((key) => `${key}=${current[key] ?? 'unknown'}`);
      lines.push(` - ok (${read.strategy ?? 'unknown strategy'}): ${bits.join(', ')}`);
      for (const key of ['mode', 'model', 'aspectRatio', 'outputs']) {
        const options = Array.isArray(read.options?.[key]) ? read.options[key] : [];
        if (options.length) lines.push(` - ${key} options: ${options.join(', ')}`);
      }
      if (read.chipModel) {
        lines.push(` - composer chip shows "${read.chipModel}"${read.modelMatchesChip === false ? ' — DIFFERS from the menu' : ''}`);
      }
      const chipBits = [read.chipAspectRatio, read.chipOutputs].filter(Boolean);
      if (chipBits.length) lines.push(` - chip shows: ${chipBits.join(' \u00b7 ')}${read.aspectMatchesChip === false || read.outputsMatchesChip === false ? ' — DIFFERS from the menu' : ''}`);
      if (read.hasModelSubmenu) lines.push(' - the model list is nested behind "Select model family" (it was opened and read)');
    } else {
      lines.push(` - FAILED (${read.code ?? 'unknown code'}): ${read.error ?? 'unknown error'}`);
    }
  }

  // Agent mode: the verified chip (button.agent-mode-chip + aria-pressed), the
  // composer custom elements (existence AND visibility), and the classic settings
  // trigger's hidden state — the facts that explain a settings click going nowhere.
  const composerState = d.composerState;
  if (composerState) {
    lines.push('', `Composer state: ${composerState.state} — ${composerState.label}`);
    for (const item of composerState.evidence ?? []) lines.push(` - ${item}`);
    lines.push(` - active composer: ${composerState.activeComposer ?? 'none visible'}`);
    if (composerState.state === 'B') {
      lines.push(' - consequence: the standard-composer automation cannot set model, mode, aspect ratio or output count here.');
    }
    if (composerState.state === 'C') {
      lines.push(' - consequence: neither Agent mode nor a hidden trigger explains this; see the settings-trigger inspection and click evidence below.');
    }
  }

  const agent = d.agentMode;
  if (agent) {
    lines.push('', 'Agent mode (read-only inspection):');
    lines.push(` - chip (button.agent-mode-chip): ${agent.chipFound ? `found, aria-pressed=${agent.chipPressed ? 'true (Agent mode is ON)' : 'false'}` : 'not found'}`);
    const hostState = (host, hiddenWord) => (!host || !host.exists ? 'absent' : host.visible ? 'visible' : hiddenWord);
    const hostParts = [];
    if (agent.composerHosts?.classic) hostParts.push(`flow-prompt-box ${hostState(agent.composerHosts.classic, 'present but HIDDEN')}`);
    if (agent.composerHosts?.agent) hostParts.push(`flow-creative-agent-prompt-box ${hostState(agent.composerHosts.agent, 'present but hidden')}`);
    lines.push(` - composer: ${agent.composer ?? 'neither visible'}${hostParts.length ? ` (${hostParts.join(', ')})` : ''}`);
    const button = d.composerArea?.settingsButton ?? d.settingsTrigger?.settingsButton;
    if (button) {
      lines.push(` - classic settings trigger (.settings-trigger-button): ${button.exists ? (button.hidden ? 'present but HIDDEN (display:none, not interactable)' : 'visible') : 'absent'}`);
    }
  }
  const recovery = d.settingsRead?.agentModeRecovery;
  if (recovery) {
    lines.push(' - recovery: ' + (recovery.classicComposerBack ? 'Agent mode was left (chip clicked once, state verified, classic composer back)' : `Agent mode could NOT be left: ${recovery.reason}`));
  }

  // The settings trigger: the expected button (the community reference's shape, as a
  // candidate), the actual control, and what covers it. Read-only evidence.
  const trigger = d.settingsTrigger;
  if (trigger) {
    lines.push('', 'Settings trigger (read-only inspection):');
    if (!trigger.found) {
      lines.push(' - not found');
    } else {
      lines.push(` - found (${trigger.strategy}${trigger.ambiguous ? ', ambiguous' : ''}): label "${trigger.label ?? ''}"`);
      if (trigger.control) {
        const c = trigger.control;
        lines.push(
          ` - control: <${c.tag}${c.classes ? ` class="${c.classes}"` : ''}> "${c.name ?? ''}"${c.rect ? ` ${c.rect.width}x${c.rect.height} at (${c.rect.x}, ${c.rect.y})` : ''}` +
            ` — visible: ${c.visible}, enabled: ${c.enabled}, connected: ${c.connected}, in composer: ${c.inComposer}, resolved via ${c.via}`,
        );
      }
      if (trigger.foundElement && !trigger.foundElement.interactive) {
        lines.push(` - the found element <${trigger.foundElement.tag}> is a LABEL, not a control (resolved to the control above)`);
      }
      lines.push(` - expected button (candidate): ${trigger.expectedButton?.exists ? `<${trigger.expectedButton.tag} class="${trigger.expectedButton.classes}"> "${trigger.expectedButton.name}" visible: ${trigger.expectedButton.visible}` : 'not present'}`);
      lines.push(` - associated with the model chip: ${trigger.associatedWithChip === null ? 'unknown' : trigger.associatedWithChip}`);
      lines.push(` - covered by another element: ${trigger.coveredBy ? `<${trigger.coveredBy.tag} class="${trigger.coveredBy.classes}"> "${trigger.coveredBy.name}"` : 'no'}`);
      if (trigger.customAncestors?.length) lines.push(` - custom-element ancestors: ${trigger.customAncestors.join(' < ')}`);
    }
  }

  // What the settings-read attempt's click changed in the DOM (added/removed
  // menu-like elements): the evidence when a menu does not open.
  const click = d.settingsRead?.click;
  if (click) {
    lines.push('', 'Settings-menu click evidence:');
    lines.push(` - clicked: ${click.control} "${click.label}"${click.retried ? ' (retried once with a fresh element)' : ''}`);
    lines.push(` - DOM added after the click: ${click.domAdded.length ? click.domAdded.join('; ') : 'nothing'}`);
    lines.push(` - DOM removed after the click: ${click.domRemoved.length ? click.domRemoved.join('; ') : 'nothing'}`);
  }
  // The step-by-step trace of the settings read/apply (trigger found, menu opened,
  // each selection verified against the chip).
  const trace = d.settingsRead?.trace;
  if (Array.isArray(trace) && trace.length) {
    lines.push('', 'Settings read trace:');
    for (const line of trace) lines.push(` - ${line.step}: ${line.detail}`);
  }

  // The composer area: the model chip, its ancestor chain, every text field in its
  // region, the controls there, generate-button candidates and shadow-DOM hosts.
  // This is what identifies the prompt editor when the composer is NOT detected.
  // No element text crosses into the report: a composer's text is the user's prompt.
  const area = d.composerArea;
  if (area) {
    lines.push('', 'Composer area (read-only DOM map):');
    if (area.chip) {
      lines.push(` - model chip: <${area.chip.tag}${area.chip.role ? ` role=${area.chip.role}` : ''}> "${area.chip.name}"`);
    } else {
      lines.push(' - model chip: not identified');
    }
    if (area.chipChain?.length) {
      lines.push(` - chip ancestor chain (${area.chipChain.length}):`);
      for (const step of area.chipChain) {
        lines.push(`   <${step.tag}${step.role ? ` role=${step.role}` : ''}${step.label ? ` "${step.label}"` : ''}> children: ${step.childTags || '(none)'}`);
      }
    }
    if (area.regionFields?.length) {
      lines.push(` - text fields in the chip's region (${area.regionFields.length}):`);
      for (const field of area.regionFields) {
        const bits = [field.kind];
        if (field.classes) bits.push(`.${field.classes.split(/\s+/).slice(0, 3).join('.')}`);
        if (field.customAncestors?.length) bits.push(`in ${field.customAncestors.join(' < ')}`);
        if (field.role) bits.push(`role=${field.role}`);
        if (field.name) bits.push(`"${field.name}"`);
        bits.push(field.visible ? 'visible' : 'hidden');
        if (field.readonly) bits.push('read-only');
        if (field.disabled) bits.push('disabled');
        if (field.rect) bits.push(`${field.rect.width}x${field.rect.height} at (${field.rect.x}, ${field.rect.y})`);
        lines.push(`   <${field.tag}> ${bits.join(' ')}`);
      }
    } else {
      lines.push(' - text fields in the chip\u2019s region: none');
    }
    if (area.regionControls?.length) {
      lines.push(` - controls in the chip's region (${area.regionControls.length}):`);
      for (const control of area.regionControls) {
        lines.push(`   <${control.tag}${control.role ? ` role=${control.role}` : ''}> "${control.name}"${control.purpose && control.purpose !== 'other' ? ` — ${control.purpose}` : ''}`);
      }
    }
    if (area.generateCandidates?.length) {
      const labelled = area.generateCandidates.filter((candidate) => candidate.labelled);
      lines.push(
        ` - generate-button candidates: ${
          labelled.length
            ? labelled.map((candidate) => `"${candidate.name}" <${candidate.tag}${candidate.classes ? ` class="${candidate.classes}"` : ''}>`).join(', ')
            : 'none labelled'
        }`,
      );
    }
    if (area.shadowHosts?.length) {
      lines.push(` - custom elements with shadow roots: ${area.shadowHosts.map((host) => host.tag).join(', ')}`);
    }
  }

  const selectors = Array.isArray(d.selectorResults) ? d.selectorResults : [];
  if (selectors.length) {
    lines.push('', 'Composer selectors (matched/visible):');
    for (const row of selectors) {
      lines.push(` - ${row.selector} [${row.scope}]: ${row.matched} matched, ${row.visible} visible`);
    }
  }

  const candidates = Array.isArray(d.promptCandidates) ? d.promptCandidates : [];
  lines.push('', `Prompt field candidates (${candidates.length}):`);
  if (!candidates.length) lines.push(' - none: the page offers no text-entry element');
  for (const candidate of candidates) {
    const bits = [candidate.tag];
    if (candidate.role) bits.push(`role=${candidate.role}`);
    if (candidate.type) bits.push(`type=${candidate.type}`);
    if (candidate.contenteditable) bits.push(`contenteditable=${candidate.contenteditable}`);
    if (candidate.frame && candidate.frame !== 'top') bits.push(`frame=${candidate.frame}`);
    if (candidate.inShadowRoot) bits.push('in shadow root');
    bits.push(candidate.visible ? 'visible' : 'hidden');
    bits.push(candidate.disabled ? 'disabled' : 'enabled');
    if (candidate.readonly) bits.push('readonly');
    const rect = candidate.rect ? `${candidate.rect.width}x${candidate.rect.height} at (${candidate.rect.x}, ${candidate.rect.y})` : 'no box';
    const label = candidate.name || candidate.placeholder || '(unnamed)';
    const verdict = candidate.rejection ? `REJECTED: ${candidate.rejection}` : candidate.error ? `UNREADABLE: ${candidate.error}` : 'usable composer candidate';
    lines.push(` - ${bits.join(' ')} "${label}" ${rect} — ${verdict}`);
  }

  lines.push('', 'Checks:');
  for (const item of d.checks ?? []) {
    lines.push(` ${item.ok ? 'PASS' : item.warn ? 'WARN' : 'FAIL'}  ${item.label} — ${item.detail ?? ''}`);
  }
  const controls = Array.isArray(d.promptControls) ? d.promptControls : [];
  if (controls.length) {
    lines.push('', 'Controls near the prompt:');
    for (const control of controls) {
      const bits = [control.tag];
      if (control.role) bits.push(`role=${control.role}`);
      if (control.popup) bits.push(`popup=${control.popup}`);
      if (control.disabled) bits.push('disabled');
      if (control.purpose && control.purpose !== 'other') bits.push(`purpose=${control.purpose}`);
      lines.push(` - ${bits.join(' ')} "${control.name ?? ''}"${control.title ? ` (title: "${control.title}")` : ''}`);
    }
  }
  if (Array.isArray(d.issues) && d.issues.length) {
    lines.push('', 'Issues:');
    for (const issue of d.issues) lines.push(` - ${issue}`);
  }
  const exceptions = Array.isArray(d.exceptions) ? d.exceptions : [];
  if (exceptions.length) {
    lines.push('', 'Exceptions (stack traces trimmed):');
    for (const exception of exceptions) {
      lines.push(` - ${exception.label ?? 'check'}: ${exception.message ?? ''}`);
      if (exception.stack) lines.push(`   ${exception.stack}`);
    }
  }
  return lines.join('\n');
}

/**
 * Copy text to the clipboard. The async clipboard API is preferred; a hidden textarea and
 * execCommand is the fallback, so copying works without extra extension permissions.
 * @returns {Promise<boolean>} whether the text reached the clipboard.
 */
export async function copyTextToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fall through to the execCommand fallback.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}
