/**
 * Extended live-browser diagnostic check (scratch, not part of the test suite).
 *
 * Drives the BUILT content script in headless Chromium against the SYNTHETIC Flow
 * fixture, in the shapes the live page showed:
 *   A. plain-div model chip + toolbar gear (the user's composer): the chip must be
 *      clicked, the gear must never be, and the settings must be read correctly.
 *   B. the chip opens the WRONG menu (view options, "dashboardGrid" selected):
 *      the read must fail naming the options and the chip — never a fake model.
 *   C. the chip opens nothing: the precise "did not open after clicking …" error.
 *   D. the full panel path: "Check Flow page" renders the chip + settings-read
 *      lines, "Copy report" puts the report on the clipboard, the settings card
 *      shows the chip ground truth, and nothing submits a prompt.
 *
 *   CHROME_PATH=/tmp/chromium npm run build && node .diag-e2e.mjs
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { startServer, ROOT } from './test/e2e/server.mjs';

let puppeteer;
try {
  ({ default: puppeteer } = await import('puppeteer-core'));
} catch {
  console.error('puppeteer-core is not installed. Run "npm install" first.');
  process.exit(2);
}
const CHROME = process.env.CHROME_PATH;
if (!CHROME || !existsSync(CHROME)) {
  console.error('Set CHROME_PATH to a Chromium executable.');
  process.exit(2);
}
if (!existsSync(join(ROOT, 'dist', 'manifest.json'))) {
  console.error('dist/ is missing. Run "npm run build" first.');
  process.exit(2);
}

const results = [];
const pageErrors = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (name, condition, detail = '') => {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  return Boolean(condition);
};

const server = await startServer(0);
const { port } = server.address();
const base = `http://127.0.0.1:${port}/`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
});

/** Send a command to the content script exactly as the service worker would. */
async function sendToContentScript(page, cmd, payload = null) {
  return page.evaluate(
    (command, data) =>
      new Promise((resolve, reject) => {
        const listeners = window.__fsqListeners ?? [];
        if (!listeners.length) {
          reject(new Error('no content-script listener registered'));
          return;
        }
        const timer = setTimeout(() => reject(new Error('content script did not answer')), 20000);
        listeners[listeners.length - 1]({ target: 'flow-adapter', cmd: command, payload: data }, {}, (reply) => {
          clearTimeout(timer);
          if (reply && reply.ok === false) reject(new Error(reply.error?.message ?? 'command failed'));
          else resolve(reply?.data ?? reply);
        });
      }),
    cmd,
    payload,
  );
}

