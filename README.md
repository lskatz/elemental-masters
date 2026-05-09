# Elemental Masters

A never-ending elemental battling game for the browser. Choose your element,
defeat enemies, fight a boss every five levels, and unlock new elements as
you go. Built as a Jekyll site with a tiny Python pre-build step.

🌐 **Live:** <https://lskatz.github.io/elemental-masters/>
📖 **Player guide:** <https://lskatz.github.io/elemental-masters/help/>

Installable as a PWA on phones (Add to Home Screen) for an offline-capable,
standalone-window experience.

---

## How to play (short version)

1. Pick a hero name and a starting element.
2. Explore the map to trigger mob fights, visit the Elemental Shrine, and
   approach the Boss Arena.
3. Every 5 levels you can challenge a **boss** — beat them to unlock a new
   element until you own the full set.
4. The game auto-saves to your browser. Use the **Save to File** button
   for a JSON backup.

For the full guide see [`help.md`](./help.md) (rendered at `/help/` on
the live site).

### Element weakness chart

| Element     | Beaten by   |
|-------------|-------------|
| 🔥 Fire     | 💧 Water    |
| 💧 Water    | 🔥 Fire     |
| 💨 Wind     | 🪨 Earth    |
| 🪨 Earth    | 💨 Wind     |
| ⚡ Lightning | 🌫️ Dust     |
| 🌫️ Dust     | ⚡ Lightning |
| ❄️ Ice      | 🌋 Lava     |
| 🌋 Lava     | ❄️ Ice      |
| 🌑 Darkness | 🧠 Psychic  |
| 🧠 Psychic  | 🌑 Darkness |
| ⚙️ Metal    | 🌬️ Air      |
| 🌬️ Air      | ⚙️ Metal    |
| 🌀 Vortex   | 🌀 Vortex   |

Most relationships are two-way mutual weaknesses (`A` beats `B`, and `B` beats `A`). Vortex is the exception because its weakness is itself (self-countering).

---

## Architecture

The game is a static Jekyll site plus a small Python pre-build step. The
runtime has zero JavaScript dependencies and no bundler — JS modules
communicate through `window`-level globals and load in a fixed order.

### Project layout

```
elemental-masters/
├── _config.yml             # Jekyll config (baseurl, semver)
├── _data/
│   └── elements.yml        # ★ Source of truth: elements, mobs, balance
├── _layouts/
│   ├── base.html           # HTML head/body wrapper; loads manifest + service worker
│   ├── game.html           # extends base; loads game JS
│   └── help.html           # extends base; help-page chrome
├── index.html              # Game-screen markup (uses `game` layout)
├── help.md                 # Player help page (uses `help` layout)
├── manifest.json           # PWA manifest (Liquid-processed)
├── service-worker.js       # Offline cache (Liquid-processed)
├── assets/
│   ├── css/style.scss      # Single mobile-first stylesheet
│   ├── icons/*.png         # ⚠ generated PWA icons, .gitignored
│   ├── js/
│   │   ├── storage.js      # Thin localStorage wrapper, namespaced keys
│   │   ├── state.js        # GameState class — pure logic, no DOM
│   │   ├── save.js         # autosave + JSON file export/import
│   │   ├── battle.js       # Turn-based combat, emits typed events
│   │   ├── coach.js        # Inline help banners for new players
│   │   ├── ui.js           # All DOM rendering and screen routing
│   │   ├── main.js         # Entry point, wires modules together
│   │   └── generated-data.js   # ⚠ generated, .gitignored
│   └── svg/elements/*.svg  # ⚠ generated, .gitignored
├── scripts/
│   ├── build.py            # Generates SVGs + JS data + PWA icons from YAML
│   └── check_size.py       # Performance-budget enforcer for CI
├── tests/
│   ├── test_build.py            # pytest unit tests for build.py
│   ├── test_svg_snapshots.py    # SVG visual-regression tests
│   ├── snapshots/baseline.json  # Hashes of approved SVG renderings
│   └── js/
│       ├── _harness.js     # VM-based test harness for game JS
│       ├── storage.test.js
│       ├── state.test.js
│       ├── save.test.js
│       ├── battle.test.js
│       └── coach.test.js
├── pyproject.toml          # Pytest config
├── requirements-dev.txt    # Python dev deps (pyyaml, pillow, pytest, cairosvg)
├── package.json            # Defines `npm test` etc. (Node test runner)
├── Gemfile                 # Jekyll deps
└── .github/workflows/
    └── ci.yml              # Test + budget check + build + deploy
```

