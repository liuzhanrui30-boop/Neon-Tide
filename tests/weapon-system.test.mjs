import test from 'node:test';
import assert from 'node:assert/strict';
import { createEntityWorld } from '../src/game/entity-world.js';
import {
  TIDE_LANCE_CHARGE_SECONDS,
  WEAPON_IDS,
  createWeaponSystem,
  selectAutoTarget,
  selectTideLanceLine,
} from '../src/systems/weapon-system.js';

test('auto target prioritizes executing threats and objectives over nearest fodder', () => {
  const target = selectAutoTarget({ x: 0, y: 0 }, [
    { id: 1, x: 1, y: 0, role: 'swarm', threat: 1 },
    { id: 2, x: 4, y: 0, role: 'lancer', executingTelegraph: true, threat: 5 },
    { id: 3, x: 3, y: 0, objective: true, threat: 4 },
  ], {});
  assert.equal(target.id, 2);
});

test('auto target has bounded range and stable distance/id ties', () => {
  const player = { x: 0, y: 0 };
  const target = selectAutoTarget(player, [
    { id: 9, x: 2, y: 0, threat: 3 },
    { id: 4, x: -2, y: 0, threat: 3 },
    { id: 1, x: 100, y: 0, executingTelegraph: true, threat: 20 },
  ], { range: 12, maxCandidates: 8 });
  assert.equal(target.id, 4);
});

test('Tide Lance line search rewards aligned objectives and Boss weak points', () => {
  assert.equal(TIDE_LANCE_CHARGE_SECONDS, 0.28);
  const line = selectTideLanceLine({ x: 0, y: 0, facing: { x: 0, y: 1 } }, [
    { id: 10, x: 3, y: 0, threat: 2, radius: 0.4 },
    { id: 11, x: 5, y: 0.05, threat: 8, executingTelegraph: true, radius: 0.4 },
    { id: 12, x: 4.5, y: 0.1, role: 'boss', weakPoint: true, threat: 10, radius: 0.5 },
  ], [
    { id: 20, x: 6, y: 0, objective: true, objectiveType: 'core', radius: 0.6 },
  ]);

  assert.ok(line.directionX > 0.99, JSON.stringify(line));
  assert.ok(Math.abs(line.directionY) < 0.08, JSON.stringify(line));
  assert.deepEqual(line.targetIds, [10, 12, 11, 20]);
  assert.ok(line.score > 0);
});

test('starter weapons use the fixed friendly projectile pool and perfect phase accelerates cadence', () => {
  assert.deepEqual(WEAPON_IDS, ['pulse-cannon', 'arc-drones', 'prism-missiles']);
  const run = (buffSeconds) => {
    const world = createEntityWorld({ capacities: { player: 1, enemy: 4, friendlyProjectile: 24 } });
    const playerId = world.spawn('player', {
      x: 0,
      y: 0,
      team: 1,
      collidable: true,
      fireTimer: buffSeconds,
    });
    world.spawn('enemy', { x: 8, y: 0, hp: 20, maxHp: 20, team: 2, collidable: true, threat: 4 });
    const system = createWeaponSystem();
    const emitted = [];
    const events = { emit(type, payload) { emitted.push({ type, payload }); return true; } };
    for (let step = 0; step < 60; step += 1) system.update(world, playerId, 1 / 60, events);
    const projectiles = [...world.query('friendlyProjectile')].map((id) => world.get(id));
    return { system, emitted, projectiles, world };
  };

  const base = run(0);
  const buffed = run(1);
  assert.equal(base.world.getStats().pools.friendlyProjectile.capacity, 24);
  assert.equal(base.projectiles.filter(({ type }) => type === 'arc-drone').length, 2);
  assert.ok(base.projectiles.some(({ weaponId }) => weaponId === 'pulse-cannon'));
  assert.ok(base.projectiles.some(({ weaponId }) => weaponId === 'arc-drones'));
  assert.ok(base.projectiles.some(({ weaponId }) => weaponId === 'prism-missiles'));
  assert.ok(buffed.system.getStats().shotsFired > base.system.getStats().shotsFired);
  assert.ok(base.emitted.every(({ type }) => type === 'weaponFire'));
  assert.ok(base.emitted.every(({ payload }) => payload.total > 0 && payload.total <= 8));
});

