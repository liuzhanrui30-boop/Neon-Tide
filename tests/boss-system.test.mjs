import test from 'node:test';
import assert from 'node:assert/strict';
import { ABYSS_MAW } from '../src/content/bosses/abyss-maw.js';
import { createEntityWorld } from '../src/game/entity-world.js';
import { createBossSystem } from '../src/systems/boss-system.js';
import { createEnemySystem } from '../src/systems/enemy-system.js';
import { createWeaponSystem } from '../src/systems/weapon-system.js';
import { createProjectileSystem } from '../src/systems/projectile-system.js';
import { createCollisionSystem } from '../src/systems/collision-system.js';
import { createCampaign } from '../src/game/campaign.js';
import { createEncounterDirector } from '../src/systems/encounter-director.js';
import { getEncounterTemplate } from '../src/content/encounters.js';
import { createGameSession } from '../src/game/session.js';
import { roomRequestForRunRoute } from '../src/game/run-route.js';

function createHarness(mode = 'standard') {
  const world = createEntityWorld();
  const playerId = world.spawn('player', {
    x: 0, y: 0, previousX: 0, previousY: 0, hp: 5, maxHp: 5,
    radius: 0.4, team: 1, collidable: true,
  });
  const emitted = [];
  const events = { emit(type, payload) { emitted.push({ type, payload }); return true; }, input: [] };
  const system = createBossSystem({ seed: 42, mode });
  const objective = system.start(ABYSS_MAW, { targetDurationSeconds: 100 });
  system.update({ world, player: world.get(playerId), damageRecords: [] }, 1 / 60, events);
  return { world, playerId, system, objective, events, emitted };
}

function moveToward(harness, targetX, targetY, { speed = 5, dt = 1 / 60 } = {}) {
  let guard = 0;
  while (guard < 480) {
    const player = harness.world.get(harness.playerId);
    const dx = targetX - player.x;
    const dy = targetY - player.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= speed * dt + 1e-9) {
      harness.world.write(harness.playerId, {
        previousX: player.x, previousY: player.y, x: targetX, y: targetY,
        vx: dx / dt, vy: dy / dt,
      });
    } else {
      const step = speed * dt;
      harness.world.write(harness.playerId, {
        previousX: player.x, previousY: player.y,
        x: player.x + dx / distance * step,
        y: player.y + dy / distance * step,
        vx: dx / distance * speed,
        vy: dy / distance * speed,
      });
    }
    const moved = harness.world.get(harness.playerId);
    assert.ok(Math.hypot(moved.x - moved.previousX, moved.y - moved.previousY) <= speed * dt + 1e-8);
    harness.system.update({ world: harness.world, player: moved, damageRecords: [] }, dt, harness.events);
    guard += 1;
    if (Math.hypot(targetX - moved.x, targetY - moved.y) <= 1e-6) return guard;
  }
  throw new Error(`natural route failed to reach ${targetX},${targetY}`);
}

function routeBreak(harness, repetitions = 12) {
  const points = [[7.4, 0], [-7.4, 0], [0, 5.2], [0, -5.2]];
  for (let index = 0; index <= repetitions; index += 1) {
    if (index > 0) moveToward(harness, 0, 0);
    const [x, y] = points[index % points.length];
    moveToward(harness, x, y);
  }
}

test('Abyss Maw data is deeply immutable and outcome-gated rather than timer-only', () => {
  assert.ok(Object.isFrozen(ABYSS_MAW));
  assert.ok(Object.isFrozen(ABYSS_MAW.phases));
  assert.ok(Object.isFrozen(ABYSS_MAW.attacks));
  assert.deepEqual(Object.keys(ABYSS_MAW.phases), ['hunt', 'suction', 'weakPoints', 'enraged']);
  assert.equal(ABYSS_MAW.phases.hunt.gate.kind, 'stability');
  assert.equal(ABYSS_MAW.phases.suction.gate.kind, 'suctionOutcome');
  assert.equal(ABYSS_MAW.phases.weakPoints.gate.organCount, 3);
  assert.equal(ABYSS_MAW.phases.enraged.gate.kind, 'health');
});

