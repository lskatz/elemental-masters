// tests/js/_harness.js
// Loads the game's JS modules in a Node VM context with a fake `window`
// object. Returns the populated context so individual tests can grab
// GameState, Battle, GameSave, etc. without polluting Node's globals.
//
// Used by all .test.js files in this folder.

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

/**
 * Build a fresh sandbox each time so tests cannot bleed state into each
 * other via window-level mutables (e.g., localStorage).
 */
function loadGame({ rng } = {}) {
  // Per-test localStorage shim.
  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  };

  // Math.random can be overridden so battle/enemy generation is
  // deterministic. Default delegates to the real one.
  const fakeMath = Object.create(Math);
  if (rng) fakeMath.random = rng;

  // Stub FileReader so save.js's importFromFile can run in Node. The
  // fake reader expects a file-like object carrying `_text`. Real browser
  // tests would use a real File; for unit tests we just shuttle the text.
  // save.js reads from `reader.result` (not the event arg), so we set that.
  class FakeFileReader {
    readAsText(file) {
      Promise.resolve().then(() => {
        if (file && typeof file._text === "string") {
          this.result = file._text;
          if (this.onload) this.onload({ target: this });
        } else if (this.onerror) {
          this.onerror(new Error("fake reader: missing _text"));
        }
      });
    }
    set onload(fn) { this._onload = fn; }
    get onload() { return this._onload; }
    set onerror(fn) { this._onerror = fn; }
    get onerror() { return this._onerror; }
  }

  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    Math: fakeMath,
    Date,
    JSON,
    Promise,
    URL,
    Blob: class { constructor(parts) { this.parts = parts; } },
    FileReader: FakeFileReader,
    document: { addEventListener: () => {}, readyState: "complete" },
    localStorage,
  };
  ctx.window = ctx;
  vm.createContext(ctx);

  // Order matters: data first, then storage (used by save+coach), then
  // state/save (which depend on data), then battle (which depends on
  // state). UI and main are skipped — they touch DOM, and we test only
  // pure logic here.
  const order = ["generated-data.js", "storage.js", "state.js", "save.js", "battle.js"];
  for (const f of order) {
    const src = fs.readFileSync(
      path.join(PROJECT_ROOT, "assets/js", f),
      "utf8"
    );
    vm.runInContext(src, ctx, { filename: f });
  }

  return ctx;
}

/**
 * Build a deterministic RNG that yields the supplied values in order, then
 * cycles. Useful when we need to force a specific element / mob choice.
 */
function seededRng(values) {
  let i = 0;
  return () => {
    const v = values[i % values.length];
    i++;
    return v;
  };
}

module.exports = { loadGame, seededRng, PROJECT_ROOT };
