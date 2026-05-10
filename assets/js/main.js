/* ============================================================================
 * main.js — Entry point. Wires state, battle, save, and UI together.
 *
 * The Game object is a small state machine:
 *   title -> [new game] -> element-select -> map
 *   title -> [continue] -> map
 *   map   -> [encounter] -> battle  -> victory  -> map  (or element-select on unlock)
 *                            └──────> defeat   -> battle (retry same level)
 *
 * `currentBattle` holds the in-progress Battle (so retries can rebuild it).
 * ========================================================================== */

(function () {
  "use strict";

  const Save = window.GameSave;

  /** The single live game state. Null when on the title screen. */
  let state = null;
  /** The active Battle, or null when not in combat. */
  let currentBattle = null;
  const LANDMARKS = {
    shrine: { x: 0, y: 0 },
    wildlands: { x: 0, y: 2 },
    boss: { x: 2, y: 2 },
  };
  const ENCOUNTER_TYPES = {
    BOSS_NOT_READY: "boss_not_ready",
  };

  // ---- Boot ------------------------------------------------------------

  function boot() {
    showTitle();
    installBeforeUnloadGuard();
  }

  function showTitle() {
    state = null;
    currentBattle = null;
    window.UI.renderTitle({
      hasSave: Save.hasLocalSave(),
      onNewGame: startNewGame,
      onContinue: continueGame,
      onImport: importSaveFile,
    });
  }

  // ---- Top-level flows -------------------------------------------------

  function startNewGame(name) {
    // Show element-select with no owned elements yet.
    window.UI.renderElementSelect({
      title: "Choose Your Element",
      subtitle: `Welcome, ${name}! Pick the element you'll start with.`,
      owned: [],
      onPick: (elementKey) => {
        state = new window.GameState(name, elementKey);
        autosave("Game started!");
        goToMap();
      },
    });
  }

  function continueGame() {
    const loaded = Save.loadFromLocal();
    if (!loaded) {
      window.UI.toast("No save found.", "error");
      return;
    }
    state = loaded;
    goToMap();
  }

  function importSaveFile(file) {
    Save.importFromFile(file)
      .then(loaded => {
        state = loaded;
        autosave("Save imported!");
        goToMap();
      })
      .catch(err => {
        window.UI.toast(err.message || "Could not load save.", "error");
      });
  }

  function goToMap() {
    currentBattle = null;
    window.UI.renderMap({
      state,
      landmarks: LANDMARKS,
      onMove: (dx, dy) => {
        const moved = state.moveOnMap(dx, dy);
        if (!moved) return { moved: false };
        autosave();
        return {
          moved: true,
          onArrive: () => {
            if (isAtLandmark(state, LANDMARKS.shrine) && !state.hasShrineBlessing()) {
              state.grantShrineBlessing();
              autosave("The shrine grants a blessing.");
            }

            const encounter = rollEncounter(state);
            if (encounter) {
              if (encounter.type === ENCOUNTER_TYPES.BOSS_NOT_READY) {
                window.UI.toast("The Boss Arena is quiet for now.", "error");
                goToMap();
                return;
              }
              enterBattle({ withTransition: true, levelOffset: encounter.levelOffset });
              return;
            }
            goToMap();
          },
        };
      },
      onSwitchElement: (key) => {
        state.setActive(key);
        autosave();
        goToMap();
      },
      onExport: () => {
        const fname = Save.exportToFile(state);
        window.UI.toast(`Saved to ${fname}`, "success");
      },
      onReset: () => {
        if (window.UI.confirm(
          "Are you sure you want to start over? This deletes your saved game."
        )) {
          Save.clearLocal();
          // Reset coach dismissals too so the new playthrough sees the
          // intro tips again.
          if (window.Coach) window.Coach.reset();
          showTitle();
        }
      },
    });
  }

  function enterBattle(options) {
    const opts = options || {};
    currentBattle = new window.Battle(state, { levelOffset: opts.levelOffset || 0 });
    const begin = () => {
      if (currentBattle.enemy.isBoss) {
        const wKey = currentBattle.weaknessKey();
        const wEl = window.GameData.elements[window.GameData.elementIndex[wKey]];
        window.UI.renderBossIntro({
          enemy: currentBattle.enemy,
          weaknessEl: wEl,
          playerHas: currentBattle.playerHasWeakness(),
          onContinue: showBattleScreen,
        });
      } else {
        showBattleScreen();
      }
    };
    if (opts.withTransition) {
      window.UI.renderEncounterTransition({
        enemy: currentBattle.enemy,
        onContinue: begin,
      });
      return;
    }
    begin();
  }

  function showBattleScreen() {
    window.UI.renderBattle({
      state,
      battle: currentBattle,
      onEnd: handleBattleEnd,
    });
  }

  function handleBattleEnd(winner, wasBoss) {
    if (winner === "hero") {
      const result = state.onVictory(wasBoss);
      autosave();
      window.UI.renderVictory({
        state,
        wasBoss,
        unlocking: result.unlockableElement,
        onContinue: () => {
          if (result.unlockableElement) {
            // Let the player pick a new element (any not yet owned).
            window.UI.renderElementSelect({
              title: "New Element Unlocked!",
              subtitle: `Pick your ${ordinal(state.ownedElements.length + 1)} element.`,
              owned: state.ownedElements,
              onPick: (elementKey) => {
                state.grantElement(elementKey);
                autosave("New element unlocked!");
                goToMap();
              },
            });
          } else {
            goToMap();
          }
        },
      });
    } else {
      // Defeat — restore HP and go to retry screen.
      const enemyForDisplay = currentBattle.enemy;
      state.onDefeat();
      autosave();
      window.UI.renderDefeat({
        enemy: enemyForDisplay,
        onRetry: () => {
          // Build a fresh battle at the same level.
          enterBattle();
        },
      });
    }
  }

  function isAtLandmark(s, lm) {
    return s.mapX === lm.x && s.mapY === lm.y;
  }

  function rollEncounter(s) {
    if (isAtLandmark(s, LANDMARKS.shrine)) {
      return null;
    }
    if (isAtLandmark(s, LANDMARKS.boss)) {
      if (!window.GameRules.isBossLevel(s.level)) {
        return { type: ENCOUNTER_TYPES.BOSS_NOT_READY };
      }
      return { levelOffset: 0 };
    }
    const distanceToBoss = Math.abs(s.mapX - LANDMARKS.boss.x) + Math.abs(s.mapY - LANDMARKS.boss.y);
    const danger = Math.max(0, 3 - Math.min(3, distanceToBoss));
    const inWildlands = isAtLandmark(s, LANDMARKS.wildlands);
    const chance = Math.min(0.9, 0.18 + (danger * 0.14) + (inWildlands ? 0.22 : 0));
    if (Math.random() > chance) return null;
    return { levelOffset: Math.max(0, danger + (inWildlands ? 1 : 0)) };
  }

  // ---- Helpers ---------------------------------------------------------

  function autosave(toastMessage) {
    if (!state) return;
    const ok = Save.saveToLocal(state);
    if (toastMessage && ok) window.UI.toast(toastMessage, "success");
  }

  function ordinal(n) {
    const abs = Math.abs(n);
    const v = abs % 100;
    if (v >= 11 && v <= 13) return n + "th";
    switch (abs % 10) {
      case 1: return n + "st";
      case 2: return n + "nd";
      case 3: return n + "rd";
      default: return n + "th";
    }
  }

  /**
   * Warn the player if they leave the page after making changes since their
   * last JSON export. localStorage already has their progress, but if the
   * browser later clears storage, the JSON file is the only safety net.
   */
  function installBeforeUnloadGuard() {
    window.addEventListener("beforeunload", (e) => {
      if (state && state.dirtyForExport) {
        // Modern browsers ignore custom messages; setting returnValue
        // is what triggers the prompt.
        e.preventDefault();
        e.returnValue =
          "You have progress that hasn't been saved to a file yet. " +
          "Leave anyway?";
        return e.returnValue;
      }
    });
  }

  // ---- Kick off --------------------------------------------------------

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
