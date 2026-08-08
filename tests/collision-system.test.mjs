import test from 'node:test';
import assert from 'node:assert/strict';
import { createEntityWorld } from '../src/game/entity-world.js';
import { createCollisionSystem, resolveCollisions, sweptCircleHit } from '../src/systems/collision-system.js';
import { createEnemySystem } from '../src/systems/enemy-system.js';

function createEvents() {
  const emitted = [];
  return { emitted, emit(type, payload) { emitted.push({ type, payload }); return true; } };
}

test('friendly projectile damage is authoritative and Boss weak points amplify it', () => {
  const world = createEntityWorld({ capacities: { friendlyProjectile: 2, bossPart: 1 } });
  const weakPointId = world.spawn('bossPart', {
    x: 1,
    y: 0,
    hp: 5,
    maxHp: 5,
    radius: 0.6,
    team: 2,
    weakPoint: true,
    collidable: true,
  });
  const projectileId = world.spawn('friendlyProjectile', {
    x: 1,
    y: 0,
    damage: 2,
    radius: 0.2,
    team: 1,
    collidable: true,
    weaponId: 'pulse-cannon',
  });
  const events = createEvents();
  const summary = resolveCollisions(world, { damageHull() { throw new Error('player was not hit'); } }, 1 / 60, events);

  assert.equal(world.get(projectileId), null);
  assert.equal(world.get(weakPointId).hp, 2);
  assert.equal(summary.damageRecords[0].amount, 3);
  assert.equal(summary.damageRecords[0].weakPoint, true);
  assert.equal(events.emitted.filter(({ type }) => type === 'weaponHit').length, 1);
});

test('Prism Missile split spawns are deferred until after the active collision pass', () => {
  const world = createEntityWorld({ capacities: { enemy: 2, friendlyProjectile: 8 } });
  world.spawn('enemy', { x: 0, y: 0, hp: 10, radius: 0.5, team: 2, collidable: true });
  world.spawn('friendlyProjectile', {
    x: 0,
    y: 0,
    vx: 2,
    vy: 0,
    damage: 2,
    radius: 0.2,
    team: 1,
    collidable: true,
    weaponId: 'prism-missiles',
    type: 'prism-missile',
    splitCount: 3,
    splitOnImpact: true,
  });
  const system = createCollisionSystem();
  const summary = system.resolve(world, { damageHull() { return false; } }, 1 / 60, createEvents());
  const splitProjectiles = [...world.query('friendlyProjectile')].map((id) => world.get(id));

  assert.equal(summary.deferredSpawns, 3);
  assert.equal(splitProjectiles.length, 3);
  assert.ok(splitProjectiles.every(({ type, splitCount }) => type === 'prism-shard' && splitCount === 0));
});

test('perfect phase consumes one collision, refunds one charge, buffs cadence, and protects hull', () => {
  const world = createEntityWorld({ capacities: { player: 1, enemyProjectile: 2 } });
  const playerId = world.spawn('player', {
    x: 0,
    y: 0,
    radius: 0.5,
    team: 1,
    collidable: true,
    perfectPhaseWindow: 0.1,
    dashCharges: [0, 1],
    cooldown: 0.55,
  });
  world.spawn('enemyProjectile', { x: 0, y: 0, damage: 1, radius: 0.2, team: 2, collidable: true });
  let hullDamage = 0;
  const events = createEvents();
  const summary = resolveCollisions(world, { damageHull(amount) { hullDamage += amount; return true; } }, 1 / 60, events);
  const player = world.get(playerId);

  assert.equal(hullDamage, 0);
  assert.equal(summary.perfectPhases, 1);
  assert.equal(player.perfectPhaseWindow, 0);
  assert.equal(player.dashCharge0, 0.35);
  assert.equal(player.dashCharge1, 1);
  assert.equal(player.fireTimer, 0.8);
  assert.ok(player.cooldown <= 0.55 * 0.75 + 1e-9);
  assert.equal(events.emitted.filter(({ type }) => type === 'perfectPhase').length, 1);
});

test('normal player hits aggregate through session hull authority once per step', () => {
  const world = createEntityWorld({ capacities: { player: 1, enemyProjectile: 3 } });
  world.spawn('player', { x: 0, y: 0, radius: 0.5, team: 1, collidable: true });
  world.spawn('enemyProjectile', { x: 0, y: 0, damage: 1, radius: 0.2, team: 2, collidable: true });
  world.spawn('enemyProjectile', { x: 0.1, y: 0, damage: 2, radius: 0.2, team: 2, collidable: true });
  const calls = [];
  const summary = resolveCollisions(world, { damageHull(amount) { calls.push(amount); return true; } }, 1 / 60, createEvents());

  assert.deepEqual(calls, [3]);
  assert.equal(summary.playerDamage, 3);
  assert.equal(world.query('enemyProjectile').length, 0);
});

