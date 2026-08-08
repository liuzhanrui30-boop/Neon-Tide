import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createEntityWorld } from '../src/game/entity-world.js';
import { createEntityRenderer } from '../src/render/entity-renderer.js';
import { createCollisionSystem } from '../src/systems/collision-system.js';
import {
  ENEMY_ROLE_IDS,
  ENEMY_ROLES,
  getEnemyRole,
  validateEnemyRoster,
} from '../src/content/enemies.js';
import {
  createEnemySystem,
  predictHunterTarget,
  selectInterceptorCut,
} from '../src/systems/enemy-system.js';

const STEP = 1 / 60;

function sink() {
  const events = [];
  return { events, emit(type, payload) { events.push({ type, payload }); return true; } };
}

function fixture(capacities = {}) {
  const world = createEntityWorld({ capacities: {
    enemy: 56, enemyProjectile: 96, warning: 96, enemyHazard: 96, ...capacities,
  } });
  const playerId = world.spawn('player', {
    x: 0, y: 0, previousX: 0, previousY: 0, vx: 2, vy: 0,
    hp: 5, maxHp: 5, radius: 0.4, team: 1, collidable: true,
  });
  return { world, playerId, player: () => world.get(playerId), events: sink() };
}

function step(system, setup, seconds, objective = null) {
  const count = Math.ceil(seconds / STEP);
  let summary = null;
  for (let index = 0; index < count; index += 1) {
    summary = system.update(setup.world, setup.player(), objective, STEP, setup.events);
  }
  return summary;
}

function entities(world, kind) {
  return [...world.query(kind)].map((id) => world.get(id)).filter(Boolean);
}

test('the immutable roster defines exactly eight roles with locked movement, cost, gate, warning, cap and counterplay data', () => {
  assert.deepEqual(ENEMY_ROLE_IDS, [
    'hunter', 'interceptor', 'striker', 'lancer', 'swarm', 'mine', 'warden', 'bulwark',
  ]);
  assert.equal(validateEnemyRoster(ENEMY_ROLES), true);
  assert.equal(Object.isFrozen(ENEMY_ROLES), true);
  for (const id of ENEMY_ROLE_IDS) {
    const role = getEnemyRole(id);
    assert.equal(Object.isFrozen(role), true);
    assert.deepEqual(Object.keys(role).sort(), [
      'activeCap', 'blockedAreaCost', 'color', 'counterplay', 'damage', 'highDamage', 'hp', 'id',
      'minChapter', 'projectileCost', 'radius', 'speedRange', 'telegraphSeconds', 'threatCost',
    ].sort());
    assert.ok(role.speedRange[0] >= (id === 'interceptor' ? 5.2 : 3.2));
    assert.ok(role.speedRange[1] <= (id === 'interceptor' ? 7 : 5));
    assert.ok(role.speedRange[1] >= role.speedRange[0]);
    assert.ok(Number.isInteger(role.threatCost) && role.threatCost > 0);
    assert.ok(Number.isInteger(role.minChapter) && role.minChapter >= 0);
    assert.ok(Number.isInteger(role.activeCap) && role.activeCap > 0);
    assert.ok(role.counterplay.length >= 16);
    if (role.highDamage) assert.ok(role.telegraphSeconds >= 0.55);
  }
  assert.throws(() => { ENEMY_ROLES.hunter.activeCap = 99; }, TypeError);
});

test('Hunter predicts bounded velocity lead and never reads future frames', () => {
  const target = predictHunterTarget(
    { x: -5, y: 0, speed: 4 },
    { x: 1, y: 2, vx: 100, vy: -100 },
  );
  assert.ok(Math.hypot(target.x - 1, target.y - 2) <= 3.000001);
  assert.ok(target.x > 1 && target.y < 2);
  const stopped = predictHunterTarget({ x: -5, y: 0, speed: 4 }, { x: 1, y: 2, vx: 0, vy: 0 });
  assert.deepEqual(stopped, { x: 1, y: 2, leadSeconds: 0.75 });
});

test('Interceptor selects a bounded 35-55 degree anti-orbit cut and exposes the angle before acceleration', () => {
  const cut = selectInterceptorCut(
    { x: -8, y: 0 },
    { x: 6, y: 0, vx: 0, vy: 4 },
    { direction: 1, orbitPressure: 2, normalizedAngle: 0, normalizedRadius: 0.9 },
    () => 0.5,
  );
  assert.ok(cut.angleDegrees >= 35 && cut.angleDegrees <= 55);
  assert.equal(cut.direction, 1);
  assert.ok(Math.abs(cut.x) <= 9.2 && Math.abs(cut.y) <= 5.5);

  const setup = fixture();
  const system = createEnemySystem({ random: () => 0.5 });
  const id = system.spawnRole(setup.world, 'interceptor', { x: -8, y: 0 });
  system.update(setup.world, setup.player(), { antiOrbit: { direction: 1, orbitPressure: 2 } }, STEP, setup.events);
  const enemy = setup.world.get(id);
  assert.equal(enemy.state, 'cut-telegraph');
  assert.ok(enemy.value >= 35 && enemy.value <= 55);
  assert.equal(enemy.executingTelegraph, true);
  assert.ok(entities(setup.world, 'warning').some(({ ownerId, collidable }) => ownerId === id && !collidable));
});

