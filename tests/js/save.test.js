// tests/js/save.test.js
// Tests for GameSave — localStorage persistence, version compatibility, and
// JSON file import (export touches DOM and is harder to test in Node, but we
// at least verify localStorage round-trips and version rejection).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadGame } = require("./_harness");

test("GameSave: hasLocalSave reflects localStorage state", () => {
  const { GameSave, GameState } = loadGame();
  assert.equal(GameSave.hasLocalSave(), false);
  GameSave.saveToLocal(new GameState("H", "fire"));
  assert.equal(GameSave.hasLocalSave(), true);
  GameSave.clearLocal();
  assert.equal(GameSave.hasLocalSave(), false);
});

test("GameSave: saveToLocal + loadFromLocal round-trips a game", () => {
  const { GameSave, GameState } = loadGame();
  const s = new GameState("Tester", "ice");
  s.level = 8;
  s.wins = 14;
  s.grantElement("lava");
  GameSave.saveToLocal(s);

  const loaded = GameSave.loadFromLocal();
  assert.ok(loaded, "should load");
  assert.equal(loaded.heroName, "Tester");
  assert.equal(loaded.level, 8);
  assert.equal(loaded.wins, 14);
  assert.deepEqual(Array.from(loaded.ownedElements), ["ice", "lava"]);
});

test("GameSave: loadFromLocal returns null when no save exists", () => {
  const { GameSave } = loadGame();
  assert.equal(GameSave.loadFromLocal(), null);
});

test("GameSave: rejects save with mismatched major version", () => {
  const ctx = loadGame();
  // Hand-write a save in localStorage with a major-version mismatch.
  ctx.localStorage.setItem(
    "elemental-masters:save:v1",
    JSON.stringify({
      format: "elemental-masters-save",
      version: "999.0.0",
      state: { heroName: "Old", activeElement: "fire", level: 1 },
    })
  );
  assert.equal(ctx.GameSave.loadFromLocal(), null);
});

test("GameSave: accepts save with same major, different minor/patch", () => {
  const ctx = loadGame();
  const current = ctx.GameData.version;
  const [maj] = current.split(".");
  // Same major, much higher minor/patch
  ctx.localStorage.setItem(
    "elemental-masters:save:v1",
    JSON.stringify({
      format: "elemental-masters-save",
      version: `${maj}.99.99`,
      state: { heroName: "Future", activeElement: "fire", level: 3 },
    })
  );
  const s = ctx.GameSave.loadFromLocal();
  assert.ok(s, "should load same-major save");
  assert.equal(s.heroName, "Future");
  assert.equal(s.level, 3);
});

test("GameSave: importFromFile rejects wrong format tag", async () => {
  const { GameSave } = loadGame();
  const fakeFile = { _text: JSON.stringify({ format: "wrong", version: "1.0.0" }) };
  await assert.rejects(
    GameSave.importFromFile(fakeFile),
    /doesn't look like an Elemental Masters save/i
  );
});

test("GameSave: importFromFile rejects malformed JSON", async () => {
  const { GameSave } = loadGame();
  const fakeFile = { _text: "{not valid json" };
  await assert.rejects(
    GameSave.importFromFile(fakeFile),
    /corrupted/i
  );
});

test("GameSave: importFromFile rejects future major version", async () => {
  const { GameSave } = loadGame();
  const fakeFile = {
    _text: JSON.stringify({
      format: "elemental-masters-save",
      version: "999.0.0",
      state: { heroName: "X", activeElement: "fire" },
    }),
  };
  await assert.rejects(GameSave.importFromFile(fakeFile), /Cannot load/i);
});

test("GameSave: importFromFile loads a valid save", async () => {
  const { GameSave, GameData } = loadGame();
  const fakeFile = {
    _text: JSON.stringify({
      format: "elemental-masters-save",
      version: GameData.version,
      state: {
        heroName: "Imported",
        activeElement: "wind",
        ownedElements: ["wind"],
        level: 4,
      },
    }),
  };
  const s = await GameSave.importFromFile(fakeFile);
  assert.equal(s.heroName, "Imported");
  assert.equal(s.activeElement, "wind");
  assert.equal(s.level, 4);
});

test("GameSave: importFromFile rejects null file", async () => {
  const { GameSave } = loadGame();
  await assert.rejects(GameSave.importFromFile(null), /No file/i);
});
