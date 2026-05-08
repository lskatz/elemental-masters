// tests/js/state.test.js
// Tests for GameState — derived stats, level/HP/energy logic, element
// ownership, victory/defeat side effects, and JSON round-trip.
//
// Uses Node's built-in test runner. Run with:
//   node --test tests/js

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadGame } = require("./_harness");

// ---------------------------------------------------------------------------
// Construction & derived stats
// ---------------------------------------------------------------------------

test("GameState: starts with sensible defaults", () => {
  const { GameState } = loadGame();
  const s = new GameState("Bobby", "fire");
  assert.equal(s.heroName, "Bobby");
  assert.equal(s.activeElement, "fire");
  assert.deepEqual(Array.from(s.ownedElements), ["fire"]);
  assert.equal(s.level, 1);
  assert.equal(s.wins, 0);
  assert.equal(s.bossesBeaten, 0);
  assert.equal(s.hp, s.maxHp);
  assert.equal(s.energy, 0);
  assert.equal(s.dirtyForExport, false);
});

test("GameState: maxHp scales with level", () => {
  const { GameState } = loadGame();
  const s = new GameState("H", "fire");
  const at1 = s.maxHp;
  s.level = 5;
  assert.ok(s.maxHp > at1, "max HP should grow as level rises");
});

test("GameState: tier increments at 6, 11, 16 and caps at 3", () => {
  const { GameState } = loadGame();
  const s = new GameState("H", "fire");
  s.level = 1;  assert.equal(s.tier, 0);
  s.level = 5;  assert.equal(s.tier, 0);
  s.level = 6;  assert.equal(s.tier, 1);
  s.level = 10; assert.equal(s.tier, 1);
  s.level = 11; assert.equal(s.tier, 2);
  s.level = 16; assert.equal(s.tier, 3);
  s.level = 99; assert.equal(s.tier, 3, "tier capped at 3");
});

test("GameState: specialName reflects active element + tier", () => {
  const { GameState } = loadGame();
  const s = new GameState("H", "fire");
  assert.equal(s.specialName, "Flame");
  s.level = 6;
  assert.equal(s.specialName, "Fireball");
  s.level = 11;
  assert.equal(s.specialName, "Inferno");
  s.level = 16;
  assert.equal(s.specialName, "Meteor");
});

test("GameState: activeEmoji returns the active element's emoji", () => {
  const { GameState } = loadGame();
  const s = new GameState("H", "fire");
  assert.equal(s.activeEmoji, "🔥");
});

// ---------------------------------------------------------------------------
// Energy
// ---------------------------------------------------------------------------

test("GameState: energy capped at max, cannot go negative", () => {
  const { GameState, GameData } = loadGame();
  const s = new GameState("H", "fire");
  s.gainEnergy(9999);
  assert.equal(s.energy, GameData.balance.special_energy_max);
  assert.equal(s.spendEnergy(9999), false, "cannot spend more than current");
  // spendEnergy returning false means nothing was deducted
  assert.equal(s.energy, GameData.balance.special_energy_max);
});

test("GameState: canSpecial only when above special_energy_cost", () => {
  const { GameState, GameData } = loadGame();
  const s = new GameState("H", "fire");
  assert.equal(s.canSpecial(), false);
  s.gainEnergy(GameData.balance.special_energy_cost - 1);
  assert.equal(s.canSpecial(), false);
  s.gainEnergy(1);
  assert.equal(s.canSpecial(), true);
});

// ---------------------------------------------------------------------------
// Combat-related mutators
// ---------------------------------------------------------------------------

test("GameState: takeDamage clamps at 0 and marks defeated", () => {
  const { GameState } = loadGame();
  const s = new GameState("H", "fire");
  s.takeDamage(99999);
  assert.equal(s.hp, 0);
  assert.equal(s.isDefeated(), true);
});

