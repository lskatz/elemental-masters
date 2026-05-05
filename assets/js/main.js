/* ============================================================================
 * main.js — Entry point. Wires state, battle, save, and UI together.
 *
 * The Game object is a small state machine:
 *   title -> [new game] -> element-select -> hub
 *   title -> [continue] -> hub
 *   hub   -> battle  -> victory  -> hub  (or element-select on unlock)
 *                    -> defeat   -> battle (retry same level)
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
        goToHub();
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
    goToHub();
  }

  function importSaveFile(file) {
    Save.importFromFile(file)
      .then(loaded => {
        state = loaded;
        autosave("Save imported!");
        goToHub();
      })
      .catch(err => {
        window.UI.toast(err.message || "Could not load save.", "error");
      });
  }

  function goToHub() {
    currentBattle = null;
    window.UI.renderHub({
      state,
      onStartBattle: enterBattle,
      onSwitchElement: (key) => {
        state.setActive(key);
        autosave();
        goToHub();
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

  function enterBattle() {
    currentBattle = new window.Battle(state);
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
                goToHub();
              },
            });
          } else {
            goToHub();
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

  // ---- Helpers ---------------------------------------------------------

  function autosave(toastMessage) {
    if (!state) return;
    const ok = Save.saveToLocal(state);
    if (toastMessage && ok) window.UI.toast(toastMessage, "success");
  }

  function ordinal(n) {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
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