### Module responsibilities

The runtime is split into single-purpose modules so each can be tested in
isolation. The DOM only enters the picture in `ui.js`.

| Module      | Touches DOM? | Touches `localStorage`? | Knows about elements? |
|-------------|--------------|-------------------------|-----------------------|
| `storage.js`| No           | Yes (the only writer)   | No                    |
| `state.js`  | No           | No                      | Yes (via `GameData`)  |
| `save.js`   | Only for file download | Through `storage.js` | No                |
| `battle.js` | No           | No                      | Yes                   |
| `coach.js`  | Only the slot it renders into | Through `storage.js` | No        |
| `ui.js`     | Yes — the only DOM-aware module | No        | Indirectly            |
| `main.js`   | Through `ui.js` | Through `save.js` + `coach.js` | No        |

`storage.js` exists so all `localStorage` access goes through one place
with consistent namespacing (`elemental-masters:` prefix), JSON
encoding, and try/catch error handling. Adding a new persistence-backed
feature means adding a key, not new error-handling boilerplate.

#### Load order

`_layouts/game.html` loads scripts in dependency order:

```
generated-data.js   →   provides window.GameData
storage.js          →   provides GameStorage (no deps)
state.js            →   provides GameState, GameRules (uses GameData)
save.js             →   provides GameSave (uses GameState, GameStorage)
battle.js           →   provides Battle, Enemy (uses GameState, GameRules)
coach.js            →   provides Coach (uses GameState, GameStorage)
ui.js               →   provides UI (uses everything above)
main.js             →   entry point, wires it all together
```

Adding a new module? Pick a slot, declare its `window.X` global, and load
it after its dependencies. The dependency graph is enforced by load order
alone — there's no bundler, no module system, just well-named globals.

#### Game state machine

`main.js` is a tiny state machine that transitions between screens:

```
title ─[New Game]→ element-select ─[pick]→ map
title ─[Continue]→ map
map   ─[encounter/challenge]→ [boss-intro?] → battle ─[win]→ victory ─→ map
                                                     ─[lose]→ defeat  ─→ battle (retry)
victory (after boss) ─[unlock]→ element-select → map
```

`currentBattle` holds the in-progress `Battle` object so retries can
rebuild it at the same level.

### The data file is the source of truth

`_data/elements.yml` is read by `scripts/build.py` to generate two outputs:

- **`assets/svg/elements/<key>.svg`** — one stylized icon per element
- **`assets/js/generated-data.js`** — the data module the runtime consumes

Both outputs are gitignored. Anything game-content-related — element
weaknesses, mob lists, balance numbers, neutral-mob spawn rate — lives in
this one YAML file. Edit it, rerun the build script, refresh the browser.

#### Mob system

Each element has 4 named mob variants (e.g. Fire's mobs are Fire Imp,
Ember Sprite, Cinder Wolf, Lava Pup). On battle start, the game:

1. Rolls against `balance.neutral_mob_chance` (default 0.25). On hit, it
   picks from `neutral_mobs` instead — these have no element and get a
   `neutral_mob_*_multiplier` stat boost (default 1.2×) to compensate
   for not being weak to anything.
2. Otherwise picks a random element, then a random mob from that element's
   `mobs` list.

Bosses are always elemental and use the element's `boss_title`.

#### Balance constants

All knobs live under `balance:` in `_data/elements.yml`. Common edits:

| Want to…                    | Change                            |
|-----------------------------|-----------------------------------|
| Make the game harder        | bump `mob_attack_per_level` or `boss_attack_multiplier` |
| Faster level-ups            | lower `mob_base_hp` / `mob_hp_per_level` |
| More forgiving specials     | lower `special_energy_cost`       |
| More/fewer neutral mobs     | adjust `neutral_mob_chance` (0..1) |
| Change element roster size  | edit `elements` and `max_elements` together |

Re-run `python3 scripts/build.py` after editing.

### Coaching system

`assets/js/coach.js` shows context-aware help banners during the first
few levels. Tips are defined declaratively as `{id, screen, when, render}`
objects. `pickTip()` returns the first non-dismissed tip whose `when()`
predicate matches; `render()` injects it into a slot element with a
dismiss button. Once dismissed, a tip never reappears (tracked in
`localStorage`). Above level 10 the coach goes silent.

To add a new tip:

```js
// in coach.js, append to the TIPS array
{
  id: "battle-low-hp-warning",
  screen: "battle",
  when: (state, ctx) => state.hp < 10 && state.level <= 5,
  render: () => `<strong>Watch out!</strong> Your HP is critical — try Defend.`,
}
```

Tips with the same `screen` are evaluated top-to-bottom, so order them
roughly by specificity (most specific first).

---

## Building locally

### Prerequisites

- **Ruby** 3.x with Bundler (for Jekyll)
- **Python** 3.10+ (for the asset generator and tests)
- **Node.js** 18+ (only required if you want to run the JS unit tests)

System libraries needed by Pillow and cairosvg for the SVG snapshot
tests: on Ubuntu/Debian, `apt install libcairo2`. On macOS,
`brew install cairo`. Tests skip automatically if these aren't present.

### Develop

```bash
# Install Ruby deps once
bundle install

# Install Python deps once
pip install -r requirements-dev.txt

# Run the asset generator (re-run any time _data/elements.yml changes).
# Generates SVGs, the JS data module, and PWA icons.
python3 scripts/build.py

# Start Jekyll dev server with live reload
bundle exec jekyll serve --livereload
```

Open <http://localhost:4000/elemental-masters/>.

> **Tip:** Add `python3 scripts/build.py &&` to your dev shell alias so
> data and SVGs always get regenerated before Jekyll starts.

### Why Python?

The pre-build step exists for two reasons: validating the data file (the
script will refuse to build if weaknesses aren't symmetric, mobs are
missing, etc.) and emitting a single `window.GameData` payload that the
runtime can consume without parsing YAML in the browser.

Python was a natural choice over a Ruby/Jekyll plugin because the project
maintainer is more fluent in Python. It's a single file with one
dependency (`pyyaml`).

---

## Testing

### Run the whole suite

```bash
# Convenience: runs both Python and JS test suites
npm run test:all

# Or invoke each runner directly:
python -m pytest                       # 48 tests
node --test tests/js/*.test.js         # 70 tests
```

Both suites run automatically in CI on every push and pull request — see
[`.github/workflows/ci.yml`](./.github/workflows/ci.yml). The test job
gates the build + deploy jobs, so a red test blocks deployment.

### Python tests (`tests/`)

48 tests across two files:

**`test_build.py`** — covers the build script's pure functions:

- `parse_semver` — happy path, malformed inputs, non-string inputs
- `is_compatible_save_version` — major-version compatibility logic
- `validate_elements` — count, missing keys, duplicates, asymmetric
  weakness, mob list validation
- `validate_neutral_mobs` — empty list, missing emoji
- `validate_balance` — all required keys, range checks on
  `neutral_mob_chance`, `max_elements`, `element_unlock_levels`
- `build_js_payload` — version, lookups, neutral mob inclusion
- `svg_for` — output format, color injection, unknown-key handling
- `read_game_version` — happy path + missing/empty config rejection
- An integration test that loads the real `_data/elements.yml` and
  asserts it validates cleanly

**`test_svg_snapshots.py`** — visual regression test:

- Renders each element's SVG to PNG via cairosvg
- Hashes the pixel buffer with SHA-256
- Compares against `tests/snapshots/baseline.json`