test('Maw cannot transition by waiting; varied route outcomes drive hunt and suction', () => {
  const harness = createHarness();
  for (let step = 0; step < 200; step += 1) {
    harness.system.update({ world: harness.world, player: harness.world.get(harness.playerId), damageRecords: [] }, 0.1, harness.events);
  }
  assert.equal(harness.system.getSnapshot().phase, 'hunt');
  assert.equal(harness.system.getObjective().status, 'active');

  routeBreak(harness, 8);
  assert.equal(harness.system.getSnapshot().phase, 'suction');
  let bridgedForce = 0;
  for (let step = 0; step < 9; step += 1) {
    harness.system.update({
      world: harness.world,
      player: harness.world.get(harness.playerId),
      damageRecords: [],
      applyPlayerForce(x, y) { bridgedForce += Math.hypot(x, y); },
    }, 0.1, harness.events);
  }
  assert.ok(bridgedForce > 0, 'the runtime movement bridge receives the authoritative current');
  const shifted = harness.world.get(harness.playerId);
  assert.notEqual(Math.hypot(shifted.vx, shifted.vy), 0, 'suction writes a real current into player motion');

  routeBreak(harness, 6);
  assert.equal(harness.system.getSnapshot().phase, 'weakPoints');
  assert.equal(harness.system.getSnapshot().suctionOutcome.succeeded, true);
  harness.world.dispose();
});

test('weak points require real organ destruction, auto-target exposure, and then core health', () => {
  const harness = createHarness();
  routeBreak(harness, 14);
  let snapshot = harness.system.getSnapshot();
  assert.equal(snapshot.phase, 'weakPoints');
  assert.equal(snapshot.parts.organs.length, 3);
  assert.ok(snapshot.parts.organs.every(({ weakPoint, invulnerable }) => weakPoint && !invulnerable));

  const organRecords = snapshot.parts.organs.map((organ) => ({
    targetId: organ.entityId, targetKind: 'bossPart', amount: organ.maxHp, hpAfter: 0, destroyed: true,
  }));
  harness.system.update({
    world: harness.world, player: harness.world.get(harness.playerId), damageRecords: organRecords,
  }, 1 / 60, harness.events);
  snapshot = harness.system.getSnapshot();
  assert.equal(snapshot.phase, 'enraged');
  assert.equal(snapshot.destroyedOrgans, 3);
  assert.notDeepEqual(snapshot.arenaCenter, { x: 0, y: 0 });

  const body = snapshot.parts.body;
  harness.system.update({
    world: harness.world,
    player: harness.world.get(harness.playerId),
    damageRecords: [{
      targetId: body.entityId, targetKind: 'bossPart', amount: body.maxHp, hpAfter: 0, destroyed: true,
    }],
  }, 1 / 60, harness.events);
  assert.equal(harness.system.getObjective().status, 'completed');
  assert.equal(harness.system.getSnapshot().phase, 'complete');
  harness.world.dispose();
});

test('tentacle, jelly, bite and current entities are pooled/readable and cleanup is once-only idempotent', () => {
  const harness = createHarness('abyss');
  routeBreak(harness, 14);
  for (let step = 0; step < 500; step += 1) {
    harness.system.update({ world: harness.world, player: harness.world.get(harness.playerId), damageRecords: [] }, 0.1, harness.events);
  }
  const snapshot = harness.system.getSnapshot();
  assert.ok(snapshot.attacksSeen.includes('suction-current'));
  assert.ok(snapshot.attacksSeen.includes('tentacle-fan'));
  assert.ok(snapshot.attacksSeen.includes('tracking-jelly'));
  assert.ok(snapshot.attacksSeen.includes('bite-zone'));
  assert.ok(snapshot.attackCounts.projectile > 0);
  assert.ok(snapshot.maxOwnedEntityCount <= 48, `Boss entity budget exceeded: ${snapshot.maxOwnedEntityCount}`);
  assert.ok(harness.world.query('bossPart').length > 0);
  assert.ok(harness.world.query('warning').length > 0 || snapshot.attackCounts.telegraph > 0);
  assert.ok(harness.emitted.some(({ type }) => type === 'boss:music-layer'));
  assert.ok(harness.emitted.some(({ type }) => type === 'boss:state'));
  const beforeCleanupEvents = harness.emitted.filter(({ type }) => type === 'boss:cleanup').length;
  assert.equal(harness.system.cleanup(harness.world, harness.events, 'test'), true);
  assert.equal(harness.system.cleanup(harness.world, harness.events, 'test-again'), false);
  assert.equal(harness.emitted.filter(({ type }) => type === 'boss:cleanup').length, beforeCleanupEvents + 1);
  for (const kind of ['bossPart', 'enemy', 'enemyProjectile', 'warning', 'enemyHazard']) {
    assert.equal([...harness.world.query(kind)].filter((id) => harness.world.get(id)?.ownerKind === 'boss').length, 0, kind);
  }
  assert.equal(harness.system.getSnapshot().ownedEntityCount, 0);
  assert.equal(harness.system.getObjective().status, 'failed');
  assert.equal(harness.system.getObjective().failureReason, 'test');
  assert.ok(harness.emitted.some(({ type, payload }) => type === 'boss:music-layer' && payload.layer === null));
  assert.ok(harness.emitted.some(({ type, payload }) => type === 'objective:cleanup' && payload.id === harness.objective.id));
  harness.world.dispose();
});

