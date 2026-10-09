import { parseScenes } from '../parser/parse-scenes.js';
import { resolveReferenceTokens, summarizeSceneReferences } from '../references/match.js';
import { listLibrary } from '../references/library.js';
import { buildSceneQueue, countByStatus, updateReferenceSummaries } from '../queue/scene-model.js';
import { computeReadiness } from '../queue/readiness.js';
import { SESSION_PHASE, isActivePhase } from '../queue/states.js';
import { AutomationError, ERROR_CODES, toErrorPayload } from '../utils/errors.js';
import { defaultValue, DEFAULT_PREFS, LOG_LIMIT, mergePrefs, STORAGE_KEYS } from '../storage/schema.js';
import { uid } from '../utils/ids.js';
import { checkFlowConnection } from './connection.js';

const K = STORAGE_KEYS;
const SESSION_CONNECTION_KEY = K.connection;

/**
 * Command handler for the side panel. It owns the rules the UI relies on:
 * the document cannot be replaced mid-run, settings cannot change mid-scene,
 * and every command that touches Flow first binds the active Flow tab.
 */
export class Controller {
  /**
   * @param {object} deps
   * @param {import('../storage/store.js').KeyValueStore} deps.store
   * @param {import('../queue/runner.js').AutomationRunner} deps.runner
   * @param {ReturnType<import('./flow-bridge.js').createFlowBridge>} deps.bridge
   * @param {{get: Function, set: Function}} deps.kv  chrome.storage.local adapter
   * @param {typeof chrome} deps.chromeApi
   * @param {() => number} [deps.now]
   */
  constructor({ store, runner, bridge, kv, chromeApi, now = () => Date.now() }) {
    this.store = store;
    this.runner = runner;
    this.bridge = bridge;
    this.kv = kv;
    this.chromeApi = chromeApi;
    this.now = now;
    this.runner.logger = (level, message, sceneId) => this.log(level, message, sceneId);
    this.flowBusy = 0;
    this.settingsReadPromise = null;
    this.settingsRetryAfter = 0;
  }

  async handle(name, payload = {}) {
    switch (name) {
      case 'getState':
        return this.getState();
      case 'checkFlow':
        return this.checkFlow({ autoRead: true });
      case 'diagnoseFlow':
        return this.diagnoseFlow();
      case 'analyze':
        return this.analyze(payload);
      case 'setPrefs':
        return this.setPrefs(payload);
      case 'setOverride':
        return this.setOverride(payload);
      case 'refreshReferences':
        return this.refreshReferences();
      case 'clearProject':
        return this.clearProject();
      case 'refreshFlowSettings':
        return this.refreshFlowSettings();
      case 'setFlowSetting':
        return this.setFlowSetting(payload);
      case 'start':
        return this.start();
      case 'pause':
        return this.runner.pause();
      case 'resume':
        return this.resume();
      case 'stop':
        return this.runner.stop();
      case 'retry':
        return this.bindThen(() => this.runner.retry(requireString(payload.sceneId, 'sceneId')));
      case 'skip':
        return this.bindThen(() => this.runner.skip(requireString(payload.sceneId, 'sceneId')));
      case 'markCompleted':
        return this.bindThen(() => this.runner.markCompleted(requireString(payload.sceneId, 'sceneId')));
      case 'regenerate':
        return this.runner.regenerate(requireString(payload.sceneId, 'sceneId'));
      case 'clearLogs':
        return this.store.update(K.logs, () => []).then(() => null);
      default:
        throw new AutomationError(ERROR_CODES.INVALID_INPUT, `Unknown command "${name}".`, { recoverable: false });
    }
  }

  // ---------------------------------------------------------------------------
  // Read-only state
  // ---------------------------------------------------------------------------

  async getState() {
    const queue = this.store.read(K.queue);
    const document = this.store.read(K.document);
    const automation = this.store.read(K.automation);
    const readiness = computeReadiness({ queue, documentState: document });
    const connection = await this.readConnection();
    return {
      connection,
      document,
      queue: { ...queue, counts: countByStatus(queue) },
      readiness,
      automation,
      prefs: mergePrefs(this.store.read(K.prefs)),
      flowSettings: this.store.read(K.flowSettings),
      logs: this.store.read(K.logs).slice(-150),
      serverTime: this.now(),
    };
  }

