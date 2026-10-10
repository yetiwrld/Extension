import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRunner, sceneByNumber, readExampleDocument, TEST_LIBRARY } from './helpers.js';
import { STORAGE_KEYS } from '../src/storage/schema.js';
import { parseScenes } from '../src/parser/parse-scenes.js';

const queueOf = (store) => store.read(STORAGE_KEYS.queue);
const automationOf = (store) => store.read(STORAGE_KEYS.automation);

test('the example queue runs one scene at a time, in order, with each scene uploading only its own references', async () => {
  const { runner, store, flow } = await createRunner();

  await runner.start({ tabId: 7 });
  await runner.whenIdle();

  assert.equal(automationOf(store).phase, 'completed');
  assert.equal(flow.state.overlaps, 0, 'no submission may overlap an unfinished generation');
  assert.equal(flow.state.submits.length, 4);
  assert.deepEqual(flow.state.downloads, ['out-1', 'out-2', 'out-3', 'out-4'], 'each completed scene requests exactly one download');
  assert.deepEqual(
    flow.state.submits.map((submit) => submit.prompt.slice(0, 12)),
    ['Wide establi', 'Medium shot ', 'Close-up of ', 'Mira steps o'],
  );

  const uploads = flow.state.calls.filter((call) => Array.isArray(call) && call[0] === 'attach').map((call) => call[1]);
  assert.deepEqual(uploads, [
    ['Aron.png', 'Laboratory.png'],
    ['Aron.png'],
    ['Vex.png', 'Mira.png'],
    ['Mira.png', 'Laboratory.png'],
  ]);

  const statuses = queueOf(store).scenes.map((scene) => scene.status);
  assert.deepEqual(statuses, ['completed', 'completed', 'completed', 'completed']);
  assert.equal(Object.keys(queueOf(store).completed).length, 4);
});

test('a scene is never submitted before the previous generation reported completion', async () => {
  const { runner, flow } = await createRunner({ flowScript: { pollsUntilDone: 5 } });
  const order = [];
  const originalSubmit = flow.submit;
  flow.submit = async () => {
    order.push('submit');
    return originalSubmit();
  };
  const originalStatus = flow.generationStatus;
  flow.generationStatus = async (baseline) => {
    const status = await originalStatus(baseline);
    order.push(`status:${status.state}`);
    return status;
  };
  await runner.start({ tabId: 1 });
  await runner.whenIdle();
  const submitIndexes = order.map((item, index) => (item === 'submit' ? index : -1)).filter((index) => index >= 0);
  assert.equal(submitIndexes.length, 4);
  for (let i = 1; i < submitIndexes.length; i += 1) {
    const between = order.slice(submitIndexes[i - 1], submitIndexes[i]);
    assert.ok(between.includes('status:completed'), `scene ${i + 1} was submitted before the previous one completed`);
  }
});

test('a failed Generate click pauses the queue and Retry continues from the same scene', async () => {
  const { runner, store, flow } = await createRunner({ flowScript: { failSubmitCalls: [2] } });

  await runner.start({ tabId: 1 });
  await runner.whenIdle();

  let automation = automationOf(store);
  assert.equal(automation.phase, 'paused');
  assert.equal(automation.decision.type, 'scene-failed');
  assert.equal(automation.decision.code, 'GENERATE_UNAVAILABLE');
  assert.equal(sceneByNumber(store, 1).status, 'completed');
  assert.equal(sceneByNumber(store, 2).status, 'failed');
  assert.ok(automation.decision.actions.includes('retry'));

  await runner.retry(sceneByNumber(store, 2).id);
  await runner.whenIdle();

  automation = automationOf(store);
  assert.equal(automation.phase, 'completed');
  assert.deepEqual(
    queueOf(store).scenes.map((scene) => scene.status),
    ['completed', 'completed', 'completed', 'completed'],
  );
});

test('a failed generation is never submitted again automatically', async () => {
  const { runner, store, flow } = await createRunner({ flowScript: { failGeneration: true } });
  await runner.start({ tabId: 1 });
  await runner.whenIdle();
  assert.equal(flow.state.submits.length, 1, 'Flow must receive exactly one submission');
  assert.equal(sceneByNumber(store, 1).status, 'failed');
  assert.equal(sceneByNumber(store, 1).error.code, 'GENERATION_FAILED');
  assert.equal(automationOf(store).phase, 'paused');
});

