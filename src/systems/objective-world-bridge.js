import { createEntityReadTarget } from '../game/entity-world.js';

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

const PATCH_FIELDS = Object.freeze([
  'x', 'y', 'radius', 'scale', 'scaleX', 'scaleY', 'hp', 'maxHp', 'value', 'team',
  'role', 'type', 'objective', 'objectiveType', 'progress', 'completed', 'state', 'color',
  'collidable', 'invulnerable', 'sourceId',
]);

function resetPatch(patch, sourceId) {
  patch.x = 0;
  patch.y = 0;
  patch.previousX = 0;
  patch.previousY = 0;
  patch.previousRotation = 0;
  patch.radius = 0.5;
  patch.scale = 1;
  patch.scaleX = 1;
  patch.scaleY = 1;
  patch.hp = 1;
  patch.maxHp = 1;
  patch.value = 0;
  patch.team = 1;
  patch.role = 'objective';
  patch.type = 'objective';
  patch.objective = true;
  patch.objectiveType = 'unknown';
  patch.progress = 0;
  patch.completed = false;
  patch.state = 'active';
  patch.color = COLORS.anchor;
  patch.collidable = false;
  patch.invulnerable = true;
  patch.sourceId = sourceId;
  return patch;
}

function patchChanged(entry, patch) {
  for (let index = 0; index < PATCH_FIELDS.length; index += 1) {
    const field = PATCH_FIELDS[index];
    if (entry[field] !== patch[field]) return true;
  }
  return false;
}

function cachePatch(entry, patch) {
  for (let index = 0; index < PATCH_FIELDS.length; index += 1) {
    const field = PATCH_FIELDS[index];
    entry[field] = patch[field];
  }
}

