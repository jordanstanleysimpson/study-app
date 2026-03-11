/**
 * Loads app.js into an isolated vm context with mocked browser APIs.
 * This lets us test all logic without a running server or a real browser.
 *
 * All top-level constants, state, and functions from app.js are accessible
 * directly on the returned context object, e.g.:
 *   ctx.normalize('café')  → 'cafe'
 *   ctx.state.progress     → {}
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const APP_JS_PATH = join(dirname(fileURLToPath(import.meta.url)), '../../app.js');
const appCode = readFileSync(APP_JS_PATH, 'utf-8');

// ─── DOM stub helpers ──────────────────────────────────────────────────────

function makeClassList() {
  const classes = new Set();
  return {
    _classes: classes,
    add(...cls)        { cls.forEach(c => classes.add(c)); },
    remove(...cls)     { cls.forEach(c => classes.delete(c)); },
    toggle(cls, force) {
      if (force !== undefined) {
        if (force) classes.add(cls); else classes.delete(cls);
      } else if (classes.has(cls)) {
        classes.delete(cls);
      } else {
        classes.add(cls);
      }
    },
    contains(cls) { return classes.has(cls); },
  };
}

/** Returns a new stub DOM element. Each call produces an independent object. */
function makeElement(id = '') {
  let _innerHTML = '';
  const el = {
    id,
    style:       {},
    textContent: '',
    className:   '',
    disabled:    false,
    src:         '',
    children:    [],
    classList:   makeClassList(),

    get innerHTML()    { return _innerHTML; },
    set innerHTML(val) {
      _innerHTML = val;
      if (val === '') el.children = []; // reset children when container is cleared
    },

    appendChild(child) { el.children.push(child); return child; },
    addEventListener() {},
    setAttribute()     {},
    blur()             {},
    focus()            {},
  };
  return el;
}

/**
 * Creates a minimal document stub.
 * Every getElementById call lazily creates and caches a stub element,
 * so tests can inspect ctx.document._elements['some-id'] after the fact.
 */
function makeDocument() {
  const elements = {};
  return {
    _elements: elements,
    activeElement: null,
    body: makeElement('body'),

    getElementById(id) {
      if (!elements[id]) elements[id] = makeElement(id);
      return elements[id];
    },

    querySelectorAll() {
      // Return an empty iterable for most queries (screen/quiz-mode lists).
      // Tests that need specific behaviour can override after context creation.
      return [];
    },

    querySelector()   { return null; },
    createElement()   { return makeElement(); },
  };
}

/** Creates a minimal localStorage stub backed by a plain object. */
function makeLocalStorage() {
  const store = {};
  return {
    getItem:    k      => store[k] ?? null,
    setItem:    (k, v) => { store[k] = String(v); },
    removeItem: k      => { delete store[k]; },
    clear:      ()     => { Object.keys(store).forEach(k => delete store[k]); },
  };
}

// ─── Context factory ───────────────────────────────────────────────────────

/**
 * Creates a fresh vm context with app.js loaded into it.
 * Returns the context; every top-level name from app.js is a direct property.
 *
 * Extra tracking arrays are also attached:
 *   ctx._clearedTimeouts  — timeout IDs passed to clearTimeout
 *   ctx._scheduledTimeouts — pending { fn, ms } entries keyed by timeout ID
 */
export function createAppContext() {
  const clearedTimeouts   = [];
  const scheduledTimeouts = {};
  let nextTimeoutId = 1;

  const doc = makeDocument();

  const ctx = vm.createContext({
    // Browser globals
    window:       { addEventListener: () => {}, location: { reload: () => {} } },
    document:     doc,
    localStorage: makeLocalStorage(),
    indexedDB:    { open: () => ({ onupgradeneeded: null, onsuccess: null, onerror: null }) },

    // Timer stubs — we track calls so tests can assert on them
    setTimeout: (fn, ms) => {
      const id = nextTimeoutId++;
      scheduledTimeouts[id] = { fn, ms };
      return id;
    },
    clearTimeout: id => {
      clearedTimeouts.push(id);
      delete scheduledTimeouts[id];
    },
    setInterval:  () => nextTimeoutId++, // no-op; app uses this for update polling
    clearInterval: () => {},

    // Network stub — no-op (app.js uses fetch only inside init / gistSync)
    fetch: async () => ({ ok: true, json: async () => ({}) }),

    // Standard builtins
    console,
    Math, JSON, Promise, Set, Map, Array, Object, String, Number, Boolean,
    Error, TypeError, parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent,

    // Test-only tracking
    _clearedTimeouts:   clearedTimeouts,
    _scheduledTimeouts: scheduledTimeouts,
  });

  // `const`/`let` top-level declarations are NOT exposed as vm context properties,
  // but `var` and `function` declarations are.  We append a small shim that creates
  // var aliases for the consts tests need to inspect/mutate.
  const testShim = '\nvar __state = state;\n';
  vm.runInContext(appCode + testShim, ctx);

  // Expose state so tests can do ctx.state.progress etc.
  // ctx.__state IS the same object as the internal `const state`, so mutations are shared.
  ctx.state = ctx.__state;

  // Ensure clean state (init() was never called because DOMContentLoaded is a no-op)
  ctx.state.progress = {};

  return ctx;
}
