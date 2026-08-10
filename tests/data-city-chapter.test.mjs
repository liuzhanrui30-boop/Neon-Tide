import test from 'node:test';
import assert from 'node:assert/strict';
import { DATA_CITY_CHAPTER, getDataCityRoomDefinition } from '../src/content/chapters/data-city.js';
import { PROTOCOL_ZERO } from '../src/content/bosses/protocol-zero.js';
import { createEntityWorld } from '../src/game/entity-world.js';
import { createObjective, getDataLaneEffect, updateObjective } from '../src/systems/objective-system.js';
import { createBossSystem } from '../src/systems/boss-system.js';
import { createCampaign } from '../src/game/campaign.js';
import { getEncounterTemplate } from '../src/content/encounters.js';
import { loadChapterContent } from '../src/content/realms.js';
import { createEncounterDirector } from '../src/systems/encounter-director.js';

test('Data City is a deeply immutable introduce-develop-test teaching sawtooth', () => {
  assert.ok(Object.isFrozen(DATA_CITY_CHAPTER));
  assert.deepEqual(DATA_CITY_CHAPTER.rooms.map(({ objectiveTemplate }) => objectiveTemplate), [
    'escort-skiff', 'storm-run', 'dual-crisis',
  ]);
  assert.deepEqual(DATA_CITY_CHAPTER.rooms.map(({ teachingStage }) => teachingStage), [
    'introduce', 'develop', 'test',
  ]);
  assert.deepEqual(DATA_CITY_CHAPTER.teachingOrder, ['striker', 'lancer', 'warden', 'interceptor']);
  assert.ok(DATA_CITY_CHAPTER.rooms.every((room) => room.warningCap <= 3));
  assert.ok(DATA_CITY_CHAPTER.rooms.every((room) => room.safeRoutes.length >= 1));
  assert.equal(DATA_CITY_CHAPTER.boss.id, 'protocol-zero');
  assert.deepEqual(DATA_CITY_CHAPTER.boss.phases, ['firewall', 'trafficGrid', 'cloneNodes', 'kernel']);
  assert.strictEqual(getDataCityRoomDefinition('storm-run'), DATA_CITY_CHAPTER.rooms[1]);
  assert.throws(() => { DATA_CITY_CHAPTER.rooms[0].beats[0].at = 99; }, TypeError);
});

test('data lanes alter steering and dash recovery without direct damage', () => {
  const effect = getDataLaneEffect({
    type: 'data-lane', phase: 'active', laneCenter: 0, laneHalfWidth: 1,
    steeringMultiplier: 0.78, dashRecoveryMultiplier: 0.65,
  }, { x: 2, y: 0.25, hp: 5 });
  assert.deepEqual(effect, {
    active: true, steeringMultiplier: 0.78, dashRecoveryMultiplier: 0.65, directDamage: 0,
  });
  const outside = getDataLaneEffect({
    type: 'data-lane', phase: 'active', laneCenter: 0, laneHalfWidth: 1,
  }, { x: 0, y: 2.1, hp: 5 });
  assert.equal(outside.active, false);
  assert.equal(outside.directDamage, 0);
});

test('escort and storm corridor progress/environment freeze with zero simulation time', () => {
  const escort = createObjective({
    id: 'escort-freeze', type: 'escort', timeout: 20, escortDistance: 8, escortSpeed: 2,
    supportRadius: 4, escortHp: 10, spawnHooks: [], cleanup: [],
  }, 8);
  const escortPlayer = { x: escort.escort.x, y: escort.escort.y, hp: 5 };
  updateObjective(escort, null, escortPlayer, 0.5);
  const escortBefore = structuredClone({
    elapsed: escort.elapsed, progress: escort.progress, escort: escort.escort,
  });
  updateObjective(escort, null, escortPlayer, 0);
  assert.deepEqual({ elapsed: escort.elapsed, progress: escort.progress, escort: escort.escort }, escortBefore);

  const storm = createObjective({
    id: 'storm-freeze', type: 'storm-corridor', timeout: 20, survivalSeconds: 6,
    corridorSegments: 4, corridorWidth: 2, spawnHooks: [], cleanup: [],
  }, 9);
  const stormPlayer = { x: storm.safeZone.x, y: storm.safeZone.y, hp: 5 };
  updateObjective(storm, null, stormPlayer, 0.5);
  const stormBefore = structuredClone({
    elapsed: storm.elapsed, progress: storm.progress, corridor: storm.corridor,
    safeZone: storm.safeZone, nextSafeZone: storm.nextSafeZone, stormExposure: storm.stormExposure,
  });
  updateObjective(storm, null, stormPlayer, 0);
  assert.deepEqual({
    elapsed: storm.elapsed, progress: storm.progress, corridor: storm.corridor,
    safeZone: storm.safeZone, nextSafeZone: storm.nextSafeZone, stormExposure: storm.stormExposure,
  }, stormBefore);
});