test('the phase protection gained by a perfect avoid covers the rest of the same finite pass', () => {
  const world = createEntityWorld({ capacities: { player: 1, enemyProjectile: 2 } });
  world.spawn('player', {
    x: 0, y: 0, radius: 0.5, team: 1, collidable: true, perfectPhaseWindow: 0.1, dashCharges: [0, 1],
  });
  world.spawn('enemyProjectile', { x: 0, y: 0, damage: 1, radius: 0.2, team: 2, collidable: true });
  world.spawn('enemyProjectile', { x: 0, y: 0, damage: 2, radius: 0.2, team: 2, collidable: true });
  const calls = [];
  const summary = resolveCollisions(world, { damageHull(amount) { calls.push(amount); return true; } }, 1 / 60, createEvents());

  assert.deepEqual(calls, []);
  assert.equal(summary.perfectPhases, 1);
  assert.equal(summary.playerDamage, 0);
  assert.equal(world.query('enemyProjectile').length, 0);
});

test('enemy projectiles damage allied objectives without emitting friendly weapon feedback', () => {
  const world = createEntityWorld({ capacities: { objective: 1, enemyProjectile: 1 } });
  const objectiveId = world.spawn('objective', {
    x: 1, y: 1, hp: 4, maxHp: 4, radius: 0.6, team: 1, collidable: true,
  });
  world.spawn('enemyProjectile', {
    x: 1, y: 1, damage: 1.5, radius: 0.2, team: 2, collidable: true, weaponId: 'enemy-bolt',
  });
  const events = createEvents();
  const summary = resolveCollisions(world, { damageHull() { return false; } }, 1 / 60, events);

  assert.equal(world.get(objectiveId).hp, 2.5);
  assert.equal(summary.damage, 1.5);
  assert.equal(events.emitted.some(({ type }) => type === 'weaponHit'), false);
});

test('friendly projectiles ignore allied objectives and damage hostile objective cores', () => {
  const world = createEntityWorld({ capacities: { objective: 2, friendlyProjectile: 2 } });
  const allied = world.spawn('objective', { x: 0, y: 0, hp: 3, radius: 0.5, team: 1, objective: true, collidable: true });
  const hostile = world.spawn('objective', { x: 3, y: 0, hp: 3, radius: 0.5, team: 2, objective: true, collidable: true });
  world.spawn('friendlyProjectile', { x: 0, y: 0, damage: 1, radius: 0.1, team: 1, collidable: true });
  world.spawn('friendlyProjectile', { x: 3, y: 0, damage: 1, radius: 0.1, team: 1, collidable: true });
  resolveCollisions(world, null, 1 / 60, createEvents());
  assert.equal(world.get(allied).hp, 3);
  assert.equal(world.get(hostile).hp, 2);
});

test('pickup collection and objective overlap are finite deferred outcomes', () => {
  const world = createEntityWorld({ capacities: { player: 1, pickup: 1, objective: 1 } });
  world.spawn('player', { x: 0, y: 0, radius: 0.5, team: 1, collidable: true });
  const pickupId = world.spawn('pickup', { x: 0, y: 0, radius: 0.3, value: 2, collidable: true });
  const objectiveId = world.spawn('objective', {
    x: 0,
    y: 0,
    radius: 1,
    progress: 0,
    duration: 0.02,
    objectiveType: 'capture',
    collidable: true,
  });
  const events = createEvents();
  const summary = resolveCollisions(world, { damageHull() { return false; } }, 1 / 60, events);

  assert.equal(world.get(pickupId), null);
  assert.ok(world.get(objectiveId).progress > 0);
  assert.equal(summary.pickups, 1);
  assert.equal(summary.objectiveOverlaps, 1);
});

test('swept projectile collision catches tunneling and stays finite for zero-length and extreme segments', () => {
  assert.equal(sweptCircleHit({ previousX: -10, previousY: 0, x: 10, y: 0, radius: 0.1 }, {
    x: 0, y: 0, radius: 0.4,
  }), true);
  assert.equal(sweptCircleHit({ previousX: 2, previousY: 2, x: 2, y: 2, radius: 0.1 }, {
    x: 2.2, y: 2, radius: 0.2,
  }), true);
  assert.equal(sweptCircleHit({ previousX: -Number.MAX_VALUE, previousY: 0, x: Number.MAX_VALUE, y: 0, radius: 1 }, {
    x: 0, y: 0, radius: 1,
  }), false);
  assert.equal(sweptCircleHit({ previousX: -1e150, previousY: 0, x: 1e150, y: 0, radius: 1 }, {
    x: 0, y: 0, radius: 1,
  }), true);
});

