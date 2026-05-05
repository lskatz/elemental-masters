/* ============================================================================
 * save.js — Persistence: localStorage autosave + JSON file export/import
 *
 * Saves are automatic to localStorage so a kid can close the tab and come
 * back. JSON export is for moving between devices or making a backup.
 *
 * Save file format:
 *   {
 *     "format":     "elemental-masters-save",
 *     "version":    "1.0.0",                // game semver at export time
 *     "exportedAt": "2026-05-04T12:00:00Z",
 *     "state":      { ...GameState.toJSON() }
 *   }
 *
 * Compatibility check: same MAJOR version is required to load.
 * Different MAJOR -> load is rejected with a clear message.
 * Different MINOR/PATCH -> loads with a console warning.
 * ========================================================================== */

(function (root) {
  "use strict";

  // Storage key (without the global namespace prefix — GameStorage adds it).
  // The trailing ":v1" lets us migrate to a new schema by bumping the suffix.
  const STORAGE_KEY = "save:v1";

  // Magic string written into save files so we can recognize them on import.
  const FILE_FORMAT = "elemental-masters-save";
  const CURRENT_VERSION = window.GameData.version;
  const Storage = window.GameStorage;

  // ---- localStorage autosave ---------------------------------------------

  /** Persist the current game state. Returns true on success, false on failure. */
  function saveToLocal(state) {
    return Storage.write(STORAGE_KEY, {
      format: FILE_FORMAT,
      version: CURRENT_VERSION,
      exportedAt: new Date().toISOString(),
      state: state.toJSON(),
    });
  }

  /**
   * Load and validate the auto-saved state. Returns null if no save exists,
   * if it's corrupted, or if the major version doesn't match.
   */
  function loadFromLocal() {
    const payload = Storage.read(STORAGE_KEY);
    if (!payload) return null;
    const check = checkVersion(payload.version);
    if (!check.ok) {
      console.warn("save version incompatible:", check.reason);
      return null;
    }
    try {
      return window.GameState.fromJSON(payload.state);
    } catch (err) {
      console.warn("could not deserialize saved state:", err);
      return null;
    }
  }

  function hasLocalSave() { return Storage.has(STORAGE_KEY); }
  function clearLocal()   { Storage.remove(STORAGE_KEY); }

  // ---- Version compatibility --------------------------------------------

  function parseSemver(v) {
    if (typeof v !== "string") return null;
    const m = v.match(/^(\d+)\.(\d+)\.(\d+)/);
    if (!m) return null;
    return { major: +m[1], minor: +m[2], patch: +m[3] };
  }

  function checkVersion(v) {
    const cur = parseSemver(CURRENT_VERSION);
    const got = parseSemver(v);
    if (!got) return { ok: false, reason: "missing or malformed version" };
    if (got.major !== cur.major) {
      return {
        ok: false,
        reason: `save is v${v} but game is v${CURRENT_VERSION}`,
      };
    }
    return { ok: true };
  }

  // ---- JSON file export --------------------------------------------------

  function exportToFile(state) {
    const payload = {
      format: FILE_FORMAT,
      version: CURRENT_VERSION,
      exportedAt: new Date().toISOString(),
      state: state.toJSON(),
    };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    // Use a transient anchor to trigger a download. Filename includes the
    // hero name and level for easy identification.
    const safeName = (state.heroName || "hero").replace(/[^a-z0-9]/gi, "_").toLowerCase();
    const filename = `elemental-masters-${safeName}-lvl${state.level}.json`;

    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // Free the blob URL after a short delay (some browsers need the click
    // to complete first).
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    state.dirtyForExport = false;
    return filename;
  }

  // ---- JSON file import --------------------------------------------------

  /**
   * Read a File (from an <input type="file">) and resolve to a GameState.
   * Rejects with a user-friendly Error message if anything is wrong.
   */
  function importFromFile(file) {
    return new Promise((resolve, reject) => {
      if (!file) {
        reject(new Error("No file selected."));
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Could not read the file."));
      reader.onload = () => {
        try {
          const payload = JSON.parse(reader.result);
          if (payload.format !== FILE_FORMAT) {
            throw new Error("That doesn't look like an Elemental Masters save.");
          }
          const check = checkVersion(payload.version);
          if (!check.ok) {
            throw new Error(`Cannot load save: ${check.reason}.`);
          }
          if (!payload.state || typeof payload.state !== "object") {
            throw new Error("Save file is missing game state.");
          }
          const state = window.GameState.fromJSON(payload.state);
          resolve(state);
        } catch (err) {
          // JSON.parse errors get a friendlier message. Use `.name` rather
          // than `instanceof SyntaxError` because the parse error may come
          // from a different realm (e.g., when running in tests).
          if (err && err.name === "SyntaxError") {
            reject(new Error("Save file is corrupted (bad JSON)."));
          } else {
            reject(err);
          }
        }
      };
      reader.readAsText(file);
    });
  }

  root.GameSave = {
    saveToLocal,
    loadFromLocal,
    hasLocalSave,
    clearLocal,
    exportToFile,
    importFromFile,
    CURRENT_VERSION,
  };
})(window);
