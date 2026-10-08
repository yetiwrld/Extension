/*
 * chrome.* stand-in for the browser harness. Only the APIs the extension uses are
 * implemented. Local storage persists in localStorage so reloads behave like a real
 * browser profile; session storage is in memory. Messages are delivered in-page.
 *
 * This stub is test infrastructure. It is NOT part of the extension.
 */
(function () {
  var LOCAL_KEY = 'fsq-e2e-local';
  var listeners = { message: [], storageChanged: [] };
  var sessionData = {};
  var activeTab = { id: 1, url: 'https://flow.google.com/project/e2e-test', active: true };

  function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  }
  function readLocal() {
    try {
      return JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}');
    } catch (error) {
      return {};
    }
  }
  function notify(area, changes) {
    setTimeout(function () {
      for (var i = 0; i < listeners.storageChanged.length; i += 1) {
        listeners.storageChanged[i](changes, area);
      }
    }, 0);
  }

  function storageArea(kind) {
    function load() {
      return kind === 'local' ? readLocal() : sessionData;
    }
    function save(all) {
      if (kind === 'local') localStorage.setItem(LOCAL_KEY, JSON.stringify(all));
    }
    return {
      get: async function (keys) {
        var all = load();
        if (keys === null || keys === undefined) return clone(all);
        var list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
        var out = {};
        for (var i = 0; i < list.length; i += 1) {
          if (Object.prototype.hasOwnProperty.call(all, list[i])) out[list[i]] = clone(all[list[i]]);
        }
        return out;
      },
      set: async function (values) {
        var all = load();
        var changes = {};
        Object.keys(values).forEach(function (key) {
          changes[key] = { oldValue: clone(all[key]), newValue: clone(values[key]) };
          all[key] = clone(values[key]);
        });
        save(all);
        notify(kind, changes);
      },
      remove: async function (keys) {
        var all = load();
        var list = Array.isArray(keys) ? keys : [keys];
        list.forEach(function (key) {
          delete all[key];
        });
        save(all);
      },
    };
  }

  var noopEvent = function () {
    return { addListener: function () {}, removeListener: function () {}, hasListener: function () { return false; } };
  };

  window.chrome = {
    runtime: {
      onMessage: {
        addListener: function (fn) {
          listeners.message.push(fn);
        },
        removeListener: function () {},
      },
      onConnect: noopEvent(),
      onInstalled: noopEvent(),
      getURL: function (path) {
        return path;
      },
      sendMessage: function (message) {
        return new Promise(function (resolve, reject) {
          if (!listeners.message.length) {
            reject(new Error('Could not establish connection. Receiving end does not exist.'));
            return;
          }
          var answered = false;
          listeners.message[0](message, { id: 'stub' }, function (reply) {
            answered = true;
            resolve(reply);
          });
          setTimeout(function () {
            if (!answered) reject(new Error('The message port closed before a response was received.'));
          }, 120000);
        });
      },
      connect: function (info) {
        return { name: info && info.name, postMessage: function () {}, disconnect: function () {}, onMessage: noopEvent(), onDisconnect: noopEvent() };
      },
    },
    storage: {
      local: storageArea('local'),
      session: storageArea('session'),
      onChanged: {
        addListener: function (fn) {
          listeners.storageChanged.push(fn);
        },
        removeListener: function () {},
      },
    },
    tabs: {
      query: async function () {
        return activeTab ? [clone(activeTab)] : [];
      },
      get: async function (id) {
        if (activeTab && activeTab.id === id) return clone(activeTab);
        if (id === 1) return { id: 1, url: 'https://flow.google.com/project/e2e-test' };
        throw new Error('No tab with id: ' + id);
      },
      sendMessage: async function (tabId, message) {
        var frame = document.getElementById('flow');
        var handlers = frame && frame.contentWindow && frame.contentWindow.__fsqListeners;
        if (!handlers || !handlers.length) {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        }
        return new Promise(function (resolve) {
          handlers[0](message, {}, resolve);
        });
      },
    },
    scripting: {
      executeScript: async function () {
        return [{ result: null }];
      },
    },
  };

  window.__fsqStub = {
    setActiveTab: function (tab) {
      activeTab = tab;
    },
    listenerCount: function () {
      return listeners.message.length;
    },
  };
})();