test('Boss restart reuses pools with generation-safe IDs and stale handles cannot remove the new body', () => {
  const harness = createHarness();
  const firstBody = harness.system.getSnapshot().parts.body.entityId;
  assert.equal(harness.system.cleanup(harness.world, harness.events, 'restart'), true);
  harness.system.start(ABYSS_MAW, { targetDurationSeconds: 100 });
  harness.system.update({
    world: harness.world, player: harness.world.get(harness.playerId), damageRecords: [],
  }, 1 / 60, harness.events);
  const secondBody = harness.system.getSnapshot().parts.body.entityId;
  assert.notEqual(secondBody, firstBody);
  assert.equal(harness.world.get(firstBody), null);
  assert.equal(harness.world.despawn(firstBody), false);
  assert.equal(harness.world.get(secondBody)?.partId, 'body');
  harness.world.dispose();
});

test('fixed outer orbit at legal 60 Hz speed cannot expose organs and provokes a damaging counter', () => {
  const campaign = createCampaign(81, 'standard');
  const node = campaign.route.find(({ bossId }) => bossId === 'abyss-maw');
  const director = createEncounterDirector({ seed: 81, mode: 'standard', pressure: campaign.pressure });
  director.startRoom(getEncounterTemplate(node.objectiveTemplate), {
    chapterIndex: 0,
    timing: { kind: 'boss', targetDurationSeconds: node.targetDurationSeconds },
    campaign: { chapterId: 'abyss', nodeId: node.id, roomIndex: node.roomIndex },
    boss: {
      id: node.bossId, label: node.bossLabel, targetDurationSeconds: node.targetDurationSeconds,
      recoveryMultiplier: 1, variantCount: 3, telegraphFloorSeconds: 0.72,
    },
  });
  const world = createEntityWorld();
  const playerId = world.spawn('player', { x: 0, y: 0, hp: 8, maxHp: 8, radius: 0.4, team: 1, collidable: true });
  const events = { emit() {}, input: [] };
  const dt = 1 / 60;
  let angle = 0;
  let damagingCounterSeen = false;
  for (let step = 0; step < 720; step += 1) {
    const player = world.get(playerId);
    const angularStep = 5 * dt / 9;
    angle += angularStep;
    const x = Math.cos(angle) * 9;
    const y = Math.sin(angle) * 5.4;
    const distance = Math.hypot(x - player.x, y - player.y);
    const scale = distance > 5 * dt ? 5 * dt / distance : 1;
    world.write(playerId, {
      previousX: player.x, previousY: player.y,
      x: player.x + (x - player.x) * scale,
      y: player.y + (y - player.y) * scale,
      vx: (x - player.x) * scale / dt,
      vy: (y - player.y) * scale / dt,
    });
    director.update({ world, player: world.get(playerId), presentationPending: 1, damageRecords: [] }, dt, events);
    damagingCounterSeen ||= [...world.query('enemyHazard')].some((id) => {
      const hazard = world.get(id);
      return hazard?.ownerKind === 'boss' && hazard.attackKind === 'orbit-counter'
        && hazard.collidable && hazard.contactDamaging;
    });
  }
  assert.equal(director.getSnapshot().bossBehavior.phase, 'hunt');
  assert.equal(director.getSnapshot().bossBehavior.routeBreaks, 0);
  assert.ok(director.getSnapshot().bossBehavior.orbitCounterTriggers > 0);
  assert.equal(damagingCounterSeen, true);
  world.dispose();
});

