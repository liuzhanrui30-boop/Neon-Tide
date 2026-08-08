import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createEntityWorld } from '../src/game/entity-world.js';
import { createEntityRenderer } from '../src/render/entity-renderer.js';
import { resolveCollisions } from '../src/systems/collision-system.js';

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

test('warning and hazard transforms match authoritative footprint dimensions without allocation growth', () => {
  const { world, renderer, root } = createFixture({ warning: 2, enemyHazard: 3 });
  world.spawn('warning', {
    x: 3, y: -2, rotation: Math.PI / 3, scaleX: 14.21, scaleY: 0.56,
    opacity: 0.8, collidable: false,
  });
  world.spawn('enemyHazard', { x: -2, y: 0, radius: 0.34, scaleX: 0.34, scaleY: 0.34, collidable: true });
  world.spawn('enemyHazard', { x: 0, y: 0, radius: 1.2, scaleX: 1.2, scaleY: 1.2, collidable: false, role: 'warden-gap' });
  world.spawn('enemyHazard', { x: 2, y: 0, radius: 1.35, scaleX: 1.35, scaleY: 1.35, collidable: false, role: 'safe-sector' });
  const ownership = renderer.getStats().ownership;
  renderer.sync(world, 1);

  const warningMesh = findKind(root, 'warning').children[0];
  assert.deepEqual(warningMesh.position.toArray(), [3, -2, 0]);
  assert.ok(Math.abs(warningMesh.rotation.z - Math.PI / 3) < 1e-9);
  assert.deepEqual(warningMesh.scale.toArray(), [14.21, 0.56, 1]);

  const hazardMesh = findKind(root, 'enemyHazard');
  const scales = [];
  const matrix = new THREE.Matrix4();
  const scale = new THREE.Vector3();
  for (let index = 0; index < 3; index += 1) {
    hazardMesh.getMatrixAt(index, matrix);
    matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
    scales.push(Number(scale.x.toFixed(2)));
  }
  assert.deepEqual(scales, [0.34, 1.2, 1.35]);
  assert.deepEqual(renderer.getStats().ownership, ownership);
  renderer.dispose();
  world.dispose();
});

test('Warden, Lancer, Mine, and Bulwark hazards render the same authoritative radius used by collision', () => {
  const cases = [
    { role: 'warden-wall', type: 'warden-wall-node', radius: 0.34, contactRadius: 0.34, scaleX: 8, scaleY: 7 },
    { role: 'lancer', type: 'lancer-beam-node', radius: 0.28, contactRadius: 0.5, scaleX: 0.02, scaleY: 6 },
    { role: 'mine', type: 'mine-explosion', radius: 0.38, contactRadius: 0, scaleX: 5, scaleY: 0.01 },
    { role: 'bulwark', type: 'bulwark-counter-wave', radius: 0.42, contactRadius: 0.62, scaleX: 0.03, scaleY: 9 },
  ];
  for (const entry of cases) {
    const { world, renderer, root } = createFixture({ player: 1, enemyHazard: 1 });
    const footprint = entry.contactRadius || entry.radius;
    const playerId = world.spawn('player', {
      x: footprint + 0.39, y: 0, radius: 0.4, team: 1, collidable: true,
    });
    const hazardId = world.spawn('enemyHazard', {
      x: 0, y: 0, radius: entry.radius, contactRadius: entry.contactRadius,
      scale: 4, scaleX: entry.scaleX, scaleY: entry.scaleY, role: entry.role, type: entry.type,
      damage: 0.35, ownerId: 7, team: 2, collidable: true, contactDamaging: true,
    });
    renderer.sync(world, 1);
    const matrix = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    findKind(root, 'enemyHazard').getMatrixAt(0, matrix);
    matrix.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
    assert.ok(Math.abs(scale.x - footprint) < 1e-6, entry.role);
    assert.ok(Math.abs(scale.y - footprint) < 1e-6, entry.role);

    const hits = [];
    resolveCollisions(world, { damageHull(amount) { hits.push(amount); return true; } }, 1 / 60, { emit() {} });
    assert.deepEqual(hits, [0.35], entry.role);
    world.write(playerId, { x: footprint + 0.41 });
    world.write(hazardId, { hitCooldown: 0 });
    resolveCollisions(world, { damageHull(amount) { hits.push(amount); return true; } }, 1 / 60, { emit() {} });
    assert.deepEqual(hits, [0.35], entry.role);
    renderer.dispose();
    world.dispose();
  }
});

