function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const entry of Object.values(value)) deepFreeze(entry);
  return Object.freeze(value);
}

export const PROTOCOL_ZERO = deepFreeze({
  id: 'protocol-zero',
  label: '零号协议',
  chapterId: 'data-city',
  arena: { halfWidth: 10.5, halfHeight: 7.2 },
  silhouette: {
    bodyRadius: 1.65,
    bodyColor: 0x27e5ff,
    nodeColor: 0xff4fd8,
    kernelColor: 0xb8ff45,
  },
  phases: {
    firewall: {
      gate: { kind: 'quadrantOutcome' },
      requiredQuadrants: 4,
      centerHandshakeRadius: 1.15,
      outerRadius: 6.4,
      innerRadius: 3.45,
      targetTolerance: 1.05,
      routeCounterSeconds: 2.5,
    },
    trafficGrid: {
      gate: { kind: 'safeCellOutcome' },
      requiredSafeCells: 4,
      holdSeconds: 0.16,
      gridColumns: 3,
      gridRows: 2,
    },
    cloneNodes: {
      gate: { kind: 'nodes', nodeCount: 3 },
      nodeCount: 3,
      nodeHp: 7,
      shapes: ['diamond', 'hexagon', 'ring'],
    },
    kernel: {
      gate: { kind: 'health', threshold: 0 },
      coreHp: 6,
    },
  },
  attacks: {
    gridLock: { id: 'grid-lock', telegraphSeconds: 0.74, activeSeconds: 1.1 },
    trafficWall: {
      id: 'traffic-wall', telegraphSeconds: 0.76, activeSeconds: 1.25,
      wallCount: 4, minimumOpenLanes: 1,
    },
    cloneBurst: { id: 'clone-burst', telegraphSeconds: 0.68, activeSeconds: 1.3 },
    predictiveBeam: {
      id: 'predictive-beam', telegraphSeconds: 0.72, activeSeconds: 0.85,
      beamCount: 2, minimumOpenLanes: 1,
    },
  },
  safeCellShapes: {
    truthful: 'notched-hexagon',
    standardFalse: ['square', 'circle', 'triangle', 'diamond', 'cross'],
    abyssDecoy: ['split-square', 'ring-triangle'],
  },
  warningCap: { standard: 3, abyss: 4 },
  maxOwnedEntities: 48,
  cleanupKinds: ['bossPart', 'enemy', 'enemyProjectile', 'warning', 'enemyHazard', 'objective'],
  musicLayers: {
    firewall: 'protocol-firewall',
    trafficGrid: 'protocol-grid',
    cloneNodes: 'protocol-clones',
    kernel: 'protocol-kernel',
    cleanup: null,
  },
});

export default PROTOCOL_ZERO;
