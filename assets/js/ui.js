/* ============================================================================
 * ui.js — All DOM rendering and screen transitions
 *
 * The game has these screens, each a top-level <section class="screen">:
 *   #screen-title      — name input, new/load/import
 *   #screen-element    — element picker (start + unlock)
 *   #screen-map        — overworld exploration and landmarks
 *   #screen-boss-intro — pre-fight boss reveal with hint
 *   #screen-battle     — turn-based combat
 *   #screen-victory    — post-win results
 *   #screen-defeat     — try-again screen
 *
 * Only one screen is visible at a time (.screen.is-active).
 *
 * UI is event-driven for battles: events from battle.js are queued and
 * played back with delays so animations have time to breathe.
 * ========================================================================== */

(function (root) {
  "use strict";

  const Elements = window.GameData.elements;
  const ElementIndex = window.GameData.elementIndex;
  const Balance = window.GameData.balance;
  const Rules = window.GameRules;

  // Tiny querySelector helpers, scoped to optional root element.
  const $ = (sel, scope) => (scope || document).querySelector(sel);
  const $$ = (sel, scope) => Array.from((scope || document).querySelectorAll(sel));

  // ---- Tunables ----------------------------------------------------------
  // Animation pacing — feels good on phones without dragging.
  const STEP_DELAY = 550;       // ms between battle events
  const SHAKE_DURATION = 400;   // ms
  const FLASH_DURATION = 600;   // ms
  const FLOAT_DURATION = 1000;  // ms — damage number lifetime
  const END_PAUSE = 400;        // ms — pause before screen transition on battle end
  const MAP_TRANSITION_DURATION = 900; // ms
  const TOAST_DURATION = 2400;  // ms — toast on-screen lifetime
  const TOAST_FADE = 300;       // ms — toast fade-out before removal
  const LOG_MAX_LINES = 50;     // cap battle-log size to avoid unbounded growth

  // ---- Timer registry ----------------------------------------------------
  // Battle animations chain `setTimeout`s. If the player resets the game or
  // imports a save mid-battle, the chain would otherwise keep firing against
  // a stale `state`/`battle` and could call `onEnd` on a finished session.
  // We track every timer here and provide `_clearAllTimers()` to cancel them
  // on screen change.
  const _timers = new Set();
  function _setTimeout(fn, ms) {
    const id = setTimeout(() => {
      _timers.delete(id);
      fn();
    }, ms);
    _timers.add(id);
    return id;
  }
  function _clearAllTimers() {
    for (const id of _timers) clearTimeout(id);
    _timers.clear();
  }

  const UI = {
    // ---- Screen routing ---------------------------------------------

    showScreen(id) {
      // Cancel any in-flight timers from a previous screen — primarily
      // mid-battle animation chains. Without this a reset-during-battle
      // would let stale callbacks fire against a fresh game state.
      _clearAllTimers();
      $$(".screen").forEach(s => s.classList.remove("is-active"));
      const target = document.getElementById(id);
      if (target) target.classList.add("is-active");
      // Always scroll to top when changing screens — important on phones.
      window.scrollTo(0, 0);

      // Move keyboard focus to the new screen's primary action so a
      // screen reader announces it and a keyboard user can act without
      // re-tabbing. We try a small set of likely candidates and fall back
      // to the screen container itself.
      if (target) {
        const focusTarget = target.querySelector(
          "[data-autofocus], input:not([type=hidden]):not([disabled]), " +
          "button.btn--primary:not([disabled]), button:not([disabled])"
        );
        if (focusTarget) {
          // requestAnimationFrame so the focus call doesn't race with the
          // .is-active class change (some browsers won't focus a hidden el).
          requestAnimationFrame(() => focusTarget.focus({ preventScroll: true }));
        }
      }
    },

    // ---- Title screen ----------------------------------------------

    renderTitle({ hasSave, onNewGame, onContinue, onImport }) {
      const versionEl = document.getElementById("title-version-num");
      if (versionEl) versionEl.textContent = window.GameData.version;

      const continueBtn = $("#btn-continue");
      continueBtn.disabled = !hasSave;
      continueBtn.classList.toggle("is-disabled", !hasSave);

      $("#btn-new-game").onclick = () => {
        // Sanitize the name: strip control characters (which would break
        // file-export filenames and look weird in the UI), trim whitespace,
        // and cap length even if maxlength was bypassed.
        const raw = $("#hero-name-input").value || "";
        const name = raw
          .replace(/[\x00-\x1f\x7f]/g, "")  // strip control chars
          .trim()
          .slice(0, 16) || "Hero";
        onNewGame(name);
      };
      continueBtn.onclick = () => {
        if (!hasSave) return;
        onContinue();
      };
      $("#import-file").onchange = (e) => {
        const file = e.target.files[0];
        if (file) onImport(file);
        e.target.value = ""; // allow re-selecting the same file later
      };
      this.showScreen("screen-title");
    },

    // ---- Element select (initial pick OR unlock) -------------------

    renderElementSelect({ title, subtitle, owned, onPick, allowedKeys }) {
      $("#element-title").textContent = title;
      $("#element-subtitle").textContent = subtitle;

      const grid = $("#element-grid");
      grid.innerHTML = "";
      Elements.forEach(el => {
        const ownedAlready = owned.includes(el.key);
        const allowed = !allowedKeys || allowedKeys.includes(el.key);
        const btn = document.createElement("button");
        btn.className = `element-card element-card--${el.key}`;
        btn.disabled = ownedAlready || !allowed;
        if (ownedAlready) btn.classList.add("is-owned");
        if (!allowed && !ownedAlready) btn.classList.add("is-locked");
        btn.style.setProperty("--element-color", el.color);
        btn.style.setProperty("--element-color-dark", el.color_dark);
        // Accessible label that includes status. The visual emoji is
        // aria-hidden because it's redundant with the element name; without
        // hiding it, a screen reader would announce both the emoji name
        // (e.g. "fire") and the element name ("Fire"), which is noisy.
        btn.setAttribute(
          "aria-label",
          ownedAlready ? `${el.name} (already owned)` :
          !allowed ? `${el.name} (locked)` :
          `Choose ${el.name}`
        );
        btn.innerHTML = `
          <span class="element-card__emoji" aria-hidden="true">${el.emoji}</span>
          <span class="element-card__name">${el.name}</span>
          ${ownedAlready ? '<span class="element-card__badge">Owned</span>' : ""}
        `;
        btn.onclick = () => onPick(el.key);
        grid.appendChild(btn);
      });
      this.showScreen("screen-element");
    },

    // ---- Overworld map ----------------------------------------------

    renderMap({
      state,
      landmarks,
      onMove,
      onChallengeBoss,
      onBlessAtShrine,
      onSwitchElement,
      onExport,
      onReset,
    }) {
      $("#map-hero-name").textContent = state.heroName;
      $("#map-level").textContent = state.level;
      $("#map-wins").textContent = state.wins;

      // Active element display
      const activeEl = state.activeElementData();
      $("#map-active-emoji").textContent = activeEl.emoji;
      $("#map-active-name").textContent = activeEl.name;
      $("#map-special-name").textContent = state.specialName;
      $("#map-tier").textContent = `Tier ${state.tier + 1}`;

      // Owned-elements switcher (only shows if >1 element owned)
      const switcher = $("#map-element-switcher");
      switcher.innerHTML = "";
      if (state.ownedElements.length > 1) {
        switcher.classList.remove("is-hidden");
        state.ownedElements.forEach(key => {
          const el = Elements[ElementIndex[key]];
          const btn = document.createElement("button");
          btn.className = "element-chip";
          const isActive = key === state.activeElement;
          btn.classList.toggle("is-active", isActive);
          btn.setAttribute("aria-pressed", isActive ? "true" : "false");
          btn.setAttribute(
            "aria-label",
            isActive ? `${el.name} (current element)` : `Switch to ${el.name}`
          );
          btn.style.setProperty("--element-color", el.color);
          btn.innerHTML = `<span aria-hidden="true">${el.emoji}</span><span>${el.name}</span>`;
          btn.onclick = () => onSwitchElement(key);
          switcher.appendChild(btn);
        });
      } else {
        switcher.classList.add("is-hidden");
      }

      const landmarkAt = (x, y) => {
        if (x === landmarks.shrine.x && y === landmarks.shrine.y) return "shrine";
        if (x === landmarks.wildlands.x && y === landmarks.wildlands.y) return "wildlands";
        if (x === landmarks.boss.x && y === landmarks.boss.y) return "boss";
        return null;
      };
      const danger = Math.max(
        0,
        3 - Math.min(3, Math.abs(state.mapX - landmarks.boss.x) + Math.abs(state.mapY - landmarks.boss.y))
      );
      const grid = $("#map-grid");
      grid.innerHTML = "";
      for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 3; x++) {
          const tile = document.createElement("div");
          tile.className = "map-tile";
          const lm = landmarkAt(x, y);
          if (lm) tile.classList.add(`is-${lm}`);
          if (state.mapX === x && state.mapY === y) tile.classList.add("is-player");
          const lmLabel = lm === "shrine" ? "Shrine"
            : lm === "wildlands" ? "Wildlands"
            : lm === "boss" ? "Boss Arena"
            : "";
          tile.innerHTML = `
            <span class="map-tile__landmark">${lmLabel}</span>
            <span class="map-tile__player" aria-hidden="true">${state.mapX === x && state.mapY === y ? "🧙" : ""}</span>
          `;
          grid.appendChild(tile);
        }
      }

      const currentLandmark = landmarkAt(state.mapX, state.mapY);
      const locationName = $("#map-location-name");
      const dangerEl = $("#map-danger");
      const actionBtn = $("#btn-map-action");
      const shrineChart = $("#shrine-chart");

      const isBossTime = Rules.isBossLevel(state.level);
      if (currentLandmark === "shrine") {
        locationName.textContent = "⛩️ Elemental Shrine";
        dangerEl.textContent = state.hasShrineBlessing()
          ? "Blessing ready: your next battle deals bonus damage."
          : "Receive a blessing to empower your next battle.";
        actionBtn.textContent = "✨ Receive Shrine Blessing";
        actionBtn.classList.remove("is-hidden");
        actionBtn.classList.remove("is-boss");
        actionBtn.disabled = false;
        actionBtn.onclick = onBlessAtShrine;
        shrineChart.classList.remove("is-hidden");
        const chartRows = Elements.map(el => {
          const weak = Elements[ElementIndex[el.weakness]];
          return `<li>${el.emoji} ${el.name} → weak to ${weak.emoji} ${weak.name}</li>`;
        }).join("");
        shrineChart.innerHTML = `
          <h3>Shrine Lore: Element Weaknesses</h3>
          <ul class="shrine-chart-list">
            ${chartRows}
          </ul>
        `;
      } else {
        shrineChart.classList.add("is-hidden");
        shrineChart.innerHTML = "";
        if (currentLandmark === "boss") {
          locationName.textContent = "🏛️ Boss Arena";
          dangerEl.textContent = isBossTime
            ? "The current boss is waiting."
            : "No boss is here yet. Win battles to reach the next boss level.";
          actionBtn.textContent = `⚔️ ${isBossTime ? "Challenge Boss" : "Boss Not Ready"}`;
          actionBtn.classList.remove("is-hidden");
          actionBtn.classList.toggle("is-boss", isBossTime);
          actionBtn.disabled = !isBossTime;
          actionBtn.onclick = onChallengeBoss;
        } else {
          actionBtn.classList.add("is-hidden");
          actionBtn.classList.remove("is-boss");
          actionBtn.disabled = false;
          locationName.textContent = currentLandmark === "wildlands"
            ? "🌲 The Wildlands"
            : "🗺️ Open Terrain";
          dangerEl.textContent = currentLandmark === "wildlands"
            ? `Mob activity high. Danger tier ${danger}/3.`
            : `Roaming zone. Danger tier ${danger}/3 (higher near the Boss Arena).`;
        }
      }

      $("#btn-move-up").onclick = () => onMove(0, -1);
      $("#btn-move-down").onclick = () => onMove(0, 1);
      $("#btn-move-left").onclick = () => onMove(-1, 0);
      $("#btn-move-right").onclick = () => onMove(1, 0);

      $("#btn-export").onclick = onExport;
      $("#btn-reset").onclick = onReset;

      // Show a coaching tip if one applies for the current state.
      // Coach is optional — guard so the UI still works if the script
      // failed to load for any reason.
      if (window.Coach) {
        window.Coach.render($("#map-coach"), "hub", state);
      }

      this.showScreen("screen-map");
    },

    renderEncounterTransition({ enemy, onContinue }) {
      const emoji = $("#transition-enemy-emoji");
      const name = $("#transition-enemy-name");
      const avatar = $(".map-transition__avatar");
      if (emoji) {
        emoji.textContent = enemy.emoji;
        emoji.style.setProperty("--element-color", enemy.color);
      }
      if (avatar) avatar.style.setProperty("--element-color", enemy.color);
      if (name) name.textContent = enemy.name;
      this.showScreen("screen-transition");
      _setTimeout(() => onContinue(), MAP_TRANSITION_DURATION);
    },

    // ---- Boss intro -------------------------------------------------

    renderBossIntro({ enemy, weaknessEl, playerHas, onContinue }) {
      $("#boss-intro-title").textContent = enemy.name;
      $("#boss-intro-emoji").textContent = enemy.emoji;
      $("#boss-intro-emoji").style.setProperty("--element-color", enemy.color);

      const hint = $("#boss-intro-hint");
      const hintText = playerHas
        ? `This boss uses ${this._elName(enemy.element)} ${enemy.emoji}. ` +
          `Try fighting with ${weaknessEl.name} ${weaknessEl.emoji} — it's super effective!`
        : `This boss uses ${this._elName(enemy.element)} ${enemy.emoji}. ` +
          `${weaknessEl.name} ${weaknessEl.emoji} would beat it — but you don't have that element yet. Fight carefully!`;
      hint.textContent = hintText;

      $("#btn-boss-continue").onclick = onContinue;
      this.showScreen("screen-boss-intro");
    },

    _elName(key) {
      return Elements[ElementIndex[key]].name;
    },

    // ---- Battle screen ----------------------------------------------

    renderBattle({ state, battle, onEnd }) {
      // Ensure buttons are never carried over in a locked state from a
      // previous battle's end-of-turn animation.
      this._setActionsLocked(false);

      // Hero panel
      $("#battle-hero-name").textContent = state.heroName;
      $("#battle-hero-emoji").textContent = state.activeEmoji;
      this._setBar("#battle-hero-hp", state.hp, state.maxHp);
      this._setBar("#battle-hero-energy", state.energy, Balance.special_energy_max);

      // Enemy panel
      $("#battle-enemy-name").textContent = battle.enemy.name;
      $("#battle-enemy-emoji").textContent = battle.enemy.emoji;
      $("#battle-enemy-emoji").style.setProperty("--element-color", battle.enemy.color);
      this._setBar("#battle-enemy-hp", battle.enemy.hp, battle.enemy.maxHp);

      // Show "BOSS" tag if applicable
      $("#battle-boss-tag").classList.toggle("is-hidden", !battle.enemy.isBoss);

      // Buttons
      $("#btn-attack").onclick = () => this._takeTurn(battle, () => battle.playerAttack(), { state, onEnd });
      $("#btn-special").onclick = () => this._takeTurn(battle, () => battle.playerSpecial(), { state, onEnd });
      $("#btn-defend").onclick = () => this._takeTurn(battle, () => battle.playerDefend(), { state, onEnd });

      // Special button shows the current special name and disables when low energy
      $("#btn-special-label").textContent = state.specialName;
      this._refreshActionButtons(state);

      // Reset log
      $("#battle-log").innerHTML = "";
      this._log(`A wild ${battle.enemy.name} appears!`);
      if (battle._shrineBlessed) {
        this._log("✨ Shrine blessing empowers your attacks in this fight.");
      }

      // Coach tip — rendered with battle context so super-effective and
      // neutral-mob hints can fire.
      if (window.Coach) {
        window.Coach.render($("#battle-coach"), "battle", state, { battle });
      }

      this.showScreen("screen-battle");
    },

    _refreshActionButtons(state) {
      const specialBtn = $("#btn-special");
      const ready = state.canSpecial();
      specialBtn.disabled = !ready;
      specialBtn.classList.toggle("is-ready", ready);
    },

    /** Run a player action: collect events from battle, play them with delays. */
    _takeTurn(battle, action, { state, onEnd }) {
      // Lock buttons during animation playback
      this._setActionsLocked(true);
      const events = action();
      this._playEvents(events, 0, () => {
        this._refreshActionButtons(state);
        // Re-evaluate the coach: energy may have filled, HP may have dropped,
        // a new tip might now apply.
        if (window.Coach && !battle._ended) {
          window.Coach.render($("#battle-coach"), "battle", state, { battle });
        }
        // If the battle ended, the "end" event handler in _applyEvent will
        // have called onEnd already — nothing more to do here.
        if (!battle._ended) {
          this._setActionsLocked(false);
        }
      }, { state, battle, onEnd });
    },

    _playEvents(events, i, done, ctx) {
      if (i >= events.length) { done(); return; }
      this._applyEvent(events[i], ctx);
      _setTimeout(() => this._playEvents(events, i + 1, done, ctx), STEP_DELAY);
    },

    _applyEvent(ev, ctx) {
      const { state, battle, onEnd } = ctx;
      switch (ev.type) {
        case "log":
          this._log(ev.text);
          break;

        case "damage": {
          const target = ev.target === "hero" ? "hero" : "enemy";
          const sel = target === "hero" ? "#battle-hero-card" : "#battle-enemy-card";
          this._shake(sel, ev.super);
          this._floatNumber(sel, ev.amount, ev.super, ev.defended);
          if (target === "hero") {
            this._setBar("#battle-hero-hp", state.hp, state.maxHp);
            this._log(
              ev.defended
                ? `Blocked! Took only ${ev.amount} damage.`
                : `Took ${ev.amount} damage.`
            );
          } else {
            this._setBar("#battle-enemy-hp", battle.enemy.hp, battle.enemy.maxHp);
            this._log(
              ev.super
                ? `Super effective! ${ev.amount} damage!`
                : `Dealt ${ev.amount} damage.`
            );
          }
          break;
        }

        case "energy":
          this._setBar("#battle-hero-energy", state.energy, Balance.special_energy_max);
          break;

        case "special":
          this._log(`✨ ${ev.name} unleashed!`);
          this._flash("#battle-board");
          break;

        case "end":
          // Tiny pause before the screen transition feels less abrupt.
          _setTimeout(() => onEnd(ev.winner, ev.wasBoss), END_PAUSE);
          break;
      }
    },

    _setActionsLocked(locked) {
      $$(".action-btn").forEach(b => {
        b.classList.toggle("is-locked", locked);
        b.disabled = locked;
      });
    },

    _setBar(sel, current, max) {
      const root = $(sel);
      if (!root) return;
      const pct = max > 0 ? Math.max(0, Math.min(100, (current / max) * 100)) : 0;
      $(".bar__fill", root).style.width = pct + "%";
      const label = $(".bar__label", root);
      if (label) label.textContent = `${current} / ${max}`;
    },

    _shake(sel, big) {
      const el = $(sel);
      if (!el) return;
      el.classList.remove("is-hit", "is-hit-big");
      // Force reflow so the class re-add re-triggers the animation.
      void el.offsetWidth;
      el.classList.add(big ? "is-hit-big" : "is-hit");
      _setTimeout(() => el.classList.remove("is-hit", "is-hit-big"), SHAKE_DURATION);
    },

    _flash(sel) {
      const el = $(sel);
      if (!el) return;
      el.classList.remove("is-flashing");
      void el.offsetWidth;
      el.classList.add("is-flashing");
      _setTimeout(() => el.classList.remove("is-flashing"), FLASH_DURATION);
    },

    _floatNumber(targetSel, amount, isSuper, defended) {
      const target = $(targetSel);
      if (!target) return;
      const num = document.createElement("span");
      num.className = "damage-number";
      if (isSuper) num.classList.add("is-super");
      if (defended) num.classList.add("is-defended");
      num.textContent = `-${amount}`;
      target.appendChild(num);
      _setTimeout(() => num.remove(), FLOAT_DURATION);
    },

    _log(text) {
      const log = $("#battle-log");
      if (!log) return;
      const line = document.createElement("div");
      line.className = "log-line";
      line.textContent = text;
      log.appendChild(line);
      // Cap log size: long fights would otherwise accumulate hundreds of
      // <div>s. Removing the oldest is cheap enough — done each turn.
      while (log.childElementCount > LOG_MAX_LINES) {
        log.removeChild(log.firstElementChild);
      }
      // Auto-scroll to bottom
      log.scrollTop = log.scrollHeight;
    },

    // ---- Victory / Defeat -------------------------------------------

    renderVictory({ state, wasBoss, unlocking, onContinue }) {
      $("#victory-title").textContent = wasBoss ? "BOSS DEFEATED!" : "Victory!";
      $("#victory-level").textContent = state.level;
      $("#victory-wins").textContent = state.wins;
      $("#victory-message").textContent = unlocking
        ? "You earned a new element!"
        : (wasBoss ? "You vanquished the master!" : "Onward to the next battle!");
      $("#btn-victory-continue").textContent = unlocking
        ? "Choose New Element →"
        : "Continue →";
      $("#btn-victory-continue").onclick = onContinue;
      this.showScreen("screen-victory");
    },

    renderDefeat({ enemy, onRetry }) {
      $("#defeat-enemy-name").textContent = enemy.name;
      $("#btn-defeat-retry").onclick = onRetry;
      this.showScreen("screen-defeat");
    },

    // ---- Toasts (for save confirmation, errors, etc.) ---------------

    toast(text, kind) {
      const t = document.createElement("div");
      t.className = "toast";
      if (kind) t.classList.add(`toast--${kind}`);
      t.textContent = text;
      document.body.appendChild(t);
      // Trigger fade-in then schedule removal. Toasts intentionally use
      // raw setTimeout (not _setTimeout) so a "Saved!" confirmation keeps
      // showing across screen transitions.
      requestAnimationFrame(() => t.classList.add("is-visible"));
      setTimeout(() => {
        t.classList.remove("is-visible");
        setTimeout(() => t.remove(), TOAST_FADE);
      }, TOAST_DURATION);
    },

    confirm(message) {
      // Use native confirm for now — keeps the project dependency-free and
      // gives the kid a familiar OS dialog that's hard to dismiss accidentally.
      return window.confirm(message);
    },
  };

  root.UI = UI;
})(window);
