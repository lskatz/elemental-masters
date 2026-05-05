/* ============================================================================
 * storage.js — Thin localStorage wrapper used by save.js and coach.js.
 *
 * The browser localStorage API throws in private mode, when the quota is
 * exceeded, or when storage is disabled. Every module that persists state
 * needs identical try/catch boilerplate; this module centralizes that so
 * the rest of the codebase can pretend storage just works.
 *
 * Conventions:
 *   - All keys are namespaced under "elemental-masters:" so we don't
 *     collide with other apps if hosted on a multi-tenant domain.
 *   - Values are JSON-serialized. Caller deals in plain objects/arrays.
 *   - Read failures return null. Write failures return false. Neither throws.
 *
 * Adding a new storage-backed feature: pick a key (snake-case, lowercase,
 * suffix with `:vN` if you'll ever change its shape), then call
 *
 *     window.GameStorage.read("yourkey:v1")    // -> object | null
 *     window.GameStorage.write("yourkey:v1", obj)
 *     window.GameStorage.remove("yourkey:v1")
 *
 * Because keys are namespaced internally, callers pass the un-prefixed
 * portion only.
 * ========================================================================== */

(function (root) {
  "use strict";

  const NAMESPACE = "elemental-masters:";

  /** Build the full localStorage key for a logical key. */
  function fullKey(key) {
    return NAMESPACE + key;
  }

  /**
   * Read and JSON-parse a value. Returns null if the key is missing,
   * storage is unavailable, or the stored value is not valid JSON.
   */
  function read(key) {
    try {
      const raw = localStorage.getItem(fullKey(key));
      if (raw == null) return null;
      return JSON.parse(raw);
    } catch (err) {
      // Private mode, quota exceeded, corrupted JSON — all fail gracefully.
      console.warn(`storage.read(${key}) failed:`, err);
      return null;
    }
  }

  /**
   * JSON-serialize and write a value. Returns true on success, false on
   * failure (e.g. quota, private mode). Never throws.
   */
  function write(key, value) {
    try {
      localStorage.setItem(fullKey(key), JSON.stringify(value));
      return true;
    } catch (err) {
      console.warn(`storage.write(${key}) failed:`, err);
      return false;
    }
  }

  /** Delete a key. Silently succeeds if the key doesn't exist. */
  function remove(key) {
    try {
      localStorage.removeItem(fullKey(key));
      return true;
    } catch (err) {
      console.warn(`storage.remove(${key}) failed:`, err);
      return false;
    }
  }

  /** Check whether a key has a stored value. */
  function has(key) {
    try {
      return localStorage.getItem(fullKey(key)) !== null;
    } catch (err) {
      return false;
    }
  }

  root.GameStorage = { read, write, remove, has, NAMESPACE };
})(window);