test('sync clamps extreme finite transforms before writing GPU buffers', () => {
  const { world, renderer, root } = createFixture({ enemy: 1, friendlyProjectile: 1 });
  world.spawn('enemy', {
    previousX: -Number.MAX_VALUE,
    previousY: Number.MAX_VALUE,
    x: Number.MAX_VALUE,
    y: -Number.MAX_VALUE,
    scale: Number.MAX_VALUE,
    rotation: Number.MAX_VALUE,
  });
  world.spawn('friendlyProjectile', {
    previousX: Number.MAX_VALUE,
    previousY: -Number.MAX_VALUE,
    x: -Number.MAX_VALUE,
    y: Number.MAX_VALUE,
  });

  assert.equal(renderer.sync(world, 0.5), true);
  assert.equal(Array.from(findKind(root, 'enemy').instanceMatrix.array).every(Number.isFinite), true);
  assert.equal(Array.from(findKind(root, 'friendlyProjectile').geometry.attributes.position.array).every(Number.isFinite), true);
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
    assert.equal(foreignGeometry.userData.entityRendererDisposed, undefined);
    assert.equal(foreignMaterial.userData.entityRendererDisposed, undefined);
    foreignGeometry.dispose();
    foreignMaterial.dispose();

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

test('corruption recovery never disposes foreign resources owned outside its scene', () => {
  const { world, renderer, root } = createFixture({ enemy: 1 });
  const enemy = findKind(root, 'enemy');
  const ownedGeometry = enemy.geometry;
  const ownedMaterial = enemy.material;
  const foreignGeometry = new THREE.BufferGeometry();
  const foreignMaterial = new THREE.MeshBasicMaterial();
  const otherScene = new THREE.Scene();
  otherScene.add(new THREE.Mesh(foreignGeometry, foreignMaterial));
  let geometryDisposals = 0;
  let materialDisposals = 0;
  foreignGeometry.dispose = () => { geometryDisposals += 1; };
  foreignMaterial.dispose = () => { materialDisposals += 1; };
  enemy.geometry = foreignGeometry;
  enemy.material = foreignMaterial;

  assert.equal(renderer.recoverCorruption(), true);
  assert.equal(enemy.geometry, ownedGeometry);
  assert.equal(enemy.material, ownedMaterial);
  assert.equal(geometryDisposals, 0);
  assert.equal(materialDisposals, 0);
  renderer.dispose();
  assert.equal(geometryDisposals, 0);
  assert.equal(materialDisposals, 0);
  foreignGeometry.dispose();
  foreignMaterial.dispose();
  assert.equal(geometryDisposals, 1);
  assert.equal(materialDisposals, 1);
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

test('dispose releases owned instance and buffer resources exactly once', () => {
  const { world, renderer, root } = createFixture();
  const instances = root.children.filter((object) => object.isInstancedMesh);
  const geometries = new Set(root.children.map((object) => object.geometry));
  const materials = new Set(root.children.map((object) => object.material));
  let instanceDisposals = 0;
  let geometryDisposals = 0;
  let materialDisposals = 0;
  for (const object of instances) object.dispose = () => { instanceDisposals += 1; };
  for (const geometry of geometries) geometry.dispose = () => { geometryDisposals += 1; };
  for (const material of materials) material.dispose = () => { materialDisposals += 1; };

  assert.equal(renderer.dispose(), true);
  assert.equal(renderer.dispose(), false);
  assert.equal(instanceDisposals, instances.length);
  assert.equal(geometryDisposals, geometries.size);
  assert.equal(materialDisposals, materials.size);
  world.dispose();
});

test('dispose detaches every owned object after parent corruption', () => {
  const { scene, world, renderer, root } = createFixture();
  const wrapper = new THREE.Group();
  const foreignParent = new THREE.Group();
  scene.add(wrapper, foreignParent);
  wrapper.add(root);
  const enemy = findKind(root, 'enemy');
  foreignParent.add(enemy);

  assert.equal(renderer.dispose(), true);
  assert.equal(root.parent, null);
  assert.equal(enemy.parent, null);
  assert.equal(wrapper.children.includes(root), false);
  assert.equal(foreignParent.children.includes(enemy), false);
  world.dispose();
});
