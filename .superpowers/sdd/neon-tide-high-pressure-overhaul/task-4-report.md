# Task 4 report — render quality foundation

## Status

Complete. The device-quality policy, renderer integration, visual hierarchy, and HUD refinements are in place without changing combat rules.

## Delivered

- Added `src/game/render-quality.js`.
  - `selectRenderQuality()` is a pure, deterministic device-policy interface.
  - Desktop (wide + fine pointer + normal motion) enables the optional lightweight Bloom Composer.
  - Compact, coarse-pointer/mobile, and reduced-motion tiers disable Composer allocation while retaining halo-compatible rendering.
  - `createPostProcessing()` owns Composer initialization, resize, direct-render fallback, and disposal boundaries.
- Added `tests/render-quality.test.mjs` with coverage for desktop, mobile/coarse pointer, compact viewport, and reduced-motion policies.
- Connected the quality policy to the runtime:
  - wide desktop enables a restrained `EffectComposer` + `UnrealBloomPass`;
  - compact, coarse-pointer, and reduced-motion tiers use direct renderer output and allocate no Composer targets;
  - resizing and a live reduced-motion preference change reselect the tier and recreate/dispose the post-processing boundary safely;
  - the active tier is exposed as `html[data-render-quality]` for visual/DOM verification.
- Refined the playfield without allocating geometry inside the frame loop:
  - player is now a layered wedge craft with detached wings, elliptical core response, and three-stage exhaust;
  - hunters have visible tail fins, strikers carry a stabilizer, and lancers use a diamond turret, spear, and rotating lock reticle;
  - the ocean field now has three distinct fluid-line depths plus two fog-light layers;
  - HUD includes phase tick marks, a short-lived formation label, fine separators, and tabular numerals.
- Reduced motion remains discrete/static for camera motion, telegraphs, fog, reticle rotation, and post-processing.
- Follow-up review fixes:
  - Composer now includes `OutputPass` for the final sRGB color transform;
  - disposal explicitly frees `OutputPass` and `UnrealBloomPass` resources before Composer targets;
  - phone boss HUD is moved below the expanded two-row HUD;
  - browser matrix probes assert desktop/coarse/reduced quality tiers and Composer state;
  - exhaust direction and player core ellipse are corrected.
- The shared `main.js` snapshot also carries the companion finite-state/pool
  guard wave from Task 5 (helpers, input teardown, and frame sanitization);
  those changes are behavior-preserving and are tracked separately in the
  final review against commit `e7e7535`.

## Validation

- `node --check src/main.js` and `node --check src/game/render-quality.js`: passed.
- `npm test`: **20 passed** (including 4 render-quality tests).
- `npm run build`: passed. The existing bundle-size advisory remains non-blocking.

## Concerns

- Bloom is intentionally desktop-only and low intensity; mobile keeps additive geometry halos and CSS color treatment to avoid fill-rate spikes.
- If the browser reports no `matchMedia`, callers should pass `false` for `coarsePointer`/`reducedMotion` (the pure selector already defaults safely).
