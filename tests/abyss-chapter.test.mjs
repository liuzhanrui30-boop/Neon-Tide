import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ABYSS_CHAPTER,
  ABYSS_FIRST_NINETY_SECONDS,
  getAbyssRoomDefinition,
} from '../src/content/chapters/abyss.js';
import { createCampaign } from '../src/game/campaign.js';
import { createEncounterDirector } from '../src/systems/encounter-director.js';
import { createEntityWorld } from '../src/game/entity-world.js';
import { getEncounterTemplate } from '../src/content/encounters.js';

test('Abyss chapter data is deeply immutable and authors three tutorial rooms plus Maw', () => {
  assert.ok(Object.isFrozen(ABYSS_CHAPTER));
  assert.ok(Object.isFrozen(ABYSS_CHAPTER.rooms));
  assert.ok(ABYSS_CHAPTER.rooms.every((room) => Object.isFrozen(room) && Object.isFrozen(room.beats)));
  assert.deepEqual(ABYSS_CHAPTER.rooms.map(({ objectiveTemplate }) => objectiveTemplate), [
    'purge-tide', 'moving-sanctum', 'anchor-break',
  ]);
  assert.equal(ABYSS_CHAPTER.boss.id, 'abyss-maw');
  assert.deepEqual(ABYSS_CHAPTER.boss.phases, ['hunt', 'suction', 'weakPoints', 'enraged']);
  assert.throws(() => { ABYSS_CHAPTER.rooms[0].beats[0].at = 99; }, TypeError);
  assert.strictEqual(getAbyssRoomDefinition('purge-tide'), ABYSS_CHAPTER.rooms[0]);
});

test('the real first ninety seconds teaches four roles and changes the route twice inside beginner warning budget', () => {
  const roles = new Map(ABYSS_FIRST_NINETY_SECONDS.roleIntroductions.map((entry) => [entry.role, entry.at]));
  for (const role of ['hunter', 'swarm', 'interceptor', 'mine']) {
    assert.ok(roles.has(role), `${role} is introduced`);
    assert.ok(roles.get(role) >= 0 && roles.get(role) <= 90, `${role} is introduced in the first 90 seconds`);
  }
  assert.ok(ABYSS_FIRST_NINETY_SECONDS.routeChanges.length >= 2);
  assert.ok(ABYSS_FIRST_NINETY_SECONDS.routeChanges.every(({ at }) => at >= 0 && at <= 90));
  assert.ok(ABYSS_FIRST_NINETY_SECONDS.maxSimultaneousHighDamageWarnings <= 2);
  assert.ok(ABYSS_FIRST_NINETY_SECONDS.beats.every((beat, index, beats) => (
    index === 0 || beat.at >= beats[index - 1].at
  )));
});

test('campaign Abyss ordinary rooms consume authored role windows and never exceed the tutorial cap', () => {
  const campaign = createCampaign(3103, 'standard');
  const node = campaign.route[0];
  const director = createEncounterDirector({
    seed: campaign.seed,
    mode: campaign.mode,
    pressure: campaign.pressure,
  });
  director.startRoom(getEncounterTemplate(node.objectiveTemplate), {
    chapterIndex: node.chapterIndex,
    timing: { kind: node.kind, targetDurationSeconds: node.targetDurationSeconds },
    campaign: { chapterId: node.chapterId, nodeId: node.id, roomIndex: node.roomIndex },
  });
  const world = createEntityWorld();
  const playerId = world.spawn('player', {
    x: 0, y: 0, hp: 3, maxHp: 3, radius: 0.4, team: 1, collidable: true,
  });
  const seen = new Set();
  const firstSeenAt = new Map();
  let maximumWarnings = 0;
  for (let step = 0; step < 900; step += 1) {
    director.update({ world, player: world.get(playerId), presentationPending: 1 }, 0.1, { emit() {}, input: [] });
    const snapshot = director.getSnapshot();
    snapshot.threatState.rolesSeen.forEach((role) => {
      seen.add(role);
      if (!firstSeenAt.has(role)) firstSeenAt.set(role, step * 0.1);
    });
    maximumWarnings = Math.max(maximumWarnings, world.query('warning').length);
    if (snapshot.objective.status !== 'active') break;
  }
  assert.ok(seen.has('hunter'));
  assert.ok(seen.has('swarm'));
  assert.ok(seen.has('interceptor'));
  assert.equal(seen.has('mine'), false);
  assert.ok(firstSeenAt.get('hunter') >= 1.9);
  assert.ok(firstSeenAt.get('swarm') >= 13.9);
  assert.ok(firstSeenAt.get('interceptor') >= 35.9);
  assert.ok(maximumWarnings <= 2);
  assert.equal(director.getSnapshot().chapterPacing.chapterId, 'abyss');
  assert.ok(director.getSnapshot().chapterPacing.routeChangesCommitted >= 1);
  world.dispose();
});

