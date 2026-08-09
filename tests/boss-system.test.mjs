import test from 'node:test';
import assert from 'node:assert/strict';
import { ABYSS_MAW } from '../src/content/bosses/abyss-maw.js';
import { createEntityWorld } from '../src/game/entity-world.js';
import { createBossSystem } from '../src/systems/boss-system.js';
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

function routeBreak(harness, repetitions = 12) {
  const points = [[8, 0], [0, 0], [-7, 3], [1, -1], [7, -3], [0, 0]];
  for (let index = 0; index < repetitions; index += 1) {
    const [x, y] = points[index % points.length];
    const player = harness.world.get(harness.playerId);
    harness.world.write(harness.playerId, { previousX: player.x, previousY: player.y, x, y });
    harness.system.update({ world: harness.world, player: harness.world.get(harness.playerId), damageRecords: [] }, 0.25, harness.events);
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
  for (let step = 0; step < 600; step += 1) {
    harness.system.update({ world: harness.world, player: harness.world.get(harness.playerId), damageRecords: [] }, 0.1, harness.events);
  }
  assert.equal(harness.system.getSnapshot().phase, 'hunt');
  assert.equal(harness.objective.status, 'active');

  routeBreak(harness, 18);
  assert.equal(harness.system.getSnapshot().phase, 'suction');
  let bridgedForce = 0;
  harness.system.update({
    world: harness.world,
    player: harness.world.get(harness.playerId),
    damageRecords: [],
    applyPlayerForce(x, y) { bridgedForce += Math.hypot(x, y); },
  }, 0.1, harness.events);
  assert.ok(bridgedForce > 0, 'the runtime movement bridge receives the authoritative current');
  const shifted = harness.world.get(harness.playerId);
  assert.notEqual(Math.hypot(shifted.vx, shifted.vy), 0, 'suction writes a real current into player motion');

  routeBreak(harness, 30);
  assert.equal(harness.system.getSnapshot().phase, 'weakPoints');
  assert.equal(harness.system.getSnapshot().suctionOutcome.succeeded, true);
  harness.world.dispose();
});

test('weak points require real organ destruction, auto-target exposure, and then core health', () => {
  const harness = createHarness();
  routeBreak(harness, 70);
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
  assert.equal(harness.objective.status, 'completed');
  assert.equal(harness.system.getSnapshot().phase, 'complete');
  harness.world.dispose();
});

test('tentacle, jelly, bite and current entities are pooled/readable and cleanup is once-only idempotent', () => {
  const harness = createHarness('abyss');
  routeBreak(harness, 90);
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
  assert.equal(harness.objective.status, 'failed');
  assert.equal(harness.objective.failureReason, 'test');
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

test('fixed outer orbit cannot expose organs while varied routes can complete the campaign Boss naturally', () => {
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
  const playerId = world.spawn('player', { x: 9, y: 0, hp: 8, maxHp: 8, radius: 0.4, team: 1, collidable: true });
  for (let step = 0; step < 240; step += 1) {
    const angle = step * 0.08;
    world.write(playerId, { x: Math.cos(angle) * 9, y: Math.sin(angle) * 5.4 });
    director.update({ world, player: world.get(playerId), presentationPending: 1, damageRecords: [] }, 0.1, { emit() {}, input: [] });
  }
  assert.equal(director.getSnapshot().bossBehavior.phase, 'hunt');
  assert.ok(director.getSnapshot().bossBehavior.orbitCounterTriggers > 0);
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
