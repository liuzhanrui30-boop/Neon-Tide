function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

const rooms = [
  {
    id: 'data-city:escort-uplink',
    objectiveTemplate: 'escort-skiff',
    objectiveType: 'escort',
    teachingStage: 'introduce',
    targetDurationSeconds: 65,
    warningCap: 2,
    activeEnemyCap: 30,
    inheritedRoles: [],
    safeRoutes: ['escort-inner-rail', 'billboard-cutback'],
    beats: [
      {
        at: 0, kind: 'data-lane', lane: 'center-packet-lane', directDamage: 0,
        laneCenter: 0, laneHalfWidth: 1, steeringMultiplier: 0.78,
        dashRecoveryRateMultiplier: 0.65,
      },
      { at: 3, kind: 'enemy-introduction', role: 'striker', count: 2 },
      {
        at: 17, kind: 'safe-route', route: 'escort-inner-rail', openLaneCount: 2,
        routePoints: [
          { x: -4.8, y: -1.4 }, { x: -1.8, y: -0.55 }, { x: 1.6, y: -0.55 },
          { x: 4.8, y: -1.4 }, { x: 2.2, y: 1.25 }, { x: -2.2, y: 1.25 },
        ],
      },
      { at: 26, kind: 'enemy-introduction', role: 'lancer', count: 1 },
      { at: 43, kind: 'pressure-test', roles: ['striker', 'lancer'], warningCap: 2 },
      { at: 55, kind: 'breather', route: 'billboard-cutback' },
    ],
  },
  {
    id: 'data-city:storm-switchback',
    objectiveTemplate: 'storm-run',
    objectiveType: 'storm-corridor',
    teachingStage: 'develop',
    targetDurationSeconds: 68,
    warningCap: 2,
    activeEnemyCap: 36,
    inheritedRoles: ['striker', 'lancer'],
    safeRoutes: ['alternating-corridor', 'maintenance-gap'],
    beats: [
      {
        at: 0, kind: 'safe-route', route: 'alternating-corridor', openLaneCount: 2,
        corridor: [
          { x: -3.6, y: -1.6 }, { x: -2.2, y: 1.6 }, { x: -0.7, y: -1.6 },
          { x: 0.7, y: 1.6 }, { x: 2.2, y: -1.6 }, { x: 3.6, y: 1.6 },
        ],
      },
      { at: 8, kind: 'enemy-introduction', role: 'warden', count: 1 },
      {
        at: 22, kind: 'route-change', route: 'maintenance-gap', openLaneCount: 1,
        corridor: [
          { x: 3.6, y: 0 }, { x: 2.2, y: 0 }, { x: 0.7, y: 1.8 },
          { x: -0.7, y: 1.8 }, { x: -2.2, y: 0 }, { x: -3.6, y: 0 },
        ],
      },
      { at: 34, kind: 'pressure-test', roles: ['lancer', 'warden'], warningCap: 2 },
      { at: 49, kind: 'pressure-test', roles: ['striker', 'warden'], warningCap: 2 },
    ],
  },
  {
    id: 'data-city:dual-crisis',
    objectiveTemplate: 'dual-crisis',
    objectiveType: 'dual-crisis',
    teachingStage: 'test',
    targetDurationSeconds: 72,
    warningCap: 3,
    activeEnemyCap: 44,
    inheritedRoles: ['striker', 'lancer', 'warden'],
    safeRoutes: ['crisis-crosslink', 'opposite-quadrant-relief'],
    beats: [
      {
        at: 0, kind: 'safe-route', route: 'crisis-crosslink', openLaneCount: 2,
        crosslink: { priority: 'balanced', reachableRadius: 2.1 },
      },
      { at: 7, kind: 'enemy-introduction', role: 'interceptor', count: 1 },
      {
        at: 20, kind: 'route-change', route: 'opposite-quadrant-relief', openLaneCount: 1,
        crosslink: { priority: 'least-charged', reachableRadius: 2.4 },
      },
      { at: 36, kind: 'pressure-test', roles: ['striker', 'lancer', 'interceptor'], warningCap: 3 },
      { at: 54, kind: 'pressure-test', roles: ['warden', 'interceptor'], warningCap: 2 },
    ],
  },
];

export const DATA_CITY_CHAPTER = deepFreeze({
  id: 'data-city',
  label: '数据都市',
  chapterIndex: 1,
  teachingOrder: ['striker', 'lancer', 'warden', 'interceptor'],
  teachingSawtooth: ['introduce', 'develop', 'test'],
  dataLane: {
    directDamage: 0,
    steeringMultiplier: 0.78,
    dashRecoveryRateMultiplier: 0.65,
  },
  rooms,
  boss: {
    id: 'protocol-zero',
    label: '零号协议',
    phases: ['firewall', 'trafficGrid', 'cloneNodes', 'kernel'],
    targetDurationSeconds: 110,
  },
});

const ROOM_BY_TEMPLATE = new Map(DATA_CITY_CHAPTER.rooms.map((room) => [room.objectiveTemplate, room]));

export function getDataCityRoomDefinition(objectiveTemplate) {
  return ROOM_BY_TEMPLATE.get(objectiveTemplate) ?? null;
}

export default DATA_CITY_CHAPTER;
