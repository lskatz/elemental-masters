// tests/js/coach.test.js
// Tests for Coach — tip selection logic, dismissal persistence, and the
// level-5 cutoff after which the coach goes silent.
//
// We test the pure selection logic via Coach.pickTip(), which doesn't
// touch the DOM — UI rendering would need a real DOM and is out of scope
// for these unit tests.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

/**
 * Like the main harness, but also loads coach.js. The coach script uses
 * `localStorage` directly (not via window.GameSave), so we still need the
 * shimmed localStorage to track dismissals.
 */
function loadGameWithCoach() {
  const store = {};
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  };

  const ctx = {
    console,
    setTimeout,
    clearTimeout,
    Math,
    Date,
    JSON,
    Promise,
    document: { addEventListener: () => {}, readyState: "complete" },
    localStorage,
  };
  ctx.window = ctx;
  vm.createContext(ctx);

  const order = [
    "generated-data.js",
    "storage.js",
    "state.js",
    "save.js",
    "battle.js",
    "coach.js",
  ];
  for (const f of order) {
    const src = fs.readFileSync(
      path.join(PROJECT_ROOT, "assets/js", f),
      "utf8"
    );
    vm.runInContext(src, ctx, { filename: f });
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Hub-screen tips
// ---------------------------------------------------------------------------

test("Coach: shows hub-welcome to a brand-new player on the hub", () => {
  const { Coach, GameState } = loadGameWithCoach();
  const s = new GameState("Newbie", "fire");
  const tip = Coach.pickTip("hub", s);
  assert.ok(tip, "should find a tip for level-1 player");
  assert.equal(tip.id, "hub-welcome");
});

test("Coach: hub-welcome doesn't reappear after dismissal", () => {
  const { Coach, GameState } = loadGameWithCoach();
  const s = new GameState("Newbie", "fire");
  Coach.dismiss("hub-welcome");
  const tip = Coach.pickTip("hub", s);
  // Should not be hub-welcome (could be null, or a different tip)
  if (tip) assert.notEqual(tip.id, "hub-welcome");
});

test("Coach: shows pre-boss tip exactly at level 5", () => {
  const { Coach, GameState } = loadGameWithCoach();
  const s = new GameState("H", "fire");
  s.level = 5;
  s.wins = 4; // dismiss earlier-tier tips with state, not localStorage
  Coach.dismiss("hub-welcome");
  Coach.dismiss("hub-after-first-win");
  const tip = Coach.pickTip("hub", s);
  assert.ok(tip);
  assert.equal(tip.id, "hub-pre-boss");
});

test("Coach: shows multi-element tip once player has 2+ elements", () => {
  const { Coach, GameState } = loadGameWithCoach();
  const s = new GameState("H", "fire");
  s.grantElement("water");
  s.level = 6;
  Coach.dismiss("hub-welcome");
  Coach.dismiss("hub-after-first-win");
  const tip = Coach.pickTip("hub", s);
  assert.ok(tip);
  assert.equal(tip.id, "hub-multi-element");
});

// ---------------------------------------------------------------------------
// Battle-screen tips
// ---------------------------------------------------------------------------

test("Coach: shows attack-explanation on first battle ever", () => {
  const { Coach, GameState, Battle } = loadGameWithCoach();
  const s = new GameState("H", "fire");
  // level 1, wins 0, no battle context yet
  const b = new Battle(s, { rng: () => 0.99 });
  const tip = Coach.pickTip("battle", s, { battle: b });
  assert.ok(tip);
  assert.equal(tip.id, "battle-attack-explanation");
});

test("Coach: shows special-explanation when energy first becomes available", () => {
  const { Coach, GameState, Battle, GameData } = loadGameWithCoach();
  const s = new GameState("H", "fire");
  s.level = 2;
  s.gainEnergy(GameData.balance.special_energy_cost);
  const b = new Battle(s, { rng: () => 0.99 });
  Coach.dismiss("battle-attack-explanation");
  // Force enemy to be non-elemental match so super-effective tip doesn't trigger first
  b.enemy.element = "earth"; // hero is fire, earth-fire are not paired
  const tip = Coach.pickTip("battle", s, { battle: b });
  assert.ok(tip);
  assert.equal(tip.id, "battle-special-explanation");
});

test("Coach: shows defend-explanation when HP is low in early levels", () => {
  const { Coach, GameState, Battle } = loadGameWithCoach();
  const s = new GameState("H", "fire");
  s.level = 2;
  s.takeDamage(Math.floor(s.maxHp * 0.7)); // 30% HP left
  const b = new Battle(s, { rng: () => 0.99 });
  b.enemy.element = "earth";
  Coach.dismiss("battle-attack-explanation");
  Coach.dismiss("battle-special-explanation");
  const tip = Coach.pickTip("battle", s, { battle: b });
  assert.ok(tip);
  assert.equal(tip.id, "battle-defend-explanation");
});

test("Coach: shows super-effective tip when matchup is favorable", () => {
  const { Coach, GameState, Battle } = loadGameWithCoach();
  const s = new GameState("H", "water");
  s.level = 2;
  // rng 0.99 => elemental, 0.0 => fire, 0.0 => first mob
  const b = new Battle(s, { rng: () => 0 });
  // Force the match to be water vs fire (super-effective)
  b.enemy.element = "fire";
  Coach.dismiss("battle-attack-explanation");
  const tip = Coach.pickTip("battle", s, { battle: b });
  assert.ok(tip);
  assert.equal(tip.id, "battle-super-effective");
});

test("Coach: shows neutral-mob tip when fighting a non-elemental enemy", () => {
  const { Coach, GameState, Battle } = loadGameWithCoach();
  const s = new GameState("H", "fire");
  s.level = 2;
  // rng yielding 0.05 first => neutral roll succeeds
  const b = new Battle(s, { rng: () => 0.05 });
  assert.equal(b.enemy.isNeutral, true);
  Coach.dismiss("battle-attack-explanation");
  const tip = Coach.pickTip("battle", s, { battle: b });
  assert.ok(tip);
  assert.equal(tip.id, "battle-neutral-mob");
});

// ---------------------------------------------------------------------------
// Cutoff and reset
// ---------------------------------------------------------------------------

test("Coach: returns no tip after level 10 (5 past the teaching cutoff)", () => {
  const { Coach, GameState, Battle } = loadGameWithCoach();
  const s = new GameState("H", "fire");
  s.level = 11;
  const b = new Battle(s, { rng: () => 0.99 });
  const tip = Coach.pickTip("battle", s, { battle: b });
  assert.equal(tip, null, "no coaching for experienced players");
});

test("Coach: reset() clears all dismissals", () => {
  const { Coach, GameState } = loadGameWithCoach();
  const s = new GameState("H", "fire");
  Coach.dismiss("hub-welcome");
  // Confirm it's dismissed
  let tip = Coach.pickTip("hub", s);
  if (tip) assert.notEqual(tip.id, "hub-welcome");
  // Now reset
  Coach.reset();
  tip = Coach.pickTip("hub", s);
  assert.ok(tip);
  assert.equal(tip.id, "hub-welcome");
});

test("Coach: handles missing battle context gracefully", () => {
  const { Coach, GameState } = loadGameWithCoach();
  const s = new GameState("H", "fire");
  // Battle-context-dependent tips should not crash when ctx is missing.
  const tip = Coach.pickTip("battle", s);
  // Should still return *some* tip (battle-attack-explanation does not need ctx)
  // but at minimum shouldn't throw.
  assert.ok(tip);
});
