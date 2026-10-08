/**
 * Browser harness run. Drives the BUILT side panel and service worker in headless
 * Chromium against the SYNTHETIC Flow page.
 *
 *   npm run build
 *   CHROME_PATH=/path/to/chrome npm run e2e
 *
 * What is real: the built bundles, the panel DOM and layout, the real content script
 * and Flow adapter running in a real DOM, real clicks and input events, real
 * IndexedDB for reference files, real timers.
 * What is simulated: chrome.* APIs (test/e2e/harness/stub.js) and the Flow page
 * itself (test/fixtures/flow-fixture.js). A pass shows the pipeline works end to end
 * in a browser; it does NOT show that the live Google Flow page matches the fixture.
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { startServer, ROOT } from './server.mjs';

let puppeteer;
try {
  ({ default: puppeteer } = await import('puppeteer-core'));
} catch {
  console.error('puppeteer-core is not installed. Run "npm install" first.');
  process.exit(2);
}

const CHROME = process.env.CHROME_PATH;
if (!CHROME || !existsSync(CHROME)) {
  console.error('Set CHROME_PATH to a Chromium or Chrome executable to run the browser harness.');
  process.exit(2);
}
if (!existsSync(join(ROOT, 'dist', 'manifest.json'))) {
  console.error('dist/ is missing. Run "npm run build" first.');
  process.exit(2);
}

const here = dirname(fileURLToPath(import.meta.url));
const shots = join(ROOT, 'release', 'e2e-screenshots');
await mkdir(shots, { recursive: true });

const results = [];
const pageErrors = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  return Boolean(condition);
}

const server = await startServer(0);
const { port } = server.address();
const base = `http://127.0.0.1:${port}/`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--window-size=1440,900'],
  env: { ...process.env },
});

const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
page.on('pageerror', (error) => pageErrors.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error' && !/Failed to load resource|favicon/.test(message.text())) {
    pageErrors.push(`console: ${message.text()}`);
  }
});
page.on('dialog', (dialog) => dialog.accept());

async function openHarness({ reset = false } = {}) {
  await page.goto(base, { waitUntil: 'load' });
  if (reset) {
    await page.evaluate(async () => {
      localStorage.clear();
      sessionStorage.clear();
      await new Promise((resolve) => {
        const request = indexedDB.deleteDatabase('flow-scene-queue');
        request.onsuccess = resolve;
        request.onerror = resolve;
        request.onblocked = resolve;
      });
    });
    await page.goto(base, { waitUntil: 'load' });
  }
  await page.waitForSelector('#panel');
  await sleep(300);
}

const panel = async () => {
  const handle = await page.waitForSelector('#panel');
  return handle.contentFrame();
};
const flow = async () => {
  const handle = await page.waitForSelector('#flow');
  return handle.contentFrame();
};

async function waitFor(fn, { timeout = 30000, interval = 250, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      // Frame may be navigating; keep polling.
    }
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`);
    await sleep(interval);
  }
}

async function clickIn(frame, selector) {
  const ok = await frame.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el || el.disabled) return false;
    el.click();
    return true;
  }, selector);
  if (!ok) throw new Error(`Could not click ${selector}`);
}

async function phaseOf(frame) {
  return frame.evaluate(() => document.querySelector('#region-phase [data-phase]')?.getAttribute('data-phase') ?? null);
}

async function sceneStatuses(frame) {
  return frame.evaluate(() =>
    Array.from(document.querySelectorAll('#region-queue li[data-scene-id]')).map((li) => ({
      id: li.getAttribute('data-scene-id'),
      status: li.querySelector('.scene-status')?.textContent?.trim() ?? '',
      title: li.querySelector('.scene-title')?.textContent?.trim() ?? '',
    })),
  );
}

async function flowGenerations() {
  const frame = await flow();
  return frame.evaluate(() => ({
    generations: (window.__generations ?? []).slice(),
    outputs: window.__fixture?.state?.outputs ?? 0,
  }));
}

async function startAndConfirm(panelFrame) {
  await clickIn(panelFrame, '[data-action="start"]');
  await waitFor(() => panelFrame.$('[data-action="confirm-start"]'), { label: 'start confirmation' });
  await clickIn(panelFrame, '[data-action="confirm-start"]');
}

async function clearProject(panelFrame) {
  await clickIn(panelFrame, '[data-action="clear-project"]');
  await waitFor(async () => (await sceneStatuses(panelFrame)).length === 0, { label: 'empty queue' });
}

async function analyzeExample(panelFrame) {
  await clickIn(panelFrame, '[data-action="load-example"]');
  await clickIn(panelFrame, '[data-action="analyze"]');
  await waitFor(async () => (await sceneStatuses(panelFrame)).length === 4, { label: 'four scenes' });
}

async function resetFlow(flowFrame, failOn = []) {
  await flowFrame.evaluate((fails) => {
    window.__generations = [];
    window.__failOn = fails;
  }, failOn);
}

/** Track the largest number of generations started but not finished during a run. */
function startConcurrencyWatch(frame) {
  const state = { maxInFlight: 0, running: true };
  (async () => {
    while (state.running) {
      try {
        const snapshot = await flowGenerations();
        state.maxInFlight = Math.max(state.maxInFlight, snapshot.generations.length - snapshot.outputs);
      } catch {
        // ignore transient errors during reloads
      }
      await sleep(200);
    }
  })();
  return state;
}

