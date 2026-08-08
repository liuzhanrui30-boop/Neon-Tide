const COLORS = Object.freeze({
  anchor: 0x36e0ff,
  'moving-zone': 0x64f5ff,
  escort: 0xffd166,
  core: 0xa56bff,
  crisis: 0xff4fba,
  stormActive: 0x78fff1,
  stormNext: 0xffd166,
  stormInactive: 0x385d78,
});

function entryKey(kind, sourceId) {
  return `${kind}:${sourceId}`;
}

export function createObjectiveWorldBridge({ world } = {}) {
  if (!world?.spawn || !world?.write || !world?.despawn || !world?.get) {
    throw new TypeError('objective world bridge requires an EntityWorld');
  }
  const entities = new Map();
  let objectiveId = null;
  let spawnEvents = 0;
  let progressEvents = 0;
  let cleanupEvents = 0;
  let syncs = 0;

  function clear() {
    for (const { id } of entities.values()) world.despawn(id);
    entities.clear();
    objectiveId = null;
    return true;
  }

  function consume(event) {
    if (!event || typeof event.type !== 'string') return false;
    if (event.type === 'objective:spawn') {
      spawnEvents += 1;
      objectiveId = event.payload?.objectiveId ?? objectiveId;
    } else if (event.type === 'objective:progress') {
      progressEvents += 1;
    } else if (event.type === 'objective:cleanup') {
      cleanupEvents += 1;
      clear();
    }
    return true;
  }

  function upsert(kind, sourceId, data) {
    const key = entryKey(kind, sourceId);
    const current = entities.get(key);
    let id = current?.id ?? 0;
    const existing = id ? world.get(id) : null;
    if (!existing) {
      id = world.spawn(kind, { ...data, sourceId }) ?? 0;
      if (!id) return false;
      entities.set(key, { id, kind, sourceId });
      return true;
    }
    world.write(id, {
      ...data,
      sourceId,
      previousX: existing.x,
      previousY: existing.y,
      previousRotation: existing.rotation,
    });
    return true;
  }

  function removeMissing(desired) {
    for (const [key, entry] of entities) {
      if (desired.has(key)) continue;
      world.despawn(entry.id);
      entities.delete(key);
    }
  }

  function sync(objective) {
    if (!objective || objective.status !== 'active') return false;
    if (objectiveId !== null && objectiveId !== objective.id) clear();
    objectiveId = objective.id;
    const desired = new Set();
    const add = (kind, sourceId, data) => {
      desired.add(entryKey(kind, sourceId));
      upsert(kind, sourceId, data);
    };

    if (objective.type === 'anchors') {
      for (const anchor of objective.anchors) add('objective', anchor.sourceId, {
        x: anchor.x, y: anchor.y, radius: anchor.radius, scale: anchor.radius,
        team: 1, role: 'anchor', type: 'anchor', objective: true, objectiveType: 'anchors',
        progress: anchor.charge / anchor.requiredSeconds, completed: anchor.completed,
        state: anchor.completed ? 'completed' : 'active', color: COLORS.anchor,
        collidable: false, invulnerable: true,
      });
    } else if (objective.type === 'moving-zone') {
      const zone = objective.safeZone;
      add('objective', zone.sourceId, {
        x: zone.x, y: zone.y, radius: zone.radius, scale: zone.radius,
        team: 1, role: 'safe-zone', type: 'moving-zone', objective: true, objectiveType: 'moving-zone',
        progress: objective.progressRatio, state: 'active', color: COLORS['moving-zone'],
        collidable: false, invulnerable: true,
      });
    } else if (objective.type === 'escort') {
      const escort = objective.escort;
      add('objective', escort.sourceId, {
        x: escort.x, y: escort.y, radius: 0.8, scale: 1.1,
        hp: escort.hp, maxHp: escort.maxHp, team: 1, role: 'escort', type: 'escort-skiff',
        objective: true, objectiveType: 'escort', progress: objective.progressRatio,
        state: 'active', color: COLORS.escort, collidable: true, invulnerable: false,
      });
    } else if (objective.type === 'core-harvest') {
      for (const core of objective.cores) {
        if (core.collected) continue;
        add('pickup', core.sourceId, {
          x: core.x, y: core.y, radius: core.radius, scale: 1.15, value: 1,
          team: 1, role: 'harvest-core', type: 'objective-core', objective: true,
          objectiveType: 'core-harvest', state: 'active', color: COLORS.core, collidable: true,
        });
      }
    } else if (objective.type === 'dual-crisis') {
      for (const crisis of objective.crises) add('objective', crisis.sourceId, {
        x: crisis.x, y: crisis.y, radius: crisis.radius, scale: crisis.radius,
        team: 1, role: 'crisis', type: crisis.variant, objective: true, objectiveType: 'dual-crisis',
        progress: crisis.charge / crisis.requiredSeconds, completed: crisis.completed,
        state: crisis.completed ? 'completed' : crisis.escalated ? 'escalated' : 'active',
        color: COLORS.crisis, collidable: false, invulnerable: true,
      });
    } else if (objective.type === 'storm-corridor') {
      const active = objective.corridor.activeSegment;
      const next = Math.max(0, Math.min(objective.corridor.segments.length - 1, active + objective.corridor.direction));
      objective.corridor.segments.forEach((segment, index) => add('objective',
        segment.sourceId ?? (objective.safeZone.sourceId + index + 1), {
          x: segment.x, y: segment.y, radius: segment.width, scale: segment.width,
          scaleX: objective.corridor.horizontal ? 1.35 : 0.72,
          scaleY: objective.corridor.horizontal ? 0.72 : 1.35,
          team: 1, role: 'storm-segment', type: 'storm-segment', objective: true,
          objectiveType: 'storm-corridor', progress: objective.progressRatio,
          state: index === active ? 'active' : index === next ? 'telegraph' : 'inactive',
          color: index === active ? COLORS.stormActive : index === next ? COLORS.stormNext : COLORS.stormInactive,
          collidable: false, invulnerable: true,
        }));
    }
    removeMissing(desired);
    syncs += 1;
    return true;
  }

  function getStats() {
    return Object.freeze({ objectiveId, entities: entities.size, spawnEvents, progressEvents, cleanupEvents, syncs });
  }

  return Object.freeze({ consume, sync, clear, reset: clear, getStats });
}

