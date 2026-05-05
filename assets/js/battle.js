/* ============================================================================
 * battle.js — Turn-based battle controller
 *
 * Builds an enemy for the current level, runs hero<->enemy turns, and
 * returns a stream of "events" that ui.js converts to animations and
 * battle-log lines. Battles end when one side hits 0 HP.
 *
 * Event shapes:
 *   { type: "log",     text: "..." }
 *   { type: "damage",  target: "hero"|"enemy", amount: N, super: bool, defended: bool }
 *   { type: "miss",    target: "hero"|"enemy" }
 *   { type: "energy",  amount: N }
 *   { type: "special", name: "Fireball" }
 *   { type: "end",     winner: "hero"|"enemy", wasBoss: bool }
 *
 * UI consumes events one at a time so animations can sequence properly.
 * ========================================================================== */

(function (root) {
  "use strict";

  const Balance = window.GameData.balance;
  const Elements = window.GameData.elements;
  const ElementIndex = window.GameData.elementIndex;
  const NeutralMobs = window.GameData.neutralMobs;
  const WeaknessOf = window.GameData.weaknessOf;
  const Rules = window.GameRules;

  /**
   * Enemy — a regular mob or a boss for the current level.
   *
   * Three flavors:
   *   - Boss      (level % 5 === 0): always elemental, always uses boss_title.
   *   - Elemental mob: random element + random mob from that element's list.
   *   - Neutral mob: no element, slight stat boost to compensate for not
   *                  having a weakness the player can exploit.
   *
   * `rng` is injectable for testing — defaults to Math.random.
   */
  class Enemy {
    constructor(level, isBoss, rng) {
      const random = rng || Math.random;

      this.level = level;
      this.isBoss = isBoss;

      // Decide whether this is a neutral (non-elemental) mob. Bosses are
      // always elemental — neutral mobs only appear as regular encounters.
      const rollNeutral = isBoss ? 1 : random();
      this.isNeutral = !isBoss && rollNeutral < Balance.neutral_mob_chance;

      let hpMul = 1;
      let atkMul = 1;

      if (isBoss) {
        hpMul = Balance.boss_hp_multiplier;
        atkMul = Balance.boss_attack_multiplier;
      } else if (this.isNeutral) {
        hpMul = Balance.neutral_mob_hp_multiplier;
        atkMul = Balance.neutral_mob_attack_multiplier;
      }

      this.maxHp = Math.round(
        (Balance.mob_base_hp + Balance.mob_hp_per_level * (level - 1)) * hpMul
      );
      this.hp = this.maxHp;
      this.attack = Math.round(
        (Balance.mob_base_attack + Balance.mob_attack_per_level * (level - 1)) * atkMul
      );

      if (this.isNeutral) {
        // Neutral mobs have no element and no super-effective weakness.
        this.element = null;
        const mob = pickRandom(NeutralMobs, random);
        this.name = mob.name;
        this.emoji = mob.emoji;
        this.color = "#9ca3af"; // neutral grey
      } else {
        this.element = pickRandomElementKey(random);
        const elData = Elements[ElementIndex[this.element]];
        if (isBoss) {
          this.name = elData.boss_title;
          this.emoji = elData.emoji;
        } else {
          const mob = pickRandom(elData.mobs, random);
          this.name = mob.name;
          this.emoji = mob.emoji;
        }
        this.color = elData.color;
      }
    }

    takeDamage(n) { this.hp = Math.max(0, this.hp - n); }
    isDefeated() { return this.hp <= 0; }
  }

  function pickRandom(arr, rng) {
    return arr[Math.floor(rng() * arr.length)];
  }

  function pickRandomElementKey(rng) {
    return Elements[Math.floor(rng() * Elements.length)].key;
  }

  /**
   * Battle — orchestrates a single fight. Holds the enemy + a defending flag.
   * Methods that take a player turn return an array of events.
   *
   * `options.rng` (default Math.random) is used for both enemy generation
   * and damage variance. Tests inject a deterministic generator here so
   * outcomes are reproducible.
   */
  class Battle {
    constructor(state, options) {
      const opts = options || {};
      this.state = state;
      this._rng = opts.rng || Math.random;
      this.enemy = new Enemy(state.level, Rules.isBossLevel(state.level), this._rng);
      this._defending = false;
      this._ended = false;
    }

    // ---- Information helpers (used by UI for the boss intro screen) ----

    /** The element key that beats this battle's enemy, or null if neutral. */
    weaknessKey() {
      if (!this.enemy.element) return null;
      return WeaknessOf[this.enemy.element];
    }

    /** Does the player own the element that beats this enemy? Neutral = false. */
    playerHasWeakness() {
      const w = this.weaknessKey();
      if (!w) return false;
      return this.state.ownedElements.includes(w);
    }

    /** Is the player's current active element super-effective? */
    isSuperEffective() {
      const w = this.weaknessKey();
      if (!w) return false;
      return this.state.activeElement === w;
    }

    // ---- Player turns ---------------------------------------------------

    playerAttack() {
      if (this._ended) return [];
      const events = [];
      const dmg = this._computeDamage(this.state.attack, false);
      this.enemy.takeDamage(dmg.amount);
      this.state.gainEnergy(Balance.special_energy_per_attack);
      events.push({ type: "log",
        text: `${this.state.heroName} attacks with ${this.state.activeElementData().name}!` });
      events.push({ type: "damage", target: "enemy",
        amount: dmg.amount, super: dmg.super, defended: false });
      events.push({ type: "energy", amount: this.state.energy });

      if (this.enemy.isDefeated()) {
        events.push({ type: "end", winner: "hero", wasBoss: this.enemy.isBoss });
        this._ended = true;
        return events;
      }
      return events.concat(this._enemyTurn());
    }

    playerSpecial() {
      if (this._ended) return [];
      if (!this.state.canSpecial()) {
        return [{ type: "log", text: "Not enough energy yet!" }];
      }
      this.state.spendEnergy(Balance.special_energy_cost);
      const dmg = this._computeDamage(
        this.state.attack * Balance.special_damage_multiplier,
        false
      );
      this.enemy.takeDamage(dmg.amount);

      const events = [];
      events.push({ type: "special", name: this.state.specialName });
      events.push({ type: "log",
        text: `${this.state.heroName} unleashes ${this.state.specialName}!` });
      events.push({ type: "damage", target: "enemy",
        amount: dmg.amount, super: dmg.super, defended: false });
      events.push({ type: "energy", amount: this.state.energy });

      if (this.enemy.isDefeated()) {
        events.push({ type: "end", winner: "hero", wasBoss: this.enemy.isBoss });
        this._ended = true;
        return events;
      }
      return events.concat(this._enemyTurn());
    }

    playerDefend() {
      if (this._ended) return [];
      this._defending = true;
      this.state.gainEnergy(Math.round(Balance.special_energy_per_attack / 2));
      const events = [
        { type: "log", text: `${this.state.heroName} braces for impact!` },
        { type: "energy", amount: this.state.energy },
      ];
      return events.concat(this._enemyTurn());
    }

    // ---- Enemy turn -----------------------------------------------------

    _enemyTurn() {
      const events = [];
      // Enemies don't get super-effective bonuses against the player —
      // the chart works for the hero, not against them. Keeps the game
      // fair and keeps weakness-thinking pointed in one direction (which
      // is plenty for an 8-year-old to reason about).
      let dmg = this.enemy.attack;
      let defended = false;
      if (this._defending) {
        dmg = Math.round(dmg * Balance.defend_damage_reduction);
        defended = true;
        this._defending = false;
      }
      this.state.takeDamage(dmg);
      events.push({ type: "log", text: `${this.enemy.name} strikes back!` });
      events.push({ type: "damage", target: "hero",
        amount: dmg, super: false, defended });

      if (this.state.isDefeated()) {
        events.push({ type: "end", winner: "enemy", wasBoss: this.enemy.isBoss });
        this._ended = true;
      }
      return events;
    }

    // ---- Damage calculation --------------------------------------------

    _computeDamage(baseAmount, ignoreSuperEffective) {
      let amount = baseAmount;
      let isSuper = false;

      if (!ignoreSuperEffective && this.isSuperEffective()) {
        const mul = this.enemy.isBoss
          ? Balance.super_effective_boss
          : Balance.super_effective_mob;
        amount *= mul;
        isSuper = true;
      }

      // Small randomness (+/-15%) so battles aren't deterministic.
      const variance = 0.85 + this._rng() * 0.30;
      amount = Math.max(1, Math.round(amount * variance));
      return { amount, super: isSuper };
    }
  }

  root.Battle = Battle;
  root.Enemy = Enemy;
})(window);