test('only the campaign Abyss Boss node activates Maw and Standard defeat reconstructs chapter entry without a fake checkpoint', () => {
  const ordinary = createEncounterDirector({ seed: 9, mode: 'standard' });
  ordinary.startRoom(getEncounterTemplate('elite-pursuit'), {
    chapterIndex: 0,
    timing: { kind: 'boss', targetDurationSeconds: 100 },
    boss: {
      id: 'abyss-maw', label: '深渊巨口', targetDurationSeconds: 100,
      recoveryMultiplier: 1, variantCount: 3, telegraphFloorSeconds: 0.72,
    },
  });
  assert.equal(ordinary.getSnapshot().objective.type, 'elite-hunt');
  assert.equal(ordinary.getSnapshot().bossBehavior.phase, undefined);

  const runSave = {
    value: null,
    save(value) { this.value = structuredClone(value); return true; },
    load() { return this.value ? structuredClone(this.value) : null; },
    clear() { this.value = null; return true; },
  };
  const session = createGameSession({
    development: true,
    deterministicTestMode: true,
    initialRouteKind: 'campaign',
    runSave,
  });
  session.setStarterWeapon('prism-missiles');
  session.startRun('standard', 7001);
  session.startRoom(roomRequestForRunRoute(session.snapshot().route));
  assert.equal(session.damageHull(session.getHull()), true);
  const restored = session.snapshot();
  assert.equal(restored.mode, 'briefing');
  assert.equal(restored.runMode, 'standard');
  assert.equal(restored.chapterIndex, 0);
  assert.equal(restored.route.roomIndex, 0);
  assert.equal(restored.build.starterWeapon, 'prism-missiles');
  assert.equal(restored.build.offerSequence, 0);
  assert.deepEqual(restored.stats, { roomsStarted: 0, roomsCompleted: 0, damageTaken: 0, score: 0 });
  assert.equal(runSave.value, null);
});

test('public Boss objective access is a deeply frozen snapshot, never the mutable authority', () => {
  const harness = createHarness();
  const first = harness.system.getObjective();
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.arena));
  assert.throws(() => { first.status = 'completed'; }, TypeError);
  assert.throws(() => { first.arena.halfWidth = 1; }, TypeError);
  assert.equal(harness.system.getObjective().status, 'active');
  routeBreak(harness, 8);
  assert.equal(first.phase, 'hunt', 'old snapshots stay immutable');
  assert.notEqual(harness.system.getObjective(), first);
  harness.world.dispose();
});

test('Boss parts retry after temporary pool exhaustion and fail closed if capacity can never satisfy the contract', () => {
  const capacities = { bossPart: 4 };
  const world = createEntityWorld({ capacities });
  const blockers = Array.from({ length: 4 }, () => world.spawn('bossPart', { ownerKind: 'fixture' }));
  const playerId = world.spawn('player', { x: 0, y: 0, hp: 5, maxHp: 5, radius: 0.4, team: 1, collidable: true });
  const system = createBossSystem({ seed: 5, mode: 'standard' });
  system.start(ABYSS_MAW, { targetDurationSeconds: 100 });
  system.update({ world, player: world.get(playerId), damageRecords: [] }, 0.25, null);
  assert.equal(system.getSnapshot().partsReady, false);
  assert.ok(system.getSnapshot().spawnFailures >= 1);
  blockers.forEach((id) => world.despawn(id));
  for (let step = 0; step < 5 && !system.getSnapshot().partsReady; step += 1) {
    system.update({ world, player: world.get(playerId), damageRecords: [] }, 1 / 60, null);
  }
  assert.equal(system.getSnapshot().partsReady, true);
  assert.equal(world.query('bossPart').length, 4);
  world.dispose();

  const impossible = createEntityWorld({ capacities: { bossPart: 1 } });
  const impossiblePlayer = impossible.spawn('player', { x: 0, y: 0, hp: 5, maxHp: 5, radius: 0.4, team: 1, collidable: true });
  const impossibleSystem = createBossSystem({ seed: 6, mode: 'standard' });
  impossibleSystem.start(ABYSS_MAW, { targetDurationSeconds: 100 });
  for (let step = 0; step < 180 && impossibleSystem.getObjective().status === 'active'; step += 1) {
    impossibleSystem.update({ world: impossible, player: impossible.get(impossiblePlayer), damageRecords: [] }, 1 / 60, null);
  }
  assert.equal(impossibleSystem.getObjective().status, 'failed');
  assert.equal(impossibleSystem.getObjective().failureReason, 'boss-spawn-capacity');
  assert.equal(impossibleSystem.getSnapshot().ownedEntityCount, 0);
  impossible.dispose();
});