test('a generation that never finishes fails by timeout and is not marked completed', async () => {
  const { runner, store } = await createRunner({
    prefs: { generationTimeoutMinutes: 1 },
    flowScript: { neverFinish: true },
  });
  await runner.start({ tabId: 1 });
  await runner.whenIdle();
  const scene = sceneByNumber(store, 1);
  assert.equal(scene.status, 'failed');
  assert.equal(scene.error.code, 'GENERATION_TIMEOUT');
  assert.equal(queueOf(store).completed[scene.id], undefined);
  assert.equal(automationOf(store).decision.type, 'verify-submission');
});

test('pausing during generation keeps the scene and resuming waits without submitting again', async () => {
  let pauseRequested = false;
  const { runner, store, flow } = await createRunner({
    flowScript: {
      pollsUntilDone: 6,
      onPoll: (count) => {
        if (count === 3 && !pauseRequested) {
          pauseRequested = true;
          runner.pause();
        }
      },
    },
  });

  await runner.start({ tabId: 1 });
  await runner.whenIdle();

  let automation = automationOf(store);
  assert.equal(automation.phase, 'paused');
  const paused = sceneByNumber(store, 1);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.resumeStep, 'generating');
  assert.equal(flow.state.submits.length, 1);

  await runner.resume({ tabId: 1 });
  await runner.whenIdle();

  automation = automationOf(store);
  assert.equal(automation.phase, 'completed');
  assert.equal(flow.state.submits.length, 4, 'resume must not resubmit the scene that was already in Flow');
  assert.equal(flow.state.overlaps, 0);
});

test('stopping halts the queue; start later continues from the same scene', async () => {
  let stopped = false;
  const { runner, store, flow } = await createRunner({
    flowScript: {
      pollsUntilDone: 4,
      onPoll: (count) => {
        if (count === 2 && !stopped) {
          stopped = true;
          runner.stop();
        }
      },
    },
  });

  await runner.start({ tabId: 1 });
  await runner.whenIdle();
  assert.equal(automationOf(store).phase, 'stopped');
  assert.equal(sceneByNumber(store, 1).status, 'paused');
  assert.equal(flow.state.submits.length, 1);

  await runner.start({ tabId: 1 });
  await runner.whenIdle();
  assert.equal(automationOf(store).phase, 'completed');
  assert.equal(flow.state.submits.length, 4);
});

test('a scene with a missing reference blocks start and nothing is sent to Flow', async () => {
  const text = readExampleDocument() + '\n[Scene 5]\nAnother shot.\nReference images: Unknown.png\n';
  const { runner, store, flow } = await createRunner({ text });
  await assert.rejects(runner.start({ tabId: 1 }), (error) => {
    assert.equal(error.code, 'REFERENCE_MISSING');
    assert.match(error.message, /Scene 05/);
    return true;
  });
  assert.equal(automationOf(store).phase, 'idle');
  assert.equal(flow.state.calls.length, 0);
});

test('an ambiguous bare reference blocks start until the user chooses a file', async () => {
  const library = [...TEST_LIBRARY, { id: 'ref-aron-close', name: 'Aron_Closeup.png', mime: 'image/png', size: 1 }];
  const text = '[Scene 1]\nA shot.\nReference images: Aron\n';
  const { runner } = await createRunner({ text, library });
  await assert.rejects(runner.start({ tabId: 1 }), (error) => {
    assert.equal(error.code, 'REFERENCE_AMBIGUOUS');
    return true;
  });
});

test('pause on failure off lets the queue continue past a failed scene', async () => {
  const { runner, store, flow } = await createRunner({
    prefs: { pauseOnFailure: false },
    flowScript: { failSubmitCalls: [2] },
  });
  await runner.start({ tabId: 1 });
  await runner.whenIdle();
  assert.equal(automationOf(store).phase, 'completed');
  assert.deepEqual(
    queueOf(store).scenes.map((scene) => scene.status),
    ['completed', 'failed', 'completed', 'completed'],
  );
  assert.match(automationOf(store).message, /1 failed/);
});

test('continue after successful generation off pauses after each completed scene', async () => {
  const { runner, store, flow } = await createRunner({ prefs: { continueAfterSuccess: false } });
  await runner.start({ tabId: 1 });
  await runner.whenIdle();
  let automation = automationOf(store);
  assert.equal(automation.phase, 'paused');
  assert.equal(automation.decision.type, 'awaiting-continue');
  assert.equal(flow.state.submits.length, 1);

  await runner.resume({ tabId: 1 });
  await runner.whenIdle();
  automation = automationOf(store);
  assert.equal(automation.phase, 'paused');
  assert.equal(flow.state.submits.length, 2);
});

