import test from 'node:test';
import assert from 'node:assert/strict';
import { createEntityWorld } from '../src/game/entity-world.js';
import {
  circleOrientedBoxHit,
  createCollisionSystem,
  resolveCollisions,
  sweptCircleHit,
} from '../src/systems/collision-system.js';
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

test('every real perfect-phase collision family consumes the upgraded fire-surge multiplier', () => {
  const collisionFamilies = [
    ['enemyProjectile', { damage: 1 }],
    ['enemy', { hp: 3, damage: 1, contactDamaging: true }],
    ['objective', { hp: 3, damage: 1, contactDamaging: true }],
    ['enemyHazard', { hp: 3, damage: 1, contactDamaging: true }],
  ];
  for (const [kind, patch] of collisionFamilies) {
    const world = createEntityWorld({ capacities: { player: 1, [kind]: 2 } });
    const playerId = world.spawn('player', {
      x: 0, y: 0, radius: 0.5, team: 1, collidable: true,
      perfectPhaseWindow: 0.1, dashCharges: [0, 1], cooldown: 0.55,
    });
    world.spawn(kind, {
      x: 0, y: 0, radius: 0.3, team: 2, collidable: true, ...patch,
    });
    const events = createEvents();
    const summary = createCollisionSystem().resolve(
      world,
      { damageHull() { throw new Error(`${kind} bypassed perfect phase`); } },
      1 / 60,
      events,
      { perfectFireBuffMultiplier: 0.6 },
    );
    const player = world.get(playerId);
    assert.equal(summary.perfectPhases, 1, kind);
    assert.ok(player.cooldown <= 0.55 * 0.6 + 1e-9, kind);
    assert.equal(events.emitted.find(({ type }) => type === 'perfectPhase')?.payload.fireRateMultiplier, 0.6, kind);
  }
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

test('oriented Boss rectangles use the telegraphed footprint instead of an unrelated circle', () => {
  const box = {
    x: 0, y: 0, rotation: Math.PI / 4, scaleX: 8, scaleY: 0.6, variant: 'oriented-box',
  };
  const localToWorld = (along, across) => ({
    x: along * Math.cos(box.rotation) - across * Math.sin(box.rotation),
    y: along * Math.sin(box.rotation) + across * Math.cos(box.rotation),
    radius: 0.2,
  });
  assert.equal(circleOrientedBoxHit(localToWorld(3.5, 0.2), box), true);
  assert.equal(circleOrientedBoxHit(localToWorld(0, 0.8), box), false);

  const world = createEntityWorld({ capacities: { player: 1, enemyHazard: 1 } });
  world.spawn('player', {
    ...localToWorld(3.5, 0.2), hp: 3, maxHp: 3, team: 1, collidable: true,
  });
  world.spawn('enemyHazard', {
    ...box, radius: 0.3, team: 2, damage: 0.7,
    collidable: true, contactDamaging: true,
  });
  const hits = [];
  resolveCollisions(world, { damageHull(amount) { hits.push(amount); return true; } }, 1 / 60, createEvents());
  assert.deepEqual(hits, [0.7]);
  world.dispose();
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

test('one pierce means first hit plus one distinct traversal hit in swept order across target kinds', () => {
  const world = createEntityWorld({
    capacities: { bossPart: 1, enemy: 3, objective: 1, friendlyProjectile: 1 },
  });
  const hostileObjective = world.spawn('objective', {
    x: 1, y: 0, hp: 20, radius: 0.2, team: 2, objective: true, collidable: true,
  });
  const weakEnemy = world.spawn('enemy', {
    x: 2, y: 0, hp: 20, radius: 0.2, team: 2, weakPoint: true, collidable: true,
  });
  const bossPart = world.spawn('bossPart', {
    x: 3, y: 0, hp: 20, radius: 0.2, team: 2, weakPoint: true, collidable: true,
  });
  const laterEnemies = [4, 5].map((x) => world.spawn('enemy', {
    x, y: 0, hp: 20, radius: 0.2, team: 2, collidable: true,
  }));
  const projectileId = world.spawn('friendlyProjectile', {
    previousX: 0, previousY: 0, x: 6, y: 0, damage: 2, radius: 0.05,
    team: 1, collidable: true, piercing: true, pierceCount: 1,
    hitBudgetRemaining: 2, weakPointMultiplier: 2, objectiveDamageMultiplier: 1.5,
  });

  const summary = resolveCollisions(world, null, 1 / 60, createEvents());

  assert.deepEqual(summary.damageRecords.map(({ targetId }) => targetId), [hostileObjective, weakEnemy]);
  assert.equal(world.get(hostileObjective).hp, 17);
  assert.equal(world.get(weakEnemy).hp, 16);
  assert.equal(world.get(bossPart).hp, 20);
  assert.deepEqual(laterEnemies.map((id) => world.get(id).hp), [20, 20]);
  assert.equal(world.get(projectileId), null);
});

test('piercing projectiles remember distinct targets across fixed steps and never re-hit one body', () => {
  const world = createEntityWorld({ capacities: { enemy: 2, friendlyProjectile: 1 } });
  const first = world.spawn('enemy', { x: 1, y: 0, hp: 5, radius: 0.3, team: 2, collidable: true });
  const second = world.spawn('enemy', { x: 3, y: 0, hp: 5, radius: 0.3, team: 2, collidable: true });
  const projectile = world.spawn('friendlyProjectile', {
    previousX: 0, previousY: 0, x: 1.2, y: 0, damage: 1, radius: 0.1,
    team: 1, collidable: true, piercing: true, pierceCount: 1, hitBudgetRemaining: 2,
  });
  resolveCollisions(world, null, 1 / 60, createEvents());
  assert.equal(world.get(first).hp, 4);
  assert.equal(world.get(projectile).hitBudgetRemaining, 1);

  world.write(projectile, { previousX: 0.8, x: 3.4 });
  const secondPass = resolveCollisions(world, null, 1 / 60, createEvents());
  assert.deepEqual(secondPass.damageRecords.map(({ targetId }) => targetId), [second]);
  assert.equal(world.get(first).hp, 4);
  assert.equal(world.get(second).hp, 4);
  assert.equal(world.get(projectile), null);
});

test('follow-up arcs preserve upgraded radius, damage and bounded target dedupe', () => {
  const run = (chainRadius) => {
    const world = createEntityWorld({ capacities: { enemy: 2, friendlyProjectile: 4 } });
    const first = world.spawn('enemy', { x: 0, y: 0, hp: 10, radius: 0.3, team: 2, collidable: true });
    const second = world.spawn('enemy', { x: 5, y: 0, hp: 10, radius: 0.3, team: 2, collidable: true });
    world.spawn('friendlyProjectile', {
      x: 0, y: 0, previousX: 0, previousY: 0, vx: 1, vy: 0,
      damage: 2, radius: 0.1, team: 1, collidable: true,
      type: 'arc-chain', weaponId: 'arc-drones', chainCount: 1,
      chainDamageMultiplier: 0.9, chainRadius, hitBudgetRemaining: 1,
    });
    const summary = resolveCollisions(world, null, 1 / 60, createEvents());
    return {
      world,
      first,
      second,
      summary,
      chains: [...world.query('friendlyProjectile')].map((id) => world.get(id)),
    };
  };
  assert.equal(run(3).summary.deferredSpawns, 0);
  const upgraded = run(6);
  assert.equal(upgraded.summary.deferredSpawns, 1);
  assert.equal(upgraded.chains[0].targetId, upgraded.second);
  assert.equal(upgraded.chains[0].damage, 1.8);
  assert.equal(upgraded.chains[0].chainRadius, 6);
  assert.equal(upgraded.chains[0].hitTarget0, upgraded.first);
});

test('chainCount six hits the primary plus six distinct targets in stable order without repeats', () => {
  const world = createEntityWorld({ capacities: { enemy: 7, friendlyProjectile: 8 } });
  const targets = Array.from({ length: 7 }, (_, index) => world.spawn('enemy', {
    x: index,
    y: 0,
    hp: 10,
    radius: 0.2,
    team: 2,
    collidable: true,
  }));
  world.spawn('friendlyProjectile', {
    x: 0, y: 0, previousX: 0, previousY: 0, vx: 15, vy: 0,
    damage: 1, radius: 0.1, team: 1, collidable: true,
    type: 'arc-chain', weaponId: 'arc-drones', chainCount: 6,
    chainDamageMultiplier: 1, chainRadius: 2, hitBudgetRemaining: 1,
  });
  const order = [];
  for (let hop = 0; hop < 7; hop += 1) {
    const summary = resolveCollisions(world, null, 1 / 60, createEvents());
    order.push(...summary.damageRecords.map(({ targetId }) => targetId));
    const chainId = world.query('friendlyProjectile').at(0);
    if (!chainId) continue;
    const chain = world.get(chainId);
    const target = world.get(chain.targetId);
    world.write(chainId, {
      previousX: chain.x,
      previousY: chain.y,
      x: target.x,
      y: target.y,
    });
  }
  assert.deepEqual(order, targets);
  assert.equal(new Set(order).size, 7);
  assert.deepEqual(targets.map((id) => world.get(id).hp), Array(7).fill(9));
  assert.equal(world.query('friendlyProjectile').length, 0);
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
