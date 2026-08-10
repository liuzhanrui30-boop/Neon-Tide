import test from 'node:test';
import assert from 'node:assert/strict';
import { createCampaign } from '../src/game/campaign.js';
import {
  estimateCampaignObjectiveSeconds,
  tuneCampaignObjectiveTemplate,
} from '../src/game/campaign-pacing.js';
import { roomRequestForRunRoute } from '../src/game/run-route.js';
import { createGameSession } from '../src/game/session.js';
import { createEntityWorld } from '../src/game/entity-world.js';
import { getEncounterTemplate } from '../src/content/encounters.js';
import { DATA_CITY_CHAPTER } from '../src/content/chapters/data-city.js';
import { createEncounterDirector } from '../src/systems/encounter-director.js';
import { createEnemySystem } from '../src/systems/enemy-system.js';
import { applyAuthoredChapterBeat, createObjective, updateObjective } from '../src/systems/objective-system.js';

function campaignSession({ development = true, durationScale = 1 } = {}) {
  const campaignTestAuthority = {};
  const session = createGameSession({
    development,
    deterministicTestMode: true,
    deterministicCampaignTest: development,
    campaignTestAuthority,
    initialRouteKind: 'campaign',
    encounterDurationScale: durationScale,
  });
  assert.equal(session.startRun('standard', 5511), true);
  return { session, campaignTestAuthority };
}

function startCurrent(session) {
  return session.startRoom(roomRequestForRunRoute(session.snapshot().route));
}

function chooseUpgrade(session) {
  if (session.getMode() !== 'upgrade') return;
  assert.equal(session.selectUpgrade(session.snapshot().build.pendingOffer.cards[0]), true);
}

function clearThreats(world) {
  for (const kind of ['enemy', 'warning', 'enemyHazard', 'enemyProjectile']) {
    const query = world.query(kind);
    for (let index = query.length - 1; index >= 0; index -= 1) world.despawn(query.at(index));
  }
}

function updateAtCrisis(objective, crisis, dt = 0.1) {
  return updateObjective(objective, null, {
    x: crisis.x,
    y: crisis.y,
    hp: 3,
    maxHp: 3,
    buildStats: { objectiveProximityMultiplier: 1 },
  }, dt);
}

function simulateSequentialDualCrisis(template, seed) {
  const objective = createObjective(template, seed);
  let safety = 0;
  while (objective.status === 'active' && safety < 4_000) {
    const active = objective.crises.find(({ completed }) => !completed);
    updateAtCrisis(objective, active);
    safety += 1;
  }
  assert.ok(safety < 4_000);
  return objective;
}

function simulateKeyboardSequentialDualCrisis(template, seed, {
  start = { x: 0, y: -1.2 }, speed = 3.75, dt = 0.1,
} = {}) {
  const objective = createObjective(template, seed);
  applyAuthoredChapterBeat(objective, DATA_CITY_CHAPTER.rooms[2].beats[0]);
  const player = { ...start, hp: 3, maxHp: 3, buildStats: { objectiveProximityMultiplier: 1 } };
  let safety = 0;
  while (objective.status === 'active' && safety < 4_000) {
    const target = objective.crises.find(({ completed }) => !completed);
    const dx = target.x - player.x;
    const dy = target.y - player.y;
    const distance = Math.hypot(dx, dy);
    const travel = Math.min(distance, speed * dt);
    if (distance > 1e-9) {
      player.x += dx / distance * travel;
      player.y += dy / distance * travel;
    }
    updateObjective(objective, null, player, dt);
    safety += 1;
  }
  assert.ok(safety < 4_000);
  return objective;
}

function beginRoleWarning(telegraphFloorSeconds, role) {
  const world = createEntityWorld();
  const enemies = createEnemySystem({ random: () => 0.5, telegraphFloorSeconds });
  const enemyId = enemies.spawnRole(world, role, { x: 0, y: 0, stateTimer: 0 });
  enemies.update(world, { x: 4, y: 0 }, null, 0.01);
  const enemy = world.get(enemyId);
  const warnings = Array.from({ length: world.query('warning').length }, (_, index) => (
    world.get(world.query('warning').at(index))
  ));
  return { world, enemy, warnings };
}

test('production campaign rejects public completion until Director grants one natural settlement', () => {
  const { session } = campaignSession({ development: false });
  assert.equal(startCurrent(session), true);
  const before = session.snapshot();
  assert.throws(() => session.completeRoom({}), /natural campaign completion authorization/);
  assert.deepEqual(session.snapshot(), before);
  assert.equal(session.getEncounterSnapshot().phase, 'active');
});