try {
  // ---------------------------------------------------------------------------
  await openHarness({ reset: true });
  let panelFrame = await panel();

  // ---- 1. Connection -------------------------------------------------------
  const connected = await waitFor(() => panelFrame.$('[data-connection="connected"]'), { timeout: 20000, label: 'Connected' }).then(
    () => true,
    () => false,
  );
  check('panel shows ● Connected for the active Flow tab', connected);
  const connText = connected ? await panelFrame.$eval('#region-connection .conn-state', (el) => el.textContent.trim()) : '';
  check('connection label text is "● Connected"', connText === '● Connected', connText);

  // ---- 2. Layout at the required sizes -----------------------------------
  const layouts = [
    { viewport: [1366, 768], panel: 320, name: '1366x768 narrow panel (320px)' },
    { viewport: [1366, 768], panel: 400, name: '1366x768 typical panel (400px)' },
    { viewport: [1440, 900], panel: 400, name: '1440x900 typical panel (400px)' },
    { viewport: [1920, 1080], panel: 560, name: '1920x1080 wide panel (560px)' },
  ];
  for (const layout of layouts) {
    await page.setViewport({ width: layout.viewport[0], height: layout.viewport[1] });
    await page.evaluate((width) => document.documentElement.style.setProperty('--panel-w', `${width}px`), layout.panel);
    await sleep(400);
    panelFrame = await panel();
    const overflow = await panelFrame.evaluate(() => {
      const doc = document.documentElement;
      const width = doc.clientWidth;
      const offenders = [];
      for (const el of document.querySelectorAll('.app *')) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || getComputedStyle(el).display === 'none') continue;
        if (rect.right > width + 1 && !el.closest('details:not([open])')) {
          offenders.push(`${el.tagName.toLowerCase()}.${el.className}`);
        }
      }
      return { scrollOverflow: doc.scrollWidth - doc.clientWidth, offenders: offenders.slice(0, 5) };
    });
    check(`no horizontal overflow: ${layout.name}`, overflow.scrollOverflow <= 0 && overflow.offenders.length === 0, JSON.stringify(overflow));
    const handle = await page.$('#panel');
    await handle.screenshot({ path: join(shots, `panel-${layout.viewport[0]}x${layout.viewport[1]}-${layout.panel}px.png`) });
  }
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluate(() => document.documentElement.style.setProperty('--panel-w', '400px'));
  await sleep(300);
  panelFrame = await panel();

  // ---- 3. Reference library and document -----------------------------------
  const refs = [
    join(ROOT, 'examples', 'reference-library', 'Aron.png'),
    join(ROOT, 'examples', 'reference-library', 'Vex.png'),
    join(ROOT, 'examples', 'reference-library', 'Mira.png'),
    join(ROOT, 'examples', 'reference-library', 'Laboratory.png'),
  ];
  const fileInput = await panelFrame.$('#ref-input');
  await fileInput.uploadFile(...refs);
  await waitFor(async () => (await panelFrame.$$('.ref-item')).length === 4, { label: 'four library files' });
  const libraryNames = await panelFrame.$$eval('.ref-name', (els) => els.map((el) => el.textContent.trim()).sort());
  check('reference library holds Aron.png, Vex.png, Mira.png, Laboratory.png', JSON.stringify(libraryNames) === JSON.stringify(['Aron.png', 'Laboratory.png', 'Mira.png', 'Vex.png']), libraryNames.join(', '));

  await analyzeExample(panelFrame);
  const scenes = await sceneStatuses(panelFrame);
  check('example document shows four queued scenes', scenes.length === 4 && scenes.every((scene) => scene.status === 'Waiting'), scenes.map((s) => s.status).join(','));
  const startEnabled = await panelFrame.$('[data-action="start"]:not([disabled])');
  check('Start is enabled once references resolve and Flow is connected', Boolean(startEnabled));
  const settingsShown = await waitFor(async () => {
    const values = await panelFrame.$$eval('select[data-setting]', (els) => els.map((el) => `${el.dataset.setting}=${el.value}`));
    return values.includes('mode=Image') && values.includes('model=Nano Banana Pro') && values.includes('aspectRatio=16:9') ? values : null;
  }, { timeout: 20000, label: 'Flow settings shown' }).catch(() => null);
  check('Flow settings appear in the panel without a manual read', Boolean(settingsShown), settingsShown ? settingsShown.join(' ') : 'not shown');

  // ---- 4. Full run: sequential, correct references, real completion ----------
  const flowFrame = await flow();
  await resetFlow(flowFrame);
  const watch = startConcurrencyWatch(flowFrame);
  await startAndConfirm(panelFrame);
  await waitFor(async () => (await phaseOf(panelFrame)) === 'completed', { timeout: 300000, interval: 500, label: 'run completed' });
  watch.running = false;
  const run1 = await flowGenerations();
  check('four generations were submitted for four scenes', run1.generations.length === 4, `count=${run1.generations.length}`);
  check('no scene was submitted before the previous output was visible (max in flight <= 1)', watch.maxInFlight <= 1, `max=${watch.maxInFlight}`);
  const expectedRefs = [
    ['Aron.png', 'Laboratory.png'],
    ['Aron.png'],
    ['Vex.png', 'Mira.png'],
    ['Mira.png', 'Laboratory.png'],
  ];
  const refsOk = run1.generations.every((gen, index) => JSON.stringify(gen.refs) === JSON.stringify(expectedRefs[index]));
  check('each scene carried only its own references into Flow', refsOk, JSON.stringify(run1.generations.map((gen) => gen.refs)));
  const orderOk = run1.generations.every((gen, index) => gen.prompt.startsWith(['Wide establishing', 'Medium shot of Aron', 'Close-up of Vex', 'Mira steps out'][index]));
  check('prompts were submitted verbatim in document order', orderOk);
  const settingsOk = run1.generations.every((gen) => gen.mode === 'Image' && gen.model === 'Nano Banana Pro' && gen.aspectRatio === '16:9');
  check('generations used the settings that were applied in Flow', settingsOk);
  const finalStatuses = await sceneStatuses(panelFrame);
  check('all four scenes show Completed in the queue', finalStatuses.every((scene) => scene.status === 'Completed'), finalStatuses.map((s) => s.status).join(','));

  // ---- 5. Failure pauses, Retry continues without regenerating scene 1 ------
  await clickIn(panelFrame, '[data-action="clear-project"]');
  await waitFor(async () => (await sceneStatuses(panelFrame)).length === 0, { label: 'cleared queue' });
  await analyzeExample(panelFrame);
  await resetFlow(flowFrame, [2]);
  await startAndConfirm(panelFrame);
  await waitFor(async () => (await phaseOf(panelFrame)) === 'paused', { timeout: 200000, interval: 400, label: 'paused on failure' });
  const afterFailure = await sceneStatuses(panelFrame);
  check('a failed Flow generation pauses the queue', (await phaseOf(panelFrame)) === 'paused');
  check('the failed scene is marked Failed and the first scene stays Completed', afterFailure[0].status === 'Completed' && afterFailure[1].status === 'Failed', afterFailure.map((s) => s.status).join(','));
  const decisionTitle = await panelFrame.$eval('.decision-title', (el) => el.textContent.trim()).catch(() => '');
  check('the pause explains the failure with Retry, Skip and Stop', Boolean(decisionTitle) && (await panelFrame.$('[data-action="retry"]')) !== null && (await panelFrame.$('[data-action="skip"]')) !== null && (await panelFrame.$('[data-action="stop"]')) !== null, decisionTitle);
  await flowFrame.evaluate(() => {
    window.__failOn = [];
  });
  await clickIn(panelFrame, '[data-action="retry"]');
  await waitFor(async () => (await phaseOf(panelFrame)) === 'completed', { timeout: 200000, interval: 500, label: 'completed after retry' });
  const run2 = await flowGenerations();
  const countOf = (marker) => run2.generations.filter((gen) => gen.prompt.startsWith(marker)).length;
  check('Retry resubmits scene 2 and completes the queue', run2.generations.length === 5, `count=${run2.generations.length}`);
  check(
    'scene 1 was not regenerated; scene 2 was submitted twice (failed, then retried); scenes 3 and 4 once each',
    countOf('Wide establishing') === 1 && countOf('Medium shot of Aron') === 2 && countOf('Close-up of Vex') === 1 && countOf('Mira steps out') === 1,
    JSON.stringify(run2.generations.map((gen) => gen.prompt.slice(0, 14))),
  );

  // ---- 6. Pause during generation keeps the scene; resume does not resubmit --
  await clickIn(panelFrame, '[data-action="clear-project"]');
  await waitFor(async () => (await sceneStatuses(panelFrame)).length === 0, { label: 'cleared queue again' });
  await analyzeExample(panelFrame);
  await resetFlow(flowFrame);
  await startAndConfirm(panelFrame);
  await waitFor(async () => (await flowGenerations()).generations.length >= 1, { timeout: 60000, label: 'first generation submitted' });
  await clickIn(panelFrame, '[data-action="pause"]');
  await waitFor(async () => (await phaseOf(panelFrame)) === 'paused', { timeout: 60000, label: 'paused' });
  const pausedAt = (await flowGenerations()).generations.length;
  const pausedStatus = (await sceneStatuses(panelFrame))[0]?.status;
  await sleep(6000);
  check('pause keeps the scene in place (Paused, not Failed)', pausedStatus === 'Paused', pausedStatus);
  check('nothing new is submitted while paused', (await flowGenerations()).generations.length === pausedAt);
  await clickIn(panelFrame, '[data-action="resume"]');
  await waitFor(async () => (await phaseOf(panelFrame)) === 'completed', { timeout: 200000, interval: 500, label: 'completed after resume' });
  const run3 = await flowGenerations();
  check('resume finishes the queue with exactly one submission per scene', run3.generations.length === 4, `count=${run3.generations.length}`);

  // ---- 7. Reload mid-run: state is restored and nothing restarts by itself --
  await clickIn(panelFrame, '[data-action="clear-project"]');
  await waitFor(async () => (await sceneStatuses(panelFrame)).length === 0, { label: 'cleared queue for reload test' });
  await analyzeExample(panelFrame);
  await resetFlow(flowFrame);
  await startAndConfirm(panelFrame);
  await waitFor(async () => (await flowGenerations()).generations.length >= 1, { timeout: 60000, label: 'generation before reload' });
  await openHarness();
  panelFrame = await panel();
  const restoredPhase = await waitFor(async () => {
    const phase = await phaseOf(panelFrame);
    return phase === 'paused' ? phase : null;
  }, { timeout: 60000, label: 'restored paused phase' }).catch(() => null);
  check('after a reload the panel restores the run as Paused (interrupted), not running', restoredPhase === 'paused');
  const restoredDecision = await panelFrame.$eval('.decision-title', (el) => el.textContent.trim()).catch(() => '');
  check('the restored run asks the user what to do', /interrupted/i.test(restoredDecision), restoredDecision);
  await sleep(4000);
  const afterReload = await flowGenerations();
  check('the worker does not restart a generation by itself after reload', afterReload.generations.length === 0, `count=${afterReload.generations.length}`);
  const restoredQueue = await sceneStatuses(panelFrame);
  check('the queue is restored with the interrupted scene still in the list', restoredQueue.length === 4, restoredQueue.map((s) => s.status).join(','));
  await clickIn(panelFrame, '[data-action="stop"]');
  await waitFor(async () => (await phaseOf(panelFrame)) === 'stopped', { timeout: 30000, label: 'stopped' });
  check('Stop halts the queue cleanly', (await phaseOf(panelFrame)) === 'stopped');

  // ---- 8. Flow settings: read again from Flow, and change them in Flow ------------
  panelFrame = await panel();
  await clickIn(panelFrame, '[data-action="refresh-settings"]');
  const readNotice = await waitFor(async () => (await panelFrame.$eval('#region-notice', (el) => el.textContent)).includes('Read Flow settings'), { timeout: 20000, label: 'read notice' }).then(() => true, () => false);
  check('Read from Flow reports success', readNotice);
  const flowForSettings = await flow();
  await panelFrame.select('select[data-setting="mode"]', 'Video');
  await waitFor(async () => (await flowForSettings.evaluate(() => window.__fixture.state.mode)) === 'Video', { timeout: 20000, label: 'mode changed in Flow' }).then(
    () => check('changing Mode in the panel changes the mode in Flow', true),
    () => check('changing Mode in the panel changes the mode in Flow', false),
  );
  const videoModels = await waitFor(async () => {
    const options = await panelFrame.$$eval('select[data-setting="model"] option', (els) => els.map((el) => el.value));
    return options.includes('Veo 3.1') ? options : null;
  }, { timeout: 20000, label: 'video models listed' }).catch(() => []);
  check('Model options follow the mode Flow reports (Video offers Veo 3.1)', videoModels.includes('Veo 3.1') && !videoModels.includes('Nano Banana Pro'), videoModels.join(', '));
  await panelFrame.select('select[data-setting="mode"]', 'Image');
  await waitFor(async () => (await flowForSettings.evaluate(() => window.__fixture.state.mode)) === 'Image', { timeout: 20000, label: 'mode restored in Flow' });

  // ---- 9. Flow not active ------------------------------------------------------
  await page.evaluate(() => window.__fsqStub.setActiveTab({ id: 9, url: 'https://example.com/', active: true }));
  panelFrame = await panel();
  const disconnected = await waitFor(() => panelFrame.$('[data-connection="not-connected"]'), { timeout: 15000, label: 'Not Connected' }).then(
    () => true,
    () => false,
  );
  check('a non-Flow active tab shows ○ Not Connected', disconnected);
  const notConnectedText = disconnected ? await panelFrame.$eval('#region-connection .conn-state', (el) => el.textContent.trim()) : '';
  check('the not-connected label reads "○ Not Connected"', notConnectedText === '○ Not Connected', notConnectedText);
  await page.evaluate(() => window.__fsqStub.setActiveTab({ id: 1, url: 'https://flow.google.com/project/e2e-test', active: true }));
  await waitFor(() => panelFrame.$('[data-connection="connected"]'), { timeout: 15000, label: 'reconnected' }).then(() => check('reconnects when the Flow tab is active again', true)).catch(() => check('reconnects when the Flow tab is active again', false));

  await page.evaluate(() => document.documentElement.style.setProperty('--panel-w', '400px'));
  const finalShot = await page.screenshot({ path: join(shots, 'harness-full.png') });
  void finalShot;
} catch (error) {
  check('harness scenario completed without an exception', false, error.message);
  try {
    await page.screenshot({ path: join(shots, 'failure.png') });
  } catch {
    // ignore
  }
}

check('no uncaught page or console errors during the run', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));

await browser.close();
server.close();

const failed = results.filter((item) => !item.ok);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed.`);
if (failed.length) {
  console.log('Failed:');
  for (const item of failed) console.log(` - ${item.name}${item.detail ? ` (${item.detail})` : ''}`);
  process.exitCode = 1;
}
void here;