test('Maw consumes campaign recovery, variant and telegraph contracts and every attack count represents a real entity', () => {
  const contract = Object.freeze({ recoveryMultiplier: 1, variantCount: 3, telegraphFloorSeconds: 0.72 });
  const harness = createHarness();
  harness.system.cleanup(harness.world, harness.events, 'contract-restart');
  harness.system.start(ABYSS_MAW, { targetDurationSeconds: 100, behaviorContract: contract });
  harness.system.update({ world: harness.world, player: harness.world.get(harness.playerId), damageRecords: [] }, 1 / 60, harness.events);
  routeBreak(harness, 8);
  const attackEvent = harness.emitted.find(({ type, payload }) => (
    type === 'boss:attack' && payload.attack === 'suction-current'
  ));
  assert.ok(attackEvent);
  assert.ok(attackEvent.payload.telegraphSeconds >= contract.telegraphFloorSeconds);
  const contractSnapshot = harness.system.getSnapshot().behaviorContract;
  assert.deepEqual(contractSnapshot, contract);
  assert.equal(harness.system.getSnapshot().attacksSeen.includes('suction-current'), true);
  assert.equal(harness.system.getSnapshot().attackCounts.telegraph, attackEvent.payload.currentCount);
  harness.world.dispose();
});

test('generic EnemySystem and ProjectileSystem never double-update Boss-owned AI, hazards, or bolts', () => {
  const harness = createHarness('abyss');
  const jellyId = harness.world.spawn('enemy', {
    x: -2, y: 1, vx: 3, vy: -1, age: 0.2, lifetime: 5,
    hp: 2, maxHp: 2, role: 'swarm', type: 'abyss-jelly', ownerKind: 'boss', collidable: true,
  });
  const hazardId = harness.world.spawn('enemyHazard', {
    x: 1, y: 2, vx: 1, vy: 0.5, age: 0.3, lifetime: 3,
    ownerKind: 'boss', collidable: true,
  });
  const boltId = harness.world.spawn('enemyProjectile', {
    x: 3, y: -2, vx: -5, vy: 2, age: 0.4, lifetime: 3,
    ownerKind: 'boss', collidable: true,
  });
  const jelly = harness.world.get(jellyId);
  const hazard = harness.world.get(hazardId);
  const bolt = harness.world.get(boltId);
  const before = {
    jelly: { x: jelly.x, y: jelly.y, age: jelly.age },
    hazard: { x: hazard.x, y: hazard.y, age: hazard.age },
    bolt: { x: bolt.x, y: bolt.y, age: bolt.age },
  };
  createEnemySystem().update(harness.world, harness.world.get(harness.playerId), null, 1 / 60, null);
  createProjectileSystem().update(harness.world, 1 / 60, null);
  const after = {
    jelly: harness.world.get(jelly.id),
    hazard: harness.world.get(hazard.id),
    bolt: harness.world.get(bolt.id),
  };
  assert.deepEqual({ x: after.jelly.x, y: after.jelly.y, age: after.jelly.age }, before.jelly);
  assert.deepEqual({ x: after.hazard.x, y: after.hazard.y, age: after.hazard.age }, before.hazard);
  assert.deepEqual({ x: after.bolt.x, y: after.bolt.y, age: after.bolt.age }, before.bolt);
  harness.world.dispose();
});

