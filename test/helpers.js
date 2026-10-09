import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { memoryKv } from '../src/storage/kv.js';
import { KeyValueStore } from '../src/storage/store.js';
import { STORAGE_KEYS, defaultValue, mergePrefs } from '../src/storage/schema.js';
import { parseScenes } from '../src/parser/parse-scenes.js';
import { resolveReferenceTokens, summarizeSceneReferences } from '../src/references/match.js';
import { buildSceneQueue } from '../src/queue/scene-model.js';
import { AutomationRunner } from '../src/queue/runner.js';
import { FLOW_PORT_METHODS } from '../src/shared/protocol.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const TEST_LIBRARY = [
  { id: 'ref-aron', name: 'Aron.png', mime: 'image/png', size: 1000 },
  { id: 'ref-vex', name: 'Vex.png', mime: 'image/png', size: 1000 },
  { id: 'ref-mira', name: 'Mira.png', mime: 'image/png', size: 1000 },
  { id: 'ref-lab', name: 'Laboratory.png', mime: 'image/png', size: 1000 },
];

export function readExampleDocument() {
  return readFileSync(join(ROOT, 'examples', 'test-scenes.txt'), 'utf8');
}

/** Virtual clock: sleeping advances time instantly, so timing logic runs deterministically. */
export function virtualClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      await Promise.resolve();
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

export async function createStore(initial = {}) {
  const kv = memoryKv(initial);
  const store = new KeyValueStore(kv);
  await store.load([
    STORAGE_KEYS.prefs,
    STORAGE_KEYS.document,
    STORAGE_KEYS.queue,
    STORAGE_KEYS.automation,
    STORAGE_KEYS.overrides,
    STORAGE_KEYS.logs,
    STORAGE_KEYS.flowSettings,
  ]);
  return { kv, store };
}

/** Parse, match and build the queue exactly as the service worker does. */
export function buildProject(text, { library = TEST_LIBRARY, prefs = {}, overrides = {}, now = 1 } = {}) {
  const parsed = parseScenes(text);
  const merged = mergePrefs(prefs);
  const summaries = parsed.scenes.map((scene) => {
    const sceneOverrides = {};
    for (const [key, fileId] of Object.entries(overrides)) {
      const [number, tokenKey] = key.split('|');
      if (Number(number) === scene.number) sceneOverrides[tokenKey] = fileId;
    }
    const resolutions = resolveReferenceTokens(
      scene.referenceTokens,
      library,
      { caseInsensitive: merged.caseInsensitiveMatching, strictFilenameMatching: merged.strictFilenameMatching },
      sceneOverrides,
    );
    return { ...summarizeSceneReferences(resolutions), resolutions };
  });
  const queue = buildSceneQueue({ scenes: parsed.scenes, summaries, previous: null, now });
  const document = {
    ...defaultValue(STORAGE_KEYS.document),
    text,
    analyzedAt: now,
    updatedAt: now,
    sceneCount: parsed.scenes.length,
    errors: parsed.errors,
    warnings: parsed.warnings,
  };
  return { parsed, queue, document, prefs: merged, overrides };
}

export const FAST_TIMINGS = Object.freeze({
  pollMs: 1000,
  settleMs: 2000,
  requiredCompletedPolls: 2,
  submitTimeoutMs: 10000,
  idleTimeoutMs: 20000,
  maxAutomaticRetries: 1,
  retryDelayMs: 100,
});

/**
 * Scripted Flow. A generation takes `pollsUntilDone` polls, then one new output appears.
 * Every call is recorded so tests can assert ordering. `overlaps` counts any submit
 * that happened while a previous generation was still unfinished.
 *
 * Script options:
 *   pollsUntilDone   number of in-progress polls before the output appears (default 2)
 *   uploadFailures   number of attach calls that confirm nothing
 *   submitFailures   number of Generate clicks that throw (the first ones)
 *   failSubmitCalls  1-based Generate click numbers that throw (e.g. [2] fails the second scene)
 *   failGeneration   Flow reports a failed generation
 *   neverFinish      generation never completes
 *   agentOn          Agent toggle is on
 *   onPoll(n, flow)  hook called on every generationStatus poll
 */
