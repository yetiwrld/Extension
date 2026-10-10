import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createFlowBridge,
  dispatchTrustedClick,
  dispatchTrustedHover,
  isNoReceiverError,
  isNotDeliveredError,
  INJECT_FAILED_MESSAGE,
  RELOAD_TAB_MESSAGE,
} from '../src/background/flow-bridge.js';

// The exact texts Chrome uses for these failures.
const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';
const PORT_CLOSED = 'The message port closed before a response was received.';
const REFUSED = 'Cannot access contents of the page. Extension manifest must request permission to access the respective host.';

/**
 * A fake chrome with one Flow tab. Each send gets the next answer (an Error is thrown, anything
 * else is returned). Injection succeeds unless injectError is given.
 */
function fakeChrome({ sendAnswers = [], injectError = null, status = null } = {}) {
  const calls = { sends: 0, injections: 0 };
  return {
    calls,
    tabs: {
      get: async (id) => ({ id, url: 'https://flow.google.com/project/abc' }),
      sendMessage: async () => {
        const answer = sendAnswers[Math.min(calls.sends, sendAnswers.length - 1)];
        calls.sends += 1;
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
    scripting: {
      executeScript: async (options) => {
        // Status reads and clears are functions. Only file injections count as injections.
        if (options.func) return [{ result: status }];
        calls.injections += 1;
        if (injectError) throw new Error(injectError);
        return [{ result: null }];
      },
    },
  };
}

test('trusted Generate fallback dispatches one CDP mouse click and always detaches', async () => {
  const commands = [];
  const chromeApi = {
    debugger: {
      attach: async () => {},
      sendCommand: async (_target, method, params) => commands.push({ method, params }),
      detach: async () => commands.push({ method: 'detach' }),
    },
  };
  assert.equal(await dispatchTrustedClick(chromeApi, 7, { x: 320, y: 640 }), true);
  assert.deepEqual(commands.map((item) => item.method), [
    'Input.dispatchMouseEvent',
    'Input.dispatchMouseEvent',
    'Input.dispatchMouseEvent',
    'detach',
  ]);
  assert.equal(commands[1].params.type, 'mousePressed');
  assert.equal(commands[2].params.type, 'mouseReleased');
});

test('trusted download hover moves Chrome\'s pointer without clicking', async () => {
  const commands = [];
  const chromeApi = {
    debugger: {
      attach: async () => {},
      sendCommand: async (_target, method, params) => commands.push({ method, params }),
      detach: async () => commands.push({ method: 'detach' }),
    },
  };
  assert.equal(await dispatchTrustedHover(chromeApi, 7, { x: 120, y: 240 }), true);
  assert.deepEqual(commands.map((item) => item.method), ['Input.dispatchMouseEvent', 'detach']);
  assert.equal(commands[0].params.type, 'mouseMoved');
});

test('a command is never sent again after its reply was lost, because it may already have run', async () => {
  const chromeApi = fakeChrome({ sendAnswers: [new Error(PORT_CLOSED)] });
  const bridge = createFlowBridge({ getTabId: () => 7, chromeApi });
  await assert.rejects(bridge.probe(), (error) => {
    assert.equal(error.code, 'FLOW_NO_RESPONSE');
    assert.match(error.message, /may already have run/);
    return true;
  });
  assert.equal(chromeApi.calls.sends, 1);
  assert.equal(chromeApi.calls.injections, 0);
});

test('when Chrome refuses the injection, the reply gives Chrome\'s reason with the reload advice', async () => {
  const chromeApi = fakeChrome({ sendAnswers: [new Error(NO_RECEIVER)], injectError: REFUSED });
  const bridge = createFlowBridge({ getTabId: () => 7, chromeApi });
  await assert.rejects(bridge.probe(), (error) => {
    assert.equal(error.code, 'FLOW_NO_RESPONSE');
    assert.ok(error.message.startsWith(INJECT_FAILED_MESSAGE), error.message);
    assert.ok(error.message.includes(REFUSED), error.message);
    return true;
  });
  assert.equal(chromeApi.calls.sends, 1);
  assert.equal(chromeApi.calls.injections, 1);
});

test('when the connector is still missing after injection, the reply gives Chrome\'s reason', async () => {
  const chromeApi = fakeChrome({ sendAnswers: [new Error(NO_RECEIVER), new Error(NO_RECEIVER)] });
  const bridge = createFlowBridge({ getTabId: () => 7, chromeApi });
  await assert.rejects(bridge.probe(), (error) => {
    assert.equal(error.code, 'FLOW_NO_RESPONSE');
    assert.ok(error.message.startsWith(RELOAD_TAB_MESSAGE), error.message);
    assert.ok(error.message.includes(NO_RECEIVER), error.message);
    return true;
  });
  assert.equal(chromeApi.calls.sends, 2);
  assert.equal(chromeApi.calls.injections, 1);
});

test('a connector that answers at once is used without injecting anything', async () => {
  const chromeApi = fakeChrome({ sendAnswers: [{ ok: true, data: { promptFound: true } }] });
  const bridge = createFlowBridge({ getTabId: () => 7, chromeApi });
  const data = await bridge.probe();
  assert.equal(data.promptFound, true);
  assert.equal(chromeApi.calls.injections, 0);
});

test('only a missing listener counts as not delivered; a lost reply does not', () => {
  assert.equal(isNotDeliveredError(new Error(NO_RECEIVER)), true);
  assert.equal(isNotDeliveredError(new Error(PORT_CLOSED)), false);
  // Read-only connection checks may still retry after a lost reply.
  assert.equal(isNoReceiverError(new Error(PORT_CLOSED)), true);
});
