import test from 'node:test';
import assert from 'node:assert/strict';
import { createEntityWorld } from '../src/game/entity-world.js';
import { createProjectileSystem } from '../src/systems/projectile-system.js';

test('homing correction is bounded and projectile motion is fixed-step', () => {
  const world = createEntityWorld({ capacities: { enemy: 1, friendlyProjectile: 2 } });
  const targetId = world.spawn('enemy', { x: 0, y: 8, team: 2, collidable: true });
  const projectileId = world.spawn('friendlyProjectile', {
    x: 0,
    y: 0,
    vx: 8,
    vy: 0,
    speed: 8,
    maxSpeed: 8,
    turnRate: 2,
    lifetime: 2,
    targetId,
    homing: true,
    collidable: true,
    type: 'pulse-round',
  });
  const system = createProjectileSystem();

  system.update(world, 1 / 60);
  const projectile = world.get(projectileId);
  assert.ok(projectile.x > 0);
  assert.ok(projectile.vy > 0);
  assert.ok(Math.atan2(projectile.vy, projectile.vx) <= 2 / 60 + 1e-9);
});

test('two drone entities orbit their generation-safe owner without becoming collidable', () => {
  const world = createEntityWorld({ capacities: { player: 1, friendlyProjectile: 2 } });
  const playerId = world.spawn('player', { x: 2, y: -1 });
  const droneId = world.spawn('friendlyProjectile', {
    ownerId: playerId,
    type: 'arc-drone',
    orbitAngle: 0,
    orbitRadius: 1.5,
    speed: 2,
    collidable: false,
    lifetime: 999,
  });
  const system = createProjectileSystem();
  system.update(world, 0.5);
  const drone = world.get(droneId);
  assert.equal(drone.collidable, false);
  assert.ok(Math.abs(Math.hypot(drone.x - 2, drone.y + 1) - 1.5) < 1e-9);
  assert.ok(drone.orbitAngle > 0);
});

test('expired and escaped projectiles are despawned only after traversal', () => {
  const world = createEntityWorld({ capacities: { friendlyProjectile: 3 } });
  const expired = world.spawn('friendlyProjectile', { lifetime: 0.01, vx: 1, collidable: true });
  const escaped = world.spawn('friendlyProjectile', { x: 40, lifetime: 5, collidable: true });
  const stable = world.spawn('friendlyProjectile', { lifetime: 5, vx: 1, collidable: true });
  const system = createProjectileSystem({ worldLimit: 32 });
  const result = system.update(world, 1 / 60);

  assert.equal(world.get(expired), null);
  assert.equal(world.get(escaped), null);
  assert.ok(world.get(stable));
  assert.equal(result.despawned, 2);
});

