/**
 * Minimal chrome.* mock for the Cert Buddy browser test harness.
 *
 * Loaded FIRST on every fixture page (before store.js/taxonomy.js/theme.js/
 * adapters.js/outcomes.js/tagger.js), so `window.chrome` already exists by
 * the time those classic scripts run their own `(function (root) {...})
 * (globalThis)` IIFEs and touch chrome.storage.local.
 *
 * Deliberately narrow: only chrome.runtime (getURL/lastError/onMessage) and
 * chrome.storage (local + onChanged) are defined. NO chrome.tabs and NO
 * chrome.scripting — popup.js's checkActiveTab() feature-detects their
 * absence (`if (!(globalThis.chrome && chrome.tabs && chrome.tabs.query))
 * return;`) and popup-harness.html's optional ?tabUrl= param is what
 * installs a fake chrome.tabs/chrome.scripting when a fixture actually wants
 * to exercise that "not on Udemy" bar.
 *
 * Only fills in pieces that are missing, so a page that wants to install its
 * own chrome.tabs/chrome.scripting (see popup-harness.html) can load this
 * first and then extend window.chrome afterward without this file stomping
 * it back out.
 *
 * IMPORTANT: this deliberately does NOT early-return on a merely truthy
 * `window.chrome` (a literal `if (window.chrome) return` — the first draft
 * of this file, matching a too-literal reading of "only if absent" — breaks
 * in every real Chromium-based browser: Chrome/Chromium exposes a native
 * `window.chrome` global on EVERY page, extension or not, usually as an
 * empty-ish `{}` with no `.storage`/`.runtime.getURL` at all. Bailing out on
 * that leaves chrome.storage undefined and every content script's first
 * `chrome.storage.local.get(...)` throws "Cannot read properties of
 * undefined (reading 'local')" before anything else can run. The guard
 * below instead checks the SPECIFIC api surface each piece provides, so it
 * still yields to a genuinely-already-working chrome.storage.local (e.g.
 * this file loaded as an actual unpacked-extension content script, where
 * real chrome APIs already work) without being fooled by the browser's own
 * empty stub.
 */
(function () {
  const root = window.chrome || (window.chrome = {});

  // Deep-copy via JSON round-trip: every value that ever goes through
  // chrome.storage.local is JSON-serializable by contract (that's what real
  // chrome.storage enforces too), so this is a safe and simple stand-in for
  // structuredClone. Used both on the way IN (set()) and the way OUT
  // (get()/onChanged listeners) so nothing handed back by the mock is the
  // same object reference as what's sitting in __certBuddyMockStorage —
  // callers (or listeners) mutating what they got back must never corrupt
  // the backing store.
  function clone(v) {
    return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  }

  // In-memory backing object for chrome.storage.local, exposed for
  // debugging/inspection from the page console.
  const backing = {};
  globalThis.__certBuddyMockStorage = backing;

  const changeListeners = [];

  function fireChanged(changes) {
    if (!changes || !Object.keys(changes).length) return;
    for (const fn of changeListeners.slice()) {
      try {
        fn(changes, 'local');
      } catch (e) {
        console.error('[mock-chrome] storage.onChanged listener threw', e);
      }
    }
  }

  async function get(keys) {
    if (keys === undefined || keys === null) {
      return clone(backing);
    }
    if (typeof keys === 'string') {
      return Object.prototype.hasOwnProperty.call(backing, keys)
        ? { [keys]: clone(backing[keys]) }
        : {};
    }
    if (Array.isArray(keys)) {
      const out = {};
      for (const k of keys) {
        if (Object.prototype.hasOwnProperty.call(backing, k)) out[k] = clone(backing[k]);
      }
      return out;
    }
    if (typeof keys === 'object') {
      // Object-of-defaults form: every named key comes back, backed by the
      // stored value if present, else the caller's own default.
      const out = {};
      for (const k of Object.keys(keys)) {
        out[k] = Object.prototype.hasOwnProperty.call(backing, k) ? clone(backing[k]) : clone(keys[k]);
      }
      return out;
    }
    return {};
  }

  async function set(obj) {
    const changes = {};
    for (const k of Object.keys(obj || {})) {
      const oldValue = Object.prototype.hasOwnProperty.call(backing, k) ? clone(backing[k]) : undefined;
      const newValue = clone(obj[k]);
      backing[k] = newValue;
      changes[k] = { oldValue, newValue: clone(newValue) };
    }
    fireChanged(changes);
  }

  async function remove(keys) {
    const arr = Array.isArray(keys) ? keys : [keys];
    const changes = {};
    for (const k of arr) {
      if (Object.prototype.hasOwnProperty.call(backing, k)) {
        changes[k] = { oldValue: clone(backing[k]), newValue: undefined };
        delete backing[k];
      }
    }
    fireChanged(changes);
  }

  async function clear() {
    const changes = {};
    for (const k of Object.keys(backing)) {
      changes[k] = { oldValue: clone(backing[k]), newValue: undefined };
      delete backing[k];
    }
    fireChanged(changes);
  }

  // Fill in runtime.* only where missing — a real browser's native
  // window.chrome stub (see file-header comment) has none of these, so in
  // practice this always installs the mock; the per-property checks exist
  // for the "loaded as a real content script" case where they shouldn't be
  // overwritten.
  if (!root.runtime || typeof root.runtime !== 'object') root.runtime = {};
  if (typeof root.runtime.getURL !== 'function') root.runtime.getURL = (p) => p;
  if (!('lastError' in root.runtime)) root.runtime.lastError = undefined;
  if (!root.runtime.onMessage || typeof root.runtime.onMessage.addListener !== 'function') {
    root.runtime.onMessage = { addListener() {} };
  }

  if (!root.storage || typeof root.storage !== 'object') root.storage = {};
  if (!root.storage.local || typeof root.storage.local.get !== 'function') {
    root.storage.local = { get, set, remove, clear };
  }
  if (!root.storage.onChanged || typeof root.storage.onChanged.addListener !== 'function') {
    root.storage.onChanged = {
      addListener(fn) {
        if (typeof fn === 'function') changeListeners.push(fn);
      },
      removeListener(fn) {
        const i = changeListeners.indexOf(fn);
        if (i > -1) changeListeners.splice(i, 1);
      }
    };
  }
  // NO chrome.tabs, NO chrome.scripting installed here — see file-header
  // comment; popup-harness.html's own ?tabUrl= handling is what adds those,
  // when a fixture actually wants them.
})();