test('Striker warnings own independent progress/material slots and keep all three candidate lines visible', () => {
  const setup = fixture();
  const system = createEnemySystem({ random: () => 0.25 });
  const first = system.spawnRole(setup.world, 'striker', { x: -6, y: -1, stateTimer: 0 });
  step(system, setup, 0.08);
  const second = system.spawnRole(setup.world, 'striker', { x: 6, y: 1, stateTimer: 0 });
  step(system, setup, 0.08);
  const warnings = entities(setup.world, 'warning').filter(({ type }) => type === 'striker-line');
  assert.equal(warnings.filter(({ ownerId }) => ownerId === first).length, 3);
  assert.equal(warnings.filter(({ ownerId }) => ownerId === second).length, 3);
  const firstProgress = warnings.find(({ ownerId }) => ownerId === first).progress;
  const secondProgress = warnings.find(({ ownerId }) => ownerId === second).progress;
  assert.notEqual(firstProgress, secondProgress);
  assert.ok(warnings.every(({ opacity, collidable }) => opacity > 0 && !collidable));

  const scene = new THREE.Scene();
  const renderer = createEntityRenderer({ scene, capacities: { enemy: 56, enemyProjectile: 96, warning: 96, enemyHazard: 96 } });
  renderer.sync(setup.world, 1);
  const stats = renderer.getStats();
  assert.equal(stats.pools.warning.count, warnings.length);
  assert.equal(stats.warningVisibility.hiddenActive, 0);
  assert.ok(stats.ownership.materials >= setup.world.getStats().pools.warning.capacity);
  renderer.dispose();
});

test('Lancer beam groups preserve a safe sector and obey the fixed enemy projectile cap', () => {
  const setup = fixture({ enemyProjectile: 5 });
  const system = createEnemySystem({ random: () => 0.5, projectileCap: 5 });
  const lancer = system.spawnRole(setup.world, 'lancer', { x: -7, y: 0, stateTimer: 0 });
  step(system, setup, getEnemyRole('lancer').telegraphSeconds + 0.15);
  const hazards = entities(setup.world, 'enemyHazard').filter(({ ownerId }) => ownerId === lancer);
  const safe = hazards.find(({ role, collidable }) => role === 'safe-sector' && !collidable);
  assert.ok(safe);
  assert.ok(hazards.some(({ collidable }) => collidable));
  assert.ok(hazards.filter(({ collidable }) => collidable)
    .every((node) => Math.hypot(node.x - safe.x, node.y - safe.y) >= safe.radius + node.radius));
  assert.ok(setup.world.query('enemyProjectile').length <= 5);
});

test('Swarm alternates formation split and merge instead of collapsing into one pursuit state', () => {
  const setup = fixture();
  const system = createEnemySystem({ random: () => 0.5 });
  const ids = [0, 1, 2].map((index) => system.spawnRole(setup.world, 'swarm', {
    x: -7, y: index - 1, parentId: 77, variantIndex: index,
  }));
  const seen = new Set();
  for (let index = 0; index < 240; index += 1) {
    system.update(setup.world, setup.player(), null, STEP, setup.events);
    for (const id of ids) seen.add(setup.world.get(id)?.state);
  }
  assert.ok(seen.has('formation-split'));
  assert.ok(seen.has('formation-merge'));
  assert.ok(ids.every((id) => Number.isFinite(setup.world.get(id)?.x)));
});

test('spawnWave materializes exactly the director-selected roles without hidden swarm cap inflation', () => {
  const setup = fixture({ enemy: 4 });
  const system = createEnemySystem({ random: () => 0.5 });
  const selected = ['swarm', 'hunter', 'swarm', 'interceptor'];
  const ids = system.spawnWave(setup.world, selected);
  assert.equal(ids.length, selected.length);
  assert.equal(setup.world.query('enemy').length, selected.length);
  assert.deepEqual(ids.map((id) => setup.world.get(id).role), selected);
});

