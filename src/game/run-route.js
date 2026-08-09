import {
  getCampaignChapterIndex,
  getCampaignEncounter,
  getEncounterTemplate,
} from '../content/encounters.js';
import { createCampaign } from './campaign.js';

export const MAX_CAMPAIGN_CHAPTER_INDEX = 3;
// Historical v2.2 authored routes remain valid for safe checkpoint migration.
export const AUTHORED_CAMPAIGN_ROOM_COUNT = 5;
export const CAMPAIGN_ROUTE_ROOM_COUNT = 15;
export const COMPATIBILITY_BOSS_TEMPLATE_ID = 'v2.2-boss-compatibility';

const ROUTE_KEYS = new Set(['kind', 'roomIndex', 'chapterIndex', 'realmIndex', 'templateId']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function boundedChapter(value) {
  return Number.isInteger(value) && value >= 0 && value <= MAX_CAMPAIGN_CHAPTER_INDEX;
}

function freezeRoute(route) {
  return Object.freeze({ ...route });
}

export function createAuthoredRunRoute(roomIndex, seed = 0) {
  if (!Number.isInteger(roomIndex) || roomIndex < 0 || roomIndex >= AUTHORED_CAMPAIGN_ROOM_COUNT) {
    throw new TypeError('authored route room index is outside the campaign');
  }
  const chapterIndex = getCampaignChapterIndex(roomIndex);
  return freezeRoute({
    kind: 'authored',
    roomIndex,
    chapterIndex,
    realmIndex: chapterIndex,
    templateId: getCampaignEncounter(roomIndex, { mode: 'standard', seed }).id,
  });
}

export function createCampaignRunRoute(roomIndex, seed = 0, mode = 'standard') {
  if (!Number.isInteger(roomIndex) || roomIndex < 0 || roomIndex >= CAMPAIGN_ROUTE_ROOM_COUNT) {
    throw new TypeError('campaign route room index is outside the campaign');
  }
  const node = createCampaign(seed, mode).route[roomIndex];
  return freezeRoute({
    kind: 'campaign',
    roomIndex,
    chapterIndex: node.chapterIndex,
    realmIndex: node.chapterIndex,
    templateId: node.id,
  });
}

export function createCompatibilityRunRoute({ roomIndex, chapterIndex, templateId }) {
  if (!Number.isInteger(roomIndex) || roomIndex < 0 || !boundedChapter(chapterIndex)
    || typeof templateId !== 'string' || templateId.length < 1 || templateId.length > 128) {
    throw new TypeError('compatibility route metadata is invalid');
  }
  return freezeRoute({
    kind: 'compatibility',
    roomIndex,
    chapterIndex,
    realmIndex: chapterIndex,
    templateId,
  });
}

export function createNextStandardRunRoute(roomIndex, seed = 0) {
  if (!Number.isInteger(roomIndex) || roomIndex < 0) throw new TypeError('next route room index is invalid');
  if (roomIndex < AUTHORED_CAMPAIGN_ROOM_COUNT) return createAuthoredRunRoute(roomIndex, seed);
  return createCompatibilityRunRoute({
    roomIndex,
    chapterIndex: MAX_CAMPAIGN_CHAPTER_INDEX,
    templateId: COMPATIBILITY_BOSS_TEMPLATE_ID,
  });
}

export function normalizeRunRoute(value, { seed, stats, chapterIndex } = {}) {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== ROUTE_KEYS.size || keys.some((key) => !ROUTE_KEYS.has(key))
    || !['campaign', 'authored', 'compatibility'].includes(value.kind)
    || !Number.isInteger(value.roomIndex) || value.roomIndex < 0
    || !boundedChapter(value.chapterIndex)
    || value.realmIndex !== value.chapterIndex
    || typeof value.templateId !== 'string' || value.templateId.length < 1 || value.templateId.length > 128
    || !stats || value.roomIndex !== stats.roomsStarted
    || value.chapterIndex !== chapterIndex) return null;

  if (value.kind === 'campaign') {
    if (value.roomIndex >= CAMPAIGN_ROUTE_ROOM_COUNT) return null;
    const expected = createCampaignRunRoute(value.roomIndex, seed, 'standard');
    if (value.chapterIndex !== expected.chapterIndex || value.templateId !== expected.templateId) return null;
    return expected;
  }

  if (value.kind === 'authored') {
    if (value.roomIndex >= AUTHORED_CAMPAIGN_ROOM_COUNT) return null;
    const expected = createAuthoredRunRoute(value.roomIndex, seed);
    if (value.chapterIndex !== expected.chapterIndex || value.templateId !== expected.templateId) return null;
    return expected;
  }

  if (getEncounterTemplate(value.templateId)) return null;
  const chapterMatch = /^v2\.2-compatibility-chapter-(\d+)$/.exec(value.templateId);
  if (chapterMatch && Number(chapterMatch[1]) !== value.chapterIndex) return null;
  if (value.templateId === COMPATIBILITY_BOSS_TEMPLATE_ID
    && (value.chapterIndex !== MAX_CAMPAIGN_CHAPTER_INDEX
      || value.roomIndex < MAX_CAMPAIGN_CHAPTER_INDEX)) return null;
  return createCompatibilityRunRoute(value);
}

export function roomRequestForRunRoute(route) {
  if (route?.kind === 'campaign') return {
    campaign: true,
    nodeId: route.templateId,
    chapterIndex: route.chapterIndex,
  };
  if (route?.kind === 'compatibility') return {
    id: route.templateId,
    compatibility: true,
    chapterIndex: route.chapterIndex,
  };
  if (route?.kind === 'authored') return {
    legacyAuthored: true,
    objectiveTemplate: route.templateId,
    chapterIndex: route.chapterIndex,
  };
  throw new TypeError('run route is unavailable');
}