  async readConnection() {
    try {
      const data = await this.chromeApi.storage.session.get(SESSION_CONNECTION_KEY);
      return data[SESSION_CONNECTION_KEY] ?? defaultValue(K.connection);
    } catch {
      return defaultValue(K.connection);
    }
  }

  async checkFlow({ autoRead = false } = {}) {
    const status = await checkFlowConnection({ chromeApi: this.chromeApi, now: this.now });
    await this.chromeApi.storage.session.set({ [SESSION_CONNECTION_KEY]: status });
    if (autoRead && status.status === 'connected' && status.promptFound) {
      this.readSettingsOnceFor(status.tabId);
    }
    return status;
  }

  /**
   * The first time a project page is seen, read Flow's settings so the panel shows real values
   * without a manual step. This briefly opens Flow's settings menu. It is skipped while automation
   * is active, and after a failure it waits a minute before trying again.
   */
  readSettingsOnceFor(tabId) {
    if (this.flowBusy > 0 || this.settingsReadPromise) return;
    if (this.store.read(K.flowSettings).readAt) return;
    if (this.settingsRetryAfter && this.now() < this.settingsRetryAfter) return;
    if (isActivePhase(this.store.read(K.automation).phase)) return;
    this.settingsReadPromise = this.bindTab(tabId)
      .then(() => this.bridge.readSettings())
      .then((result) => this.storeFlowSettings(result))
      .catch(async (error) => {
        this.settingsRetryAfter = this.now() + 60000;
        await this.log('info', `Flow settings are not read yet: ${toErrorPayload(error).message}`);
      })
      .finally(() => {
        this.settingsReadPromise = null;
      });
  }

  /**
   * Run a command that operates Flow's menus. Background reads wait while it runs, and it waits for
   * any background read already in progress, so two Flow menu operations never overlap.
   */
  async withFlowCommand(task) {
    this.flowBusy += 1;
    try {
      if (this.settingsReadPromise) await this.settingsReadPromise;
      return await task();
    } finally {
      this.flowBusy -= 1;
    }
  }

  async storeFlowSettings(result) {
    await this.store.update(K.flowSettings, () => ({
      current: result.current,
      options: result.options,
      readAt: this.now(),
      source: 'flow',
    }));
    return this.store.read(K.flowSettings);
  }

  /** Point the automation at a tab, unless a run is active (a run keeps its own tab). */
  async bindTab(tabId) {
    if (tabId == null) return;
    await this.store.update(K.automation, (automation) => (isActivePhase(automation.phase) ? automation : { ...automation, tabId }));
  }

  async diagnoseFlow() {
    const status = await this.checkFlow();
    if (status.status !== 'connected' || status.tabId == null) {
      return { ok: false, checks: [{ label: 'Flow tab', ok: false, detail: status.message }], checkedAt: status.checkedAt };
    }
    const report = await this.bridge.diagnoseTab(status.tabId);
    return { ...report, checkedAt: status.checkedAt, tabId: status.tabId };
  }

  // ---------------------------------------------------------------------------
  // Document and queue
  // ---------------------------------------------------------------------------