test('runtime attack admission preserves the simultaneous high-damage warning cap after spawning', () => {
  const setup = fixture();
  const system = createEnemySystem({ random: () => 0.5, warningCap: 2 });
  system.spawnRole(setup.world, 'interceptor', { x: -7, y: 0 });
  system.spawnRole(setup.world, 'striker', { x: 7, y: 1, stateTimer: 0 });
  system.spawnRole(setup.world, 'lancer', { x: 7, y: -1, stateTimer: 0 });
  system.update(setup.world, setup.player(), null, STEP, setup.events);
  const warnedOwners = new Set(entities(setup.world, 'warning')
    .filter(({ role }) => ENEMY_ROLES[role]?.highDamage)
    .map(({ ownerId }) => ownerId));
  assert.equal(warnedOwners.size, 2);
  assert.equal(entities(setup.world, 'enemy').filter(({ executingTelegraph }) => executingTelegraph).length, 2);
});

test('Mine chains never explode in the trigger frame and retain at least the authored delayed warning', () => {
  const setup = fixture();
  const system = createEnemySystem({ random: () => 0.5 });
  const first = system.spawnRole(setup.world, 'mine', { x: 1, y: 0, state: 'arming', stateTimer: 0.01 });
  const second = system.spawnRole(setup.world, 'mine', { x: 2.8, y: 0, stateTimer: 5 });
  system.update(setup.world, setup.player(), null, STEP, setup.events);
  const chained = setup.world.get(second);
  assert.equal(setup.world.get(first).state, 'detonate');
  assert.equal(chained.state, 'chain-telegraph');
  assert.ok(chained.stateTimer >= 0.45 - 1e-9);
  assert.equal(entities(setup.world, 'enemyHazard').some(({ ownerId }) => ownerId === second), false);
  step(system, setup, 0.3);
  assert.equal(setup.world.get(second).state, 'chain-telegraph');
});

test('Warden moving walls always expose a visible non-damaging gap wider than the player body', () => {
  const setup = fixture();
  const system = createEnemySystem({ random: () => 0.5 });
  const warden = system.spawnRole(setup.world, 'warden', { x: 0, y: 5, stateTimer: 0 });
  step(system, setup, getEnemyRole('warden').telegraphSeconds + 0.08);
  const wall = entities(setup.world, 'enemyHazard').filter(({ ownerId }) => ownerId === warden);
  const gap = wall.find(({ role }) => role === 'warden-gap');
  assert.ok(gap && !gap.collidable && gap.opacity > 0);
  assert.ok(gap.radius >= 1.2);
  assert.ok(wall.filter(({ collidable }) => collidable)
    .every((node) => Math.hypot(node.x - gap.x, node.y - gap.y) >= gap.radius + node.radius));
  const before = wall.find(({ collidable }) => collidable).x;
  step(system, setup, 0.2);
  const after = entities(setup.world, 'enemyHazard').find(({ ownerId, collidable }) => ownerId === warden && collidable).x;
  assert.notEqual(after, before);
});

test('Bulwark armor accepts one dash/Tide Lance counter token per attack and gives a fair telegraph', () => {
  const setup = fixture();
  const system = createEnemySystem({ random: () => 0.5 });
  const id = system.spawnRole(setup.world, 'bulwark', { x: 0.4, y: 0, hp: 6, maxHp: 6 });
  setup.world.write(setup.playerId, { dashTimer: 0.2, sequence: 7, attackKind: 'dash' });
  system.update(setup.world, setup.player(), null, STEP, setup.events);
  const first = setup.world.get(id);
  assert.equal(first.state, 'counter-telegraph');
  assert.equal(first.counterToken, 7);
  assert.ok(first.telegraphTimer >= getEnemyRole('bulwark').telegraphSeconds - STEP - 1e-9);
  const hpAfterFirst = first.hp;
  system.update(setup.world, setup.player(), null, STEP, setup.events);
  assert.equal(setup.world.get(id).hp, hpAfterFirst);
  assert.ok(entities(setup.world, 'warning').some(({ ownerId, opacity }) => ownerId === id && opacity > 0));
});

test('execution protection lets a committed high-damage telegraph finish before pooled cleanup', () => {
  const setup = fixture();
  const system = createEnemySystem({ random: () => 0.5 });
  const id = system.spawnRole(setup.world, 'striker', { x: 0, y: 1, hp: 1, maxHp: 1, stateTimer: 0 });
  step(system, setup, 0.05);
  const projectile = setup.world.spawn('friendlyProjectile', {
    x: 0, y: 1, previousX: 0, previousY: 1, damage: 5, radius: 0.2,
    team: 1, collidable: true, weaponId: 'pulse-cannon', type: 'pulse-round',
  });
  assert.ok(projectile);
  const collision = createCollisionSystem();
  const summary = collision.resolve(setup.world, { damageHull() {} }, STEP, setup.events);
  assert.equal(summary.damageRecords[0].executionProtected, true);
  assert.ok(setup.world.get(id));
  assert.equal(setup.world.get(id).hp, 0);
  step(system, setup, getEnemyRole('striker').telegraphSeconds + 0.7);
  assert.equal(setup.world.get(id), null);
});
