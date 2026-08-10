import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createEntityWorld } from '../src/game/entity-world.js';
import { createEntityRenderer } from '../src/render/entity-renderer.js';
import { createCollisionSystem, resolveCollisions } from '../src/systems/collision-system.js';
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
import { createWeaponSystem } from '../src/systems/weapon-system.js';

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

test('Interceptor fallback follows the natural angular-velocity sign in both rotation directions', () => {
  const counterClockwise = selectInterceptorCut(
    { x: -8, y: 0 }, { x: 5, y: 0, vx: 0, vy: 3 }, null, () => 0.5,
  );
  const clockwise = selectInterceptorCut(
    { x: -8, y: 0 }, { x: 5, y: 0, vx: 0, vy: -3 }, null, () => 0.5,
  );
  assert.equal(counterClockwise.direction, 1);
  assert.equal(clockwise.direction, -1);
  assert.ok(Math.atan2(counterClockwise.y, counterClockwise.x) > 0);
  assert.ok(Math.atan2(clockwise.y, clockwise.x) < 0);
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

test('Lancer preview covers the complete future damaging beam footprint including node radii', () => {
  const setup = fixture();
  setup.world.write(setup.playerId, { x: 8, y: 0, vx: 0, vy: 0 });
  const system = createEnemySystem({ random: () => 0.5 });
  const lancer = system.spawnRole(setup.world, 'lancer', { x: -8.8, y: 0, stateTimer: 0 });
  system.update(setup.world, setup.player(), null, STEP, setup.events);
  const preview = entities(setup.world, 'warning').find(({ ownerId, type }) => ownerId === lancer && type === 'lancer-beam');
  assert.ok(preview);
  step(system, setup, getEnemyRole('lancer').telegraphSeconds + STEP);
  const nodes = entities(setup.world, 'enemyHazard')
    .filter(({ ownerId, type, collidable }) => ownerId === lancer && type === 'lancer-beam-node' && collidable);
  assert.ok(nodes.length >= 8);
  const cos = Math.cos(preview.rotation);
  const sin = Math.sin(preview.rotation);
  for (const node of nodes) {
    const dx = node.x - preview.x;
    const dy = node.y - preview.y;
    const along = dx * cos + dy * sin;
    const across = -dx * sin + dy * cos;
    assert.ok(Math.abs(along) + node.radius <= preview.scaleX / 2 + 1e-9,
      `beam node escaped preview length: ${JSON.stringify({ preview, node })}`);
    assert.ok(Math.abs(across) + node.radius <= preview.scaleY / 2 + 1e-9,
      `beam node escaped preview width: ${JSON.stringify({ preview, node })}`);
  }
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

test('runtime enemy, warning, and projectile admission expose and enforce the supplied device caps', () => {
  const setup = fixture({ enemy: 8, enemyProjectile: 8 });
  const system = createEnemySystem({ random: () => 0.5, enemyCap: 2, warningCap: 2, projectileCap: 3 });
  assert.ok(system.spawnRole(setup.world, 'hunter', { x: -1, y: 0 }));
  assert.ok(system.spawnRole(setup.world, 'swarm', { x: 1, y: 0 }));
  assert.equal(system.spawnRole(setup.world, 'interceptor', { x: 0, y: 1 }), null);
  assert.equal(setup.world.query('enemy').length, 2);
  assert.deepEqual(system.getStats(setup.world).caps, { enemy: 2, projectile: 3, warning: 2 });
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

test('low hull and healing never cancel existing or newly committed body, projectile, or hazard damage', () => {
  const setup = fixture();
  setup.world.write(setup.playerId, { hp: 1, maxHp: 5, x: 8, y: 0 });
  const system = createEnemySystem({ random: () => 0.5 });
  const hunter = system.spawnRole(setup.world, 'hunter', { x: 0, y: 0 });
  const lancer = system.spawnRole(setup.world, 'lancer', { x: -8, y: 0, stateTimer: 0 });
  const existingProjectile = setup.world.spawn('enemyProjectile', {
    x: 0, y: 0, vx: 0, vy: 0, lifetime: 5, damage: 1, radius: 0.2,
    team: 2, collidable: true, contactDamaging: true,
  });
  system.update(setup.world, setup.player(), null, STEP, setup.events);
  step(system, setup, getEnemyRole('lancer').telegraphSeconds + STEP);
  const assertDangerous = () => {
    assert.equal(setup.world.get(hunter).contactDamaging, true);
    assert.equal(setup.world.get(existingProjectile).collidable, true);
    assert.ok(entities(setup.world, 'enemyProjectile')
      .filter(({ ownerId }) => ownerId === lancer)
      .every(({ collidable }) => collidable));
    assert.ok(entities(setup.world, 'enemyHazard')
      .filter(({ ownerId, role }) => ownerId === lancer && role !== 'safe-sector')
      .every(({ collidable, contactDamaging }) => collidable && contactDamaging));
  };
  assertDangerous();
  setup.world.write(setup.playerId, { hp: 5 });
  system.update(setup.world, setup.player(), null, STEP, setup.events);
  assertDangerous();
});

test('low-hull then healed collision probes still apply body, projectile, and hazard damage', () => {
  for (const kind of ['body', 'projectile', 'hazard']) {
    const setup = fixture();
    setup.world.write(setup.playerId, { hp: 1, maxHp: 5, x: 0, y: 0, invulnerable: false });
    const system = createEnemySystem({ random: () => 0.5 });
    let threatId = null;
    const spawnThreat = () => {
      if (kind === 'body') {
        threatId ??= system.spawnRole(setup.world, 'hunter', { x: 0, y: 0, speed: 3.2 });
      } else if (kind === 'projectile') {
        threatId = setup.world.spawn('enemyProjectile', {
          x: 0, y: 0, previousX: 0, previousY: 0, damage: 0.35, radius: 0.2,
          lifetime: 2, team: 2, collidable: true, contactDamaging: true,
        });
      } else {
        threatId ??= setup.world.spawn('enemyHazard', {
          x: 0, y: 0, previousX: 0, previousY: 0, damage: 0.35, radius: 0.5,
          lifetime: 2, team: 2, collidable: true, contactDamaging: true,
        });
      }
    };
    spawnThreat();
    system.update(setup.world, setup.player(), null, STEP, setup.events);
    const damage = [];
    resolveCollisions(setup.world, { damageHull(amount) { damage.push(amount); return true; } }, STEP, setup.events);
    assert.ok(damage[0] > 0, `${kind} did not damage at low hull`);

    setup.world.write(setup.playerId, { hp: 5 });
    if (kind === 'projectile') spawnThreat();
    else setup.world.write(threatId, { hitCooldown: 0 });
    system.update(setup.world, setup.player(), null, STEP, setup.events);
    resolveCollisions(setup.world, { damageHull(amount) { damage.push(amount); return true; } }, STEP, setup.events);
    assert.ok(damage[1] > 0, `${kind} did not damage after healing`);
  }
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
  assert.ok(chained.stateTimer >= 0.55 - 1e-9);
  assert.equal(entities(setup.world, 'enemyHazard').some(({ ownerId }) => ownerId === second), false);
  step(system, setup, 0.3);
  assert.equal(setup.world.get(second).state, 'chain-telegraph');
});

test('natural Mine chains preserve a longer warning already in progress', () => {
  const setup = fixture();
  const system = createEnemySystem({ random: () => 0.5 });
  const source = system.spawnRole(setup.world, 'mine', { x: 1, y: 0, state: 'arming', stateTimer: 0.01 });
  const chained = system.spawnRole(setup.world, 'mine', { x: 2.8, y: 0, state: 'deploy', stateTimer: 0 });
  system.update(setup.world, setup.player(), null, STEP, setup.events);
  assert.equal(setup.world.get(source).state, 'detonate');
  assert.equal(setup.world.get(chained).state, 'chain-telegraph');
  assert.ok(setup.world.get(chained).stateTimer >= getEnemyRole('mine').telegraphSeconds - STEP - 1e-9);
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

test('Bulwark consumes one collision-authored dash armor-break token and gives a fair telegraph', () => {
  const setup = fixture();
  const system = createEnemySystem({ random: () => 0.5 });
  const collision = createCollisionSystem();
  const id = system.spawnRole(setup.world, 'bulwark', { x: 0.4, y: 0, hp: 6, maxHp: 6 });
  setup.world.write(setup.playerId, {
    previousX: -0.2, previousY: 0, x: 0, y: 0,
    dashTimer: 0.2, sequence: 7, attackKind: 'dash', invulnerable: true,
  });
  const collisionSummary = collision.resolve(setup.world, { damageHull() {} }, STEP, setup.events);
  assert.equal(collisionSummary.damageRecords.length, 1);
  assert.equal(collisionSummary.damageRecords[0].weaponId, 'phase-dash');
  assert.equal(collisionSummary.damageRecords[0].amount, 1);
  system.update(setup.world, setup.player(), null, STEP, setup.events);
  const first = setup.world.get(id);
  assert.equal(first.state, 'counter-telegraph');
  assert.equal(first.counterToken, first.armorBreakToken);
  assert.equal(first.hp, 5);
  assert.equal(first.armored, false);
  assert.equal(first.weakPoint, true);
  assert.ok(first.telegraphTimer >= getEnemyRole('bulwark').telegraphSeconds - STEP - 1e-9);
  const hpAfterFirst = first.hp;
  system.update(setup.world, setup.player(), null, STEP, setup.events);
  assert.equal(setup.world.get(id).hp, hpAfterFirst);
  assert.ok(entities(setup.world, 'warning').some(({ ownerId, opacity }) => ownerId === id && opacity > 0));
});

test('Bulwark Tide Lance armor break delegates the only HP write to CollisionSystem', () => {
  const setup = fixture();
  setup.world.write(setup.playerId, {
    x: 0, y: 0, previousX: 0, previousY: 0, vx: 0, vy: 0,
    attackKind: 'tide-lance', sequence: 41, directionX: 1, directionY: 0,
  });
  const enemySystem = createEnemySystem({ random: () => 0.5 });
  const weaponSystem = createWeaponSystem();
  const collisionSystem = createCollisionSystem();
  const id = enemySystem.spawnRole(setup.world, 'bulwark', { x: 3, y: 0, hp: 20, maxHp: 20 });

  weaponSystem.update(setup.world, setup.playerId, STEP, setup.events, {});
  const summary = collisionSystem.resolve(setup.world, { damageHull() {} }, STEP, setup.events, {});
  const records = summary.damageRecords.filter((record) => record.targetId === id);
  assert.equal(records.length, 1, JSON.stringify(summary.damageRecords));
  assert.equal(records[0].weaponId, 'tide-lance');
  assert.equal(records[0].hpBefore, 20);
  assert.equal(records[0].hpAfter, 16.8);
  assert.equal(records[0].armorBreak, true);
  const broken = setup.world.get(id);
  assert.equal(broken.hp, 16.8);
  assert.equal(broken.armored, false);
  assert.equal(broken.weakPoint, true);
  assert.equal(broken.state, 'chase');
  assert.ok(broken.armorBreakToken > 0);

  enemySystem.update(setup.world, setup.player(), null, STEP, setup.events);
  const counter = setup.world.get(id);
  assert.equal(counter.state, 'counter-telegraph');
  assert.equal(counter.counterToken, broken.armorBreakToken);
  assert.equal(counter.executingTelegraph, true);
});

test('Bulwark outside the real 7.2 Tide Lance ray keeps armor and starts no counter', () => {
  const setup = fixture();
  setup.world.write(setup.playerId, {
    x: 0, y: 0, previousX: 0, previousY: 0,
    attackKind: 'tide-lance', sequence: 51, directionX: 1, directionY: 0,
  });
  const enemySystem = createEnemySystem({ random: () => 0.5 });
  const weaponSystem = createWeaponSystem();
  const collisionSystem = createCollisionSystem();
  const id = enemySystem.spawnRole(setup.world, 'bulwark', { x: 10, y: 0, hp: 20, maxHp: 20 });

  weaponSystem.update(setup.world, setup.playerId, STEP, setup.events, {});
  const summary = collisionSystem.resolve(setup.world, { damageHull() {} }, STEP, setup.events, {});
  assert.equal(summary.damageRecords.filter((record) => record.targetId === id).length, 0);
  enemySystem.update(setup.world, setup.player(), null, STEP, setup.events);
  const enemy = setup.world.get(id);
  assert.equal(enemy.hp, 20);
  assert.equal(enemy.armored, true);
  assert.equal(enemy.weakPoint, false);
  assert.equal(enemy.state, 'chase');
  assert.equal(enemy.armorBreakToken, 0);
  assert.equal(entities(setup.world, 'warning').some(({ ownerId }) => ownerId === id), false);
});

test('Bulwark ignores fresh dash and Tide Lance tokens until the current counter wave resolves', () => {
  const setup = fixture();
  const system = createEnemySystem({ random: () => 0.5 });
  const collision = createCollisionSystem();
  const id = system.spawnRole(setup.world, 'bulwark', { x: 0.4, y: 0, hp: 12, maxHp: 12 });
  setup.world.write(setup.playerId, { dashTimer: 0.2, sequence: 1, attackKind: 'dash', invulnerable: true });
  collision.resolve(setup.world, { damageHull() {} }, STEP, setup.events);
  system.update(setup.world, setup.player(), null, STEP, setup.events);
  const warningIds = entities(setup.world, 'warning').filter(({ ownerId }) => ownerId === id).map(({ id: warningId }) => warningId);
  setup.world.write(setup.playerId, { dashTimer: 0.2, sequence: 2, attackKind: 'dash' });
  const duplicate = collision.resolve(setup.world, { damageHull() {} }, STEP, setup.events);
  assert.equal(duplicate.damageRecords.length, 0);
  system.update(setup.world, setup.player(), null, STEP, setup.events);
  const counterToken = setup.world.get(id).counterToken;
  assert.ok(counterToken > 0);
  assert.deepEqual(entities(setup.world, 'warning').filter(({ ownerId }) => ownerId === id).map(({ id: warningId }) => warningId), warningIds);
  step(system, setup, getEnemyRole('bulwark').telegraphSeconds + STEP);
  const waveIds = entities(setup.world, 'enemyHazard').filter(({ ownerId }) => ownerId === id).map(({ id: hazardId }) => hazardId);
  assert.equal(waveIds.length, 14);
  setup.world.write(setup.playerId, {
    attackKind: 'tide-lance', sequence: 3, directionX: 1, directionY: 0, dashTimer: 0,
  });
  system.update(setup.world, setup.player(), null, STEP, setup.events);
  assert.equal(setup.world.get(id).state, 'counter-active');
  assert.equal(setup.world.get(id).counterToken, counterToken);
  assert.deepEqual(entities(setup.world, 'enemyHazard').filter(({ ownerId }) => ownerId === id).map(({ id: hazardId }) => hazardId), waveIds);
  assert.equal(entities(setup.world, 'warning').some(({ ownerId }) => ownerId === id), false);
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

test('execution protection retains every committed active attack owner until its attack resolves exactly once', () => {
  const cases = [
    ['striker', 'strike-dash'],
    ['lancer', 'beam-active'],
    ['mine', 'detonate'],
    ['warden', 'wall-active'],
    ['bulwark', 'counter-active'],
  ];
  for (const [role, activeState] of cases) {
    const setup = fixture();
    const system = createEnemySystem({ random: () => 0.5 });
    const id = system.spawnRole(setup.world, role, {
      x: role === 'lancer' ? -7 : 0.4, y: role === 'warden' ? 5 : 0,
      hp: role === 'bulwark' ? 8 : 2, maxHp: role === 'bulwark' ? 8 : 2,
      stateTimer: 0,
    });
    if (role === 'bulwark') {
      setup.world.write(setup.playerId, {
        dashTimer: 0.2, sequence: 9, attackKind: 'dash', invulnerable: true,
      });
      createCollisionSystem().resolve(setup.world, { damageHull() {} }, STEP, setup.events);
      system.update(setup.world, setup.player(), null, STEP, setup.events);
      setup.world.write(setup.playerId, { dashTimer: 0, attackKind: null });
    } else {
      system.update(setup.world, setup.player(), null, STEP, setup.events);
    }
    const deadline = 180;
    for (let frame = 0; frame < deadline && setup.world.get(id)?.state !== activeState; frame += 1) {
      system.update(setup.world, setup.player(), null, STEP, setup.events);
    }
    const active = setup.world.get(id);
    assert.equal(active?.state, activeState, `${role} never entered ${activeState}`);
    const ownedHazards = entities(setup.world, 'enemyHazard')
      .filter(({ ownerId }) => ownerId === id)
      .map(({ id: hazardId }) => hazardId);
    if (role !== 'striker') assert.ok(ownedHazards.length > 0, `${role} active state has no committed hazards`);
    setup.world.write(id, { hp: 0 });
    system.update(setup.world, setup.player(), null, STEP, setup.events);
    assert.ok(setup.world.get(id), `${role} owner disappeared during ${activeState}`);
    assert.ok(ownedHazards.every((hazardId) => setup.world.get(hazardId)), `${role} hazards disappeared before owner resolution`);
    step(system, setup, active.stateTimer + 0.25);
    assert.equal(setup.world.get(id), null, `${role} owner did not clean after ${activeState}`);
    assert.ok(ownedHazards.every((hazardId) => setup.world.get(hazardId) === null), `${role} hazards survived owner cleanup`);
    assert.equal(setup.events.events.filter(({ type, payload }) => type === 'enemy:destroyed' && payload.id === id).length, 1);
  }
});

test('fixed-step enemy updates reuse their compact result and avoid normalize/prediction objects in hot paths', () => {
  const setup = fixture();
  const system = createEnemySystem({ random: () => 0.5 });
  system.spawnRole(setup.world, 'hunter', { x: -5, y: 0 });
  const first = system.update(setup.world, setup.player(), null, STEP, setup.events);
  for (let index = 0; index < 600; index += 1) {
    assert.equal(system.update(setup.world, setup.player(), null, STEP, setup.events), first);
  }
  const source = readFileSync(new URL('../src/systems/enemy-system.js', import.meta.url), 'utf8');
  const hunterBody = source.match(/function updateHunter[\s\S]*?\n  }/)?.[0] ?? '';
  const steerBody = source.match(/function steer[\s\S]*?\n  }/)?.[0] ?? '';
  assert.equal(hunterBody.includes('predictHunterTarget('), false);
  assert.equal(steerBody.includes('normalize('), false);
});