export function scriptedFlow(script = {}) {
  const state = {
    calls: [],
    submits: [],
    attached: [],
    outputs: [],
    inFlight: null,
    overlaps: 0,
    uploadFailuresLeft: script.uploadFailures ?? 0,
    submitFailuresLeft: script.submitFailures ?? 0,
    settings: { mode: 'Image', model: 'Nano Banana Pro', aspectRatio: '16:9', ...script.settings },
    options: {
      mode: ['Image', 'Video'],
      model: ['Nano Banana Pro', 'Nano Banana'],
      aspectRatio: ['16:9', '9:16', '1:1'],
      ...script.options,
    },
    promptText: '',
    pollCount: 0,
    probeError: null,
    probeQueue: [],
  };

  const flow = {
    state,
    async probe() {
      state.calls.push('probe');
      if (state.probeQueue.length) {
        const next = state.probeQueue.shift();
        if (next instanceof Error) throw next;
      }
      if (state.probeError) throw state.probeError;
      return {
        url: 'https://flow.google.com/project/test',
        isProjectPage: true,
        promptFound: true,
        promptStrategy: 'scripted',
        agentOn: Boolean(script.agentOn),
      };
    },
    async readSettings() {
      state.calls.push('readSettings');
      return { current: { ...state.settings }, options: structuredClone(state.options), strategy: 'scripted' };
    },
    async applySettings(target) {
      state.calls.push(['applySettings', target]);
      if (script.applySettingsError) throw script.applySettingsError;
      // A locked setting models Flow refusing the change: the value Flow reports stays put.
      if (!script.lockedSettings) Object.assign(state.settings, target);
      Object.assign(state.settings, script.lockedSettings ?? {});
      // Keys the scripted page does not expose: applied values are left alone and the
      // key is reported, exactly as the live menu does when a control is missing.
      return {
        current: { ...state.settings },
        options: structuredClone(state.options),
        strategy: 'scripted',
        notOffered: script.notOffered ?? [],
      };
    },
    async countReferences() {
      return { attached: state.attached.length, promptFound: true };
    },
    async clearReferences() {
      state.calls.push('clear');
      const removed = state.attached.length;
      state.attached = [];
      return { removed, remaining: 0 };
    },
    async attachReferences(payloads) {
      state.calls.push(['attach', payloads.map((p) => p.name)]);
      if (state.uploadFailuresLeft > 0) {
        state.uploadFailuresLeft -= 1;
        return { attached: 0, expected: payloads.length };
      }
      state.attached.push(...payloads.map((p) => p.name));
      return { attached: payloads.length, expected: payloads.length };
    },
    async insertPrompt(text) {
      state.calls.push(['insert', text]);
      state.promptText = text;
      return { verified: true, strategy: 'scripted', length: text.length };
    },
    async snapshotOutputs() {
      state.calls.push('snapshot');
      return { outputKeys: [...state.outputs], alerts: [], takenAt: 0 };
    },
    async submit() {
      state.calls.push(['submit', state.promptText]);
      state.submitCalls = (state.submitCalls ?? 0) + 1;
      const failThisCall = (script.failSubmitCalls ?? []).includes(state.submitCalls);
      if (state.submitFailuresLeft > 0 || failThisCall) {
        if (state.submitFailuresLeft > 0) state.submitFailuresLeft -= 1;
        throw Object.assign(new Error('Generate is disabled.'), { code: 'GENERATE_UNAVAILABLE' });
      }
      if (state.inFlight && !state.inFlight.done) state.overlaps += 1;
      const key = `out-${state.outputs.length + 1}`;
      state.inFlight = {
        key,
        remaining: script.pollsUntilDone ?? 2,
        failed: Boolean(script.failGeneration),
        never: Boolean(script.neverFinish),
        done: false,
      };
      state.submits.push({ prompt: state.promptText, attached: [...state.attached] });
      return { clicked: true };
    },
    async generationStatus(baseline) {
      state.pollCount += 1;
      state.calls.push('poll');
      if (script.onPoll) script.onPoll(state.pollCount, flow);
      const known = new Set(baseline?.outputKeys ?? []);
      const newKeys = state.outputs.filter((key) => !known.has(key));
      const flight = state.inFlight;

      if (flight && flight.never) {
        return { state: 'in_progress', started: true, inProgress: true, pending: 1, newOutputs: 0, outputKeys: [], detail: 'Generating' };
      }
      if (flight && flight.failed) {
        flight.done = true;
        return { state: 'failed', started: true, inProgress: false, pending: 0, newOutputs: 0, outputKeys: [], error: { message: 'Flow could not generate this image.' }, detail: 'Failed' };
      }
      if (flight && flight.remaining > 0) {
        flight.remaining -= 1;
        return { state: 'in_progress', started: true, inProgress: true, pending: 1, newOutputs: 0, outputKeys: [], detail: 'Generating' };
      }
      if (flight && !state.outputs.includes(flight.key)) {
        state.outputs.push(flight.key);
      }
      if (flight) {
        flight.done = true;
        const keys = state.outputs.filter((key) => !known.has(key));
        return { state: 'completed', started: true, inProgress: false, pending: 0, newOutputs: keys.length, outputKeys: keys, detail: 'Output visible' };
      }
      return { state: 'pending', started: newKeys.length > 0, inProgress: false, pending: 0, newOutputs: newKeys.length, outputKeys: newKeys, detail: 'Idle' };
    },
  };

  for (const method of FLOW_PORT_METHODS) {
    if (typeof flow[method] !== 'function') throw new Error(`Scripted flow is missing ${method}`);
  }
  return flow;
}

export function fileLoader(library = TEST_LIBRARY) {
  return {
    async load(ids) {
      return ids.map((id) => {
        const item = library.find((entry) => entry.id === id);
        if (!item) {
          throw Object.assign(new Error('Reference missing'), { code: 'REFERENCE_MISSING' });
        }
        return { id, name: item.name, mime: 'image/png', base64: Buffer.from(`fake:${item.name}`).toString('base64') };
      });
    },
  };
}

/** Build a runner wired to in-memory storage and a scripted Flow. */
export async function createRunner({ text, library = TEST_LIBRARY, prefs = {}, flowScript = {}, timings = {}, initialAutomation, overrides = {} } = {}) {
  const clock = virtualClock();
  const project = buildProject(text ?? readExampleDocument(), { library, prefs, overrides, now: clock.now() });
  const initial = {
    [STORAGE_KEYS.prefs]: project.prefs,
    [STORAGE_KEYS.document]: project.document,
    [STORAGE_KEYS.queue]: project.queue,
    [STORAGE_KEYS.overrides]: overrides,
  };
  if (initialAutomation) initial[STORAGE_KEYS.automation] = initialAutomation;
  const { store } = await createStore(initial);
  const flow = scriptedFlow(flowScript);
  const logs = [];
  const runner = new AutomationRunner({
    store,
    flow,
    files: fileLoader(library),
    log: async (level, message, sceneId) => {
      logs.push({ level, message, sceneId });
    },
    clock,
    timings: { ...FAST_TIMINGS, ...timings },
  });
  return { runner, store, flow, clock, logs };
}

export function sceneByNumber(store, number) {
  return store.read(STORAGE_KEYS.queue).scenes.find((scene) => scene.number === number);
}