test('skipping a failed scene and continuing the queue completes the remaining scenes', async () => {
  const { runner, store, flow } = await createRunner({ flowScript: { failSubmitCalls: [2] } });
  await runner.start({ tabId: 1 });
  await runner.whenIdle();
  await runner.skip(sceneByNumber(store, 2).id);
  await runner.whenIdle();
  assert.equal(automationOf(store).phase, 'completed');
  assert.deepEqual(
    queueOf(store).scenes.map((scene) => scene.status),
    ['completed', 'skipped', 'completed', 'completed'],
  );
});

test('a transient reference upload failure is retried once automatically', async () => {
  const { runner, store, flow } = await createRunner({ flowScript: { uploadFailures: 1 } });
  await runner.start({ tabId: 1 });
  await runner.whenIdle();
  assert.equal(automationOf(store).phase, 'completed');
  const uploadsForSceneOne = flow.state.calls.filter((call) => Array.isArray(call) && call[0] === 'attach').slice(0, 2);
  assert.deepEqual(uploadsForSceneOne[0], ['attach', ['Aron.png', 'Laboratory.png']]);
  assert.deepEqual(uploadsForSceneOne[1], ['attach', ['Aron.png', 'Laboratory.png']]);
});

test('a transient 2K download failure retries without regenerating the completed scene', async () => {
  const { runner, flow, store } = await createRunner({ flowScript: { downloadFailures: 2 } });

  await runner.start({ tabId: 7 });
  await runner.whenIdle();

  assert.equal(flow.state.submits.length, 4);
  assert.deepEqual(flow.state.downloads, ['out-1', 'out-2', 'out-3', 'out-4']);
  assert.equal(flow.state.calls.filter((call) => Array.isArray(call) && call[0] === 'download2k').length, 6);
  assert.deepEqual(queueOf(store).scenes.map((scene) => scene.status), ['completed', 'completed', 'completed', 'completed']);
});

test('an unavailable 2K option pauses after completion without regenerating or starting the next scene', async () => {
  const { runner, flow, store } = await createRunner({ flowScript: { downloadFailures: 99 } });

  await runner.start({ tabId: 7 });
  await runner.whenIdle();

  assert.equal(flow.state.submits.length, 1);
  assert.equal(queueOf(store).scenes[0].status, 'completed');
  assert.equal(queueOf(store).scenes[1].status, 'waiting');
  assert.equal(automationOf(store).phase, 'paused');
  assert.equal(automationOf(store).decision.type, 'download-failed');
});

test('a lost Flow tab pauses the queue (it does not fail the scene)', async () => {
  const { runner, store, flow } = await createRunner();
  flow.state.probeQueue = [Object.assign(new Error('gone'), { code: 'FLOW_TAB_CLOSED' })];
  await runner.start({ tabId: 1 });
  await runner.whenIdle();
  assert.equal(automationOf(store).phase, 'paused');
  assert.equal(automationOf(store).decision.type, 'flow-unavailable');
  assert.equal(flow.state.submits.length, 0);
});

test('Agent mode on blocks the run before any scene is submitted', async () => {
  const { runner, store, flow } = await createRunner({ flowScript: { agentOn: true } });
  await runner.start({ tabId: 1 });
  await runner.whenIdle();
  assert.equal(automationOf(store).phase, 'paused');
  assert.equal(automationOf(store).decision.type, 'agent-on');
  assert.equal(flow.state.submits.length, 0);
});

test('completed scenes are never generated again by starting the queue', async () => {
  const { runner, store, flow } = await createRunner();
  await runner.start({ tabId: 1 });
  await runner.whenIdle();
  await assert.rejects(runner.start({ tabId: 1 }), /already completed or skipped/);
  assert.equal(flow.state.submits.length, 4);
});

test('a manual Mark completed records the scene and then continues the queue', async () => {
  const { runner, store, flow } = await createRunner({ flowScript: { failGeneration: true } });
  await runner.start({ tabId: 1 });
  await runner.whenIdle();
  const failed = sceneByNumber(store, 1);
  assert.equal(flow.state.submits.length, 1);

  await runner.markCompleted(failed.id);
  await runner.whenIdle();

  const scene = sceneByNumber(store, 1);
  assert.equal(scene.status, 'completed');
  assert.equal(scene.completion.manual, true);
  assert.equal(queueOf(store).completed[failed.id].manual, true);
  // Scene 2 is the next one; it fails in this scripted run, which pauses the queue again.
  assert.equal(flow.state.submits.length, 2);
  assert.equal(sceneByNumber(store, 2).status, 'failed');
  assert.equal(automationOf(store).phase, 'paused');
});

