/* ============================================================================
 * coach.js — Inline coaching tips for new players.
 *
 * During the first 5 levels we show small dismissible help banners that
 * teach the game one concept at a time. Each tip has:
 *
 *   id:      stable id, used in localStorage to track "dismissed" state.
 *   when(s): predicate (game state -> bool) deciding if the tip applies right now.
 *   render:  returns the HTML body for the tip.
 *
 * The first matching tip is shown on each render. Once a tip is dismissed
 * by the player, it never reappears for that browser. After level 10 the
 * coach goes silent — by then the player has the basics.
 * ========================================================================== */

(function (root) {
  "use strict";

  const Storage = window.GameStorage;
  // Storage key (without the global namespace prefix — GameStorage adds it).
  const STORAGE_KEY = "coach:dismissed:v1";
  // Coach goes silent above this level. By then a player has the basics.
  const MAX_LEVEL = 5;

  // ---- Dismissal persistence ------------------------------------------

  /** Load the set of dismissed tip IDs. Returns an empty Set if none stored. */
  function loadDismissed() {
    const arr = Storage.read(STORAGE_KEY);
    return new Set(Array.isArray(arr) ? arr : []);
  }

  function saveDismissed(set) {
    Storage.write(STORAGE_KEY, Array.from(set));
  }

  // ---- Tip definitions -------------------------------------------------
  //
  // Order matters: the first tip whose `when()` returns true and that
  // hasn't been dismissed yet is shown. Tips are scoped by `screen` so
  // hub-only and battle-only advice doesn't bleed across.

  const TIPS = [
    // ----- Hub screen tips -------------------------------------------
    {
      id: "hub-welcome",
      screen: "hub",
      when: (s) => s.level === 1 && s.wins === 0,
      render: (s) => `
        <strong>Welcome, ${escapeHtml(s.heroName)}!</strong> This is your hub.
        From here you start battles, see your level, and switch elements
        once you have more than one. Tap <strong>Start Battle</strong>
        when you're ready.`,
    },
    {
      id: "hub-after-first-win",
      screen: "hub",
      when: (s) => s.level === 2 && s.wins >= 1,
      render: () => `
        <strong>Great job!</strong> You won your first battle and your HP
        refilled automatically. Keep going — every 5 levels you'll meet a
        boss who unlocks a new element when you beat them.`,
    },
    {
      id: "hub-pre-boss",
      screen: "hub",
      when: (s) => s.level === 5,
      render: () => `
        <strong>Boss alert!</strong> The next battle is a boss. Bosses are
        tougher, but they tell you their element so you can prepare.
        Right now you only have one element — just fight your best!`,
    },
    {
      id: "hub-multi-element",
      screen: "hub",
      when: (s) => s.ownedElements.length >= 2 && s.level <= MAX_LEVEL + 5,
      render: () => `
        <strong>Element switcher unlocked!</strong> Tap any of the chips
        above to swap your active element. If a boss uses fire, switching
        to water makes it much easier.`,
    },

    // ----- Battle screen tips ---------------------------------------
    {
      id: "battle-attack-explanation",
      screen: "battle",
      when: (s) => s.level === 1 && s.wins === 0,
      render: () => `
        <strong>Your first fight!</strong> Tap <strong>⚔ Attack</strong> to
        hit the enemy. Each attack also fills your purple energy bar,
        which you'll need for special moves.`,
    },
    {
      id: "battle-special-explanation",
      screen: "battle",
      when: (s) => s.level <= 3 && s.canSpecial(),
      render: (s) => `
        <strong>Energy full enough!</strong> Tap <strong>✨ ${escapeHtml(s.specialName)}</strong>
        for a powerful attack that does double damage. The button glows
        when it's ready.`,
    },
    {
      id: "battle-defend-explanation",
      screen: "battle",
      when: (s) => s.level <= 3 && s.hp <= s.maxHp * 0.4,
      render: () => `
        <strong>HP getting low!</strong> Tap <strong>🛡 Defend</strong>
        to cut the next hit in half. You still gain a little energy, too.`,
    },
    {
      id: "battle-super-effective",
      screen: "battle",
      when: (s, ctx) => ctx && ctx.battle && ctx.battle.isSuperEffective(),
      render: (s, ctx) => `
        <strong>Super effective!</strong> Your ${escapeHtml(s.activeElementData().name)}
        beats this enemy's element. Your attacks will hit harder than usual.`,
    },
    {
      id: "battle-neutral-mob",
      screen: "battle",
      when: (s, ctx) => ctx && ctx.battle && ctx.battle.enemy.isNeutral && s.level <= MAX_LEVEL + 5,
      render: () => `
        <strong>No element here.</strong> This enemy doesn't have an
        element, so no super-effective bonus applies. Just hit hard!`,
    },
  ];

  // ---- Public API -----------------------------------------------------

  function pickTip(screen, state, ctx) {
    if (!state || state.level > MAX_LEVEL + 5) return null;
    const dismissed = loadDismissed();
    for (const tip of TIPS) {
      if (tip.screen !== screen) continue;
      if (dismissed.has(tip.id)) continue;
      try {
        if (tip.when(state, ctx)) return tip;
      } catch (e) {
        // A buggy `when` shouldn't crash the game — skip and keep going.
        console.warn("coach: error evaluating tip", tip.id, e);
      }
    }
    return null;
  }

  function dismiss(id) {
    const set = loadDismissed();
    set.add(id);
    saveDismissed(set);
  }

  /**
   * Render a coach tip into the given container element. If `state` has no
   * applicable tip, the container is hidden. If the same tip is already
   * shown in the container, this is a no-op (avoids visible flicker when
   * the same tip applies across multiple turns).
   */
  function render(container, screen, state, ctx) {
    if (!container) return;
    const tip = pickTip(screen, state, ctx);

    // Idempotency: if the same tip is already showing, leave the existing
    // DOM alone. This matters because UI re-renders the coach on every
    // state change; without this guard we'd reflow on every turn.
    const currentId = container.firstElementChild
      ? container.firstElementChild.getAttribute("data-tip-id")
      : null;
    if (tip && currentId === tip.id) return;

    if (!tip) {
      container.innerHTML = "";
      container.style.display = "none";
      return;
    }
    container.style.display = "";
    container.innerHTML = `
      <div class="coach-tip" data-tip-id="${escapeHtml(tip.id)}">
        <span class="coach-tip__icon" aria-hidden="true">💡</span>
        <div class="coach-tip__body">${tip.render(state, ctx)}</div>
        <button class="coach-tip__close" aria-label="Dismiss tip">×</button>
      </div>
    `;
    const closeBtn = container.querySelector(".coach-tip__close");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        dismiss(tip.id);
        // Re-render in case another tip applies right now.
        render(container, screen, state, ctx);
      });
    }
  }

  /** Reset all dismissals — used by Reset Game so a new playthrough sees tips again. */
  function reset() {
    Storage.remove(STORAGE_KEY);
  }

  // Tiny HTML escaper for any user-controlled text we splice into tip HTML.
  function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  root.Coach = { render, reset, pickTip, dismiss, _TIPS: TIPS };
})(window);
