// tests/js/storage.test.js
// Tests for GameStorage — JSON round-trips, namespace handling, graceful
// failure when localStorage throws.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadGame } = require("./_harness");

test("GameStorage: write + read round-trips an object", () => {
  const { GameStorage } = loadGame();
  const obj = { foo: 1, bar: ["a", "b"] };
  assert.equal(GameStorage.write("test", obj), true);
  assert.deepEqual(GameStorage.read("test"), obj);
});

test("GameStorage: read returns null for missing key", () => {
  const { GameStorage } = loadGame();
  assert.equal(GameStorage.read("never-stored"), null);
});

test("GameStorage: has() reports existence correctly", () => {
  const { GameStorage } = loadGame();
  assert.equal(GameStorage.has("foo"), false);
  GameStorage.write("foo", { x: 1 });
  assert.equal(GameStorage.has("foo"), true);
  GameStorage.remove("foo");
  assert.equal(GameStorage.has("foo"), false);
});

test("GameStorage: keys are namespaced under 'elemental-masters:'", () => {
  const ctx = loadGame();
  ctx.GameStorage.write("a-key", "value");
  // Inspect the underlying store directly: the value should appear under
  // the namespaced key, not the raw one.
  assert.equal(ctx.localStorage.getItem("a-key"), null);
  assert.notEqual(ctx.localStorage.getItem("elemental-masters:a-key"), null);
});

test("GameStorage: read returns null on corrupted JSON", () => {
  const ctx = loadGame();
  // Bypass the API to inject garbage at the namespaced key.
  ctx.localStorage.setItem("elemental-masters:bad", "{not json");
  assert.equal(ctx.GameStorage.read("bad"), null);
});

test("GameStorage: write returns false when localStorage throws", () => {
  const ctx = loadGame();
  // Replace setItem with a function that throws (simulates quota exceeded).
  ctx.localStorage.setItem = () => { throw new Error("QuotaExceededError"); };
  assert.equal(ctx.GameStorage.write("anything", { x: 1 }), false);
});

test("GameStorage: read returns null when localStorage throws", () => {
  const ctx = loadGame();
  ctx.localStorage.getItem = () => { throw new Error("storage disabled"); };
  assert.equal(ctx.GameStorage.read("anything"), null);
});

test("GameStorage: remove is idempotent", () => {
  const { GameStorage } = loadGame();
  // Removing a non-existent key shouldn't throw or return false.
  assert.equal(GameStorage.remove("never-stored"), true);
  GameStorage.write("k", { x: 1 });
  assert.equal(GameStorage.remove("k"), true);
  assert.equal(GameStorage.has("k"), false);
});
