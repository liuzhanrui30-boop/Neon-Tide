import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameSession } from '../src/game/session.js';
import { createCampaign } from '../src/game/campaign.js';
import { createCampaignRunRoute, roomRequestForRunRoute } from '../src/game/run-route.js';
import { isRunCheckpoint } from '../src/persistence/run-save.js';
import { createUpgradeBuild, serializeUpgradeBuild } from '../src/systems/upgrade-system.js';
import { createEntityWorld } from '../src/game/entity-world.js';
import { createEnemySystem } from '../src/systems/enemy-system.js';
import { createEncounterDirector } from '../src/systems/encounter-director.js';
import { getEncounterTemplate } from '../src/content/encounters.js';

class MemoryRunSave {
  checkpoint = null;
  saves = [];
  save(value) {
    this.checkpoint = structuredClone(value);
    this.saves.push(structuredClone(value));
    return true;
  }
  load() { return this.checkpoint ? structuredClone(this.checkpoint) : null; }
  clear() { this.checkpoint = null; return true; }
  getStatus() { return { available: true }; }
}

function modernSession({ mode = 'standard', seed = 7001, runSave = new MemoryRunSave(), durationScale = 1 } = {}) {
  const campaignTestAuthority = {};
  const session = createGameSession({
    development: true,
    deterministicTestMode: true,
    deterministicCampaignTest: true,
    campaignTestAuthority,
    initialRouteKind: 'campaign',
    encounterDurationScale: durationScale,
    runSave,
  });
  assert.equal(session.startRun(mode, seed), true);
  return { session, campaignTestAuthority, runSave, seed };
}

function startCurrent(session) {
  return session.startRoom(roomRequestForRunRoute(session.snapshot().route));
}

function selectPending(session) {
  if (session.getMode() !== 'upgrade') return false;
  const [choice] = session.snapshot().build.pendingOffer.cards;
  assert.equal(session.selectUpgrade(choice), true);
  return true;
}

function completeCurrent(harness, { select = true } = {}) {
  assert.equal(harness.campaignTestAuthority.completeCurrentNode(), true);
  if (select) selectPending(harness.session);
  return harness.session.getMode();
}

test('campaign route rejects compatibility and authored downgrade requests before any state mutation', () => {
  const { session } = modernSession();
  const before = session.snapshot();
  assert.throws(() => session.startRoom({
    id: 'forged-chapter-three', compatibility: true, chapterIndex: 3,
  }), /request type does not match authoritative campaign route/);
  assert.throws(() => session.startRoom({
    legacyAuthored: true, objectiveTemplate: 'storm-run', chapterIndex: 3,
  }), /request type does not match authoritative campaign route/);
  assert.deepEqual(session.snapshot(), before);
});

test('campaign completion mode is owned by the node and cannot skip rewards or forge victory', () => {
  const harness = modernSession();
  startCurrent(harness.session);
  const before = harness.session.snapshot();
  assert.throws(() => harness.session.completeRoom({ nextMode: 'chapterComplete' }), /campaign completion is authoritative/);
  assert.throws(() => harness.session.completeRoom({ outcome: 'victory' }), /campaign completion is authoritative/);
  assert.equal(harness.session.getMode(), 'playing');
  assert.deepEqual(harness.session.snapshot().stats, before.stats);

  assert.equal(completeCurrent(harness, { select: false }), 'upgrade');
  assert.equal(harness.session.snapshot().build.pendingOffer.rewardKind, 'normal');
});

test('deterministic campaign acceleration traverses director phases and only the final Boss wins', () => {
  const harness = modernSession();
  const visited = [];
  while (harness.session.getMode() !== 'victory') {
    assert.equal(startCurrent(harness.session), true);
    const playing = harness.session.snapshot();
    visited.push([playing.route.roomIndex, playing.room.kind]);
    completeCurrent(harness);
  }
  assert.equal(visited.length, 15);
  assert.deepEqual(visited.filter(([, kind]) => kind === 'boss').map(([index]) => index), [3, 7, 11, 14]);
  assert.equal(harness.session.snapshot().stats.roomsCompleted, 15);
  assert.equal(harness.session.snapshot().build.offerSequence, 9);

  const unavailable = {};
  createGameSession({
    development: false,
    deterministicCampaignTest: true,
    campaignTestAuthority: unavailable,
  });
  assert.equal(Object.hasOwn(unavailable, 'completeCurrentNode'), false);
});