test('the deterministic hook still traverses fifteen nodes while the final Boss can win through natural objective updates', () => {
  const harness = campaignSession({ durationScale: 0.1 });
  for (let index = 0; index < 14; index += 1) {
    assert.equal(startCurrent(harness.session), true);
    assert.equal(harness.campaignTestAuthority.completeCurrentNode(), true);
    chooseUpgrade(harness.session);
  }

  assert.equal(startCurrent(harness.session), true);
  assert.equal(harness.session.snapshot().room.kind, 'boss');
  assert.equal(harness.session.snapshot().room.boss.id, 'void-regent');
  assert.throws(() => harness.session.completeRoom({}), /natural campaign completion authorization/);

  let safety = 0;
  while (harness.session.getMode() === 'playing' && safety < 4_000) {
    const objective = harness.session.getEncounterSnapshot().objective;
    const player = objective?.safeZone
      ? { x: objective.safeZone.x, y: objective.safeZone.y, hp: 3, maxHp: 3 }
      : { x: 0, y: 0, hp: 3, maxHp: 3 };
    harness.session.updateRoom({ player, presentationPending: 0 }, 0.1, null);
    safety += 1;
  }
  assert.ok(safety < 4_000);
  assert.equal(harness.session.getMode(), 'victory');
  assert.equal(harness.session.snapshot().stats.roomsCompleted, 15);
});

test('natural campaign objective work estimates 18–25 minutes and closes the reviewed pacing gaps', () => {
  const campaign = createCampaign(9191, 'standard');
  const rows = campaign.route.map((node) => {
    const authored = getEncounterTemplate(node.objectiveTemplate);
    const natural = tuneCampaignObjectiveTemplate(authored, {
      targetDurationSeconds: node.targetDurationSeconds,
      durationScale: 1,
    });
    const accelerated = tuneCampaignObjectiveTemplate(authored, {
      targetDurationSeconds: node.targetDurationSeconds,
      durationScale: 0.1,
    });
    const naturalSeconds = estimateCampaignObjectiveSeconds(natural);
    const acceleratedSeconds = estimateCampaignObjectiveSeconds(accelerated);
    const director = createEncounterDirector({
      mode: 'standard', seed: 9191, pressure: createCampaign(9191, 'standard').pressure,
    });
    const live = director.startRoom(authored, {
      chapterIndex: node.chapterIndex,
      timing: { kind: node.kind, targetDurationSeconds: node.targetDurationSeconds },
      boss: node.kind === 'boss' ? {
        id: node.bossId, label: node.bossLabel, targetDurationSeconds: node.targetDurationSeconds,
        recoveryMultiplier: 1, variantCount: 3, telegraphFloorSeconds: 0.55,
      } : null,
    });
    assert.equal(live.timing.estimatedObjectiveSeconds, naturalSeconds);
    assert.equal(estimateCampaignObjectiveSeconds(live.objective), naturalSeconds);
    assert.equal(live.objective.pacing.completesOnObjective, true);
    assert.ok(naturalSeconds >= node.targetDurationSeconds * 0.78,
      `${node.id} natural estimate ${naturalSeconds}`);
    assert.ok(naturalSeconds < node.targetDurationSeconds,
      `${node.id} must retain a fair timeout margin`);
    assert.ok(Math.abs(acceleratedSeconds - naturalSeconds * 0.1) <= 1.5,
      `${node.id} durationScale must preserve the same work contract`);
    assert.equal(Object.hasOwn(natural, 'minimumCompletionSeconds'), false);
    return { node, natural, naturalSeconds };
  });

  const total = rows.reduce((sum, row) => sum + row.naturalSeconds, 0);
  assert.ok(total >= 18 * 60, `natural campaign estimate ${total}`);
  assert.ok(total <= 25 * 60, `natural campaign estimate ${total}`);

  const moving62 = rows.find(({ node }) => node.targetDurationSeconds === 62);
  const escort65 = rows.find(({ node }) => node.objectiveTemplate === 'escort-skiff');
  const finalBoss197 = rows.find(({ node }) => node.targetDurationSeconds === 197);
  assert.equal(moving62.natural.type, 'moving-zone');
  assert.ok(moving62.naturalSeconds >= 48, '62 second moving room cannot collapse to 9.5 seconds');
  assert.ok(escort65.naturalSeconds >= 50, '65 second escort cannot collapse to 7.6 seconds');
  assert.ok(finalBoss197.naturalSeconds >= 155, '197 second Boss cannot collapse to 68 seconds');
  assert.ok(escort65.natural.escortDistance >= escort65.natural.escortSpeed * 50);
});

