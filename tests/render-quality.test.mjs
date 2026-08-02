import test from 'node:test';
import assert from 'node:assert/strict';

import { selectRenderQuality } from '../src/game/render-quality.js';

test('desktop defaults to the high quality bloom path', () => {
  const quality = selectRenderQuality({
    coarsePointer: false,
    reducedMotion: false,
    viewportWidth: 1440,
    devicePixelRatio: 2,
  });

  assert.equal(quality.tier, 'desktop');
  assert.equal(quality.enableComposer, true);
  assert.equal(quality.enableBloom, true);
  assert.equal(quality.halo, true);
  assert.equal(quality.pixelRatio, 2);
});

test('coarse pointer selects the lightweight path even on a wide tablet', () => {
  const quality = selectRenderQuality({
    coarsePointer: true,
    reducedMotion: false,
    viewportWidth: 1280,
    devicePixelRatio: 3,
  });

  assert.equal(quality.tier, 'mobile');
  assert.equal(quality.enableComposer, false);
  assert.equal(quality.enableBloom, false);
  assert.equal(quality.halo, true);
  assert.equal(quality.pixelRatio, 1.5);
});

test('reduced motion disables post processing and animated intensity', () => {
  const quality = selectRenderQuality({
    coarsePointer: false,
    reducedMotion: true,
    viewportWidth: 1440,
    devicePixelRatio: 2,
  });

  assert.equal(quality.tier, 'reduced-motion');
  assert.equal(quality.enableComposer, false);
  assert.equal(quality.enableBloom, false);
  assert.equal(quality.staticLighting, true);
  assert.equal(quality.pixelRatio, 1.5);
});

test('narrow viewport without coarse pointer still avoids composer', () => {
  const quality = selectRenderQuality({
    coarsePointer: false,
    reducedMotion: false,
    viewportWidth: 760,
    devicePixelRatio: 2,
  });

  assert.equal(quality.tier, 'compact');
  assert.equal(quality.enableComposer, false);
  assert.equal(quality.enableBloom, false);
  assert.equal(quality.pixelRatio, 1.5);
});