  async analyze({ text }) {
    this.assertDocumentEditable();
    const documentText = String(text ?? '');
    const parsed = parseScenes(documentText);
    const library = await listLibrary(this.kv);
    const prefs = mergePrefs(this.store.read(K.prefs));
    const overrides = this.store.read(K.overrides);
    const summaries = this.summarize(parsed.scenes, library, prefs, overrides);
    const now = this.now();

    const previousQueue = this.store.read(K.queue);
    // A completed scene whose text or references changed is a new scene: report it instead of regenerating silently.
    const completedNumbers = new Set(previousQueue.scenes.filter((item) => previousQueue.completed?.[item.id]).map((item) => item.number));
    const changed = parsed.scenes
      .filter((scene) => !previousQueue.scenes.some((item) => item.id === scene.id) && completedNumbers.has(scene.number))
      .map((scene) => scene.number);

    const queue = buildSceneQueue({ scenes: parsed.scenes, summaries, previous: previousQueue, now });
    await this.store.update(K.queue, () => queue);
    await this.store.update(K.document, () => ({
      text: documentText,
      updatedAt: now,
      analyzedAt: now,
      sceneCount: parsed.scenes.length,
      errors: parsed.errors,
      warnings: parsed.warnings,
      preamble: parsed.preamble,
    }));

    const readiness = computeReadiness({ queue, documentState: this.store.read(K.document) });
    const message = parsed.errors.length
      ? `Analyzed ${parsed.scenes.length} scenes with ${parsed.errors.length} blocking problem${parsed.errors.length === 1 ? '' : 's'}.`
      : `Analyzed ${parsed.scenes.length} scenes.`;
    await this.log(parsed.errors.length ? 'warn' : 'success', message);
    for (const number of changed) {
      await this.log('info', `Scene ${String(number).padStart(2, '0')} has a changed prompt, so it will generate again.`);
    }
    return {
      sceneCount: parsed.scenes.length,
      errors: parsed.errors,
      warnings: parsed.warnings,
      readiness,
    };
  }

  async refreshReferences() {
    const document = this.store.read(K.document);
    const queue = this.store.read(K.queue);
    if (!queue.scenes.length) return { updated: 0 };
    const parsed = parseScenes(document.text);
    const library = await listLibrary(this.kv);
    const prefs = mergePrefs(this.store.read(K.prefs));
    const overrides = this.store.read(K.overrides);
    const summaries = this.summarize(parsed.scenes, library, prefs, overrides);
    const now = this.now();
    await this.store.update(K.queue, (current) => updateReferenceSummaries({ queue: current, scenes: parsed.scenes, summaries, now }));
    return { updated: parsed.scenes.length };
  }

  async setOverride({ sceneNumber, tokenKey, fileId }) {
    this.assertNotActive();
    const key = `${Number(sceneNumber)}|${String(tokenKey).toLowerCase()}`;
    await this.store.update(K.overrides, (overrides) => {
      if (fileId) overrides[key] = fileId;
      else delete overrides[key];
      return overrides;
    });
    await this.refreshReferences();
    await this.log('info', fileId ? `Scene ${String(sceneNumber).padStart(2, '0')}: ${tokenKey} set to the chosen file.` : `Scene ${String(sceneNumber).padStart(2, '0')}: choice for ${tokenKey} cleared.`);
    return this.store.read(K.queue);
  }

  async clearProject() {
    const { phase } = this.store.read(K.automation);
    if (isActivePhase(phase) || phase === SESSION_PHASE.PAUSED) {
      throw new AutomationError(ERROR_CODES.INVALID_STATE, 'Stop the automation before clearing the project.');
    }
    await this.store.update(K.document, () => defaultValue(K.document));
    await this.store.update(K.queue, () => defaultValue(K.queue));
    await this.store.update(K.overrides, () => ({}));
    await this.store.update(K.automation, () => defaultValue(K.automation));
    await this.log('warn', 'Project cleared. The reference library and settings were kept.');
    return null;
  }

  // ---------------------------------------------------------------------------
  // Preferences and Flow settings
  // ---------------------------------------------------------------------------

  async setPrefs(patch) {
    const allowed = Object.keys(DEFAULT_PREFS);
    const clean = Object.fromEntries(Object.entries(patch ?? {}).filter(([key]) => allowed.includes(key)));
    const before = mergePrefs(this.store.read(K.prefs));
    const next = await this.store.update(K.prefs, (current) => mergePrefs({ ...current, ...clean }));
    if (before.caseInsensitiveMatching !== next.caseInsensitiveMatching || before.strictFilenameMatching !== next.strictFilenameMatching) {
      await this.refreshReferences();
    }
    return next;
  }

  async refreshFlowSettings() {
    this.assertNotActive('Settings are read at the start of each run. Stop the automation to read them now.');
    return this.withFlowCommand(() =>
      this.withFlowTab(async () => {
        const result = await this.bridge.readSettings();
        return this.storeFlowSettings(result);
      }),
    );
  }

