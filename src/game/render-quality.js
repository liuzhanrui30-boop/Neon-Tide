import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';

const COMPACT_VIEWPORT = 900;
const MOBILE_PIXEL_RATIO = 1.5;
const DESKTOP_PIXEL_RATIO = 2;

/**
 * Pick a stable visual budget from browser capabilities. This function has no
 * browser or Three.js side effects so it can be covered by Node tests.
 */
export function selectRenderQuality({
  coarsePointer = false,
  reducedMotion = false,
  viewportWidth = 0,
  devicePixelRatio = 1,
} = {}) {
  const normalizedPixelRatio = Math.max(1, Number(devicePixelRatio) || 1);
  if (reducedMotion) {
    return Object.freeze({
      tier: 'reduced-motion',
      enableComposer: false,
      enableBloom: false,
      halo: true,
      staticLighting: true,
      pixelRatio: Math.min(normalizedPixelRatio, MOBILE_PIXEL_RATIO),
    });
  }
  if (coarsePointer) {
    return Object.freeze({
      tier: 'mobile',
      enableComposer: false,
      enableBloom: false,
      halo: true,
      staticLighting: false,
      pixelRatio: Math.min(normalizedPixelRatio, MOBILE_PIXEL_RATIO),
    });
  }
  if (viewportWidth < COMPACT_VIEWPORT) {
    return Object.freeze({
      tier: 'compact',
      enableComposer: false,
      enableBloom: false,
      halo: true,
      staticLighting: false,
      pixelRatio: Math.min(normalizedPixelRatio, MOBILE_PIXEL_RATIO),
    });
  }
  return Object.freeze({
    tier: 'desktop',
    enableComposer: true,
    enableBloom: true,
    halo: true,
    staticLighting: false,
    pixelRatio: Math.min(normalizedPixelRatio, DESKTOP_PIXEL_RATIO),
  });
}

/**
 * Own the optional Composer lifecycle. The caller can always call render,
 * resize, and dispose without branching; lightweight tiers keep the direct
 * renderer path and allocate no render targets.
 */
export function createPostProcessing({ renderer, scene, camera, quality, width, height }) {
  const direct = {
    enabled: false,
    composer: null,
    bloomPass: null,
    render() { renderer.render(scene, camera); },
    resize() {},
    dispose() {},
  };
  if (!quality?.enableComposer || !quality?.enableBloom) return direct;

  const composer = new EffectComposer(renderer);
  composer.setPixelRatio(quality.pixelRatio);
  composer.setSize(width, height);
  const renderPass = new RenderPass(scene, camera);
  const bloomPass = new UnrealBloomPass(
    new THREE.Vector2(width, height),
    0.48,
    0.38,
    0.72,
  );
  composer.addPass(renderPass);
  composer.addPass(bloomPass);

  return {
    enabled: true,
    composer,
    bloomPass,
    render() { composer.render(); },
    resize(nextWidth, nextHeight, pixelRatio = quality.pixelRatio) {
      composer.setPixelRatio(pixelRatio);
      composer.setSize(nextWidth, nextHeight);
      bloomPass.setSize(nextWidth, nextHeight);
    },
    dispose() {
      composer.dispose();
    },
  };
}
