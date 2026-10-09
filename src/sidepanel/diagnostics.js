/**
 * The "Check Flow page" report: assembled in the panel from the diagnostic the service
 * worker returned, formatted for copying, and put on the clipboard.
 *
 * Privacy: the report contains page structure only — which controls exist, their roles
 * and accessible names, and which checks passed. It never contains the user's prompt
 * text, page text content, or account information.
 */

/**
 * @param {object|null} d The `diagnoseFlow` result: probe fields, checks, controls.
 * @returns {string} A plain-text report, one finding per line.
 */
export function formatDiagnosticsReport(d) {
  if (!d) return 'No Flow page check has run yet. Press "Check Flow page" first.';
  const yesNo = (value) => (value === true ? 'yes' : value === false ? 'no' : 'unknown');
  const lines = [
    'Flow Scene Queue — Flow page check',
    `Checked: ${d.checkedAt ? new Date(d.checkedAt).toISOString() : 'unknown time'}`,
    `URL: ${d.url ?? 'unknown'}`,
    `Adapter: ${d.adapterVersion ?? 'unknown'}`,
    `Flow project page: ${yesNo(d.isProjectPage)}`,
    `Prompt box: ${d.promptFound ? `found (${d.promptStrategy ?? 'unknown strategy'})` : 'NOT FOUND'}`,
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
  ];
  const detected = d.detectedSettings ?? {};
  const detectedParts = [
    detected.mode ? `mode=${detected.mode}` : null,
    detected.model ? `model=${detected.model}` : null,
    detected.aspectRatio ? `aspectRatio=${detected.aspectRatio}` : null,
  ].filter(Boolean);
  lines.push(`Detected in Flow: ${detectedParts.length ? detectedParts.join(', ') : 'not identifiable without opening the settings menu'}`);
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
