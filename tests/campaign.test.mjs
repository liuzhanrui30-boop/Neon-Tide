import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CAMPAIGN_CHAPTERS,
  getChapterContentLoadState,
  loadChapterContent,
} from '../src/content/realms.js';
import { createCampaign } from '../src/game/campaign.js';
import {
  CAMPAIGN_ROUTE_ROOM_COUNT,
  createCampaignRunRoute,
  createNextStandardRunRoute,
  normalizeRunRoute,
  roomRequestForRunRoute,
} from '../src/game/run-route.js';
import { createGameSession } from '../src/game/session.js';
import {
  RUN_MODE_PREFERENCE_KEY,
  createRunModePreference,
} from '../src/persistence/run-save.js';

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

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

const campaignAuthorities = new WeakMap();

function createCampaignTestSession(options = {}) {
  const campaignTestAuthority = {};
  const session = createGameSession({
    development: true,
    deterministicTestMode: true,
    deterministicCampaignTest: true,
    campaignTestAuthority,
    initialRouteKind: 'campaign',
    ...options,
  });
  campaignAuthorities.set(session, campaignTestAuthority);
  return session;
}

function completeCurrentNode(session) {
  assert.equal(session.startRoom(roomRequestForRunRoute(session.snapshot().route)), true);
  assert.equal(campaignAuthorities.get(session).completeCurrentNode(), true);
  if (session.getMode() === 'upgrade') {
    const [choice] = session.snapshot().build.pendingOffer.cards;
    assert.equal(session.selectUpgrade(choice), true);
    return 'upgrade';
  }
  return session.getMode();
}

test('campaign data defines four pure-data chapters, eleven rooms, four bosses, and an 18–25 minute route', async () => {
  assert.deepEqual(CAMPAIGN_CHAPTERS.map(({ id }) => id), [
    'abyss', 'data-city', 'star-forge', 'void-cathedral',
  ]);
  assert.deepEqual(CAMPAIGN_CHAPTERS.map(({ normalRoomCount }) => normalRoomCount), [3, 3, 3, 2]);

  for (const mode of ['standard', 'abyss']) {
    for (const seed of [0, 1, 77, -1942, 0x7fffffff]) {
      const campaign = createCampaign(seed, mode);
      assert.equal(campaign.route.filter(({ kind }) => kind === 'room').length, 11);
      assert.equal(campaign.route.filter(({ kind }) => kind === 'boss').length, 4);
      assert.equal(campaign.route.length, 15);
      assert.equal(campaign.upgradeCount, 9);
      assert.ok(campaign.totalTargetDurationSeconds >= 18 * 60);
      assert.ok(campaign.totalTargetDurationSeconds <= 25 * 60);
      assert.deepEqual(campaign, createCampaign(seed, mode));
    }
  }

  const source = await readFile(new URL('../src/content/realms.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /from ['"]three['"]|document\.|window\.|HTMLElement|WebGL/);
});

test('Abyss changes deterministic ordering and raises fair pressure by 18–25 percent with stronger bosses', () => {
  const standard = createCampaign(734, 'standard');
  const abyss = createCampaign(734, 'abyss');
  assert.deepEqual(standard.route.map(({ chapterId, kind }) => [chapterId, kind]), abyss.route.map(({ chapterId, kind }) => [chapterId, kind]));
  assert.notDeepEqual(
    standard.route.filter(({ kind }) => kind === 'room').map(({ objectiveTemplate }) => objectiveTemplate),
    abyss.route.filter(({ kind }) => kind === 'room').map(({ objectiveTemplate }) => objectiveTemplate),
  );
  for (const key of ['threatBudget', 'enemySpeed', 'eliteFrequency']) {
    assert.ok(abyss.pressure[key] >= standard.pressure[key] * 1.18);
    assert.ok(abyss.pressure[key] <= standard.pressure[key] * 1.25);
  }
  assert.ok(abyss.pressure.telegraphFloorSeconds < standard.pressure.telegraphFloorSeconds);
  assert.ok(abyss.pressure.telegraphFloorSeconds >= 0.55);
  assert.ok(abyss.route.filter(({ kind }) => kind === 'boss').every(({ variant }) => variant === 'abyss'));
});

test('campaign routes are explicit and do not invalidate historical authored v2 routes', () => {
  const campaign = createCampaign(42, 'standard');
  assert.equal(CAMPAIGN_ROUTE_ROOM_COUNT, 15);
  for (let index = 0; index < campaign.route.length; index += 1) {
    const route = createCampaignRunRoute(index, 42, 'standard');
    const node = campaign.route[index];
    assert.deepEqual(route, {
      kind: 'campaign', roomIndex: index, chapterIndex: node.chapterIndex,
      realmIndex: node.chapterIndex, templateId: node.id,
    });
    assert.deepEqual(roomRequestForRunRoute(route), {
      campaign: true, nodeId: node.id, chapterIndex: node.chapterIndex,
    });
    assert.deepEqual(normalizeRunRoute(route, {
      seed: 42,
      stats: { roomsStarted: index, roomsCompleted: index },
      chapterIndex: node.chapterIndex,
    }), route);
  }

  const historical = createNextStandardRunRoute(1, 42);
  assert.equal(historical.kind, 'authored');
  assert.deepEqual(normalizeRunRoute(historical, {
    seed: 42,
    stats: { roomsStarted: 1, roomsCompleted: 1 },
    chapterIndex: historical.chapterIndex,
  }), historical);
});

