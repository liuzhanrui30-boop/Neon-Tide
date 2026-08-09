function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

export const ABYSS_MAW = deepFreeze({
  id: 'abyss-maw',
  label: '深渊巨口',
  chapterId: 'abyss',
  arena: { halfWidth: 10.5, halfHeight: 7.2 },
  silhouette: {
    bodyRadius: 2.15,
    bodyColor: 0x13d9ce,
    organColor: 0xd9ff61,
    enragedColor: 0xffc857,
  },
  phases: {
    hunt: {
      stability: 100,
      gate: { kind: 'stability', threshold: 0 },
      routeBreakDamage: 9,
      tideLanceDamage: 30,
      minimumRouteBreaks: 8,
    },
    suction: {
      gate: { kind: 'suctionOutcome', requiredCrossings: 6, minimumSeconds: 3 },
      pullAcceleration: 7.8,
      safeGateRadius: 2.45,
      centerRadius: 3.1,
    },
    weakPoints: {
      gate: { kind: 'organs', organCount: 3 },
      organCount: 3,
      organHp: 8,
      exposureRadius: 7.1,
      shiftedCenter: { x: 2.35, y: -0.8 },
    },
    enraged: {
      gate: { kind: 'health', threshold: 0 },
      coreHp: 24,
      outerRingDangerRadius: 7.25,
      shiftedCenter: { x: -2.1, y: 1.15 },
    },
  },
  attacks: {
    suctionCurrent: {
      id: 'suction-current', telegraphSeconds: 0.72, activeSeconds: 2.4,
      currentCount: 4, radius: 1.05, pullAcceleration: 7.8,
    },
    tentacleFan: {
      id: 'tentacle-fan', telegraphSeconds: 0.78, activeSeconds: 1.2,
      tentacleCount: 7, safeGapCount: 2, radius: 0.52, reach: 8.6,
    },
    trackingJelly: {
      id: 'tracking-jelly', telegraphSeconds: 0.66, activeSeconds: 5,
      count: 3, speed: 3.9, radius: 0.48,
    },
    biteZone: {
      id: 'bite-zone', telegraphSeconds: 0.82, activeSeconds: 0.9,
      halfWidth: 3.4, halfHeight: 1.35, damage: 0.65,
    },
  },
  cleanupKinds: ['bossPart', 'enemy', 'enemyProjectile', 'warning', 'enemyHazard'],
  musicLayers: {
    hunt: 'abyss-maw-hunt', suction: 'abyss-maw-suction',
    weakPoints: 'abyss-maw-organs', enraged: 'abyss-maw-enraged', cleanup: null,
  },
});

export default ABYSS_MAW;