export function createObjectiveWorldBridge({ world } = {}) {
  if (!world?.spawn || !world?.write || !world?.despawn || !world?.readInto) {
    throw new TypeError('objective world bridge requires an EntityWorld');
  }
  const entities = [];
  const entitiesBySourceId = new Map();
  const readTarget = createEntityReadTarget();
  const patch = {};
  let objectiveId = null;
  let spawnEvents = 0;
  let progressEvents = 0;
  let cleanupEvents = 0;
  let syncs = 0;
  let syncRevision = 0;
  let writes = 0;
  let skippedWrites = 0;

  function clear() {
    for (let index = entities.length - 1; index >= 0; index -= 1) world.despawn(entities[index].id);
    entities.length = 0;
    entitiesBySourceId.clear();
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

  function upsert(kind, sourceId) {
    let entry = entitiesBySourceId.get(sourceId);
    const existing = entry ? world.readInto(entry.id, readTarget) : null;
    if (!entry || !existing) {
      if (entry) {
        const staleIndex = entities.indexOf(entry);
        if (staleIndex >= 0) entities.splice(staleIndex, 1);
        entitiesBySourceId.delete(sourceId);
      }
      patch.previousX = patch.x;
      patch.previousY = patch.y;
      const id = world.spawn(kind, patch) ?? 0;
      if (!id) return false;
      entry = { id, kind, sourceId, touched: syncRevision };
      cachePatch(entry, patch);
      entities.push(entry);
      entitiesBySourceId.set(sourceId, entry);
      return true;
    }
    entry.touched = syncRevision;
    if (!patchChanged(entry, patch)) {
      skippedWrites += 1;
      return true;
    }
    patch.previousX = existing.x;
    patch.previousY = existing.y;
    patch.previousRotation = existing.rotation;
    if (!world.write(entry.id, patch)) return false;
    cachePatch(entry, patch);
    writes += 1;
    return true;
  }

  function removeUntouched() {
    for (let index = entities.length - 1; index >= 0; index -= 1) {
      const entry = entities[index];
      if (entry.touched === syncRevision) continue;
      world.despawn(entry.id);
      entitiesBySourceId.delete(entry.sourceId);
      entities.splice(index, 1);
    }
  }

  function addAnchor(anchor) {
    resetPatch(patch, anchor.sourceId);
    patch.x = anchor.x;
    patch.y = anchor.y;
    patch.radius = anchor.radius;
    patch.scale = anchor.radius;
    patch.role = 'anchor';
    patch.type = 'anchor';
    patch.objectiveType = 'anchors';
    patch.progress = anchor.charge / anchor.requiredSeconds;
    patch.completed = anchor.completed;
    patch.state = anchor.completed ? 'completed' : 'active';
    patch.color = COLORS.anchor;
    return upsert('objective', anchor.sourceId);
  }

  function addMovingZone(objective) {
    const zone = objective.safeZone;
    resetPatch(patch, zone.sourceId);
    patch.x = zone.x;
    patch.y = zone.y;
    patch.radius = zone.radius;
    patch.scale = zone.radius;
    patch.role = 'safe-zone';
    patch.type = 'moving-zone';
    patch.objectiveType = 'moving-zone';
    patch.progress = objective.progressRatio;
    patch.color = COLORS['moving-zone'];
    return upsert('objective', zone.sourceId);
  }

  function addEscort(objective) {
    const escort = objective.escort;
    resetPatch(patch, escort.sourceId);
    patch.x = escort.x;
    patch.y = escort.y;
    patch.radius = 0.8;
    patch.scale = 1.1;
    patch.hp = escort.hp;
    patch.maxHp = escort.maxHp;
    patch.role = 'escort';
    patch.type = 'escort-skiff';
    patch.objectiveType = 'escort';
    patch.progress = objective.progressRatio;
    patch.color = COLORS.escort;
    patch.collidable = true;
    patch.invulnerable = false;
    return upsert('objective', escort.sourceId);
  }

  function addCore(core) {
    resetPatch(patch, core.sourceId);
    patch.x = core.x;
    patch.y = core.y;
    patch.radius = core.radius;
    patch.scale = 1.15;
    patch.value = 1;
    patch.role = 'harvest-core';
    patch.type = 'objective-core';
    patch.objectiveType = 'core-harvest';
    patch.color = COLORS.core;
    patch.collidable = true;
    patch.invulnerable = false;
    return upsert('pickup', core.sourceId);
  }

  function addCrisis(crisis) {
    resetPatch(patch, crisis.sourceId);
    patch.x = crisis.x;
    patch.y = crisis.y;
    patch.radius = crisis.radius;
    patch.scale = crisis.radius;
    patch.role = 'crisis';
    patch.type = crisis.variant;
    patch.objectiveType = 'dual-crisis';
    patch.progress = crisis.charge / crisis.requiredSeconds;
    patch.completed = crisis.completed;
    patch.state = crisis.completed ? 'completed' : crisis.escalated ? 'escalated' : 'active';
    patch.color = COLORS.crisis;
    return upsert('objective', crisis.sourceId);
  }

  function addStormSegment(objective, segment, index, active, next) {
    const sourceId = segment.sourceId ?? (objective.safeZone.sourceId + index + 1);
    resetPatch(patch, sourceId);
    patch.x = segment.x;
    patch.y = segment.y;
    patch.radius = segment.width;
    patch.scale = segment.width;
    patch.scaleX = objective.corridor.horizontal ? 1.35 : 0.72;
    patch.scaleY = objective.corridor.horizontal ? 0.72 : 1.35;
    patch.role = 'storm-segment';
    patch.type = 'storm-segment';
    patch.objectiveType = 'storm-corridor';
    patch.progress = objective.progressRatio;
    patch.state = index === active ? 'active' : index === next ? 'telegraph' : 'inactive';
    patch.color = index === active ? COLORS.stormActive : index === next ? COLORS.stormNext : COLORS.stormInactive;
    return upsert('objective', sourceId);
  }

  function sync(objective) {
    if (!objective || objective.status !== 'active') return false;
    if (objectiveId !== null && objectiveId !== objective.id) clear();
    objectiveId = objective.id;
    syncRevision += 1;

    if (objective.type === 'anchors') {
      for (let index = 0; index < objective.anchors.length; index += 1) addAnchor(objective.anchors[index]);
    } else if (objective.type === 'moving-zone') {
      addMovingZone(objective);
    } else if (objective.type === 'escort') {
      addEscort(objective);
    } else if (objective.type === 'core-harvest') {
      for (let index = 0; index < objective.cores.length; index += 1) {
        if (!objective.cores[index].collected) addCore(objective.cores[index]);
      }
    } else if (objective.type === 'dual-crisis') {
      for (let index = 0; index < objective.crises.length; index += 1) addCrisis(objective.crises[index]);
    } else if (objective.type === 'storm-corridor') {
      const active = objective.corridor.activeSegment;
      const next = Math.max(0, Math.min(objective.corridor.segments.length - 1, active + objective.corridor.direction));
      for (let index = 0; index < objective.corridor.segments.length; index += 1) {
        addStormSegment(objective, objective.corridor.segments[index], index, active, next);
      }
    }
    removeUntouched();
    syncs += 1;
    return true;
  }

  function getStats() {
    return Object.freeze({
      objectiveId, entities: entities.length, spawnEvents, progressEvents, cleanupEvents, syncs, writes, skippedWrites,
    });
  }

  return Object.freeze({ consume, sync, clear, reset: clear, getStats });
}
