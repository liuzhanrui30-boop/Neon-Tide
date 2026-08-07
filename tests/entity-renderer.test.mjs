import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createEntityWorld } from '../src/game/entity-world.js';
import { createEntityRenderer } from '../src/render/entity-renderer.js';

function createFixture(capacities = {}) {
  const scene = new THREE.Scene();
  const world = createEntityWorld({ capacities });
  const renderer = createEntityRenderer({
    scene,
    quality: { tier: 'desktop' },
    capacities,
  });
  const root = scene.children.find((child) => child.userData.entityRendererRoot);
  assert.ok(root);
  return { scene, world, renderer, root };
}

function findKind(root, kind) {
  return root.children.find((child) => child.userData.entityKind === kind);
}

test('renderer preallocates semantic enemy instances and projectile points', () => {
  const { world, renderer, root } = createFixture({
    enemy: 3,
    friendlyProjectile: 4,
    enemyProjectile: 5,
  });

  assert.ok(findKind(root, 'enemy').isInstancedMesh);
  assert.ok(findKind(root, 'friendlyProjectile').isPoints);
  assert.ok(findKind(root, 'enemyProjectile').isPoints);
  assert.equal(findKind(root, 'enemy').instanceMatrix.count, 3);
  assert.equal(findKind(root, 'friendlyProjectile').geometry.attributes.position.count, 4);
  assert.equal(findKind(root, 'enemyProjectile').geometry.attributes.position.count, 5);

  const stats = renderer.getStats();
  assert.equal(stats.capacity, world.getStats().capacity);
  assert.equal(stats.pools.enemy.capacity, 3);
  assert.equal(stats.pools.friendlyProjectile.capacity, 4);
  assert.ok(stats.ownership.geometries > 0);
  assert.ok(stats.ownership.materials > 0);
  renderer.dispose();
  world.dispose();
});

test('sync interpolates fixed slots without replacing owned resources', () => {
  const { world, renderer, root } = createFixture({ enemy: 2, friendlyProjectile: 2 });
  world.spawn('enemy', {
    previousX: 0,
    previousY: 2,
    x: 10,
    y: 6,
    color: 0x123456,
  });
  world.spawn('friendlyProjectile', {
    previousX: -2,
    previousY: -4,
    x: 2,
    y: 4,
    color: 0xabcdef,
  });
  const enemy = findKind(root, 'enemy');
  const projectile = findKind(root, 'friendlyProjectile');
  const enemyGeometry = enemy.geometry;
  const enemyMaterial = enemy.material;
  const projectileGeometry = projectile.geometry;
  const projectileMaterial = projectile.material;

  assert.equal(renderer.sync(world, 0.25), true);
  const matrix = new THREE.Matrix4();
  enemy.getMatrixAt(0, matrix);
  const position = new THREE.Vector3().setFromMatrixPosition(matrix);
  assert.deepEqual(position.toArray(), [2.5, 3, 0]);
  assert.deepEqual(Array.from(projectile.geometry.attributes.position.array.slice(0, 3)), [-1, -2, 0]);

  for (let frame = 0; frame < 20; frame += 1) renderer.sync(world, frame / 19);
  assert.equal(enemy.geometry, enemyGeometry);
  assert.equal(enemy.material, enemyMaterial);
  assert.equal(projectile.geometry, projectileGeometry);
  assert.equal(projectile.material, projectileMaterial);
  assert.equal(renderer.getStats().active, 2);
  renderer.dispose();
  world.dispose();
});

test('explicit recovery repairs repeated corruption without growing ownership', () => {
  const { scene, world, renderer, root } = createFixture({ enemy: 2 });
  world.spawn('enemy', { x: 1, y: 2 });
  renderer.sync(world, 1);
  const enemy = findKind(root, 'enemy');
  const ownedGeometry = enemy.geometry;
  const ownedMaterial = enemy.material;
  const baseline = renderer.getStats();
  const sceneChildren = scene.children.length;
  const rootChildren = root.children.length;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const foreignGeometry = new THREE.BufferGeometry();
    const foreignMaterial = new THREE.MeshBasicMaterial();
    enemy.geometry = foreignGeometry;
    enemy.material = foreignMaterial;
    enemy.instanceMatrix.array[0] = Number.NaN;
    enemy.instanceColor = null;
    root.position.x = Number.NaN;
    root.remove(enemy);

    assert.equal(renderer.recoverCorruption(), true);
    assert.equal(enemy.parent, root);
    assert.equal(enemy.geometry, ownedGeometry);
    assert.equal(enemy.material, ownedMaterial);
    assert.equal(Number.isFinite(enemy.instanceMatrix.array[0]), true);
    assert.equal(root.position.x, 0);
    assert.equal(foreignGeometry.userData.entityRendererDisposed, true);
    assert.equal(foreignMaterial.userData.entityRendererDisposed, true);

    renderer.reset();
    renderer.sync(world, 1);
    const stable = renderer.getStats();
    assert.equal(scene.children.length, sceneChildren);
    assert.equal(root.children.length, rootChildren);
    assert.equal(stable.capacity, baseline.capacity);
    assert.equal(stable.ownership.geometries, baseline.ownership.geometries);
    assert.equal(stable.ownership.materials, baseline.ownership.materials);
  }

  assert.ok(renderer.getStats().corrections >= 12 * 5);
  renderer.dispose();
  world.dispose();
});

test('reset and dispose are bounded and idempotent', () => {
  const { scene, world, renderer, root } = createFixture({ objective: 2, bossPart: 3 });
  world.spawn('objective', { x: 2 });
  world.spawn('bossPart', { y: 3 });
  renderer.sync(world, 1);
  const before = renderer.getStats();

  for (let index = 0; index < 25; index += 1) assert.equal(renderer.reset(), true);
  const reset = renderer.getStats();
  assert.equal(reset.capacity, before.capacity);
  assert.equal(reset.active, 0);
  assert.equal(scene.children.includes(root), true);
  assert.equal(renderer.dispose(), true);
  assert.equal(renderer.dispose(), false);
  assert.equal(renderer.reset(), false);
  assert.equal(renderer.sync(world, 1), false);
  assert.equal(scene.children.includes(root), false);
  world.dispose();
});