function createProtocolHarness(mode = 'standard') {
  const world = createEntityWorld();
  const playerId = world.spawn('player', {
    x: 0, y: 0, previousX: 0, previousY: 0, vx: 0, vy: 0,
    hp: 8, maxHp: 8, radius: 0.4, team: 1, collidable: true,
  });
  const emitted = [];
  const events = { input: [], emit(type, payload) { emitted.push({ type, payload }); return true; } };
  const system = createBossSystem({ seed: 2030, mode });
  system.start(PROTOCOL_ZERO, { targetDurationSeconds: 110 });
  system.update({ world, player: world.get(playerId), damageRecords: [] }, 1 / 60, events);
  return { world, playerId, system, events, emitted };
}

function enterMarkedQuadrant(harness) {
  const snapshot = harness.system.getSnapshot();
  const cell = snapshot.firewall.markedQuadrant;
  const x = cell.xSign * 5.5;
  const y = cell.ySign * 3.7;
  const player = harness.world.get(harness.playerId);
  harness.world.write(harness.playerId, {
    previousX: player.x, previousY: player.y, x, y, vx: x - player.x, vy: y - player.y,
  });
  harness.system.update({
    world: harness.world, player: harness.world.get(harness.playerId), damageRecords: [],
  }, 1 / 60, harness.events);
}

test('Protocol Zero phases are outcome-driven and standard safe cell is unique by shape', () => {
  assert.ok(Object.isFrozen(PROTOCOL_ZERO));
  assert.deepEqual(Object.keys(PROTOCOL_ZERO.phases), ['firewall', 'trafficGrid', 'cloneNodes', 'kernel']);
  const harness = createProtocolHarness('standard');
  for (let index = 0; index < 300; index += 1) {
    harness.system.update({ world: harness.world, player: harness.world.get(harness.playerId), damageRecords: [] }, 0.1, harness.events);
  }
  assert.equal(harness.system.getSnapshot().phase, 'firewall', 'waiting cannot clear firewall');

  for (let index = 0; index < PROTOCOL_ZERO.phases.firewall.requiredQuadrants; index += 1) enterMarkedQuadrant(harness);
  let snapshot = harness.system.getSnapshot();
  assert.equal(snapshot.phase, 'trafficGrid');
  assert.equal(snapshot.safeCells.filter(({ truthful }) => truthful).length, 1);
  const trueCell = snapshot.safeCells.find(({ truthful }) => truthful);
  assert.equal(snapshot.safeCells.filter(({ shape }) => shape === trueCell.shape).length, 1);
  assert.ok(snapshot.safeRoute.openLanes >= 1);

  for (let index = 0; index < PROTOCOL_ZERO.phases.trafficGrid.requiredSafeCells; index += 1) {
    snapshot = harness.system.getSnapshot();
    const safe = snapshot.safeCells.find(({ truthful }) => truthful);
    const player = harness.world.get(harness.playerId);
    harness.world.write(harness.playerId, {
      previousX: player.x, previousY: player.y, x: safe.x, y: safe.y, vx: 0, vy: 0,
    });
    harness.system.update({ world: harness.world, player: harness.world.get(harness.playerId), damageRecords: [] }, 0.2, harness.events);
  }
  snapshot = harness.system.getSnapshot();
  assert.equal(snapshot.phase, 'cloneNodes');
  assert.ok(snapshot.parts.nodes.length >= 3);
  assert.equal(new Set(snapshot.parts.nodes.map(({ shape }) => shape)).size, snapshot.parts.nodes.length);

  const nodeRecords = snapshot.parts.nodes.map((node) => ({
    targetId: node.entityId, targetKind: 'bossPart', amount: node.maxHp, hpAfter: 0, destroyed: true,
  }));
  harness.system.update({
    world: harness.world, player: harness.world.get(harness.playerId), damageRecords: nodeRecords,
  }, 1 / 60, harness.events);
  snapshot = harness.system.getSnapshot();
  assert.equal(snapshot.phase, 'kernel');
  assert.equal(snapshot.parts.body.weakPoint, true);
  assert.equal(snapshot.parts.body.invulnerable, false);

  harness.system.update({
    world: harness.world,
    player: harness.world.get(harness.playerId),
    damageRecords: [{
      targetId: snapshot.parts.body.entityId, targetKind: 'bossPart', amount: snapshot.parts.body.maxHp,
      hpAfter: 0, destroyed: true,
    }],
  }, 1 / 60, harness.events);
  assert.equal(harness.system.getObjective().status, 'completed');
  assert.equal(harness.system.getSnapshot().phase, 'complete');
  harness.world.dispose();
});

