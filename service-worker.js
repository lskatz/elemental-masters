---
# Front matter forces Jekyll to process this file with Liquid.
# Final filename is /service-worker.js after Jekyll build.
permalink: /service-worker.js
---
/* ============================================================================
 * service-worker.js — Offline support for Elemental Masters.
 *
 * Strategy:
 *   - On install, pre-cache the game shell (HTML, CSS, JS, manifest, icons,
 *     fonts via cross-origin requests).
 *   - On fetch, try cache first, then network. New responses get cached so
 *     subsequent visits are fully offline-capable.
 *   - On activate, delete old caches whose name doesn't match CACHE_NAME.
 *
 * The cache name embeds the game version. Bumping `game_version` in
 * `_config.yml` invalidates the cache on next visit, ensuring updates
 * actually land instead of getting served from stale storage forever.
 * ========================================================================== */

const CACHE_NAME = "elemental-masters-v{{ site.game_version }}";

// The shell — assets the game can't run without. Listed explicitly rather
// than discovered at runtime so the install step is deterministic.
// Liquid renders relative_url so paths match the deployed baseurl.
const PRECACHE_URLS = [
  "{{ '/' | relative_url }}",
  "{{ '/help/' | relative_url }}",
  "{{ '/manifest.json' | relative_url }}",
  "{{ '/assets/css/style.css' | relative_url }}",
  "{{ '/assets/js/generated-data.js' | relative_url }}",
  "{{ '/assets/js/storage.js' | relative_url }}",
  "{{ '/assets/js/state.js' | relative_url }}",
  "{{ '/assets/js/save.js' | relative_url }}",
  "{{ '/assets/js/battle.js' | relative_url }}",
  "{{ '/assets/js/coach.js' | relative_url }}",
  "{{ '/assets/js/ui.js' | relative_url }}",
  "{{ '/assets/js/main.js' | relative_url }}",
  "{{ '/assets/icons/icon-192.png' | relative_url }}",
  "{{ '/assets/icons/icon-512.png' | relative_url }}",
];

// ---- Install: pre-cache the shell ------------------------------------

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // addAll fails atomically — if any URL 404s, nothing is cached.
      // That's the right behaviour: a partial cache would leave the game
      // broken offline. Use Promise.allSettled for individual fetches if
      // you need lenient caching later.
      return cache.addAll(PRECACHE_URLS);
    })
  );
  // Activate this worker as soon as it's done installing, replacing any
  // older worker controlling the page. Without skipWaiting, updates only
  // take effect after every tab is closed.
  self.skipWaiting();
});

// ---- Activate: clean up old caches ----------------------------------

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(
      names
        .filter((n) => n !== CACHE_NAME)
        .map((n) => caches.delete(n))
    )).then(() => self.clients.claim())
  );
});

// ---- Fetch: cache-first with network fallback -----------------------

self.addEventListener("fetch", (event) => {
  // Only handle GETs. POSTs etc. should go straight through (we don't have
  // any in this app, but it's good hygiene).
  if (event.request.method !== "GET") return;

  // Skip cross-origin requests we don't control (e.g. Google Fonts could
  // be cached, but if the request fails, returning an opaque cached copy
  // can mask network problems during development). Letting them pass
  // through means fonts may not work offline on first load — acceptable
  // trade-off, and they'll be served from the browser HTTP cache anyway.
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      // Not in cache — go to network, then opportunistically cache the
      // response so it's available next time. Clone first because a
      // Response body can only be consumed once.
      return fetch(event.request).then((response) => {
        // Don't cache failed responses or opaque/redirected ones — they'd
        // poison the cache.
        if (!response || response.status !== 200 || response.type !== "basic") {
          return response;
        }
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        return response;
      }).catch(() => {
        // Network failure and not in cache — for navigations, fall back
        // to the cached root so the player still gets *something*.
        if (event.request.mode === "navigate") {
          return caches.match("{{ '/' | relative_url }}");
        }
        // For other resources, let the failure propagate.
        return Response.error();
      });
    })
  );
});
