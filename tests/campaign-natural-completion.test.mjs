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
import { createEncounterDirector } from '../src/systems/encounter-director.js';
import { createEnemySystem } from '../src/systems/enemy-system.js';

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

test('Abyss Boss recovery, variants, and warning floor alter live behavior without reducing fair telegraphs', () => {
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

  const warningWorld = createEntityWorld();
  const enemies = createEnemySystem({ random: () => 0.5, telegraphFloorSeconds: 0.8 });
  const strikerId = enemies.spawnRole(warningWorld, 'striker', { x: 0, y: 0, stateTimer: 0 });
  enemies.update(warningWorld, { x: 4, y: 0 }, null, 0.01);
  assert.ok(warningWorld.get(strikerId).telegraphTimer >= 0.8);
  const warnings = warningWorld.query('warning');
  assert.ok(warnings.length > 0);
  for (let index = 0; index < warnings.length; index += 1) {
    assert.ok(warningWorld.get(warnings.at(index)).duration >= 0.8);
  }
  standardWorld.dispose();
  abyssWorld.dispose();
  warningWorld.dispose();
});