test("GameState: onVictory levels up, full heals, resets energy", () => {
  const { GameState } = loadGame();
  const s = new GameState("H", "fire");
  s.takeDamage(20);
  s.gainEnergy(30);
  const beforeLevel = s.level;
  s.onVictory(false);
  assert.equal(s.level, beforeLevel + 1);
  assert.equal(s.hp, s.maxHp);
  assert.equal(s.energy, 0);
  assert.equal(s.wins, 1);
});

test("GameState: onVictory(true) signals unlockableElement until all elements are owned", () => {
  const { GameState, GameData } = loadGame();
  const s = new GameState("H", "fire");
  const toGrant = GameData.elements.map((el) => el.key).filter((k) => k !== "fire");
  let r = null;

  toGrant.forEach((key, i) => {
    s.level = (i + 1) * 5;
    r = s.onVictory(true);
    assert.equal(r.unlockableElement, true, "each boss should unlock until full set owned");
    assert.equal(s.grantElement(key), true);
  });

  s.level = (toGrant.length + 1) * 5;
  r = s.onVictory(true);
  assert.equal(r.unlockableElement, false, "no unlock after owning every element");
  assert.equal(s.ownedElements.length, GameData.elements.length);
});

test("GameState: onVictory marks newTier at level transitions", () => {
  const { GameState } = loadGame();
  const s = new GameState("H", "fire");
  s.level = 5;
  let r = s.onVictory(true);
  assert.equal(r.newTier, true, "level 5 -> 6 crosses tier boundary");

  s.level = 7;
  r = s.onVictory(false);
  assert.equal(r.newTier, false, "no tier change in middle of band");
});

test("GameState: onDefeat fully heals for a retry", () => {
  const { GameState } = loadGame();
  const s = new GameState("H", "fire");
  s.hp = 0;
  s.energy = 50;
  s.onDefeat();
  assert.equal(s.hp, s.maxHp);
  assert.equal(s.energy, 0);
});

// ---------------------------------------------------------------------------
// Element ownership
// ---------------------------------------------------------------------------

test("GameState: grantElement adds new, rejects duplicates and overflow", () => {
  const { GameState, GameData } = loadGame();
  const s = new GameState("H", "fire");

  assert.equal(s.grantElement("fire"), false, "cannot regrant existing");
  assert.equal(s.ownedElements.length, 1);

  const allOtherKeys = GameData.elements.map((el) => el.key).filter((k) => k !== "fire");
  allOtherKeys.forEach((key) => {
    assert.equal(s.grantElement(key), true);
  });
  assert.equal(s.ownedElements.length, GameData.elements.length);

  // Any extra grant beyond full set is rejected.
  assert.equal(s.grantElement("not-real"), false, "rejects once all elements are already owned");
  assert.equal(s.ownedElements.length, GameData.elements.length);
});

test("GameState: setActive throws on unowned element, sets owned ones", () => {
  const { GameState } = loadGame();
  const s = new GameState("H", "fire");
  assert.throws(() => s.setActive("water"), /unowned/);
  s.grantElement("water");
  s.setActive("water");
  assert.equal(s.activeElement, "water");
});

// ---------------------------------------------------------------------------
// JSON round-trip
// ---------------------------------------------------------------------------

test("GameState: toJSON / fromJSON round-trips faithfully", () => {
  const { GameState } = loadGame();
  const s = new GameState("Saver", "lightning");
  s.level = 7;
  s.wins = 12;
  s.bossesBeaten = 1;
  s.grantElement("dust");
  s.takeDamage(5);
  s.gainEnergy(40);

  const snap = s.toJSON();
  const restored = GameState.fromJSON(snap);

  assert.equal(restored.heroName, "Saver");
  assert.equal(restored.activeElement, "lightning");
  assert.deepEqual(Array.from(restored.ownedElements), ["lightning", "dust"]);
  assert.equal(restored.level, 7);
  assert.equal(restored.wins, 12);
  assert.equal(restored.bossesBeaten, 1);
  assert.equal(restored.hp, s.hp);
  assert.equal(restored.energy, 40);
});