test('a real collision-despawned kernel completes from its retained generation-safe damage record', () => {
  const harness = createProtocolHarness('standard');
  for (let index = 0; index < PROTOCOL_ZERO.phases.firewall.requiredQuadrants; index += 1) enterMarkedQuadrant(harness);
  for (let index = 0; index < PROTOCOL_ZERO.phases.trafficGrid.requiredSafeCells; index += 1) {
    const safe = harness.system.getSnapshot().safeCells.find(({ truthful }) => truthful);
    const player = harness.world.get(harness.playerId);
    harness.world.write(harness.playerId, {
      previousX: player.x, previousY: player.y, x: safe.x, y: safe.y, vx: 0, vy: 0,
    });
    harness.system.update({ world: harness.world, player: harness.world.get(harness.playerId), damageRecords: [] }, 0.2, harness.events);
  }
  let snapshot = harness.system.getSnapshot();
  harness.system.update({
    world: harness.world,
    player: harness.world.get(harness.playerId),
    damageRecords: snapshot.parts.nodes.map((node) => ({
      targetId: node.entityId, targetKind: 'bossPart', amount: node.maxHp, hpAfter: 0, destroyed: true,
    })),
  }, 1 / 60, harness.events);
  snapshot = harness.system.getSnapshot();
  assert.equal(snapshot.phase, 'kernel');
  const destroyedKernelId = snapshot.parts.body.entityId;
  assert.equal(harness.world.despawn(destroyedKernelId), true, 'CollisionSystem removes the lethal target before Boss update');
  harness.system.update({
    world: harness.world,
    player: harness.world.get(harness.playerId),
    damageRecords: [{
      targetId: destroyedKernelId, targetKind: 'bossPart', weaponId: 'pulse-cannon',
      amount: snapshot.parts.body.maxHp, hpAfter: 0, destroyed: true,
    }],
  }, 1 / 60, harness.events);
  assert.equal(harness.system.getObjective().status, 'completed');
  assert.equal(harness.system.getSnapshot().phase, 'complete');
  assert.equal(harness.system.getSnapshot().parts.body.entityId, 0, 'the destroyed handle is never replaced');
  harness.world.dispose();
});