test('campaign checkpoints accept only exact chapter entries with exact three-offer chapter progression', () => {
  const harness = modernSession({ seed: 8181 });
  for (let index = 0; index < 4; index += 1) {
    startCurrent(harness.session);
    completeCurrent(harness, { select: index < 3 });
  }
  assert.equal(harness.session.getMode(), 'upgrade');
  const pending = structuredClone(harness.runSave.checkpoint);
  assert.equal(pending.route.roomIndex, 4);
  assert.equal(pending.build.offerSequence, 3);
  assert.equal(pending.build.pendingOffer.rewardKind, 'boss');
  assert.equal(isRunCheckpoint(pending), true);

  selectPending(harness.session);
  const selected = structuredClone(harness.runSave.checkpoint);
  assert.equal(selected.build.pendingOffer, null);
  assert.equal(selected.build.offerSequence, 3);
  assert.equal(isRunCheckpoint(selected), true);

  const midpoint = structuredClone(selected);
  midpoint.route = structuredClone(createCampaignRunRoute(5, midpoint.seed, 'standard'));
  midpoint.chapterIndex = midpoint.route.chapterIndex;
  midpoint.stats.roomsStarted = 5;
  midpoint.stats.roomsCompleted = 5;
  assert.equal(isRunCheckpoint(midpoint), false);

  const emptyEntry = structuredClone(selected);
  emptyEntry.build = serializeUpgradeBuild(createUpgradeBuild());
  assert.equal(isRunCheckpoint(emptyEntry), false);

  const zeroEntry = structuredClone(selected);
  zeroEntry.route = structuredClone(createCampaignRunRoute(0, zeroEntry.seed, 'standard'));
  zeroEntry.chapterIndex = 0;
  zeroEntry.stats.roomsStarted = 0;
  zeroEntry.stats.roomsCompleted = 0;
  assert.equal(isRunCheckpoint(zeroEntry), false);

  const wrongReward = structuredClone(pending);
  wrongReward.build.pendingOffer.rewardKind = 'normal';
  assert.equal(isRunCheckpoint(wrongReward), false);

  const badSave = new MemoryRunSave();
  badSave.checkpoint = midpoint;
  const restore = createGameSession({ development: true, runSave: badSave, initialRouteKind: 'campaign' });
  assert.equal(restore.restoreCheckpoint(), false);
  assert.equal(restore.getMode(), 'menu');
});

test('every campaign node exposes target-driven objective timing and explicit Boss timing contracts', () => {
  const natural = modernSession({ seed: 9191 });
  const accelerated = modernSession({ seed: 9191, durationScale: 0.1 });
  const campaign = createCampaign(9191, 'standard');
  const bossDurations = [];

  for (const node of campaign.route) {
    startCurrent(natural.session);
    startCurrent(accelerated.session);
    const naturalRoom = natural.session.snapshot().room;
    const acceleratedRoom = accelerated.session.snapshot().room;
    assert.equal(naturalRoom.timing.authoredTargetDurationSeconds, node.targetDurationSeconds);
    assert.equal(naturalRoom.timing.effectiveTargetDurationSeconds, node.targetDurationSeconds);
    assert.equal(naturalRoom.objective.timeout, node.targetDurationSeconds);
    assert.equal(acceleratedRoom.timing.authoredTargetDurationSeconds, node.targetDurationSeconds);
    assert.equal(acceleratedRoom.timing.effectiveTargetDurationSeconds, node.targetDurationSeconds * 0.1);
    assert.equal(acceleratedRoom.objective.timeout, node.targetDurationSeconds * 0.1);
    if (node.kind === 'boss') {
      bossDurations.push(naturalRoom.boss.targetDurationSeconds);
      assert.equal(naturalRoom.boss.id, node.bossId);
      assert.equal(naturalRoom.timing.kind, 'boss');
    } else {
      assert.equal(naturalRoom.timing.kind, 'room');
      assert.ok(naturalRoom.objective.target > 0);
    }
    completeCurrent(natural);
    completeCurrent(accelerated);
  }
  assert.deepEqual(bossDurations, [100, 110, 125, 197]);
});

