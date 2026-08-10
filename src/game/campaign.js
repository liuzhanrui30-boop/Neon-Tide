import { CAMPAIGN_CHAPTERS } from '../content/realms.js';

const RUN_MODES = new Set(['standard', 'abyss']);
const STANDARD_PRESSURE = Object.freeze({
  threatBudget: 1,
  enemySpeed: 1,
  eliteFrequency: 1,
  bossRecovery: 1,
  bossVariantCount: 3,
  telegraphFloorSeconds: 0.72,
});
const ABYSS_PRESSURE = Object.freeze({
  threatBudget: 1.22,
  enemySpeed: 1.2,
  eliteFrequency: 1.24,
  bossRecovery: 0.8,
  bossVariantCount: 4,
  telegraphFloorSeconds: 0.58,
});
const REWARD_ROOM_INDEXES = new Set([0, 2]);
const CHECKPOINT_ENTRIES = Object.freeze({
  4: Object.freeze({ chapterIndex: 1, offerSequence: 3 }),
  8: Object.freeze({ chapterIndex: 2, offerSequence: 6 }),
  12: Object.freeze({ chapterIndex: 3, offerSequence: 9 }),
});

function seed32(value) {
  let seed = Math.trunc(Number(value)) >>> 0;
  seed ^= seed >>> 16;
  seed = Math.imul(seed, 0x7feb352d);
  seed ^= seed >>> 15;
  seed = Math.imul(seed, 0x846ca68b);
  seed ^= seed >>> 16;
  return seed >>> 0;
}

function randomFrom(seed) {
  let state = seed32(seed) || 0x6d2b79f5;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

function shuffled(values, seed) {
  const result = [...values];
  const random = randomFrom(seed);
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function freezeCampaign(value) {
  return Object.freeze({
    ...value,
    chapters: Object.freeze(value.chapters.map((chapter) => Object.freeze({
      ...chapter,
      nodes: Object.freeze(chapter.nodes.map((node) => Object.freeze({ ...node }))),
    }))),
    route: Object.freeze(value.route.map((node) => Object.freeze({ ...node }))),
  });
}

export function createCampaign(seed, mode = 'standard') {
  if (!Number.isFinite(seed)) throw new TypeError('campaign seed must be finite');
  if (!RUN_MODES.has(mode)) throw new TypeError('campaign mode must be standard or abyss');
  let routeIndex = 0;
  const chapters = CAMPAIGN_CHAPTERS.map((chapter) => {
    const authoredObjectives = mode === 'abyss' && chapter.preserveObjectiveOrder !== true
      ? shuffled(chapter.objectiveTemplates, seed32(seed + chapter.index * 0x9e3779b9))
      : [...chapter.objectiveTemplates];
    const nodes = authoredObjectives.map((objectiveTemplate, roomIndex) => ({
      id: `${chapter.id}:room:${roomIndex + 1}:${objectiveTemplate}`,
      routeIndex: routeIndex++,
      chapterId: chapter.id,
      chapterIndex: chapter.index,
      roomIndex,
      kind: 'room',
      objectiveTemplate,
      targetDurationSeconds: chapter.roomDurations[roomIndex],
      rewardKind: REWARD_ROOM_INDEXES.has(roomIndex) && chapter.index < 3 ? 'normal' : null,
      variant: mode,
    }));
    nodes.push({
      id: `${chapter.id}:boss:${chapter.bossId}`,
      routeIndex: routeIndex++,
      chapterId: chapter.id,
      chapterIndex: chapter.index,
      roomIndex: chapter.normalRoomCount,
      kind: 'boss',
      bossId: chapter.bossId,
      bossLabel: chapter.bossLabel,
      objectiveTemplate: chapter.index === 0 ? 'elite-pursuit' : chapter.index === 1 ? 'dual-crisis' : chapter.index === 2 ? 'anchor-break' : 'storm-run',
      targetDurationSeconds: chapter.bossDuration,
      rewardKind: chapter.index < CAMPAIGN_CHAPTERS.length - 1 ? 'boss' : null,
      variant: mode,
    });
    return { id: chapter.id, index: chapter.index, label: chapter.label, nodes };
  });
  const route = chapters.flatMap(({ nodes }) => nodes);
  const totalTargetDurationSeconds = route.reduce((total, node) => total + node.targetDurationSeconds, 0);
  return freezeCampaign({
    seed,
    mode,
    chapters,
    route,
    totalTargetDurationSeconds,
    normalRoomCount: route.filter(({ kind }) => kind === 'room').length,
    bossCount: route.filter(({ kind }) => kind === 'boss').length,
    upgradeCount: route.filter(({ rewardKind }) => Boolean(rewardKind)).length,
    pressure: mode === 'abyss' ? ABYSS_PRESSURE : STANDARD_PRESSURE,
  });
}

export function getCampaignNode(campaign, routeIndex) {
  if (!campaign || !Array.isArray(campaign.route) || !Number.isInteger(routeIndex)) return null;
  return campaign.route[routeIndex] ?? null;
}

export function isCampaignChapterEntry(campaign, routeIndex) {
  const node = getCampaignNode(campaign, routeIndex);
  return Boolean(node && node.roomIndex === 0);
}

export function getCampaignCheckpointContract(routeIndex) {
  return CHECKPOINT_ENTRIES[routeIndex] ?? null;
}