test('Abyss decoys retain non-color shape and rhythm evidence, bounded warnings, and complete cleanup', () => {
  const harness = createProtocolHarness('abyss');
  for (let index = 0; index < PROTOCOL_ZERO.phases.firewall.requiredQuadrants; index += 1) enterMarkedQuadrant(harness);
  const snapshot = harness.system.getSnapshot();
  assert.equal(snapshot.phase, 'trafficGrid');
  assert.ok(snapshot.safeCells.some(({ decoy }) => decoy));
  assert.ok(snapshot.safeCells.every(({ shape, pulseBeat }) => typeof shape === 'string' && Number.isInteger(pulseBeat)));
  assert.equal(snapshot.safeCells.filter(({ truthful }) => truthful).length, 1);
  assert.ok(snapshot.maxSimultaneousWarnings <= PROTOCOL_ZERO.warningCap.abyss);
  assert.ok(snapshot.maxOwnedEntityCount <= PROTOCOL_ZERO.maxOwnedEntities);
  assert.equal(harness.system.cleanup(harness.world, harness.events, 'test'), true);
  assert.equal(harness.system.cleanup(harness.world, harness.events, 'again'), false);
  for (const kind of PROTOCOL_ZERO.cleanupKinds) {
    assert.equal([...harness.world.query(kind)].filter((id) => harness.world.get(id)?.ownerKind === 'boss').length, 0, kind);
  }
  assert.equal(harness.system.getSnapshot().ownedEntityCount, 0);
  harness.world.dispose();
});

test('lazy Data City content drives real room role windows and Protocol Zero campaign dispatch', async () => {
  const loaded = await loadChapterContent('data-city');
  assert.strictEqual(loaded.chapter, DATA_CITY_CHAPTER);
  assert.strictEqual(loaded.boss, PROTOCOL_ZERO);
  const campaign = createCampaign(4112, 'standard');
  const room = campaign.route.find(({ chapterId, roomIndex }) => chapterId === 'data-city' && roomIndex === 0);
  const director = createEncounterDirector({ seed: campaign.seed, mode: campaign.mode, pressure: campaign.pressure });
  director.startRoom(getEncounterTemplate(room.objectiveTemplate), {
    chapterIndex: room.chapterIndex,
    timing: { kind: room.kind, targetDurationSeconds: room.targetDurationSeconds },
    campaign: { chapterId: room.chapterId, nodeId: room.id, roomIndex: room.roomIndex },
  });
  const world = createEntityWorld();
  const playerId = world.spawn('player', {
    x: 0, y: 0, hp: 8, maxHp: 8, radius: 0.4, team: 1, collidable: true,
  });
  let maximumWarnings = 0;
  for (let step = 0; step < 460; step += 1) {
    const escort = director.getSnapshot().objective.escort;
    world.write(playerId, { x: escort.x, y: escort.y, previousX: escort.x, previousY: escort.y });
    director.update({ world, player: world.get(playerId), presentationPending: 1 }, 0.1, { emit() {}, input: [] });
    maximumWarnings = Math.max(maximumWarnings, world.query('warning').length);
  }
  const roomSnapshot = director.getSnapshot();
  assert.equal(roomSnapshot.chapterPacing.chapterId, 'data-city');
  assert.equal(roomSnapshot.chapterPacing.teachingStage, 'introduce');
  assert.ok(roomSnapshot.threatState.rolesSeen.includes('striker'));
  assert.ok(roomSnapshot.threatState.rolesSeen.includes('lancer'));
  assert.equal(roomSnapshot.threatState.rolesSeen.includes('warden'), false);
  assert.ok(maximumWarnings <= DATA_CITY_CHAPTER.rooms[0].warningCap);
  director.reset();
  world.dispose();

  const boss = campaign.route.find(({ bossId }) => bossId === 'protocol-zero');
  const bossDirector = createEncounterDirector({ seed: campaign.seed, mode: campaign.mode, pressure: campaign.pressure });
  const bossStart = bossDirector.startRoom(getEncounterTemplate(boss.objectiveTemplate), {
    chapterIndex: boss.chapterIndex,
    timing: { kind: boss.kind, targetDurationSeconds: boss.targetDurationSeconds },
    campaign: { chapterId: boss.chapterId, nodeId: boss.id, roomIndex: boss.roomIndex },
    boss: {
      id: boss.bossId, label: boss.bossLabel, targetDurationSeconds: boss.targetDurationSeconds,
      recoveryMultiplier: 1, variantCount: 3, telegraphFloorSeconds: 0.72,
    },
  });
  assert.equal(bossStart.bossBehavior.phase, 'firewall');
  assert.equal(bossStart.bossBehavior.bossId, 'protocol-zero');
});
