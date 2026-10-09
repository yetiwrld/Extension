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
  ].filter(Boolean);
  lines.push(`Detected in Flow: ${detectedParts.length ? detectedParts.join(', ') : 'not identifiable without opening the settings menu'}`);
  const chipModel = d.modelChip ?? detected.model ?? null;
  lines.push(`Model chip in the composer: ${chipModel ? `"${chipModel}"` : 'not identified'}`);

  // The settings-read attempt: which control was clicked, whether a menu opened,
  // and which options it offered. This is the evidence for "did not open" and for
  // any value the panel shows.
  const read = d.settingsRead;
  if (read?.attempted) {
    lines.push('', 'Settings read attempt:');
    if (read.ok) {
      const current = read.current ?? {};
      const bits = ['mode', 'model', 'aspectRatio'].map((key) => `${key}=${current[key] ?? 'unknown'}`);
      lines.push(` - ok (${read.strategy ?? 'unknown strategy'}): ${bits.join(', ')}`);
      for (const key of ['mode', 'model', 'aspectRatio']) {
        const options = Array.isArray(read.options?.[key]) ? read.options[key] : [];
        if (options.length) lines.push(` - ${key} options: ${options.join(', ')}`);
      }
      if (read.chipModel) {
        lines.push(` - composer chip shows "${read.chipModel}"${read.modelMatchesChip === false ? ' — DIFFERS from the menu' : ''}`);
      }
    } else {
      lines.push(` - FAILED (${read.code ?? 'unknown code'}): ${read.error ?? 'unknown error'}`);
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
