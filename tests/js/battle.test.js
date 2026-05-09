// tests/js/battle.test.js
// Tests for Battle and Enemy — covers mob variety, neutral-mob spawning,
// stat scaling, super-effective damage, and event emission. RNG is
// injected as a deterministic stream so we can pin down outcomes.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadGame, seededRng } = require("./_harness");

// ---------------------------------------------------------------------------
// Enemy generation
// ---------------------------------------------------------------------------

test("Enemy: a level-5 enemy is always a boss", () => {
  const { Enemy } = loadGame();
  const e = new Enemy(5, true, () => 0);
  assert.equal(e.isBoss, true);
});

test("Enemy: bosses are always elemental, never neutral", () => {
  const { Enemy } = loadGame();
  // Even with rng heavily biased toward 'neutral', a boss must be elemental.
  const e = new Enemy(5, true, () => 0.0);
  assert.equal(e.isNeutral, false);
  assert.ok(typeof e.element === "string" && e.element.length > 0);
});

test("Enemy: bosses use boss_title and have boosted stats", () => {
  const { Enemy, GameData } = loadGame();
  // rng=0 picks the first element (fire); fire boss is "Master of Flames".
  const e = new Enemy(5, true, () => 0);
  assert.equal(e.element, "fire");
  assert.equal(e.name, "Master of Flames");
  // HP must be > base mob HP at the same level (boss multiplier in effect).
  const lvl5MobBase = GameData.balance.mob_base_hp +
    GameData.balance.mob_hp_per_level * 4;
  assert.ok(e.maxHp > lvl5MobBase);
});

test("Enemy: neutral mob picked when roll < neutral_mob_chance", () => {
  const { Enemy, GameData } = loadGame();
  // rng must yield a value below neutral_mob_chance (0.25) for the
  // neutral-roll, then any value (used to pick which neutral mob).
  const rng = seededRng([0.05, 0.0]);
  const e = new Enemy(3, false, rng);
  assert.equal(e.isNeutral, true);
  assert.equal(e.element, null);
  // Neutral mob name must come from the neutral_mobs pool.
  const names = GameData.neutralMobs.map(m => m.name);
  assert.ok(names.includes(e.name), `${e.name} should be in neutral pool`);
});

test("Enemy: elemental mob picked when roll >= neutral_mob_chance", () => {
  const { Enemy, GameData } = loadGame();
  // First random above threshold = elemental. Then random for element pick,
  // then random for which mob within that element's mob list.
  const rng = seededRng([0.99, 0.0, 0.0]);
  const e = new Enemy(3, false, rng);
  assert.equal(e.isNeutral, false);
  // 0.0 picks the first element -> fire
  assert.equal(e.element, "fire");
  // Mob is one of fire's mobs
  const fireMobs = GameData.elements[0].mobs.map(m => m.name);
  assert.ok(fireMobs.includes(e.name), `${e.name} should be a fire mob`);
});

test("Enemy: neutral mob has higher stats than elemental at same level", () => {
  const { Enemy } = loadGame();
  const lvl = 4;
  const elemental = new Enemy(lvl, false, seededRng([0.99, 0.0, 0.0]));
  const neutral = new Enemy(lvl, false, seededRng([0.05, 0.0]));
  assert.ok(neutral.maxHp > elemental.maxHp,
    `neutral HP (${neutral.maxHp}) should exceed elemental (${elemental.maxHp})`);
  assert.ok(neutral.attack > elemental.attack,
    `neutral attack (${neutral.attack}) should exceed elemental (${elemental.attack})`);
});

test("Enemy: stats scale up with level", () => {
  const { Enemy } = loadGame();
  // Force same flavor (elemental) for both
  const r = () => 0.99;
  const low = new Enemy(1, false, r);
  const high = new Enemy(10, false, r);
  assert.ok(high.maxHp > low.maxHp);
  assert.ok(high.attack > low.attack);
});

test("Enemy: takeDamage clamps HP at 0", () => {
  const { Enemy } = loadGame();
  const e = new Enemy(1, false, () => 0.99);
  e.takeDamage(99999);
  assert.equal(e.hp, 0);
  assert.equal(e.isDefeated(), true);
});

// ---------------------------------------------------------------------------
// Battle: weakness logic
// ---------------------------------------------------------------------------

test("Battle: weaknessKey returns null for neutral mobs", () => {
  const { Battle, GameState } = loadGame();
  const s = new GameState("H", "fire");
  // rng forces a neutral mob.
  const b = new Battle(s, { rng: seededRng([0.05, 0.0]) });
  assert.equal(b.enemy.isNeutral, true);
  assert.equal(b.weaknessKey(), null);
  assert.equal(b.isSuperEffective(), false);
  assert.equal(b.playerHasWeakness(), false);
});

test("Battle: super-effective when active element matches weakness", () => {
  const { Battle, GameState } = loadGame();
  const s = new GameState("H", "water");
  // rng=0.99 -> elemental; 0 -> first element (fire); 0 -> first mob.
  const b = new Battle(s, { rng: seededRng([0.99, 0.0, 0.0]) });
  assert.equal(b.enemy.element, "fire");
  assert.equal(b.weaknessKey(), "water");
  assert.equal(b.isSuperEffective(), true,
    "water active vs fire enemy = super-effective");
});

test("Battle: NOT super-effective when active element doesn't match", () => {
  const { Battle, GameState } = loadGame();
  const s = new GameState("H", "earth"); // earth doesn't beat fire
  const b = new Battle(s, { rng: seededRng([0.99, 0.0, 0.0]) });
  assert.equal(b.enemy.element, "fire");
  assert.equal(b.isSuperEffective(), false);
});

