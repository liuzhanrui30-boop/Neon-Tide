import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createRealmBackgrounds } from '../src/game/realm-backgrounds.js';

function createController() {
  const scene = new THREE.Scene();
  const controller = createRealmBackgrounds({
    scene,
    quality: { tier: 'desktop' },
    width: 1280,
    height: 720,
  });
  const root = scene.children.find((child) => child.userData.realmBackgroundRoot);
  assert.ok(root);
  return { scene, controller, root };
}

function firstPointsAttribute(group) {
  let attribute = null;
  group.traverse((object) => {
    if (!attribute && object.isPoints) attribute = object.geometry.attributes.position;
  });
  assert.ok(attribute);
  return attribute;
}

test('stable realm frames skip all-realm audits and dynamic buffer writes', () => {
  const { controller, root } = createController();
  controller.reset();
  controller.update({ elapsed: 0, dt: 0, reducedMotion: false });

  const before = controller.getStats();
  const points = firstPointsAttribute(root.children[0]);
  const bufferVersion = points.version;
  for (let index = 0; index < 12; index += 1) {
    controller.update({ elapsed: 0, dt: 0, reducedMotion: false });
  }
  const stable = controller.getStats();

  assert.equal(stable.debug.allRealmAudits, before.debug.allRealmAudits);
  assert.equal(stable.debug.realmAudits, before.debug.realmAudits);
  assert.equal(stable.debug.stableSkips - before.debug.stableSkips, 12);
  assert.equal(points.version, bufferVersion);
  assert.ok(stable.ownership.objectCounts.every((count) => count > 0));
  assert.ok(stable.ownership.materialCounts.every((count) => count > 0));

  for (let frame = 1; frame <= 30; frame += 1) {
    controller.update({ elapsed: frame / 60, dt: 1 / 60, reducedMotion: false });
  }
  const ordinary = controller.getStats();
  assert.equal(ordinary.debug.allRealmAudits, stable.debug.allRealmAudits);
  assert.equal(ordinary.debug.realmAudits, stable.debug.realmAudits);
  assert.equal(ordinary.updateCounts[0] - stable.updateCounts[0], 30);

  controller.setRealm(1, false);
  controller.update({ elapsed: 1, dt: 0.25, reducedMotion: false });
  const transitioning = controller.getStats();
  assert.equal(transitioning.debug.allRealmAudits, ordinary.debug.allRealmAudits);
  assert.equal(transitioning.debug.realmAudits - ordinary.debug.realmAudits, 2);
  controller.dispose();
});

test('normal updates repair only active realms while explicit recovery audits all owned objects', () => {
  const { controller, root } = createController();
  controller.reset();

  const inactiveGroup = root.children[1];
  inactiveGroup.position.x = Number.NaN;
  const before = controller.getStats();
  controller.update({ elapsed: 1, dt: 1 / 60, reducedMotion: false });
  const activeOnly = controller.getStats();
  assert.equal(Number.isNaN(inactiveGroup.position.x), true);
  assert.equal(activeOnly.debug.allRealmAudits, before.debug.allRealmAudits);
  assert.equal(activeOnly.debug.realmAudits - before.debug.realmAudits, 1);

  assert.equal(controller.recoverCorruption(), true);
  const recovered = controller.getStats();
  assert.equal(inactiveGroup.position.x, 0);
  assert.equal(recovered.debug.allRealmAudits - activeOnly.debug.allRealmAudits, 1);
  assert.ok(recovered.debug.corrections > activeOnly.debug.corrections);

  const activeMaterial = root.children[0].children[0].material;
  activeMaterial.opacity = Number.NaN;
  activeMaterial.userData.realmBaseOpacity = Number.POSITIVE_INFINITY;
  controller.update({ elapsed: 2, dt: 1 / 60, reducedMotion: false });
  assert.equal(Number.isFinite(activeMaterial.opacity), true);
  assert.equal(Number.isFinite(activeMaterial.userData.realmBaseOpacity), true);

  root.position.z = Number.NaN;
  const auditsBeforeRootRepair = controller.getStats().debug.realmAudits;
  controller.update({ elapsed: 2, dt: 0, reducedMotion: false });
  assert.equal(root.position.z, -5);
  assert.equal(controller.getStats().debug.realmAudits, auditsBeforeRootRepair);
  controller.dispose();
});