test('all authored dual-crisis campaign nodes complete through real sequential objective updates before timeout', () => {
  const campaign = createCampaign(9191, 'standard');
  const nodes = campaign.route.filter(({ objectiveTemplate }) => objectiveTemplate === 'dual-crisis');
  assert.deepEqual(nodes.map(({ targetDurationSeconds }) => targetDurationSeconds), [72, 110, 82]);

  for (const [index, node] of nodes.entries()) {
    const tuned = tuneCampaignObjectiveTemplate(getEncounterTemplate(node.objectiveTemplate), {
      targetDurationSeconds: node.targetDurationSeconds,
      durationScale: 1,
    });
    const objective = simulateSequentialDualCrisis(tuned, 8_000 + index);
    const estimated = estimateCampaignObjectiveSeconds(tuned);

    assert.equal(objective.status, 'completed', `${node.id} must settle immediately after the second crisis`);
    assert.ok(objective.elapsed >= node.targetDurationSeconds * 0.78, `${node.id} cannot collapse into a short room`);
    assert.ok(objective.elapsed < node.targetDurationSeconds, `${node.id} must remain naturally completable`);
    assert.ok(Math.abs(objective.elapsed - estimated) <= 0.21,
      `${node.id} estimator ${estimated} must match stepwise runtime ${objective.elapsed}`);
    assert.ok(objective.crises.every(({ escalated }) => !escalated),
      `${node.id} competent sequential play must beat escalation`);

    const slow = createObjective(tuned, 9_000 + index);
    const first = slow.crises[0];
    while (!first.completed) updateAtCrisis(slow, first);
    while (slow.status === 'active' && slow.elapsed < slow.escalationSeconds + 0.1) {
      updateObjective(slow, null, { x: 99, y: 99, hp: 3, maxHp: 3 }, 0.1);
    }
    const unfinished = slow.crises.find(({ completed }) => !completed);
    assert.equal(slow.status, 'active', `${node.id} escalation must create pressure before timeout`);
    assert.equal(unfinished.escalated, true, `${node.id} slow processing must trigger escalation`);
    assert.ok(unfinished.requiredSeconds > tuned.crisisSeconds,
      `${node.id} escalation must increase the unfinished crisis work`);

    const forcedPressure = Object.freeze({
      ...tuned,
      timeout: node.targetDurationSeconds * 1.2,
      escalationSeconds: tuned.crisisSeconds + 5,
    });
    const pressuredObjective = simulateSequentialDualCrisis(forcedPressure, 10_000 + index);
    const pressuredEstimate = estimateCampaignObjectiveSeconds(forcedPressure);
    assert.equal(pressuredObjective.status, 'completed');
    assert.ok(pressuredObjective.crises.some(({ escalated }) => escalated));
    assert.ok(Math.abs(pressuredObjective.elapsed - pressuredEstimate) <= 0.21,
      `${node.id} estimator must include the actual escalation rule`);
  }
});

test('compressed Data City dual crisis reserves a real keyboard transit budget without changing the live contract', () => {
  const node = createCampaign(4112, 'standard').route.find(({ id }) => id === 'data-city:room:3:dual-crisis');
  const authored = getEncounterTemplate(node.objectiveTemplate);
  const live = tuneCampaignObjectiveTemplate(authored, {
    targetDurationSeconds: node.targetDurationSeconds,
    durationScale: 1,
  });
  const compressed = tuneCampaignObjectiveTemplate(authored, {
    targetDurationSeconds: node.targetDurationSeconds,
    durationScale: 0.15,
  });

  assert.equal(live.pacingGeometryScale, 1, '18–25 minute live geometry remains authored');
  assert.equal(compressed.pacingGeometryScale, 0.35, 'accelerated verification exposes its compact route contract');
  const objective = simulateKeyboardSequentialDualCrisis(compressed, 4112);
  assert.equal(objective.status, 'completed');
  assert.deepEqual(objective.choiceOrder, ['crisis-1', 'crisis-2']);
  assert.ok(objective.elapsed < objective.timeout, 'movement plus two real holds fits the compressed deadline');
  assert.ok(objective.crises.every(({ escalated }) => !escalated));
  const [first, second] = objective.crises;
  assert.ok(first.x * second.x + first.y * second.y < 0, 'compact route still uses opposite quadrants');
  assert.ok(Math.hypot(first.x - second.x, first.y - second.y) > first.radius + second.radius,
    'compact crises remain separate and cannot be solved by standing in one overlap');
});

