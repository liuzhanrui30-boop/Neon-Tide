# Task 4 report — render quality foundation

## Status

The device-quality foundation is complete and isolated from combat runtime changes.

## Delivered

- Added `src/game/render-quality.js`.
  - `selectRenderQuality()` is a pure, deterministic device-policy interface.
  - Desktop (wide + fine pointer + normal motion) enables the optional lightweight Bloom Composer.
  - Compact, coarse-pointer/mobile, and reduced-motion tiers disable Composer allocation while retaining halo-compatible rendering.
  - `createPostProcessing()` owns Composer initialization, resize, direct-render fallback, and disposal boundaries.
- Added `tests/render-quality.test.mjs` with coverage for desktop, mobile/coarse pointer, compact viewport, and reduced-motion policies.

## Validation

- `npm test`: **20 passed** (including 4 render-quality tests).

## Integration note

`src/main.js`, `src/style.css`, and `index.html` were intentionally left untouched in this isolated commit while the parallel boss-runtime wave was editing `main.js`. The parent integration should instantiate the post-processing wrapper after the scene/renderer are created, call `resize()` from the existing resize handler, and use `render()` in the frame loop. On reduced-motion preference changes, reselect the tier and dispose/recreate the wrapper so no Composer render target remains allocated.

## Concerns

- Bloom is intentionally desktop-only and low intensity; mobile keeps the existing additive halo/CSS glow to avoid fill-rate spikes.
- If the browser reports no `matchMedia`, callers should pass `false` for `coarsePointer`/`reducedMotion` (the pure selector already defaults safely).