test('Abyss campaign pressure is consumed by threat budget, movement, selection cadence, and Boss contract', () => {
  const standard = modernSession({ mode: 'standard', seed: 444 });
  const abyss = modernSession({ mode: 'abyss', seed: 444 });
  startCurrent(standard.session);
  startCurrent(abyss.session);
  const normalRoom = standard.session.snapshot().room;
  const abyssRoom = abyss.session.snapshot().room;
  const ratio = (high, low) => high / low;

  assert.ok(ratio(abyssRoom.threatBudget.total, normalRoom.threatBudget.total) >= 1.18);
  assert.ok(ratio(abyssRoom.threatBudget.total, normalRoom.threatBudget.total) <= 1.25);
  assert.equal(abyssRoom.pressure.enemySpeed, 1.2);
  assert.equal(abyssRoom.pressure.selectionCadence, 1.24);
  assert.ok(abyssRoom.pressure.waveIntervalSeconds < normalRoom.pressure.waveIntervalSeconds);
  assert.ok(abyssRoom.pressure.telegraphFloorSeconds < normalRoom.pressure.telegraphFloorSeconds);
  assert.ok(abyssRoom.pressure.telegraphFloorSeconds >= 0.55);
  assert.equal(standard.session.getEnemyTelegraphFloorSeconds(), normalRoom.pressure.telegraphFloorSeconds);
  assert.equal(abyss.session.getEnemyTelegraphFloorSeconds(), abyssRoom.pressure.telegraphFloorSeconds);
  assert.equal(abyss.session.getEncounterSnapshot().threatState.enemySystem.contract.speedMultiplier, 1.2);

  for (let index = 0; index < 3; index += 1) {
    completeCurrent(standard);
    completeCurrent(abyss);
    startCurrent(standard.session);
    startCurrent(abyss.session);
  }
  const standardBoss = standard.session.snapshot().room.boss;
  const abyssBoss = abyss.session.snapshot().room.boss;
  assert.equal(standardBoss.variantCount, 3);
  assert.equal(abyssBoss.variantCount, 4);
  assert.equal(standardBoss.recoveryMultiplier, 1);
  assert.equal(abyssBoss.recoveryMultiplier, 0.8);
  assert.ok(abyssBoss.telegraphFloorSeconds < standardBoss.telegraphFloorSeconds);
  assert.ok(abyssBoss.telegraphFloorSeconds >= 0.55);
  assert.equal(standard.session.getEnemyTelegraphFloorSeconds(), standardBoss.telegraphFloorSeconds);
  assert.equal(abyss.session.getEnemyTelegraphFloorSeconds(), abyssBoss.telegraphFloorSeconds);

  const standardWorld = createEntityWorld();
  const abyssWorld = createEntityWorld();
  const standardEnemies = createEnemySystem({ random: () => 0.5, speedMultiplier: 1 });
  const abyssEnemies = createEnemySystem({ random: () => 0.5, speedMultiplier: abyssRoom.pressure.enemySpeed });
  const standardId = standardEnemies.spawnRole(standardWorld, 'hunter', { x: 1, y: 1 });
  const abyssId = abyssEnemies.spawnRole(abyssWorld, 'hunter', { x: 1, y: 1 });
  assert.equal(abyssWorld.get(abyssId).speed / standardWorld.get(standardId).speed, 1.2);
  assert.equal(abyssWorld.get(abyssId).maxSpeed / standardWorld.get(standardId).maxSpeed, 1.2);
  standardWorld.dispose();
  abyssWorld.dispose();

  const standardThreatWorld = createEntityWorld();
  const abyssThreatWorld = createEntityWorld();
  const standardDirector = createEncounterDirector({
    mode: 'standard', seed: 2, pressure: createCampaign(2, 'standard').pressure,
  });
  const abyssDirector = createEncounterDirector({
    mode: 'abyss', seed: 2, pressure: createCampaign(2, 'abyss').pressure,
  });
  standardDirector.startRoom(getEncounterTemplate('purge-tide'));
  abyssDirector.startRoom(getEncounterTemplate('purge-tide'));
  const player = { x: 0, y: 0, hp: 3, maxHp: 3 };
  standardDirector.update({ world: standardThreatWorld, player }, 0.01);
  abyssDirector.update({ world: abyssThreatWorld, player }, 0.01);
  for (let index = 0; index < 20; index += 1) {
    standardDirector.update({ world: standardThreatWorld, player }, 0.1);
    abyssDirector.update({ world: abyssThreatWorld, player }, 0.1);
  }
  assert.equal(standardDirector.getSnapshot().threatState.wavesSelected, 1);
  assert.equal(abyssDirector.getSnapshot().threatState.wavesSelected, 2);
  standardThreatWorld.dispose();
  abyssThreatWorld.dispose();
});
