/**
 * MV3 service worker entry point.
 *
 * Owns the automation state machine, the Flow bridge and the authoritative
 * storage writes. The side panel talks to it through chrome.runtime messages.
 */
import { chromeStorageKv } from '../storage/kv.js';
import { KeyValueStore } from '../storage/store.js';
import { STORAGE_KEYS } from '../storage/schema.js';
import { AutomationRunner } from '../queue/runner.js';
import { systemClock } from '../utils/async.js';
import { toErrorPayload, ERROR_CODES } from '../utils/errors.js';
import { MESSAGE_TYPE, PANEL_COMMANDS, errorReply, okReply } from '../shared/protocol.js';
import { createFlowBridge } from './flow-bridge.js';
import { createFileLoader } from './files.js';
import { Controller } from './controller.js';

const PERSISTED_KEYS = [
  STORAGE_KEYS.prefs,
  STORAGE_KEYS.document,
  STORAGE_KEYS.queue,
  STORAGE_KEYS.automation,
  STORAGE_KEYS.overrides,
  STORAGE_KEYS.logs,
  STORAGE_KEYS.flowSettings,
];

let bootPromise = null;

/** Build the controller once per worker lifetime and recover any run that the last worker lost. */
function boot() {
  if (!bootPromise) {
    bootPromise = (async () => {
      const kv = chromeStorageKv(chrome.storage.local);
      const store = new KeyValueStore(kv);
      await store.load(PERSISTED_KEYS);
      const bridge = createFlowBridge({
        getTabId: () => store.read(STORAGE_KEYS.automation).tabId ?? null,
        chromeApi: chrome,
      });
      const runner = new AutomationRunner({
        store,
        flow: bridge,
        files: createFileLoader(kv),
        log: async () => {},
        clock: systemClock,
      });
      const controller = new Controller({ store, runner, bridge, kv, chromeApi: chrome });
      await runner.recoverAfterRestart();
      return controller;
    })().catch((error) => {
      bootPromise = null;
      throw error;
    });
  }
  return bootPromise;
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Recover state at worker start, before any command arrives.
boot().catch((error) => {
  console.error('Flow Scene Queue failed to start', error);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== MESSAGE_TYPE.PANEL) return false;
  if (!PANEL_COMMANDS.includes(message.name)) {
    sendResponse(errorReply({ code: ERROR_CODES.INVALID_INPUT, message: `Unknown command "${message.name}".`, recoverable: false }));
    return false;
  }
  boot()
    .then((controller) => controller.handle(message.name, message.payload ?? {}))
    .then((data) => sendResponse(okReply(data)))
    .catch((error) => sendResponse(errorReply(toErrorPayload(error))));
  return true;
});

// An open side panel holds a port. Chrome keeps the worker alive while the port is connected,
// which keeps an in-progress run responsive while the user watches it.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel-heartbeat') return;
  port.onMessage.addListener(() => {});
  port.onDisconnect.addListener(() => {});
});