  async setFlowSetting({ key, value }) {
    if (!['mode', 'model', 'aspectRatio'].includes(key) || !value) {
      throw new AutomationError(ERROR_CODES.INVALID_INPUT, 'Choose a Flow setting and value.', { recoverable: false });
    }
    this.assertNotActive('Stop or pause the automation before changing Flow settings.');
    return this.withFlowCommand(() =>
      this.withFlowTab(async () => {
        const result = await this.bridge.applySettings({ [key]: String(value) });
        const stored = await this.storeFlowSettings(result);
        await this.log('success', `Flow ${labelOf(key)} set to ${value}.`);
        return stored;
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Automation commands
  // ---------------------------------------------------------------------------

  async start() {
    return this.withFlowCommand(async () => {
      const status = await this.checkFlow();
      if (status.status !== 'connected') {
        throw new AutomationError(ERROR_CODES.FLOW_NOT_CONNECTED, `${status.message} Then press Start again.`);
      }
      await this.refreshReferences();
      return this.runner.start({ tabId: status.tabId });
    });
  }

  async resume() {
    return this.withFlowCommand(async () => {
      const status = await this.checkFlow();
      if (status.status !== 'connected') {
        throw new AutomationError(ERROR_CODES.FLOW_NOT_CONNECTED, `${status.message} Then press Resume again.`);
      }
      return this.runner.resume({ tabId: status.tabId });
    });
  }

  /** Bind the active Flow tab for commands that may launch the loop, when nothing is running. */
  async bindThen(task) {
    const { phase } = this.store.read(K.automation);
    if (!isActivePhase(phase)) {
      const status = await this.checkFlow();
      await this.bindTab(status.tabId);
    }
    return task();
  }

  /** Run `task` against the active Flow tab, binding it first. Used for read/write of Flow settings. */
  async withFlowTab(task) {
    const status = await this.checkFlow();
    if (status.status !== 'connected' || status.tabId == null) {
      throw new AutomationError(ERROR_CODES.FLOW_NOT_CONNECTED, status.message);
    }
    await this.bindTab(status.tabId);
    return task();
  }

  assertDocumentEditable() {
    const { phase } = this.store.read(K.automation);
    if (isActivePhase(phase) || phase === SESSION_PHASE.PAUSED) {
      throw new AutomationError(ERROR_CODES.INVALID_STATE, 'Stop the automation before changing the scene document.');
    }
  }

  assertNotActive(message = 'Stop or pause the automation before changing a reference choice.') {
    const { phase } = this.store.read(K.automation);
    if (isActivePhase(phase)) {
      throw new AutomationError(ERROR_CODES.INVALID_STATE, message);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  summarize(scenes, library, prefs, overrides) {
    return scenes.map((scene) => {
      const sceneOverrides = {};
      for (const [key, fileId] of Object.entries(overrides ?? {})) {
        const [number, tokenKey] = key.split('|');
        if (Number(number) === scene.number) sceneOverrides[tokenKey] = fileId;
      }
      const resolutions = resolveReferenceTokens(
        scene.referenceTokens,
        library,
        { caseInsensitive: prefs.caseInsensitiveMatching, strictFilenameMatching: prefs.strictFilenameMatching },
        sceneOverrides,
      );
      return { ...summarizeSceneReferences(resolutions), resolutions };
    });
  }

  async log(level, message, sceneId = null) {
    const entry = { id: uid('log'), at: this.now(), level, message, sceneId: sceneId ?? null };
    await this.store.update(K.logs, (logs) => [...logs, entry].slice(-LOG_LIMIT));
  }
}

function requireString(value, name) {
  if (typeof value !== 'string' || !value) {
    throw new AutomationError(ERROR_CODES.INVALID_INPUT, `Missing ${name}.`, { recoverable: false });
  }
  return value;
}

function labelOf(key) {
  return { mode: 'mode', model: 'model', aspectRatio: 'aspect ratio' }[key] ?? key;
}