test('real automatic weapons and one real Tide Lance collision damage exposed Boss parts and finish the core', () => {
  const harness = createHarness();
  routeBreak(harness, 14);
  assert.equal(harness.system.getSnapshot().phase, 'weakPoints');
  moveToward(harness, harness.system.getSnapshot().arenaCenter.x, harness.system.getSnapshot().arenaCenter.y);
  const weapon = createWeaponSystem();
  const projectiles = createProjectileSystem();
  const collisions = createCollisionSystem();
  const build = Object.freeze({
    starterWeapon: 'pulse-cannon', weaponDamageMultiplier: 1,
    weakPointMultiplier: 1.5, weakPointPriority: 1.8,
    fireIntervalMultiplier: 1, projectileSpeedMultiplier: 1,
    lanceDamageMultiplier: 1, lanceWeakPointMultiplier: 1.5,
    lanceTargetCap: 8, lanceLength: 7.2, lanceHalfWidth: 0.275,
  });
  const firstOrgan = harness.system.getSnapshot().parts.organs[0];
  harness.world.write(harness.playerId, {
    attackKind: 'tide-lance', sequence: 77, directionX: 1, directionY: 0,
  });
  weapon.update(harness.world, harness.playerId, 1 / 60, harness.events, build);
  assert.ok([...harness.world.query('friendlyProjectile')].some((id) => harness.world.get(id)?.type === 'tide-lance'));
  projectiles.update(harness.world, 1 / 60, harness.events);
  let summary = collisions.resolve(harness.world, { damageHull() {} }, 1 / 60, harness.events, build);
  assert.ok(summary.damageRecords.some(({ targetKind, weaponId }) => targetKind === 'bossPart' && weaponId === 'tide-lance'));
  harness.system.update({
    world: harness.world, player: harness.world.get(harness.playerId), damageRecords: summary.damageRecords,
  }, 1 / 60, harness.events);
  assert.ok(harness.system.getSnapshot().damageByWeapon['tide-lance'] > 0);
  assert.ok(harness.system.getSnapshot().parts.organs[0].hp < firstOrgan.hp
    || harness.system.getSnapshot().parts.organs.some(({ hp }) => hp < firstOrgan.maxHp));

  harness.world.write(harness.playerId, { attackKind: null });
  for (let step = 0; step < 2400 && harness.system.getObjective().status === 'active'; step += 1) {
    weapon.update(harness.world, harness.playerId, 1 / 60, harness.events, build);
    projectiles.update(harness.world, 1 / 60, harness.events);
    summary = collisions.resolve(harness.world, { damageHull() {} }, 1 / 60, harness.events, build);
    harness.system.update({
      world: harness.world, player: harness.world.get(harness.playerId), damageRecords: summary.damageRecords,
    }, 1 / 60, harness.events);
  }
  assert.equal(harness.system.getObjective().status, 'completed');
  assert.ok(harness.system.getSnapshot().damageByWeapon['pulse-cannon'] > 0);
  harness.world.dispose();
});

test('Boss hot update uses explicit ownership accounting instead of scanning all five world pools', () => {
  const world = createEntityWorld();
  let queryCalls = 0;
  const countedWorld = {
    spawn: world.spawn, despawn: world.despawn, readInto: world.readInto, write: world.write,
    query(kind) { queryCalls += 1; return world.query(kind); },
  };
  const playerId = world.spawn('player', { x: 0, y: 0, hp: 5, maxHp: 5, radius: 0.4, team: 1, collidable: true });
  const system = createBossSystem({ seed: 91, mode: 'standard' });
  system.start(ABYSS_MAW, { targetDurationSeconds: 100 });
  for (let step = 0; step < 120; step += 1) {
    system.update({ world: countedWorld, player: world.get(playerId), damageRecords: [] }, 1 / 60, null);
  }
  assert.equal(queryCalls, 0);
  assert.equal(system.getSnapshot().diagnosticReconciliations > 0, true);
  assert.equal(queryCalls, 0, 'snapshot reconciles explicit IDs without scanning world pools');
  world.dispose();
});
