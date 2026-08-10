import { ABYSS_CHAPTER } from './chapters/abyss.js';

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

const chapters = [
  {
    id: ABYSS_CHAPTER.id, index: 0, label: ABYSS_CHAPTER.label, shortLabel: '深渊', cssTheme: 'abyss',
    normalRoomCount: ABYSS_CHAPTER.rooms.length,
    bossId: ABYSS_CHAPTER.boss.id,
    bossLabel: ABYSS_CHAPTER.boss.label,
    targetDurationSeconds: ABYSS_CHAPTER.rooms.reduce((sum, room) => sum + room.targetDurationSeconds, 0)
      + ABYSS_CHAPTER.boss.targetDurationSeconds,
    palette: ['#07172f', '#13d9ce', '#7df6ff', '#d9ff61', '#ffc857'],
    objectiveTemplates: ABYSS_CHAPTER.rooms.map(({ objectiveTemplate }) => objectiveTemplate),
    roomDurations: ABYSS_CHAPTER.rooms.map(({ targetDurationSeconds }) => targetDurationSeconds),
    bossDuration: ABYSS_CHAPTER.boss.targetDurationSeconds,
    landmarks: ['珊瑚峡谷', '沉没舰骸', '远海巨眼'],
  },
  {
    id: 'data-city', index: 1, label: '数据都市', shortLabel: '都市', cssTheme: 'data-city',
    normalRoomCount: 3, bossId: 'protocol-zero', bossLabel: '零号协议', targetDurationSeconds: 315,
    // This chapter is an authored introduce → develop → test sequence. Abyss
    // changes pressure and Boss variants, but cannot shuffle away its teach
    // order or the chapter's declared room contracts.
    preserveObjectiveOrder: true,
    palette: ['#0a1038', '#27e5ff', '#ff4fd8', '#936cff', '#b8ff45'],
    objectiveTemplates: ['escort-skiff', 'storm-run', 'dual-crisis'],
    roomDurations: [65, 68, 72], bossDuration: 110,
    landmarks: ['服务器天际线', '悬浮车流', '协议主塔'],
  },
  {
    id: 'star-forge', index: 2, label: '赤红星炉', shortLabel: '星炉', cssTheme: 'star-forge',
    normalRoomCount: 3, bossId: 'solar-founder', bossLabel: '太阳铸主', targetDurationSeconds: 353,
    palette: ['#23070e', '#ff4b24', '#ff9f43', '#fff0a6', '#8c4dff'],
    objectiveTemplates: ['core-harvest', 'elite-pursuit', 'anchor-break'],
    roomDurations: [72, 76, 80], bossDuration: 125,
    landmarks: ['恒星弧面', '铸造环', '熔融输送带'],
  },
  {
    id: 'void-cathedral', index: 3, label: '虚空圣堂', shortLabel: '圣堂', cssTheme: 'void-cathedral',
    normalRoomCount: 2, bossId: 'void-regent', bossLabel: '虚空摄政王', targetDurationSeconds: 367,
    palette: ['#03030a', '#ecf8ff', '#72e8ff', '#55258f', '#ff55cb'],
    objectiveTemplates: ['dual-crisis', 'storm-run'],
    roomDurations: [82, 88], bossDuration: 197,
    landmarks: ['悬浮拱门', '反向瀑布', '仪式阶梯'],
  },
];

export const CAMPAIGN_CHAPTERS = deepFreeze(chapters);

const CHAPTER_BY_ID = new Map(CAMPAIGN_CHAPTERS.map((chapter) => [chapter.id, chapter]));
const lazyModules = Object.freeze({
  'data-city': () => import('./chapter-chunks/data-city.js'),
  'star-forge': () => import('./chapter-chunks/star-forge.js'),
  'void-cathedral': () => import('./chapter-chunks/void-cathedral.js'),
});
const loadState = new Map(Object.keys(lazyModules).map((id) => [id, 'idle']));
const loadCache = new Map();

export function getCampaignChapter(chapterIdOrIndex) {
  if (Number.isInteger(chapterIdOrIndex)) return CAMPAIGN_CHAPTERS[chapterIdOrIndex] ?? null;
  return CHAPTER_BY_ID.get(chapterIdOrIndex) ?? null;
}

export function getChapterContentLoadState() {
  return Object.freeze(Object.fromEntries(loadState));
}

export async function loadChapterContent(chapterId) {
  const chapter = getCampaignChapter(chapterId);
  if (!chapter) throw new TypeError(`unknown campaign chapter: ${chapterId}`);
  if (chapter.id === 'abyss') return chapter;
  if (loadCache.has(chapter.id)) return loadCache.get(chapter.id);
  const loader = lazyModules[chapter.id];
  loadState.set(chapter.id, 'loading');
  const promise = loader()
    .then((module) => {
      const content = module.default ?? module.CHAPTER_CONTENT;
      if (!content || content.chapterId !== chapter.id) throw new TypeError(`invalid lazy chapter content: ${chapter.id}`);
      loadState.set(chapter.id, 'loaded');
      return content;
    })
    .catch((error) => {
      loadCache.delete(chapter.id);
      loadState.set(chapter.id, 'idle');
      throw error;
    });
  loadCache.set(chapter.id, promise);
  return promise;
}