test('a GameSession completes the authored route through real transitions with nine automatic-build choices', () => {
  const runSave = new MemoryRunSave();
  const session = createCampaignTestSession({ runSave });
  assert.equal(session.startRun('standard', 2026), true);
  const chapters = [];
  let upgrades = 0;
  let safety = 0;
  while (session.getMode() !== 'victory' && safety < 20) {
    chapters.push(session.snapshot().route.chapterIndex);
    const outcome = completeCurrentNode(session);
    if (outcome === 'upgrade') upgrades += 1;
    safety += 1;
  }
  assert.equal(session.getMode(), 'victory');
  assert.equal(session.snapshot().stats.roomsCompleted, 15);
  assert.equal(upgrades, 9);
  assert.deepEqual(chapters, [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3]);
});

test('Standard restores the current chapter entry build while Abyss death performs a full reset without a checkpoint', () => {
  const standardSave = new MemoryRunSave();
  const standard = createCampaignTestSession({ runSave: standardSave });
  standard.startRun('standard', 99);
  for (let index = 0; index < 4; index += 1) completeCurrentNode(standard);
  const entry = structuredClone(standard.snapshot());
  assert.equal(entry.route.chapterIndex, 1);
  assert.equal(entry.build.pendingOffer, null);
  assert.ok(standardSave.checkpoint);
  assert.deepEqual(standardSave.checkpoint.build, entry.build);
  assert.equal(standard.startRoom(roomRequestForRunRoute(entry.route)), true);
  assert.equal(standard.damageHull(standard.getHull()), true);
  const restored = standard.snapshot();
  assert.equal(restored.mode, 'briefing');
  assert.equal(restored.chapterIndex, 1);
  assert.deepEqual(restored.build, entry.build);
  assert.deepEqual(restored.stats, entry.stats);
  assert.equal(restored.hull, entry.hull);

  const abyssSave = new MemoryRunSave();
  abyssSave.checkpoint = structuredClone(standardSave.checkpoint);
  const abyss = createCampaignTestSession({ runSave: abyssSave });
  assert.equal(abyss.startRun('abyss', 99), true);
  assert.equal(abyssSave.checkpoint, null);
  assert.equal(abyss.startRoom(roomRequestForRunRoute(abyss.snapshot().route)), true);
  assert.equal(abyss.damageHull(abyss.getHull()), true);
  const reset = abyss.snapshot();
  assert.equal(reset.mode, 'briefing');
  assert.equal(reset.runMode, 'abyss');
  assert.equal(reset.chapterIndex, 0);
  assert.equal(reset.route.roomIndex, 0);
  assert.deepEqual(reset.stats, { roomsStarted: 0, roomsCompleted: 0, damageTaken: 0, score: 0 });
  assert.equal(abyssSave.checkpoint, null);
});

test('mode preference persists independently and never creates a run', () => {
  const storage = new MemoryStorage();
  const preference = createRunModePreference(storage);
  assert.equal(preference.load(), 'standard');
  assert.equal(preference.save('abyss'), true);
  assert.equal(storage.getItem(RUN_MODE_PREFERENCE_KEY), 'abyss');
  assert.equal(createRunModePreference(storage).load(), 'abyss');
  assert.equal(preference.save('invalid'), false);
  assert.equal(storage.getItem('neon-tide:v3:checkpoint'), null);
});

test('non-first chapter content loads on demand in isolated lazy modules', async () => {
  assert.deepEqual(getChapterContentLoadState(), {
    'data-city': 'idle', 'star-forge': 'idle', 'void-cathedral': 'idle',
  });
  const data = await loadChapterContent('data-city');
  assert.equal(data.chapterId, 'data-city');
  assert.equal(getChapterContentLoadState()['data-city'], 'loaded');
  assert.equal(getChapterContentLoadState()['star-forge'], 'idle');
  assert.strictEqual(await loadChapterContent('data-city'), data);
  await assert.rejects(() => loadChapterContent('unknown'), /unknown campaign chapter/);
});

test('Abyss preserves Data City’s authored teach order through the lazy chapter handoff', async () => {
  const seed = 4112;
  const campaign = createCampaign(seed, 'abyss');
  assert.deepEqual(
    campaign.route.filter(({ chapterId, kind }) => chapterId === 'data-city' && kind === 'room')
      .map(({ objectiveTemplate }) => objectiveTemplate),
    ['escort-skiff', 'storm-run', 'dual-crisis'],
  );

  const session = createCampaignTestSession();
  assert.equal(session.startRun('abyss', seed), true);
  for (let index = 0; index < 4; index += 1) completeCurrentNode(session);
  assert.deepEqual(session.snapshot().route, createCampaignRunRoute(4, seed, 'abyss'));
  assert.equal(session.snapshot().route.chapterIndex, 1);

  await loadChapterContent('data-city');
  assert.equal(session.startRoom(roomRequestForRunRoute(session.snapshot().route)), true);
  const encounter = session.getEncounterSnapshot();
  assert.equal(encounter.chapterPacing.roomId, 'data-city:escort-uplink');
  assert.equal(encounter.objective.type, 'escort');
});
