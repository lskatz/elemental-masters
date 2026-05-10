/* ============================================================================
 * state.js — Game state container and rules
 *
 * Pure logic. Knows nothing about the DOM. All UI updates flow from this
 * state object via ui.js. Battle.js mutates state during fights; save.js
 * serializes/deserializes it.
 *
 * Depends on: GameData (from generated-data.js)
 * ========================================================================== */

(function (root) {
  "use strict";

  const Balance = window.GameData.balance;
  const Elements = window.GameData.elements;
  const ElementIndex = window.GameData.elementIndex;
  const MAP_SIZE = 10;
  const MAP_MIN = 0;
  const MAP_MAX = MAP_SIZE - 1;
  const MAP_CENTER = Math.floor(MAP_SIZE / 2);

  /**
   * GameState — the entire saveable state of one playthrough.
   *
   * Anything that needs to persist between sessions lives here. Anything
   * derived (max HP for current level, current special name, etc.) is
   * computed via getters so saves stay small and version-resilient.
   */
  class GameState {
    constructor(heroName, startElement) {
      this.heroName = heroName;
      // Elements the player owns, in unlock order. The first one is the active
      // element by default; player can switch between owned elements at the hub.
      this.ownedElements = [startElement];
      this.activeElement = startElement;

      this.level = 1;
      this.wins = 0;          // total enemies defeated (regular + boss)
      this.bossesBeaten = 0;  // tracked separately for unlock logic

      this.hp = this.maxHp;   // start at full HP
      this.energy = 0;        // builds up from attacks; spent on specials
      // Overworld map position (10x10 grid). Center spawn.
      this.mapX = MAP_CENTER;
      this.mapY = MAP_CENTER;
      // Shrine blessing charges (consumed at battle start).
      this.shrineBlessing = 0;

      // Tracks whether changes have been made since the last JSON export.
      // localStorage autosave is independent of this flag.
      this.dirtyForExport = false;
    }

    // ---- Derived stats (recomputed every read; cheap) -------------------

    get maxHp() {
      return Balance.hero_base_hp + Balance.hero_hp_per_level * (this.level - 1);
    }

    get attack() {
      return Balance.hero_base_attack + Balance.hero_attack_per_level * (this.level - 1);
    }

    /** Element tier 0..3 based on player level. Tier ups happen at lvl 6,11,16. */
    get tier() {
      return Math.min(3, Math.floor((this.level - 1) / 5));
    }

    /** Display name of the player's current special move, e.g. "Fireball". */
    get specialName() {
      const el = this.activeElementData();
      return el.specials[this.tier];
    }

    /** Display emoji of the active element. */
    get activeEmoji() {
      return this.activeElementData().emoji;
    }

    activeElementData() {
      return Elements[ElementIndex[this.activeElement]];
    }

    // ---- Mutators -------------------------------------------------------

    setActive(elementKey) {
      if (!this.ownedElements.includes(elementKey)) {
        throw new Error(`Cannot activate unowned element: ${elementKey}`);
      }
      this.activeElement = elementKey;
      this.dirtyForExport = true;
    }

    /** Called when the player wins a fight. Returns info about what unlocked. */
    onVictory(wasBoss) {
      this.wins += 1;
      if (wasBoss) this.bossesBeaten += 1;
      this.level += 1;

      // Always heal between battles (per design).
      this.hp = this.maxHp;
      this.energy = 0;

      const result = { newTier: false, unlockableElement: false };

      // Detect tier-up (level just crossed a 5x boundary, ignoring lvl 1).
      // tier transitions occur when level hits 6, 11, 16.
      if ((this.level - 1) % 5 === 0 && this.level > 1) {
        result.newTier = true;
      }

      const canHaveMore = this.ownedElements.length < Elements.length;
      if (wasBoss && canHaveMore) {
        result.unlockableElement = true;
      }

      this.dirtyForExport = true;
      return result;
    }

    /** Called when the player loses. Restores HP for the retry. */
    onDefeat() {
      this.hp = this.maxHp;
      this.energy = 0;
      this.dirtyForExport = true;
    }

    /** Add a new element to the owned list. */
    grantElement(elementKey) {
      if (this.ownedElements.includes(elementKey)) return false;
      if (this.ownedElements.length >= Elements.length) return false;
      this.ownedElements.push(elementKey);
      this.dirtyForExport = true;
      return true;
    }

    // ---- Combat helpers used by battle.js -------------------------------

    takeDamage(amount) {
      this.hp = Math.max(0, this.hp - amount);
      this.dirtyForExport = true;
    }

    gainEnergy(amount) {
      this.energy = Math.min(Balance.special_energy_max, this.energy + amount);
      this.dirtyForExport = true;
    }

    spendEnergy(amount) {
      if (this.energy < amount) return false;
      this.energy -= amount;
      this.dirtyForExport = true;
      return true;
    }

    canSpecial() {
      return this.energy >= Balance.special_energy_cost;
    }

    hasShrineBlessing() {
      return this.shrineBlessing > 0;
    }

    isDefeated() {
      return this.hp <= 0;
    }

    /**
     * Move on the overworld map. Coordinates are clamped to a 10x10 grid.
     * Returns true if the position changed.
     */
    moveOnMap(dx, dy) {
      const nextX = Math.max(MAP_MIN, Math.min(MAP_MAX, this.mapX + Number(dx || 0)));
      const nextY = Math.max(MAP_MIN, Math.min(MAP_MAX, this.mapY + Number(dy || 0)));
      const moved = nextX !== this.mapX || nextY !== this.mapY;
      if (!moved) return false;
      this.mapX = nextX;
      this.mapY = nextY;
      this.dirtyForExport = true;
      return true;
    }

    grantShrineBlessing() {
      this.shrineBlessing = 1;
      this.dirtyForExport = true;
      return true;
    }

    consumeShrineBlessing() {
      if (this.shrineBlessing <= 0) return false;
      this.shrineBlessing -= 1;
      this.dirtyForExport = true;
      return true;
    }

    // ---- Serialization --------------------------------------------------

    /** Plain-data snapshot for saving (no methods). */
    toJSON() {
      return {
        heroName: this.heroName,
        ownedElements: this.ownedElements.slice(),
        activeElement: this.activeElement,
        level: this.level,
        wins: this.wins,
        bossesBeaten: this.bossesBeaten,
        hp: this.hp,
        energy: this.energy,
        mapX: this.mapX,
        mapY: this.mapY,
        shrineBlessing: this.shrineBlessing,
      };
    }

    /**
     * Restore from a snapshot. Tolerant of missing keys (older saves) and
     * defensive against corrupted ones — unknown element keys are dropped,
     * numeric fields clamped, so a malformed save can never produce a
     * GameState that crashes the rest of the game.
     */
    static fromJSON(data) {
      // Default element falls back to the first element defined in the
      // YAML. We avoid a hardcoded "fire" string so changes to the data
      // file's order don't quietly create invalid states.
      const defaultElement = Elements[0].key;

      // Drop any element keys we don't recognize (could happen if a save
      // was made with an older/newer game where element X existed).
      const known = (key) => key in ElementIndex;
      const owned = Array.isArray(data.ownedElements)
        ? data.ownedElements.filter(known)
        : [];

      const active = known(data.activeElement)
        ? data.activeElement
        : (owned[0] || defaultElement);

      // Ensure active is in owned. Avoids the impossible "active is X but
      // X isn't in your owned list" state if the save was hand-edited.
      if (!owned.includes(active)) owned.unshift(active);

      const s = new GameState(
        typeof data.heroName === "string" && data.heroName ? data.heroName : "Hero",
        active,
      );
      s.ownedElements = owned;
      s.activeElement = active;

      // Numeric clamps: Math.max guards against negatives, Math.min keeps
      // HP/energy within current balance. `|0` would also coerce but it
      // truncates to 32-bit ints which is more surprising than clamping.
      s.level = Math.max(1, Number(data.level) || 1);
      s.wins = Math.max(0, Number(data.wins) || 0);
      s.bossesBeaten = Math.max(0, Number(data.bossesBeaten) || 0);
      s.hp = Math.max(0, Math.min(
        data.hp != null ? Number(data.hp) : s.maxHp,
        s.maxHp,
      ));
      s.energy = Math.max(0, Math.min(
        Number(data.energy) || 0,
        Balance.special_energy_max,
      ));
      const parsedX = Number(data.mapX);
      const parsedY = Number(data.mapY);
      s.mapX = Math.max(MAP_MIN, Math.min(MAP_MAX, Number.isFinite(parsedX) ? parsedX : MAP_CENTER));
      s.mapY = Math.max(MAP_MIN, Math.min(MAP_MAX, Number.isFinite(parsedY) ? parsedY : MAP_CENTER));
      s.shrineBlessing = Math.max(0, Math.min(1, Number(data.shrineBlessing) || 0));

      s.dirtyForExport = false;
      return s;
    }
  }

  // ---- Helpers exported alongside the class -----------------------------

  /** Is the given level a boss level? (every 5th level: 5, 10, 15, ...) */
  function isBossLevel(level) {
    return level % 5 === 0;
  }

  root.GameState = GameState;
  root.GameRules = { isBossLevel, MAP_SIZE, MAP_MIN, MAP_MAX, MAP_CENTER };
})(window);