test('regenerate requires a completed scene and queues it without running it', async () => {
  const { runner, store, flow } = await createRunner();
  await runner.start({ tabId: 1 });
  await runner.whenIdle();
  const scene = sceneByNumber(store, 2);
  await runner.regenerate(scene.id);
  assert.equal(sceneByNumber(store, 2).status, 'waiting');
  assert.equal(queueOf(store).completed[scene.id], undefined);
  assert.equal(flow.state.submits.length, 4, 'regenerate must not run by itself');
});

test('after a worker restart an active run is converted to a paused state the user decides on', async () => {
  const { runner, store } = await createRunner({
    initialAutomation: { phase: 'running', tabId: 1, currentSceneId: null, decision: null, message: '', progress: null },
  });
  // Simulate a scene that was submitted before the worker stopped.
  await store.update(STORAGE_KEYS.queue, (queue) => {
    queue.scenes[0].status = 'generating';
    queue.scenes[0].baseline = { outputKeys: [], alerts: [] };
    queue.scenes[0].resumeStep = 'generating';
    return queue;
  });
  await store.update(STORAGE_KEYS.automation, (automation) => ({ ...automation, currentSceneId: queueOf(store).scenes[0].id }));

  const recovered = await runner.recoverAfterRestart();
  assert.equal(recovered, true);
  const automation = automationOf(store);
  assert.equal(automation.phase, 'paused');
  assert.equal(automation.decision.type, 'interrupted');
  assert.equal(sceneByNumber(store, 1).status, 'paused');
  assert.equal(sceneByNumber(store, 1).resumeStep, 'generating');
});

test('a submission interrupted by a worker restart is failed for review, never re-clicked', async () => {
  const { runner, store, flow } = await createRunner({
    initialAutomation: { phase: 'running', tabId: 1, currentSceneId: null, decision: null, message: '', progress: null },
  });
  await store.update(STORAGE_KEYS.queue, (queue) => {
    queue.scenes[0].status = 'submitting';
    return queue;
  });
  await runner.recoverAfterRestart();
  assert.equal(sceneByNumber(store, 1).status, 'failed');
  assert.equal(sceneByNumber(store, 1).error.code, 'INTERRUPTED');
  assert.equal(flow.state.submits.length, 0);
});

test('a scene with a single reference uploads exactly that file', async () => {
  const text = '[Scene 1]\nA shot.\nReference images: Vex.png\n';
  const { runner, store, flow } = await createRunner({ text });
  await runner.start({ tabId: 1 });
  await runner.whenIdle();
  const uploads = flow.state.calls.filter((call) => Array.isArray(call) && call[0] === 'attach');
  assert.deepEqual(uploads, [['attach', ['Vex.png']]]);
  assert.equal(parseScenes(text).scenes[0].referenceTokens[0].name, 'Vex.png');
});

test("the run captures Flow's settings, re-applies them before every scene, and stores them for the panel", async () => {
  const { runner, store, flow } = await createRunner();
  await runner.start({ tabId: 1 });
  await runner.whenIdle();
  const applied = flow.state.calls.filter((call) => Array.isArray(call) && call[0] === 'applySettings');
  assert.equal(applied.length, 4, 'one settings check per scene');
  assert.deepEqual(applied[0][1], { mode: 'Image', model: 'Nano Banana Pro', aspectRatio: '16:9' });
  const stored = store.read(STORAGE_KEYS.flowSettings);
  assert.equal(stored.current.model, 'Nano Banana Pro');
  assert.ok(stored.readAt, 'the panel shows when the values were read');
  assert.deepEqual(stored.options.aspectRatio, ['16:9', '9:16', '1:1']);
});

test('a setting that Flow does not keep stops the scene before anything is uploaded or submitted', async () => {
  const { runner, store, flow } = await createRunner({ flowScript: { lockedSettings: { mode: 'Video' } } });
  await runner.start({ tabId: 1 });
  await runner.whenIdle();
  const scene = sceneByNumber(store, 1);
  assert.equal(scene.status, 'failed');
  assert.equal(scene.error.code, 'FLOW_SETTING_FAILED');
  assert.match(scene.error.message, /mode/i);
  assert.equal(flow.state.submits.length, 0);
  assert.equal(flow.state.calls.filter((call) => Array.isArray(call) && call[0] === 'attach').length, 0);
});