// ---------------------------------------------------------------------------
// Battle: damage events
// ---------------------------------------------------------------------------

test("Battle: playerAttack emits damage event with super flag", () => {
  const { Battle, GameState } = loadGame();
  const s = new GameState("H", "water");
  const b = new Battle(s, { rng: seededRng([0.99, 0.0, 0.0, 0.5, 0.5]) });
  // Drop enemy HP so the fight ends on first hit (no enemy turn / variance shenanigans).
  b.enemy.hp = 1;
  const events = b.playerAttack();
  const dmg = events.find(e => e.type === "damage" && e.target === "enemy");
  assert.ok(dmg, "should emit enemy-damage event");
  assert.equal(dmg.super, true, "water vs fire is super-effective");
  // Battle ended with hero winning -> no enemy turn afterward.
  const end = events.find(e => e.type === "end");
  assert.ok(end);
  assert.equal(end.winner, "hero");
});

test("Battle: playerAttack against neutral mob is never super-effective", () => {
  const { Battle, GameState } = loadGame();
  const s = new GameState("H", "water");
  const b = new Battle(s, { rng: seededRng([0.05, 0.0, 0.5]) });
  b.enemy.hp = 1;
  const events = b.playerAttack();
  const dmg = events.find(e => e.type === "damage" && e.target === "enemy");
  assert.equal(dmg.super, false);
});

test("Battle: playerSpecial requires energy and emits special event", () => {
  const { Battle, GameState, GameData } = loadGame();
  const s = new GameState("H", "fire");

  // No energy yet
  const b1 = new Battle(s, { rng: () => 0.5 });
  const noEnergyEvents = b1.playerSpecial();
  assert.ok(
    noEnergyEvents.some(e => e.type === "log" && /not enough energy/i.test(e.text)),
    "should warn when energy too low"
  );

  // Now with full energy
  s.gainEnergy(GameData.balance.special_energy_max);
  const b2 = new Battle(s, { rng: () => 0.5 });
  b2.enemy.hp = 1;
  const events = b2.playerSpecial();
  assert.ok(events.find(e => e.type === "special"), "emits 'special' event");
  assert.ok(events.find(e => e.type === "damage" && e.target === "enemy"));
});

test("Battle: playerDefend halves incoming damage", () => {
  const { Battle, GameState, GameData } = loadGame();
  const s = new GameState("H", "fire");
  const startHp = s.hp;
  // Use an enemy with decent attack so the difference is measurable.
  const b = new Battle(s, { rng: () => 0.5 });
  b.enemy.attack = 20;

  const events = b.playerDefend();
  const heroDmg = events.find(e => e.type === "damage" && e.target === "hero");
  assert.ok(heroDmg, "enemy should still attack on defend turn");
  assert.equal(heroDmg.defended, true);

  // Verify damage was at most defend_damage_reduction * raw, rounded.
  const max = Math.round(20 * GameData.balance.defend_damage_reduction);
  assert.ok(heroDmg.amount <= max,
    `defended damage ${heroDmg.amount} should be <= ${max}`);
  assert.equal(s.hp, startHp - heroDmg.amount);
});

test("Battle: enemy attacks ignore super-effective (chart works one way)", () => {
  // Hero is fire, enemy is water. Water is super-effective vs fire — but
  // only when the *hero* is attacking. The enemy's hits should not get
  // the multiplier.
  const { Battle, GameState, GameData } = loadGame();
  const s = new GameState("H", "fire");
  s.hp = s.maxHp;

  // Force enemy to be elemental water by hand-assigning.
  const b = new Battle(s, { rng: () => 0.99 });
  b.enemy.element = "water";

  const events = b.playerDefend();
  const heroDmg = events.find(e => e.type === "damage" && e.target === "hero");
  assert.equal(heroDmg.super, false,
    "enemy attacks never get super-effective bonus");
});

test("Battle: combat ends when hero HP hits zero", () => {
  const { Battle, GameState } = loadGame();
  const s = new GameState("H", "fire");
  s.hp = 1; // one hit and we're done
  const b = new Battle(s, { rng: () => 0.5 });
  b.enemy.attack = 50;
  const events = b.playerAttack();
  const end = events.find(e => e.type === "end");
  assert.ok(end);
  assert.equal(end.winner, "enemy");
});

test("Battle: levelOffset raises enemy battle level for map danger", () => {
  const { Battle, GameState } = loadGame();
  const s = new GameState("H", "fire");
  const normal = new Battle(s, { rng: seededRng([0.99, 0.0, 0.0]) });
  const danger = new Battle(s, { rng: seededRng([0.99, 0.0, 0.0]), levelOffset: 2 });
  assert.equal(danger.enemy.level, s.level + 2);
  assert.ok(danger.enemy.maxHp > normal.enemy.maxHp);
});

test("Battle: shrine blessing boosts damage and is consumed on battle start", () => {
  const { Battle, GameState } = loadGame();
  const s1 = new GameState("H", "fire");
  const b1 = new Battle(s1, { rng: seededRng([0.99, 0.0, 0.0, 0.5, 0.5]) });
  const e1 = b1.playerAttack().find(e => e.type === "damage" && e.target === "enemy");

  const s2 = new GameState("H", "fire");
  s2.grantShrineBlessing();
  const b2 = new Battle(s2, { rng: seededRng([0.99, 0.0, 0.0, 0.5, 0.5]) });
  const e2 = b2.playerAttack().find(e => e.type === "damage" && e.target === "enemy");

  assert.equal(s2.hasShrineBlessing(), false, "consumed when battle starts");
  assert.ok(e2.amount > e1.amount, `blessed damage ${e2.amount} should be > ${e1.amount}`);
});