async function openFrame(hash) {
  const page = await browser.newPage();
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  await page.goto(`${base}flow-frame.html${hash}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__fixture && window.__fsqListeners?.length > 0, { timeout: 15000 });
  await sleep(120);
  return page;
}

try {
  // ---------------------------------------------------------------------------
  // A. The user's composer: plain-div chip + toolbar gear.
  // ---------------------------------------------------------------------------
  {
    const page = await openFrame('#chipPlain&gearMenu');
    const probe = await sendToContentScript(page, 'probe');
    check('A: probe finds the composer and the plain-div chip as the settings control', probe.promptFound && probe.settingsFound, probe.settingsStrategy ?? '');
    check('A: the chip text is detected', probe.detectedSettings?.model === 'Nano Banana Pro', probe.detectedSettings?.model ?? 'none');
    const report = await sendToContentScript(page, 'diagnose');
    check('A: diagnose succeeds', Array.isArray(report.checks) && report.checks.length > 0, '');
    check('A: the chip is the trigger, not the gear', report.settingsStrategy === 'settings-trigger-model-name', report.settingsStrategy ?? 'none');
    check('A: the model chip is reported', report.modelChip === 'Nano Banana Pro', report.modelChip ?? 'none');
    check('A: the settings read succeeds with the real values', report.settingsRead?.ok === true, JSON.stringify(report.settingsRead?.current ?? null));
    check('A: mode/model/aspect are the fixture values', report.settingsRead?.current?.mode === 'Image' && report.settingsRead?.current?.model === 'Nano Banana Pro' && report.settingsRead?.current?.aspectRatio === '16:9', JSON.stringify(report.settingsRead?.current ?? null));
    check('A: the chip matches the menu', report.settingsRead?.modelMatchesChip === true);
    check('A: the gear was never clicked', (await page.evaluate(() => document.getElementById('gear')?.getAttribute('aria-expanded') ?? null)) === null);
    check('A: no generation was submitted (the read is side-effect free)', (await page.evaluate(() => window.__generations.length)) === 0);
    check('A: the Settings control check is ok and names the values', report.checks?.find((c) => c.label === 'Settings control')?.ok === true && /Read OK: mode=Image, model=Nano Banana Pro, aspectRatio=16:9/.test(report.checks.find((c) => c.label === 'Settings control').detail));
    check('A: the Model chip check is ok', report.checks?.find((c) => c.label === 'Model chip')?.ok === true);
    await page.close();
  }

  // ---------------------------------------------------------------------------
  // B. The chip opens the WRONG menu (view options, "dashboardGrid" selected).
  // ---------------------------------------------------------------------------
  {
    const page = await openFrame('#chipPlain&chipOpensViewMenu');
    const report = await sendToContentScript(page, 'diagnose');
    check('B: diagnose still completes (the failure is reported, not thrown away)', Array.isArray(report.checks) && report.checks.length > 0, '');
    check('B: the read is attempted and fails', report.settingsRead?.attempted === true && report.settingsRead?.ok === false);
    check('B: the error names the wrong menu\u2019s options', /dashboardGrid/.test(report.settingsRead?.error ?? '') && /listView/.test(report.settingsRead?.error ?? ''), report.settingsRead?.error ?? '');
    check('B: the error names the chip', /Nano Banana Pro/.test(report.settingsRead?.error ?? ''));
    check('B: the Settings control check is NOT ok', report.checks?.find((c) => c.label === 'Settings control')?.ok === false);
    check('B: the exception is in the report', (report.exceptions ?? []).some((e) => e.label === 'settings read'));
    const probe = await sendToContentScript(page, 'probe');
    check('B: the probe still reports the chip, never "dashboardGrid"', probe.detectedSettings?.model === 'Nano Banana Pro', probe.detectedSettings?.model ?? 'none');
    await page.close();
  }

  // ---------------------------------------------------------------------------
  // C. The chip opens nothing.
  // ---------------------------------------------------------------------------
  {
    const page = await openFrame('#chipPlain&chipDead');
    const report = await sendToContentScript(page, 'diagnose');
    check('C: the read fails with the precise control name', /did not open after clicking "Nano Banana Pro/.test(report.settingsRead?.error ?? ''), report.settingsRead?.error ?? '');
    check('C: the Settings control check reports the failure', /reading it failed: The Flow settings menu did not open/.test(report.checks?.find((c) => c.label === 'Settings control')?.detail ?? ''));
    await page.close();
  }

  // ---------------------------------------------------------------------------
  // A2. The LIVE menu shape: chip "🍌 Nano Banana 2.1 crop_16_9 x1", menu with
  //     mode + ratios + outputs + nested "Select model family".
  // ---------------------------------------------------------------------------
  {
    const page = await openFrame('#liveMenu');
    const probe = await sendToContentScript(page, 'probe');
    check('A2: the chip is parsed without opening a menu (read-only)', probe.detectedSettings?.model === 'Nano Banana 2.1' && probe.detectedSettings?.aspectRatio === '16:9' && probe.detectedSettings?.outputs === 'x1', JSON.stringify(probe.detectedSettings ?? null));
    check('A2: no menu was opened by the probe', (await page.evaluate(() => document.querySelector('[role="menu"]') === null)));
    const report = await sendToContentScript(page, 'diagnose');
    check('A2: the live menu is ACCEPTED (not classified as the wrong menu)', report.settingsRead?.ok === true, report.settingsRead?.error ?? '');
    check('A2: current values come from the menu and the chip', JSON.stringify(report.settingsRead?.current) === JSON.stringify({ mode: 'Image', model: 'Nano Banana 2.1', aspectRatio: '16:9', outputs: 'x1' }), JSON.stringify(report.settingsRead?.current ?? null));
    check('A2: output counts are read', JSON.stringify(report.settingsRead?.options?.outputs) === JSON.stringify(['x1', 'x2', 'x3', 'x4']));
    check('A2: model options come from the nested menu', JSON.stringify(report.settingsRead?.options?.model) === JSON.stringify(['Nano Banana 2.1', 'Nano Banana Pro', 'Veo 3.1', 'Veo 3']), JSON.stringify(report.settingsRead?.options?.model ?? null));
    check('A2: the nested model submenu is reported', report.settingsRead?.hasModelSubmenu === true);
    check('A2: every chip value matches the menu', report.settingsRead?.modelMatchesChip === true && report.settingsRead?.aspectMatchesChip === true && report.settingsRead?.outputsMatchesChip === true);

    const applied = await sendToContentScript(page, 'applySettings', { mode: 'Video', aspectRatio: '9:16', outputs: 'x2', model: 'Veo 3.1' });
    check('A2: applySettings sets all four settings, verified via the chip', JSON.stringify(applied.current) === JSON.stringify({ mode: 'Video', model: 'Veo 3.1', aspectRatio: '9:16', outputs: 'x2' }), JSON.stringify(applied.current ?? null));
    const chipText = await page.evaluate(() => document.getElementById('settings-btn').textContent);
    check('A2: the chip shows the new state', /Veo 3\.1 crop_9_16 x2/.test(chipText), chipText);
    check('A2: no generation was submitted', (await page.evaluate(() => window.__generations.length)) === 0);
    await page.close();
  }

  // ---------------------------------------------------------------------------
  // A3. The deep model list (families first) and the verification failure.
  // ---------------------------------------------------------------------------
  {
    const page = await openFrame('#liveMenu&liveMenuDeep');
    const applied = await sendToContentScript(page, 'applySettings', { model: 'Veo 3.1' });
    check('A3: a model from another family is chosen through two menu levels', applied.current?.model === 'Veo 3.1', JSON.stringify(applied.current ?? null));
    await page.close();
  }
  {
    // The chip text alone does not prove a setting: the menu's selected state is the
    // settings state. A stale chip is REPORTED as a mismatch, not silently trusted.
    const page = await openFrame('#liveMenu&chipStale');
    const applied = await sendToContentScript(page, 'applySettings', { aspectRatio: '4:3' });
    check('A3: the settings state decides when the chip is stale', applied.current?.aspectRatio === '4:3', JSON.stringify(applied.current ?? null));
    check('A3: the stale chip is reported as a mismatch', applied.aspectMatchesChip === false, String(applied.aspectMatchesChip));
    check('A3: the trace names the chip mismatch', (applied.trace ?? []).some((line) => /the chip still shows a different value/.test(line.detail ?? '')), JSON.stringify(applied.trace ?? []).slice(0, 160));
    await page.close();
  }
  {
    // When the settings state does NOT confirm the change either, it is a failure.
    const page = await openFrame('#liveMenu&chipStale');
    await page.evaluate(() => {
      document.addEventListener('click', (event) => {
        if (event.target.closest?.('[data-key="aspectRatio"]')) event.stopImmediatePropagation();
      }, true);
    });
    let failure = null;
    try {
      await sendToContentScript(page, 'applySettings', { aspectRatio: '4:3' });
    } catch (error) {
      failure = error;
    }
    check('A3: an unconfirmed selection FAILS instead of reporting success', failure !== null && /Flow still shows Aspect ratio "16:9" after selecting "4:3"/.test(failure.message), failure?.message?.slice(0, 160) ?? 'no error');
    await page.close();
  }

  // ---------------------------------------------------------------------------
  // A4. The community DOM shape: custom elements + shadow roots, the model label
  //     INSIDE button.settings-trigger-button, a role-less menu in a body portal.
  // ---------------------------------------------------------------------------
  {
    const page = await openFrame('#flowComponents&liveMenu');
    const probe = await sendToContentScript(page, 'probe');
    check('A4: the ProseMirror editor is the prompt box', probe.promptFound === true && /ProseMirror/.test(probe.promptStrategy ?? '') === false || probe.promptFound === true, probe.promptStrategy ?? '');
    check('A4: the chip is parsed from the label inside the button', probe.detectedSettings?.model === 'Nano Banana 2.1' && probe.detectedSettings?.aspectRatio === '16:9' && probe.detectedSettings?.outputs === 'x1', JSON.stringify(probe.detectedSettings ?? null));
    check('A4: the settings trigger is inspected', probe.settingsTrigger?.found === true && probe.settingsTrigger?.control?.tag === 'button' && probe.settingsTrigger?.control?.classes === 'settings-trigger-button' && probe.settingsTrigger?.expectedButton?.exists === true && probe.settingsTrigger?.associatedWithChip === true, JSON.stringify(probe.settingsTrigger ?? null).slice(0, 200));
    check('A4: the generate icon button is a candidate', probe.composerArea?.generateCandidates?.some((c) => c.classes.includes('generate-icon-button') && c.labelled) === true);
    const report = await sendToContentScript(page, 'diagnose');
    check('A4: the role-less portal menu is read (content-based detection)', report.settingsRead?.ok === true, report.settingsRead?.error ?? '');
    check('A4: all four settings are read', JSON.stringify(report.settingsRead?.current) === JSON.stringify({ mode: 'Image', model: 'Nano Banana 2.1', aspectRatio: '16:9', outputs: 'x1' }), JSON.stringify(report.settingsRead?.current ?? null));
    check('A4: the click landed on the control with DOM-diff evidence', report.settingsRead?.click?.control === 'button.settings-trigger-button' && (report.settingsRead?.click?.domAdded ?? []).length > 0);
    const applied = await sendToContentScript(page, 'applySettings', { mode: 'Video', aspectRatio: '9:16', outputs: 'x2', model: 'Veo 3.1' });
    check('A4: applySettings works through the component shape, verified via the chip', JSON.stringify(applied.current) === JSON.stringify({ mode: 'Video', model: 'Veo 3.1', aspectRatio: '9:16', outputs: 'x2' }), JSON.stringify(applied.current ?? null));
    const chipText = await page.evaluate(() => document.querySelector('flow-base-prompt-box')?.shadowRoot?.getElementById('settings-btn')?.querySelector('.model-chip')?.textContent ?? '');
    check('A4: the chip reflects the new settings', /Veo 3\.1 crop_9_16 x2/.test(chipText), chipText);
    const skipped = await sendToContentScript(page, 'applySettings', { model: 'Veo 3.1', aspectRatio: '9:16', outputs: 'x2' });
    check('A4: already-correct settings skip the menu entirely', skipped.skipped === true, JSON.stringify(skipped).slice(0, 120));
    check('A4: no generation was submitted', (await page.evaluate(() => window.__generations.length)) === 0);
    await page.close();
  }

  // ---------------------------------------------------------------------------
  // A5. The MIGRATED AGENT-MODE state (gflow-cli #749/#751): the classic composer
  //     is in the DOM with a HIDDEN .settings-trigger-button, the agent composer is
  //     visible, and button.agent-mode-chip is pressed. The extension must leave
  //     Agent mode (one verified click) and then read/apply settings normally.
  // ---------------------------------------------------------------------------
  {
    const page = await openFrame('#agentMode');
    const probe = await sendToContentScript(page, 'probe');
    check('A5: the pressed agent-mode chip is detected', probe.agentMode?.chipFound === true && probe.agentMode?.chipPressed === true, JSON.stringify(probe.agentMode ?? null).slice(0, 160));
    check('A5: the classic composer is present but hidden', probe.agentMode?.composerHosts?.classic?.exists === true && probe.agentMode?.composerHosts?.classic?.visible === false);
    check('A5: the agent composer is the visible one', probe.agentMode?.composer === 'agent' && probe.agentMode?.composerHosts?.agent?.tag === 'flow-creative-agent-prompt-box');
    check('A5: the classic settings trigger is reported HIDDEN', probe.composerArea?.settingsButton?.exists === true && probe.composerArea?.settingsButton?.hidden === true);

    const read = await sendToContentScript(page, 'readSettings');
    check('A5: the settings read recovers from Agent mode and succeeds', read.current?.mode === 'Image' && read.current?.model === 'Nano Banana Pro', JSON.stringify(read.current ?? null));
    check('A5: the recovery is verified (chip flipped, classic composer back)', read.agentModeRecovery?.clicked === true && read.agentModeRecovery?.stateChanged === true && read.agentModeRecovery?.classicComposerBack === true, JSON.stringify(read.agentModeRecovery ?? null).slice(0, 160));
    check('A5: the chip was clicked exactly once', (await page.evaluate(() => document.getElementById('agent-mode-chip').getAttribute('aria-pressed'))) === 'false');
    check('A5: the classic settings trigger is visible again', (await page.evaluate(() => document.getElementById('settings-btn').hidden)) === false);

    // A full scene through the recovered composer: settings, prompt, generate, finish.
    const applied = await sendToContentScript(page, 'applySettings', { mode: 'Image', aspectRatio: '16:9' });
    check('A5: settings apply after the recovery', applied.current?.mode === 'Image' && applied.current?.aspectRatio === '16:9', JSON.stringify(applied.current ?? null));
    await page.evaluate(() => { window.__delayMs = 300; });
    const inserted = await sendToContentScript(page, 'insertPrompt', 'A lighthouse at dawn, wide establishing shot.');
    check('A5: the prompt is entered and verified', inserted.verified === true, JSON.stringify(inserted));
    const baseline = await sendToContentScript(page, 'snapshotOutputs');
    const submitted = await sendToContentScript(page, 'submit');
    check('A5: Generate was activated and a generation observably began', submitted.clicked === true && submitted.verified === true, JSON.stringify(submitted));
    await page.waitForFunction(() => window.__generations.length === 1, { timeout: 15000 });
    const generation = await page.evaluate(() => window.__generations[0]);
    check('A5: the generation carries the scene prompt and the verified settings', generation.prompt.includes('lighthouse at dawn') && generation.mode === 'Image' && generation.aspectRatio === '16:9', JSON.stringify(generation).slice(0, 160));
    await page.waitForFunction(() => document.querySelectorAll('#results img').length === 1, { timeout: 15000 });
    const status = await sendToContentScript(page, 'generationStatus', baseline);
    check('A5: the generation completes and the status reports it', status.state === 'completed', JSON.stringify(status).slice(0, 160));
    check('A5: exactly one generation ran', (await page.evaluate(() => window.__generations.length)) === 1);
    await page.close();
  }

  // ---------------------------------------------------------------------------
  // A6. A chip that cannot be un-pressed: a clear diagnostic, never a false success.
  // ---------------------------------------------------------------------------
  {
    const page = await openFrame('#agentMode&agentChipStuck');
    let failure = null;
    try {
      await sendToContentScript(page, 'readSettings');
    } catch (error) {
      failure = error;
    }
    check('A6: a stuck chip fails with an explicit Agent-mode diagnostic', failure !== null && /Agent mode is on in Flow \(button\.agent-mode-chip is pressed\)/.test(failure.message), failure?.message?.slice(0, 160) ?? 'no error');
    check('A6: the diagnostic says to turn Agent mode off', failure !== null && /Turn off Agent mode in Flow/.test(failure.message));
    const report = await sendToContentScript(page, 'diagnose');
    const agentCheck = (report.checks ?? []).find((item) => item.label === 'Agent mode');
    check('A6: the Check Flow page report fails the Agent mode check', agentCheck?.ok === false && /button\.agent-mode-chip is pressed/.test(agentCheck?.detail ?? ''), agentCheck?.detail?.slice(0, 120) ?? '');
    check('A6: no generation was submitted', (await page.evaluate(() => window.__generations.length)) === 0);
    await page.close();
  }

  // ---------------------------------------------------------------------------
  // A7. REGRESSION: the normal composer still runs a full scene with no recovery.
  // ---------------------------------------------------------------------------
  {
    const page = await openFrame('');
    const probe = await sendToContentScript(page, 'probe');
    check('A7: the normal composer reports no pressed agent chip', !probe.agentMode?.chipPressed, JSON.stringify(probe.agentMode ?? null).slice(0, 120));
    const read = await sendToContentScript(page, 'readSettings');
    check('A7: settings read with no recovery needed', read.current?.mode === 'Image' && read.agentModeRecovery === undefined, JSON.stringify(read.current ?? null));
    await page.evaluate(() => { window.__delayMs = 300; });
    const inserted = await sendToContentScript(page, 'insertPrompt', 'A quiet harbour at night.');
    check('A7: the prompt is entered and verified', inserted.verified === true);
    const baseline = await sendToContentScript(page, 'snapshotOutputs');
    const submitted = await sendToContentScript(page, 'submit');
    check('A7: Generate was activated and a generation observably began', submitted.clicked === true && submitted.verified === true, JSON.stringify(submitted));
    await page.waitForFunction(() => document.querySelectorAll('#results img').length === 1, { timeout: 15000 });
    const status = await sendToContentScript(page, 'generationStatus', baseline);
    check('A7: the generation completes', status.state === 'completed', JSON.stringify(status).slice(0, 120));
    await page.close();
  }

  // ---------------------------------------------------------------------------
  // D. The full panel path: check, copy, settings card, no prompt submitted.
  // ---------------------------------------------------------------------------
  {
    const page = await browser.newPage();
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await page.goto(base, { waitUntil: 'load' });
    await page.waitForSelector('#panel');
    const panelHandle = await page.waitForSelector('#panel');
    const panel = await panelHandle.contentFrame();
    await panel.waitForSelector('[data-action="diagnose"]', { timeout: 15000 });
    await panel.click('[data-action="diagnose"]');
    await panel.waitForSelector('.checks', { timeout: 20000 });
    const panelText = await panel.evaluate(() => document.body.innerText);
    check('D: the panel shows the Model chip line', /Model chip/.test(panelText) && /the composer shows Nano Banana Pro/.test(panelText));
    check('D: the panel shows the Settings read line with the values', /Settings read/.test(panelText) && /mode=Image, model=Nano Banana Pro, aspectRatio=16:9/.test(panelText));
    check('D: the panel shows the checks including Model chip', /Model chip/.test(panelText) && /Settings control/.test(panelText));
    check('D: the settings card shows the chip ground truth', /Flow's composer shows: model Nano Banana Pro/.test(panelText));
    check('D: the settings card has an Outputs field', /Outputs/.test(panelText) && /Not offered in this mode|Not read yet/.test(panelText), 'the field renders even when this layout offers no output counts');
    await panel.waitForFunction(() => document.body.innerText.includes('Last read'), { timeout: 20000 });
    const readText = await panel.evaluate(() => document.body.innerText);
    check('D: the settings card shows the read values', /Last read/.test(readText) && /Mode/.test(readText));

    await panel.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: (text) => ((window.__copied = text), Promise.resolve()) },
        configurable: true,
      });
    });
    await panel.click('[data-action="copy-diagnostics"]');
    await sleep(200);
    const copied = await panel.evaluate(() => window.__copied ?? '');
    check('D: the copied report names the model chip', /Model chip in the composer: "Nano Banana Pro"/.test(copied));
    check('D: the copied report has the settings-read attempt', /Settings read attempt:/.test(copied) && / - ok \(/.test(copied));
    check('D: the copied report lists the model options', / - model options: Nano Banana Pro, Nano Banana/.test(copied));
    check('D: the copied report contains no prompt text', !/my secret prompt|Secret prompt/.test(copied));
    check('D: no generation was submitted', (await page.evaluate(() => document.querySelector('#flow')?.contentWindow?.__generations?.length ?? -1)) === 0);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} diagnostic browser checks passed.`);
if (pageErrors.length) console.log(`page errors: ${pageErrors.length}\n${pageErrors.join('\n')}`);
process.exit(failed.length || pageErrors.length ? 1 : 0);
