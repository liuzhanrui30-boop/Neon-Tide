import test from 'node:test';
import assert from 'node:assert/strict';
import { createEntityWorld } from '../src/game/entity-world.js';
import {
  TIDE_LANCE_CHARGE_SECONDS,
  WEAPON_IDS,
  createWeaponSystem,
  deriveTideLanceSpec,
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

test('Tide Lance selection uses the same safely capped authoritative width, reach and hit budget spec', () => {
  const spec = deriveTideLanceSpec({
    lanceLength: 12,
    lanceHalfWidth: 0.575,
    lanceTargetCap: 11,
    lancePierce: 3,
    lanceWeakPointMultiplier: 1.75,
    objectiveDamageMultiplier: 1.4,
    lanceDamageMultiplier: 1.24,
    lancePropagation: 2,
    propagationRadius: 7.2,
    chainDamageMultiplier: 0.9,
    weakPointPriority: 1.45,
  });
  assert.deepEqual(spec, {
    length: 12,
    halfWidth: 0.575,
    width: 1.15,
    baseHitCap: 11,
    pierce: 3,
    hitCap: 14,
    weakPointMultiplier: 1.75,
    objectiveMultiplier: 1.4,
    damageMultiplier: 1.24,
    propagation: 2,
    propagationRadius: 7.2,
    propagationDamageMultiplier: 0.9,
    weakPointPriority: 1.45,
  });
  const candidates = Array.from({ length: 14 }, (_, index) => ({
    id: index + 1,
    x: 1 + index * 0.8,
    y: index % 2 ? 0.5 : -0.5,
    hp: 10,
    radius: 0.1,
  }));
  candidates.push({ id: 99, x: 12.6, y: 0, hp: 10, radius: 0.1 });
  const line = selectTideLanceLine(
    { x: 0, y: 0, facing: { x: 1, y: 0 } },
    candidates,
    [],
    spec,
  );
  assert.equal(line.targetIds.length, 14);
  assert.equal(line.targetIds.includes(99), false);
  assert.equal(line.length, spec.length);
  assert.equal(line.width, spec.width);
  assert.equal(line.hitCap, spec.hitCap);
});

test('mutable build-stat inputs never poison identity caches or escape through weapon debug stats', () => {
  const mutable = { lanceLength: 8 };
  const first = deriveTideLanceSpec(mutable);
  mutable.lanceLength = 9;
  const second = deriveTideLanceSpec(mutable);
  assert.equal(first.length, 8);
  assert.equal(second.length, 9);
  assert.notEqual(second, first);

  const canonical = Object.freeze({ lanceLength: 10 });
  assert.equal(deriveTideLanceSpec(canonical), deriveTideLanceSpec(canonical));

  const world = createEntityWorld({ capacities: { player: 1, enemy: 1, friendlyProjectile: 16 } });
  const playerId = world.spawn('player', { x: 0, y: 0, team: 1, collidable: true });
  world.spawn('enemy', { x: 5, y: 0, hp: 20, team: 2, collidable: true });
  const system = createWeaponSystem();
  const callerOwned = { starterWeapon: 'pulse-cannon', weaponDamageMultiplier: 1.2 };
  system.update(world, playerId, 1 / 60, null, callerOwned);
  const exposed = system.getStats().lastBuildStats;
  assert.notEqual(exposed, callerOwned);
  assert.equal(Object.isFrozen(exposed), true);
  callerOwned.starterWeapon = 'arc-drones';
  callerOwned.weaponDamageMultiplier = 2;
  assert.deepEqual(exposed, { starterWeapon: 'pulse-cannon', weaponDamageMultiplier: 1.2 });
  system.update(world, playerId, 1 / 60, null, callerOwned);
  assert.equal(system.getStats().lastBuildStats.starterWeapon, 'arc-drones');
  assert.equal(system.getStats().lastBuildStats.weaponDamageMultiplier, 2);
});

test('only the selected starter uses the fixed friendly projectile pool and perfect phase accelerates its cadence', () => {
  assert.deepEqual(WEAPON_IDS, ['pulse-cannon', 'arc-drones', 'prism-missiles']);
  const run = (starterWeapon, buffSeconds, perfectFireBuffMultiplier = 0.75) => {
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
    const buildStats = { starterWeapon, perfectFireBuffMultiplier };
    for (let step = 0; step < 60; step += 1) system.update(world, playerId, 1 / 60, events, buildStats);
    const projectiles = [...world.query('friendlyProjectile')].map((id) => world.get(id));
    return { system, emitted, projectiles, world };
  };

  const base = run('pulse-cannon', 0);
  const buffed = run('pulse-cannon', 1, 0.62);
  const drones = run('arc-drones', 0);
  const missiles = run('prism-missiles', 0);
  assert.equal(base.world.getStats().pools.friendlyProjectile.capacity, 24);
  assert.ok(base.projectiles.some(({ weaponId }) => weaponId === 'pulse-cannon'));
  assert.ok(base.projectiles.every(({ weaponId }) => weaponId === 'pulse-cannon'));
  assert.equal(drones.projectiles.filter(({ type }) => type === 'arc-drone').length, 2);
  assert.ok(drones.projectiles.every(({ weaponId }) => weaponId === 'arc-drones'));
  assert.ok(missiles.projectiles.some(({ weaponId }) => weaponId === 'prism-missiles'));
  assert.ok(missiles.projectiles.every(({ weaponId }) => weaponId === 'prism-missiles'));
  assert.ok(buffed.system.getStats().shotsFired > base.system.getStats().shotsFired);
  assert.ok(base.emitted.every(({ type }) => type === 'weaponFire'));
  assert.ok(base.emitted.every(({ payload }) => payload.total > 0 && payload.total <= 8));
});

test('perfect-phase rising edge immediately rescales every outstanding cooldown once', () => {
  const world = createEntityWorld({ capacities: { player: 1, enemy: 1, friendlyProjectile: 16 } });
  const playerId = world.spawn('player', { x: 0, y: 0, team: 1, collidable: true });
  world.spawn('enemy', { x: 8, y: 0, hp: 100, team: 2, collidable: true });
  const system = createWeaponSystem();
  system.update(world, playerId, 0.1, { emit() { return true; } });
  const before = system.getStats().cooldowns;
  world.write(playerId, { fireTimer: 0.8 });
  system.update(world, playerId, 0.01, { emit() { return true; } });
  const afterEdge = system.getStats().cooldowns;
  system.update(world, playerId, 0.01, { emit() { return true; } });
  const afterHeld = system.getStats().cooldowns;

  assert.ok(Math.abs(afterEdge['prism-missiles'] - (before['prism-missiles'] * 0.75 - 0.01)) < 1e-9);
  assert.ok(Math.abs(afterHeld['prism-missiles'] - (afterEdge['prism-missiles'] - 0.01)) < 1e-9);
});

test('weapon fire event counter advances only when the bounded queue accepts it', () => {
  const world = createEntityWorld({ capacities: { player: 1, enemy: 1, friendlyProjectile: 8 } });
  const playerId = world.spawn('player', { x: 0, y: 0, team: 1 });
  world.spawn('enemy', { x: 4, y: 0, hp: 20, team: 2, collidable: true });
  const system = createWeaponSystem();
  system.update(world, playerId, 1 / 60, { emit() { return false; } });
  assert.equal(system.getStats().fireEvents, 0);
});

test('a Tide Lance input rising edge spawns one real swept projectile through EntityWorld', () => {
  const world = createEntityWorld({ capacities: { player: 1, bossPart: 2, friendlyProjectile: 8 } });
  const playerId = world.spawn('player', {
    x: 0, y: 0, team: 1, collidable: true,
    attackKind: 'tide-lance', sequence: 11, directionX: 0, directionY: 1,
  });
  world.spawn('bossPart', {
    x: 5, y: 0, hp: 10, maxHp: 10, radius: 0.5,
    team: 2, collidable: true, weakPoint: true, role: 'boss',
  });
  const system = createWeaponSystem();
  system.update(world, playerId, 1 / 60, { emit() { return true; } }, {
    starterWeapon: 'pulse-cannon', lanceLength: 7.2, lanceHalfWidth: 0.275,
    lanceTargetCap: 8, lanceDamageMultiplier: 1,
  });
  const lance = [...world.query('friendlyProjectile')]
    .map((id) => world.get(id))
    .find(({ type }) => type === 'tide-lance');
  assert.ok(lance);
  assert.equal(lance.weaponId, 'tide-lance');
  assert.equal(lance.previousX, 0);
  assert.equal(lance.previousY, 0);
  assert.ok(lance.x > 5.9 && Math.abs(lance.y) < 1e-9, 'auto aim chooses the exposed Boss weak point');
  assert.equal(lance.hitBudgetRemaining, 8);
  world.dispose();
});