test("GameState: fromJSON tolerates missing fields with sensible defaults", () => {
  const { GameState } = loadGame();
  const minimal = { heroName: "X", activeElement: "fire" };
  const s = GameState.fromJSON(minimal);
  assert.equal(s.heroName, "X");
  assert.equal(s.level, 1);
  assert.equal(s.hp, s.maxHp);
  assert.deepEqual(Array.from(s.ownedElements), ["fire"]);
});

test("GameState: fromJSON clamps HP if balance changed (HP > current maxHp)", () => {
  const { GameState } = loadGame();
  const s = GameState.fromJSON({
    heroName: "X",
    activeElement: "fire",
    level: 1,
    hp: 99999,
  });
  assert.equal(s.hp, s.maxHp, "HP clamped to current maxHp");
});

test("GameState: fromJSON drops unknown element keys", () => {
  const { GameState } = loadGame();
  // A save with element "banana" (perhaps from a future game version)
  // should be sanitized rather than producing a broken GameState.
  const s = GameState.fromJSON({
    heroName: "X",
    activeElement: "banana",
    ownedElements: ["banana", "fire", "wormhole"],
    level: 3,
  });
  assert.ok(s.ownedElements.includes("fire"), "known elements survive");
  assert.ok(!s.ownedElements.includes("banana"), "unknown dropped");
  assert.ok(!s.ownedElements.includes("wormhole"), "unknown dropped");
  assert.equal(s.activeElement, "fire", "active falls back to first valid");
});

test("GameState: fromJSON ensures active is in owned list", () => {
  const { GameState } = loadGame();
  // Hand-edited save where active was set to an element not in the
  // owned list — fromJSON should add it rather than create an
  // inconsistent state.
  const s = GameState.fromJSON({
    heroName: "X",
    activeElement: "water",
    ownedElements: ["fire"],
  });
  assert.ok(s.ownedElements.includes("water"));
  assert.ok(s.ownedElements.includes("fire"));
});

test("GameState: fromJSON clamps negative numbers to safe values", () => {
  const { GameState } = loadGame();
  const s = GameState.fromJSON({
    heroName: "X",
    activeElement: "fire",
    level: -5,
    wins: -10,
    bossesBeaten: -1,
    hp: -100,
    energy: -50,
  });
  assert.equal(s.level, 1, "level clamped to >= 1");
  assert.equal(s.wins, 0);
  assert.equal(s.bossesBeaten, 0);
  assert.equal(s.hp, 0, "HP clamped to >= 0");
  assert.equal(s.energy, 0);
});

test("GameState: fromJSON falls back to default when activeElement missing", () => {
  const { GameState, GameData } = loadGame();
  const s = GameState.fromJSON({ heroName: "X" });
  // Default = first element in GameData
  assert.equal(s.activeElement, GameData.elements[0].key);
});

test("GameState: fromJSON gives a hero name when absent or empty", () => {
  const { GameState } = loadGame();
  assert.equal(GameState.fromJSON({}).heroName, "Hero");
  assert.equal(GameState.fromJSON({ heroName: "" }).heroName, "Hero");
  assert.equal(GameState.fromJSON({ heroName: 42 }).heroName, "Hero",
    "non-string heroName falls back too");
});

// ---------------------------------------------------------------------------
// Rules helpers
// ---------------------------------------------------------------------------

test("GameRules: isBossLevel hits multiples of 5", () => {
  const { GameRules } = loadGame();
  assert.equal(GameRules.isBossLevel(1), false);
  assert.equal(GameRules.isBossLevel(4), false);
  assert.equal(GameRules.isBossLevel(5), true);
  assert.equal(GameRules.isBossLevel(10), true);
  assert.equal(GameRules.isBossLevel(13), false);
  assert.equal(GameRules.isBossLevel(15), true);
});