If you change SVG output intentionally, refresh the baselines:

```bash
python tests/test_svg_snapshots.py --update
```

The snapshot test is auto-skipped when `cairosvg` or Pillow aren't
installed, so dev environments without system Cairo libs still run the
rest of the suite. CI installs everything from `requirements-dev.txt`.

### JavaScript tests (`tests/js/`)

70 tests across `storage.js`, `state.js`, `save.js`, `battle.js`, and
`coach.js`. The harness (`tests/js/_harness.js`) loads each module into
a Node `vm` sandbox with a fake `window`, `localStorage`, and
`FileReader`. RNG can be seeded so battle outcomes are deterministic.

Notable scenarios:

- **storage.js** — namespacing, JSON round-trip, graceful failure when
  storage is unavailable
- **state.js** — derived stats (tier, special name), level-up effects,
  boss-based element unlocks until full ownership, defeat HP reset, JSON round-trip with old
  saves missing fields, and corruption resistance (unknown elements,
  negative numbers, non-string heroName)
- **save.js** — localStorage round-trip, version compatibility, JSON
  file import with format/version/JSON-syntax error paths
- **battle.js** — neutral-mob spawn rate, neutral-mob stat boost,
  super-effective damage emission, defend halving, enemy attacks
  *not* getting super-effective bonuses (chart works in player's favor only)
- **coach.js** — tip selection by screen, dismissal persistence,
  level-cutoff silencing, super-effective and neutral-mob context

### Why two test runners?

The Python and JS code are independent; the Python script is a build-time
tool, while the JS is the runtime game. Each runs in its native
environment with its native test runner, no cross-language mocking. CI
runs both jobs in parallel-ready stages.

---

## Performance budget

`scripts/check_size.py` walks the build output and asserts that:

- No individual file exceeds its category limit (CSS, JS, SVG, PNG, HTML).
- The total transferred bytes stay under the global ceiling (250 KB).

The script runs in CI immediately after the Jekyll build and fails the
deploy if any limit is exceeded. Edit the `CATEGORY_LIMITS` and
`TOTAL_LIMIT` constants in the script to tune as the project evolves.

The point isn't to hit an exact target — it's to make
*"oh, I added a 500 KB image without thinking"* impossible to merge
silently.

Run locally:

```bash
python3 scripts/check_size.py            # check source tree
python3 scripts/check_size.py --site _site/   # check Jekyll output
```

---

## PWA / offline support

The site installs as a Progressive Web App on iOS and Android. Adding to
the home screen gives the player a standalone game window with the
custom icon and theme color, no browser chrome.

**How it works:**

- `manifest.json` declares the app metadata and icon paths. Liquid-processed
  so `relative_url` resolves correctly on subpath deploys.
- `service-worker.js` caches the game shell on first visit and serves
  cached assets thereafter. Cache-first with network fallback. The cache
  name embeds `site.game_version`, so bumping the version in `_config.yml`
  forces a fresh cache on next visit.
- `_layouts/base.html` registers the service worker and links the manifest
  + Apple touch icon.
- PWA icons are generated programmatically by `scripts/build.py` (Pillow).

**Cache invalidation:** when you ship a release that changes any cached
asset, bump `game_version` in `_config.yml`. The service worker's
activate handler will delete the old cache and the next page load will
re-cache from network.

**Local testing:** service workers require HTTPS or `localhost`.
`bundle exec jekyll serve` works for local testing because it binds to
`localhost`.

---

## Deploying

The site is deployed as a project page at
`https://lskatz.github.io/elemental-masters/`.

1. Push to `main`.
2. CI runs Python tests, then JS tests.
3. If both pass, the build job runs `python3 scripts/build.py`, then
   `bundle exec jekyll build` with the right `--baseurl`.
4. The deploy job publishes the artifact to GitHub Pages.

To enable, set **Settings → Pages → Source = GitHub Actions** in the repo.

---

## Save files

- **Auto-save:** `localStorage`, on every meaningful state change. Survives
  closing the tab; lost if the browser clears site data.
- **Manual export:** the **Save to File** button on the map screen downloads a
  versioned JSON file. Load it on another device or after clearing
  storage.
- **Compatibility:** loads only saves with the same MAJOR semver. Bump
  `game_version` in `_config.yml` if you make a save-format-breaking
  change. Minor and patch bumps remain compatible (with a console
  warning).

The unsaved-progress browser warning fires when the player has made
changes since their last *file* export, even if `localStorage` has them.
The warning is a reminder that file backups are nice — closing the tab is
otherwise safe.

---

## Code conventions

Patterns the codebase relies on. Follow these when adding code:

### Defensive `fromJSON` for save migrations

`GameState.fromJSON` is the trust boundary for save data. It must never
throw on input from the wild. It clamps numbers, drops unknown element
keys, and substitutes defaults for missing fields. If you add a new
state field, give it a default in `fromJSON` so old saves continue to
load. This is what makes minor/patch version bumps safe.

### One place to talk to `localStorage`

All `localStorage` access goes through `storage.js`. It namespaces keys
under `elemental-masters:`, JSON-encodes values, and swallows errors
(quota, private mode) so callers don't need try/catch. Don't call
`localStorage.*` directly — add a key and use `GameStorage.read/write/remove`.

### Cancellable timers in the UI

Battle animations chain `setTimeout`s. `ui.js` uses an internal
`_setTimeout` wrapper that registers each timer in a set, and
`showScreen()` cancels them all on screen change. This prevents stale
animation callbacks from firing against a new game state if the player
resets or imports mid-battle.

The exception is `toast()`, which uses raw `setTimeout` intentionally
so success/error notifications survive screen transitions.

### Injectable RNG for testability

Anything that uses randomness in the runtime (currently `Battle` and
`Enemy`) accepts an RNG function in its options, defaulting to
`Math.random`. Tests inject a deterministic generator (`seededRng`
from the test harness) so battle outcomes are reproducible. Avoid
calling `Math.random()` directly in new logic — pipe RNG through.

### Cross-realm error checks

Use `err.name === "SyntaxError"` rather than `err instanceof SyntaxError`.
Tests run game code inside a Node `vm` context, where each realm has
its own constructors, so `instanceof` returns false even for the right
error type. The `.name` check works in both realms.

### XSS hygiene

User-controlled text (currently just the hero name) is rendered with
`textContent` everywhere except coach tips, where it's wrapped in
`escapeHtml()` before string interpolation. Game data values from
`_data/elements.yml` are project-controlled and therefore safe to
interpolate raw — but if a future feature accepts arbitrary strings,
use `textContent` or `escapeHtml()`.

---



## Contributing

A few conventions to keep things tidy:

- **Don't put logic in `ui.js`.** That module renders state; logic
  belongs in `state.js`, `battle.js`, or `coach.js`. If you find yourself
  computing damage or eligibility checks in a render method, lift it.
- **No new runtime dependencies.** The runtime is pure ES2020 + Tailwind-free
  CSS. Keep it that way unless there's a strong reason.
- **Test the change.** New balance constants get a validation test. New
  state mutations get a state test. New battle mechanics get a battle
  test. New tips get a coach test.
- **Bump `game_version` for save-incompatible changes.** Adding a new
  `state` field with a sensible default in `fromJSON()` is compatible;
  removing or renaming one is not.

### Adding a new element

1. Add an entry to `_data/elements.yml` with all required fields,
   including a `mobs` list of 4 entries.
2. Add an SVG body to the `body_by_key` dict in `scripts/build.py`.
3. Keep `weakness` relationships symmetric (`A -> B` means `B -> A`, or a
   deliberate self-counter like `vortex -> vortex`).
4. The validator will catch most mistakes (asymmetric weaknesses, missing
   mobs, malformed colors). Run `python3 scripts/build.py` to verify.
5. Add the new relationship(s) to the help-page chart in `help.md`.

### Reporting bugs

Open an issue with steps to reproduce. If it's a balance complaint,
include the player's level and active element — battle outcomes depend on
both.
