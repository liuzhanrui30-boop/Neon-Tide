function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

const rooms = [
  {
    id: 'abyss:tutorial-purge',
    objectiveTemplate: 'purge-tide',
    objectiveType: 'purge',
    targetDurationSeconds: 58,
    warningCap: 2,
    activeEnemyCap: 26,
    inheritedRoles: [],
    beats: [
      { at: 0, kind: 'landmark', landmark: '沉没舰骸', route: 'center-lane' },
      { at: 2, kind: 'enemy-introduction', role: 'hunter', count: 4 },
      { at: 14, kind: 'enemy-introduction', role: 'swarm', count: 6 },
      { at: 29, kind: 'route-change', route: 'wreck-gap', oppositeQuadrant: true },
      { at: 36, kind: 'enemy-introduction', role: 'interceptor', count: 1 },
      { at: 48, kind: 'pressure-test', roles: ['hunter', 'swarm', 'interceptor'] },
    ],
  },
  {
    id: 'abyss:moving-sanctum',
    objectiveTemplate: 'moving-sanctum',
    objectiveType: 'moving-zone',
    targetDurationSeconds: 62,
    warningCap: 2,
    activeEnemyCap: 34,
    inheritedRoles: ['hunter', 'swarm', 'interceptor'],
    beats: [
      { at: 0, kind: 'route-change', route: 'jelly-current', oppositeQuadrant: true },
      { at: 8, kind: 'enemy-introduction', role: 'mine', count: 2 },
      { at: 20, kind: 'route-change', route: 'coral-switchback', oppositeQuadrant: true },
      { at: 34, kind: 'pressure-test', roles: ['swarm', 'mine'] },
      { at: 49, kind: 'pressure-test', roles: ['interceptor', 'mine'] },
    ],
  },
  {
    id: 'abyss:anchor-grotto',
    objectiveTemplate: 'anchor-break',
    objectiveType: 'anchors',
    targetDurationSeconds: 65,
    warningCap: 3,
    activeEnemyCap: 42,
    inheritedRoles: ['hunter', 'swarm', 'interceptor', 'mine'],
    beats: [
      { at: 0, kind: 'route-change', route: 'tri-anchor-grotto', oppositeQuadrant: true },
      { at: 10, kind: 'pressure-test', roles: ['hunter', 'mine'] },
      { at: 26, kind: 'route-change', route: 'eye-line', oppositeQuadrant: true },
      { at: 39, kind: 'pressure-test', roles: ['interceptor', 'swarm', 'mine'] },
      { at: 55, kind: 'breather', landmark: '远海巨眼' },
    ],
  },
];

const absoluteBeats = rooms.flatMap((room, roomIndex) => {
  const offset = rooms.slice(0, roomIndex).reduce((sum, entry) => sum + entry.targetDurationSeconds, 0);
  return room.beats.map((beat) => ({ ...beat, roomId: room.id, at: offset + beat.at }));
}).filter(({ at }) => at <= 90).sort((left, right) => left.at - right.at);

export const ABYSS_FIRST_NINETY_SECONDS = deepFreeze({
  maxSimultaneousHighDamageWarnings: 2,
  beats: absoluteBeats,
  roleIntroductions: absoluteBeats
    .filter(({ kind }) => kind === 'enemy-introduction')
    .map(({ role, at, roomId }) => ({ role, at, roomId })),
  routeChanges: absoluteBeats
    .filter(({ kind }) => kind === 'route-change')
    .map(({ route, at, roomId, oppositeQuadrant }) => ({ route, at, roomId, oppositeQuadrant })),
});

export const ABYSS_CHAPTER = deepFreeze({
  id: 'abyss',
  label: '幽光深渊',
  chapterIndex: 0,
  teachingOrder: ['hunter', 'swarm', 'interceptor', 'mine'],
  firstNinetySeconds: ABYSS_FIRST_NINETY_SECONDS,
  rooms,
  boss: {
    id: 'abyss-maw',
    label: '深渊巨口',
    phases: ['hunt', 'suction', 'weakPoints', 'enraged'],
    targetDurationSeconds: 100,
  },
});

const ROOM_BY_TEMPLATE = new Map(ABYSS_CHAPTER.rooms.map((room) => [room.objectiveTemplate, room]));

export function getAbyssRoomDefinition(objectiveTemplate) {
  return ROOM_BY_TEMPLATE.get(objectiveTemplate) ?? null;
}

export default ABYSS_CHAPTER;