test('Abyss Boss recovery, variants, and real warning floor alter live behavior without unsafe telegraphs', () => {
  const standardCampaign = createCampaign(44, 'standard');
  const abyssCampaign = createCampaign(44, 'abyss');
  const template = getEncounterTemplate('dual-crisis');
  const createBossDirector = (mode, campaign) => {
    const director = createEncounterDirector({ mode, seed: 44, pressure: campaign.pressure });
    director.startRoom(template, {
      chapterIndex: 3,
      timing: { kind: 'boss', targetDurationSeconds: 110 },
      boss: {
        id: 'protocol-zero', label: '零号协议', targetDurationSeconds: 110,
        recoveryMultiplier: campaign.pressure.bossRecovery,
        variantCount: campaign.pressure.bossVariantCount,
        telegraphFloorSeconds: campaign.pressure.telegraphFloorSeconds,
      },
    });
    return director;
  };
  const standard = createBossDirector('standard', standardCampaign);
  const abyss = createBossDirector('abyss', abyssCampaign);
  const standardWorld = createEntityWorld();
  const abyssWorld = createEntityWorld();
  const player = { x: 99, y: 99, hp: 3, maxHp: 3 };

  const histories = new Map([[standard, []], [abyss, []]]);
  const worlds = new Map([[standard, standardWorld], [abyss, abyssWorld]]);
  for (let step = 0; step < 100; step += 1) {
    for (const director of [standard, abyss]) {
      const world = worlds.get(director);
      const before = director.getSnapshot().threatState.wavesSelected;
      director.update({ world, player }, 0.1, null);
      const snapshot = director.getSnapshot();
      if (snapshot.threatState.wavesSelected > before) {
        const enemies = world.query('enemy');
        histories.get(director).push({
          ...snapshot.threatState.lastWave,
          entityVariantIndexes: Array.from({ length: enemies.length }, (_, index) => (
            world.get(enemies.at(index)).variantIndex
          )),
        });
        clearThreats(world);
      }
    }
  }

  const standardSnapshot = standard.getSnapshot();
  const abyssSnapshot = abyss.getSnapshot();
  assert.ok(abyssSnapshot.bossBehavior.recoverySeconds < standardSnapshot.bossBehavior.recoverySeconds);
  assert.ok(abyssSnapshot.threatState.wavesSelected > standardSnapshot.threatState.wavesSelected);
  assert.deepEqual(standardSnapshot.bossBehavior.variantsSeen, [0, 1, 2]);
  assert.deepEqual(abyssSnapshot.bossBehavior.variantsSeen, [0, 1, 2, 3]);
  assert.equal(histories.get(standard)[3].bossVariantIndex, 0);
  assert.equal(histories.get(abyss)[3].bossVariantIndex, 3);
  assert.ok(histories.get(standard)[3].entityVariantIndexes.includes(0));
  assert.ok(histories.get(abyss)[3].entityVariantIndexes.includes(3));
  assert.notDeepEqual(histories.get(standard)[3].roles, histories.get(abyss)[3].roles);
  assert.ok(standardSnapshot.bossBehavior.telegraphFloorSeconds >= 0.55);
  assert.ok(abyssSnapshot.bossBehavior.telegraphFloorSeconds >= 0.55);
  assert.ok(abyssSnapshot.bossBehavior.telegraphFloorSeconds
    < standardSnapshot.bossBehavior.telegraphFloorSeconds);

  const standardBossNode = standardCampaign.route.find(({ bossId }) => bossId === 'protocol-zero');
  const abyssBossNode = abyssCampaign.route.find(({ bossId }) => bossId === 'protocol-zero');
  assert.equal(standardBossNode.id, abyssBossNode.id, 'the comparison must use the same authored Boss');
  const standardStriker = beginRoleWarning(standardSnapshot.bossBehavior.telegraphFloorSeconds, 'striker');
  const abyssStriker = beginRoleWarning(abyssSnapshot.bossBehavior.telegraphFloorSeconds, 'striker');
  assert.ok(standardStriker.warnings.length > 0);
  assert.ok(abyssStriker.warnings.length > 0);
  assert.ok(abyssStriker.enemy.telegraphTimer < standardStriker.enemy.telegraphTimer,
    'Abyss must produce a visibly tighter warning for the same Boss attack');
  assert.ok(abyssStriker.warnings.every(({ duration }, index) => (
    duration < standardStriker.warnings[index].duration
  )), 'the rendered EnemySystem warnings must consume the real Boss mode contract');
  assert.ok(abyssStriker.enemy.telegraphTimer >= 0.55);
  assert.ok(abyssStriker.warnings.every(({ duration }) => duration >= 0.55));

  const standardMine = beginRoleWarning(standardSnapshot.bossBehavior.telegraphFloorSeconds, 'mine');
  const abyssMine = beginRoleWarning(abyssSnapshot.bossBehavior.telegraphFloorSeconds, 'mine');
  assert.equal(standardMine.enemy.telegraphTimer, 0.9);
  assert.equal(abyssMine.enemy.telegraphTimer, 0.9,
    'a longer authored role warning must win over either mode floor');
  assert.ok(standardMine.warnings.every(({ duration }) => duration === 0.9));
  assert.ok(abyssMine.warnings.every(({ duration }) => duration === 0.9));
  standardWorld.dispose();
  abyssWorld.dispose();
  standardStriker.world.dispose();
  abyssStriker.world.dispose();
  standardMine.world.dispose();
  abyssMine.world.dispose();
});