test('the second real room keeps learned roles and introduces Mine at the authored chapter-second window', () => {
  const campaign = createCampaign(3103, 'standard');
  const node = campaign.route[1];
  const director = createEncounterDirector({ seed: campaign.seed, mode: campaign.mode, pressure: campaign.pressure });
  director.startRoom(getEncounterTemplate(node.objectiveTemplate), {
    chapterIndex: 0,
    timing: { kind: 'room', targetDurationSeconds: node.targetDurationSeconds },
    campaign: { chapterId: 'abyss', nodeId: node.id, roomIndex: node.roomIndex },
  });
  const world = createEntityWorld();
  const playerId = world.spawn('player', { x: 0, y: 0, hp: 3, maxHp: 3, radius: 0.4, team: 1, collidable: true });
  let mineAt = null;
  for (let step = 0; step < 100; step += 1) {
    director.update({ world, player: world.get(playerId), presentationPending: 1 }, 0.1, { emit() {}, input: [] });
    if (director.getSnapshot().threatState.rolesSeen.includes('mine')) {
      mineAt = step * 0.1;
      break;
    }
  }
  assert.ok(mineAt >= 7.9 && mineAt <= 8.2, `Mine introduced at ${mineAt}`);
  assert.ok(director.getSnapshot().chapterPacing.rolesIntroduced.includes('hunter'));
  assert.ok(director.getSnapshot().chapterPacing.routeChangesCommitted >= 1);
  world.dispose();
});

test('durationScale compresses authored Abyss beat times together with the room contract', () => {
  const campaign = createCampaign(3103, 'standard');
  const node = campaign.route[0];
  const director = createEncounterDirector({
    seed: campaign.seed,
    mode: campaign.mode,
    pressure: campaign.pressure,
    durationScale: 0.1,
  });
  director.startRoom(getEncounterTemplate(node.objectiveTemplate), {
    chapterIndex: node.chapterIndex,
    timing: { kind: node.kind, targetDurationSeconds: node.targetDurationSeconds },
    campaign: { chapterId: node.chapterId, nodeId: node.id, roomIndex: node.roomIndex },
  });
  const world = createEntityWorld();
  const playerId = world.spawn('player', {
    x: 0, y: 0, hp: 3, maxHp: 3, radius: 0.4, team: 1, collidable: true,
  });
  const events = { emit() {}, input: [] };
  director.update({ world, player: world.get(playerId), presentationPending: 1 }, 0.19, events);
  assert.equal(director.getSnapshot().threatState.rolesSeen.includes('hunter'), false);
  director.update({ world, player: world.get(playerId), presentationPending: 1 }, 0.02, events);
  assert.equal(director.getSnapshot().threatState.rolesSeen.includes('hunter'), true);
  assert.equal(director.getSnapshot().chapterPacing.nextBeatIndex, 2);
  world.dispose();
});