test('friendly and enemy projectiles use their full fixed-step sweep without duplicate hits', () => {
  const world = createEntityWorld({ capacities: { player: 1, enemy: 1, friendlyProjectile: 1, enemyProjectile: 1 } });
  const enemyId = world.spawn('enemy', { x: 0, y: 0, hp: 4, radius: 0.4, team: 2, collidable: true });
  world.spawn('player', { x: 0, y: 3, radius: 0.4, team: 1, collidable: true });
  world.spawn('friendlyProjectile', {
    previousX: -5, previousY: 0, x: 5, y: 0, damage: 1, radius: 0.1, team: 1, collidable: true,
  });
  world.spawn('enemyProjectile', {
    previousX: 0, previousY: -3, x: 0, y: 6, damage: 2, radius: 0.1, team: 2, collidable: true,
  });
  const damage = [];
  const summary = resolveCollisions(world, { damageHull(amount) { damage.push(amount); return true; } }, 1 / 60, createEvents());
  assert.equal(world.get(enemyId).hp, 3);
  assert.deepEqual(damage, [2]);
  assert.equal(summary.hits, 1);
});

test('body contact requires an explicit contact-damaging proxy contract', () => {
  const world = createEntityWorld({ capacities: { player: 1, enemy: 2 } });
  world.spawn('player', { x: 0, y: 0, radius: 0.4, team: 1, collidable: true });
  world.spawn('enemy', {
    x: 0, y: 0, hp: 2, radius: 1, contactRadius: 1, damage: 5, team: 2, collidable: true, contactDamaging: false,
  });
  let damage = 0;
  resolveCollisions(world, { damageHull(amount) { damage += amount; return true; } }, 1 / 60, createEvents());
  assert.equal(damage, 0);
  const enemyId = world.query('enemy').at(0);
  world.write(enemyId, { contactDamaging: true });
  resolveCollisions(world, { damageHull(amount) { damage += amount; return true; } }, 1 / 60, createEvents());
  assert.equal(damage, 5);
});

test('lethal hits protect every committed enemy active state from collision-pass despawn', () => {
  for (const state of ['strike-dash', 'beam-active', 'detonate', 'wall-active', 'counter-active']) {
    const world = createEntityWorld({ capacities: { enemy: 1, friendlyProjectile: 1 } });
    const enemyId = world.spawn('enemy', {
      x: 0, y: 0, hp: 1, maxHp: 1, radius: 0.5, team: 2,
      state, executingTelegraph: false, collidable: true, weakPoint: true,
    });
    world.spawn('friendlyProjectile', {
      x: 0, y: 0, previousX: 0, previousY: 0, damage: 5, radius: 0.2,
      team: 1, collidable: true, weaponId: 'pulse-cannon',
    });
    const summary = resolveCollisions(world, null, 1 / 60, createEvents());
    assert.equal(summary.damageRecords[0].executionProtected, true, state);
    assert.equal(summary.damageRecords[0].destroyed, false, state);
    assert.equal(world.get(enemyId).hp, 0, state);
    assert.equal(world.get(enemyId).state, state);
  }
});

test('a lethally hit committed dash retains authored contact damage until its execution ends', () => {
  const world = createEntityWorld({ capacities: { player: 1, enemy: 1 } });
  const playerId = world.spawn('player', {
    x: 0, y: 0, hp: 5, maxHp: 5, radius: 0.4, team: 1, collidable: true,
  });
  const enemies = createEnemySystem({ random: () => 0.5 });
  const enemyId = enemies.spawnRole(world, 'interceptor', {
    x: 0, y: 0, hp: 0, maxHp: 2, state: 'cut-dash', stateTimer: 0.1,
  });
  world.write(enemyId, {
    vx: 0, vy: 0, damage: 0.3, collidable: true, contactDamaging: true,
  });
  const hullHits = [];
  const session = { damageHull(amount) { hullHits.push(amount); return true; } };
  const events = createEvents();

  resolveCollisions(world, session, 1 / 60, events);
  resolveCollisions(world, session, 1 / 60, events);
  assert.deepEqual(hullHits, [0.3]);
  assert.equal(world.get(enemyId).hitCooldown, 2);

  enemies.update(world, world.get(playerId), null, 0.1, events);
  const ended = world.get(enemyId);
  assert.equal(ended.state, 'approach');
  assert.equal(ended.contactDamaging, false);
  world.write(enemyId, { contactDamaging: true, damage: 5, hitCooldown: 0 });
  resolveCollisions(world, session, 1 / 60, events);
  assert.deepEqual(hullHits, [0.3]);

  enemies.update(world, world.get(playerId), null, 1 / 60, events);
  assert.equal(world.get(enemyId), null);
  assert.equal(events.emitted.filter(({ type, payload }) => type === 'enemy:destroyed' && payload.id === enemyId).length, 1);
});

test('collision event stats only count accepted weapon-hit events', () => {
  const world = createEntityWorld({ capacities: { enemy: 1, friendlyProjectile: 1 } });
  world.spawn('enemy', { x: 0, y: 0, hp: 2, team: 2, collidable: true });
  world.spawn('friendlyProjectile', { x: 0, y: 0, previousX: 0, previousY: 0, damage: 1, team: 1, collidable: true });
  const system = createCollisionSystem();
  system.resolve(world, null, 1 / 60, { emit() { return false; } });
  assert.equal(system.getStats().hitEvents, 0);
});
