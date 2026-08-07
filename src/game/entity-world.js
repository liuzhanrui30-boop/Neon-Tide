export const ENTITY_KINDS = Object.freeze([
  'player',
  'enemy',
  'friendlyProjectile',
  'enemyProjectile',
  'pickup',
  'objective',
  'bossPart',
]);

export const DEFAULT_ENTITY_CAPACITIES = Object.freeze({
  player: 1,
  enemy: 56,
  friendlyProjectile: 96,
  enemyProjectile: 96,
  pickup: 32,
  objective: 8,
  bossPart: 32,
});

const MAX_KIND_CAPACITY = 1_000_000;
const KIND_SET = new Set(ENTITY_KINDS);
const POSITION_LIMIT = 1_000_000;
const VELOCITY_LIMIT = 100_000;
const SCALE_LIMIT = 10_000;
const GENERAL_LIMIT = 1_000_000_000_000;
const STRING_LIMIT = 128;

const FLOAT_RULES = Object.freeze({
  x: [-POSITION_LIMIT, POSITION_LIMIT, 0],
  y: [-POSITION_LIMIT, POSITION_LIMIT, 0],
  z: [-POSITION_LIMIT, POSITION_LIMIT, 0],
  previousX: [-POSITION_LIMIT, POSITION_LIMIT, 0],
  previousY: [-POSITION_LIMIT, POSITION_LIMIT, 0],
  previousZ: [-POSITION_LIMIT, POSITION_LIMIT, 0],
  vx: [-VELOCITY_LIMIT, VELOCITY_LIMIT, 0],
  vy: [-VELOCITY_LIMIT, VELOCITY_LIMIT, 0],
  vz: [-VELOCITY_LIMIT, VELOCITY_LIMIT, 0],
  rotation: [-POSITION_LIMIT, POSITION_LIMIT, 0],
  previousRotation: [-POSITION_LIMIT, POSITION_LIMIT, 0],
  scale: [0, SCALE_LIMIT, 1],
  scaleX: [0, SCALE_LIMIT, 1],
  scaleY: [0, SCALE_LIMIT, 1],
  scaleZ: [0, SCALE_LIMIT, 1],
  hp: [0, GENERAL_LIMIT, 1],
  maxHp: [0, GENERAL_LIMIT, 1],
  radius: [0, SCALE_LIMIT, 0.5],
  damage: [0, GENERAL_LIMIT, 0],
  lifetime: [0, GENERAL_LIMIT, 0],
  age: [0, GENERAL_LIMIT, 0],
  speed: [-VELOCITY_LIMIT, VELOCITY_LIMIT, 0],
  threat: [0, GENERAL_LIMIT, 0],
  opacity: [0, 1, 1],
  facing: [-POSITION_LIMIT, POSITION_LIMIT, 0],
  dashTimer: [0, GENERAL_LIMIT, 0],
  phaseTimer: [0, GENERAL_LIMIT, 0],
  perfectPhaseWindow: [0, GENERAL_LIMIT, 0],
  cameraLeadX: [-POSITION_LIMIT, POSITION_LIMIT, 0],
  cameraLeadY: [-POSITION_LIMIT, POSITION_LIMIT, 0],
  cooldown: [0, GENERAL_LIMIT, 0],
  fireTimer: [0, GENERAL_LIMIT, 0],
  progress: [0, GENERAL_LIMIT, 0],
  duration: [0, GENERAL_LIMIT, 0],
  chargeTimer: [0, GENERAL_LIMIT, 0],
  telegraphTimer: [0, GENERAL_LIMIT, 0],
  stateTimer: [0, GENERAL_LIMIT, 0],
  targetX: [-POSITION_LIMIT, POSITION_LIMIT, 0],
  targetY: [-POSITION_LIMIT, POSITION_LIMIT, 0],
  directionX: [-1, 1, 0],
  directionY: [-1, 1, 0],
  acceleration: [-VELOCITY_LIMIT, VELOCITY_LIMIT, 0],
  maxSpeed: [0, VELOCITY_LIMIT, 0],
  energy: [0, GENERAL_LIMIT, 0],
  value: [-GENERAL_LIMIT, GENERAL_LIMIT, 0],
  amount: [-GENERAL_LIMIT, GENERAL_LIMIT, 0],
  ownerId: [0, Number.MAX_SAFE_INTEGER, 0],
  targetId: [0, Number.MAX_SAFE_INTEGER, 0],
  parentId: [0, Number.MAX_SAFE_INTEGER, 0],
});
const FLOAT_FIELDS = Object.freeze(Object.keys(FLOAT_RULES));
const UINT_FIELDS = Object.freeze(['color', 'flags', 'team', 'phase', 'variantIndex']);
const BOOLEAN_FIELDS = Object.freeze([
  'executingTelegraph', 'objective', 'invulnerable', 'collidable', 'homing', 'weakPoint',
]);
const STRING_FIELDS = Object.freeze([
  'role', 'state', 'type', 'variant', 'weaponId', 'objectiveType', 'partId', 'attackKind', 'ownerKind',
]);
const VECTOR_FIELDS = Object.freeze({
  position: Object.freeze({ x: 'x', y: 'y', z: 'z' }),
  previousPosition: Object.freeze({ x: 'previousX', y: 'previousY', z: 'previousZ' }),
  velocity: Object.freeze({ x: 'vx', y: 'vy', z: 'vz' }),
  cameraLead: Object.freeze({ x: 'cameraLeadX', y: 'cameraLeadY' }),
});
const SPECIAL_FIELDS = new Set([...Object.keys(VECTOR_FIELDS), 'dashCharges']);
const COMPONENT_FIELDS = new Set([
  ...FLOAT_FIELDS,
  ...UINT_FIELDS,
  ...BOOLEAN_FIELDS,
  ...STRING_FIELDS,
  ...SPECIAL_FIELDS,
]);
const DEFAULT_COLORS = Object.freeze({
  player: 0xe7ffff,
  enemy: 0xff4fba,
  friendlyProjectile: 0x64f5ff,
  enemyProjectile: 0xff506f,
  pickup: 0xffd166,
  objective: 0x36e0ff,
  bossPart: 0xff9f43,
});

export const ENTITY_COMPONENT_FIELDS = Object.freeze([...COMPONENT_FIELDS]);

function assertKind(kind) {
  if (!KIND_SET.has(kind)) throw new RangeError(`unknown entity kind: ${String(kind)}`);
}

function readCapacity(capacities, kind) {
  const value = capacities?.[kind] ?? DEFAULT_ENTITY_CAPACITIES[kind];
  if (!Number.isInteger(value) || value < 0 || value > MAX_KIND_CAPACITY) {
    throw new RangeError(`capacity for ${kind} must be an integer from 0 to ${MAX_KIND_CAPACITY}`);
  }
  return value;
}

function sanitizeFloat(field, value, fallback = FLOAT_RULES[field][2]) {
  const [minimum, maximum] = FLOAT_RULES[field];
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
}

function sanitizeUint(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number >>> 0 : 0;
}

function sanitizeColor(value, fallback) {
  if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) return Number.parseInt(value.slice(1), 16);
  const number = Number(value);
  return Number.isFinite(number) ? number >>> 0 : fallback;
}

function sanitizeString(value) {
  if (value == null) return null;
  if (typeof value !== 'string') throw new TypeError('string entity components must be strings or null');
  return value.length <= STRING_LIMIT ? value : value.slice(0, STRING_LIMIT);
}

function validateData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('entity data must be an object');
  for (const key of Object.keys(data)) {
    if (!COMPONENT_FIELDS.has(key)) throw new TypeError(`unknown entity component: ${key}`);
  }
}

function createVectorRecord(pool, slot, fields) {
  const vector = {};
  for (const [axis, field] of Object.entries(fields)) {
    Object.defineProperty(vector, axis, {
      enumerable: true,
      get: () => pool[field][slot],
      set: (value) => { pool[field][slot] = sanitizeFloat(field, value); },
    });
  }
  return Object.seal(vector);
}

function createDashChargesRecord(pool, slot) {
  const charges = {};
  Object.defineProperties(charges, {
    0: {
      enumerable: true,
      get: () => pool.dashCharge0[slot],
      set: (value) => { pool.dashCharge0[slot] = sanitizeFloat('value', value); },
    },
    1: {
      enumerable: true,
      get: () => pool.dashCharge1[slot],
      set: (value) => { pool.dashCharge1[slot] = sanitizeFloat('value', value); },
    },
    length: { enumerable: false, value: 2 },
  });
  return Object.seal(charges);
}

function createSlotRecord(pool, slot) {
  const entity = {};
  Object.defineProperties(entity, {
    id: {
      enumerable: true,
      get: () => pool.alive[slot]
        ? pool.generations[slot] * pool.idStride + pool.offset + slot
        : null,
    },
    kind: { enumerable: true, value: pool.kind },
    slot: { enumerable: true, value: slot },
    active: { enumerable: true, get: () => pool.alive[slot] === 1 },
  });
  for (const field of FLOAT_FIELDS) {
    Object.defineProperty(entity, field, {
      enumerable: true,
      get: () => pool[field][slot],
      set: (value) => { pool[field][slot] = sanitizeFloat(field, value); },
    });
  }
  for (const field of UINT_FIELDS) {
    Object.defineProperty(entity, field, {
      enumerable: true,
      get: () => pool[field][slot],
      set: (value) => {
        pool[field][slot] = field === 'color'
          ? sanitizeColor(value, DEFAULT_COLORS[pool.kind])
          : sanitizeUint(value);
      },
    });
  }
  for (const field of BOOLEAN_FIELDS) {
    Object.defineProperty(entity, field, {
      enumerable: true,
      get: () => pool[field][slot] === 1,
      set: (value) => { pool[field][slot] = value ? 1 : 0; },
    });
  }
  for (const field of STRING_FIELDS) {
    Object.defineProperty(entity, field, {
      enumerable: true,
      get: () => pool[field][slot],
      set: (value) => { pool[field][slot] = sanitizeString(value); },
    });
  }
  for (const [key, fields] of Object.entries(VECTOR_FIELDS)) {
    Object.defineProperty(entity, key, {
      enumerable: true,
      value: createVectorRecord(pool, slot, fields),
    });
  }
  Object.defineProperty(entity, 'dashCharges', {
    enumerable: true,
    value: createDashChargesRecord(pool, slot),
  });
  return Object.seal(entity);
}

function setVector(entity, key, value) {
  if (value == null) return;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${key} must be a vector object`);
  if ('x' in value) entity[key].x = value.x;
  if ('y' in value) entity[key].y = value.y;
  if ('z' in value && 'z' in entity[key]) entity[key].z = value.z;
}

function resetSlot(pool, slot, data) {
  for (const field of FLOAT_FIELDS) pool[field][slot] = FLOAT_RULES[field][2];
  for (const field of UINT_FIELDS) pool[field][slot] = 0;
  for (const field of BOOLEAN_FIELDS) pool[field][slot] = 0;
  for (const field of STRING_FIELDS) pool[field][slot] = null;
  pool.dashCharge0[slot] = 0;
  pool.dashCharge1[slot] = 0;

  const entity = pool.views[slot];
  const x = sanitizeFloat('x', data.x ?? data.position?.x ?? 0);
  const y = sanitizeFloat('y', data.y ?? data.position?.y ?? 0);
  const z = sanitizeFloat('z', data.z ?? data.position?.z ?? 0);
  entity.x = x;
  entity.y = y;
  entity.z = z;
  entity.previousX = data.previousX ?? data.previousPosition?.x ?? x;
  entity.previousY = data.previousY ?? data.previousPosition?.y ?? y;
  entity.previousZ = data.previousZ ?? data.previousPosition?.z ?? z;
  entity.vx = data.vx ?? data.velocity?.x ?? 0;
  entity.vy = data.vy ?? data.velocity?.y ?? 0;
  entity.vz = data.vz ?? data.velocity?.z ?? 0;
  entity.rotation = data.rotation ?? 0;
  entity.previousRotation = data.previousRotation ?? entity.rotation;
  entity.scale = data.scale ?? 1;
  entity.scaleX = data.scaleX ?? 1;
  entity.scaleY = data.scaleY ?? 1;
  entity.scaleZ = data.scaleZ ?? 1;
  entity.hp = data.hp ?? 1;
  entity.maxHp = data.maxHp ?? entity.hp;
  entity.radius = data.radius ?? 0.5;
  entity.opacity = data.opacity ?? 1;
  entity.color = data.color ?? DEFAULT_COLORS[pool.kind];

  for (const field of FLOAT_FIELDS) {
    if (field in data && !['x', 'y', 'z', 'previousX', 'previousY', 'previousZ', 'vx', 'vy', 'vz',
      'rotation', 'previousRotation', 'scale', 'scaleX', 'scaleY', 'scaleZ', 'hp', 'maxHp', 'radius', 'opacity'].includes(field)) {
      entity[field] = data[field];
    }
  }
  for (const field of UINT_FIELDS) if (field in data && field !== 'color') entity[field] = data[field];
  for (const field of BOOLEAN_FIELDS) if (field in data) entity[field] = data[field];
  for (const field of STRING_FIELDS) if (field in data) entity[field] = data[field];
  setVector(entity, 'position', data.position);
  setVector(entity, 'previousPosition', data.previousPosition);
  setVector(entity, 'velocity', data.velocity);
  setVector(entity, 'cameraLead', data.cameraLead);
  if (data.dashCharges != null) {
    if (!Array.isArray(data.dashCharges) || data.dashCharges.length !== 2) {
      throw new TypeError('dashCharges must contain exactly two values');
    }
    entity.dashCharges[0] = data.dashCharges[0];
    entity.dashCharges[1] = data.dashCharges[1];
  }
}

function acquireSnapshot(pool) {
  if (pool.iterationActive) throw new Error(`nested ${pool.kind} query iteration is not supported`);
  pool.iterationActive = true;
  pool.snapshotCount = pool.count;
  for (let index = 0; index < pool.snapshotCount; index += 1) {
    const slot = pool.activeSlots[index];
    pool.snapshotSlots[index] = slot;
    pool.snapshotGenerations[index] = pool.generations[slot];
  }
}

function releaseSnapshot(pool) {
  pool.iterationActive = false;
  pool.snapshotCount = 0;
  pool.iteratorCursor = 0;
}

function nextSnapshotEntity(pool) {
  while (pool.iteratorCursor < pool.snapshotCount) {
    const slot = pool.snapshotSlots[pool.iteratorCursor];
    const generation = pool.snapshotGenerations[pool.iteratorCursor];
    pool.iteratorCursor += 1;
    if (pool.alive[slot] && pool.generations[slot] === generation) {
      return pool.views[slot];
    }
  }
  return null;
}

function createQueryView(pool) {
  pool.iteratorResult = Object.seal({ value: undefined, done: false });
  pool.iterator = Object.freeze({
    next() {
      const entity = nextSnapshotEntity(pool);
      if (entity) {
        pool.iteratorResult.value = entity;
        pool.iteratorResult.done = false;
      } else {
        pool.iteratorResult.value = undefined;
        pool.iteratorResult.done = true;
        releaseSnapshot(pool);
      }
      return pool.iteratorResult;
    },
    return() {
      pool.iteratorResult.value = undefined;
      pool.iteratorResult.done = true;
      releaseSnapshot(pool);
      return pool.iteratorResult;
    },
    [Symbol.iterator]() {
      return this;
    },
  });

  return Object.freeze({
    kind: pool.kind,
    capacity: pool.capacity,
    get length() {
      return pool.count;
    },
    at(index) {
      const normalized = index < 0 ? pool.count + index : index;
      if (!Number.isInteger(normalized) || normalized < 0 || normalized >= pool.count) return undefined;
      return pool.views[pool.activeSlots[normalized]];
    },
    forEach(callback, thisArg) {
      if (typeof callback !== 'function') throw new TypeError('query callback must be a function');
      acquireSnapshot(pool);
      let visibleIndex = 0;
      try {
        for (let index = 0; index < pool.snapshotCount; index += 1) {
          const slot = pool.snapshotSlots[index];
          if (!pool.alive[slot] || pool.generations[slot] !== pool.snapshotGenerations[index]) continue;
          callback.call(thisArg, pool.views[slot], visibleIndex, this);
          visibleIndex += 1;
        }
      } finally {
        releaseSnapshot(pool);
      }
    },
    find(callback, thisArg) {
      if (typeof callback !== 'function') throw new TypeError('query callback must be a function');
      acquireSnapshot(pool);
      let visibleIndex = 0;
      try {
        for (let index = 0; index < pool.snapshotCount; index += 1) {
          const slot = pool.snapshotSlots[index];
          if (!pool.alive[slot] || pool.generations[slot] !== pool.snapshotGenerations[index]) continue;
          const entity = pool.views[slot];
          if (callback.call(thisArg, entity, visibleIndex, this)) return entity;
          visibleIndex += 1;
        }
        return undefined;
      } finally {
        releaseSnapshot(pool);
      }
    },
    some(callback, thisArg) {
      return this.find(callback, thisArg) !== undefined;
    },
    [Symbol.iterator]() {
      acquireSnapshot(pool);
      pool.iteratorCursor = 0;
      return pool.iterator;
    },
  });
}

function createPool(kind, capacity, offset, idStride, maxGeneration) {
  const pool = {
    kind,
    capacity,
    offset,
    idStride,
    maxGeneration,
    alive: new Uint8Array(capacity),
    retired: new Uint8Array(capacity),
    generations: new Float64Array(capacity),
    freeSlots: new Uint32Array(capacity),
    activeSlots: new Uint32Array(capacity),
    activePositions: new Int32Array(capacity),
    snapshotSlots: new Uint32Array(capacity),
    snapshotGenerations: new Float64Array(capacity),
    views: new Array(capacity),
    count: 0,
    freeCount: capacity,
    retiredCount: 0,
    iterationActive: false,
    snapshotCount: 0,
    iteratorCursor: 0,
  };
  for (const field of FLOAT_FIELDS) pool[field] = new Float64Array(capacity);
  for (const field of UINT_FIELDS) pool[field] = new Uint32Array(capacity);
  for (const field of BOOLEAN_FIELDS) pool[field] = new Uint8Array(capacity);
  for (const field of STRING_FIELDS) pool[field] = new Array(capacity).fill(null);
  pool.dashCharge0 = new Float64Array(capacity);
  pool.dashCharge1 = new Float64Array(capacity);
  pool.generations.fill(1);
  pool.activePositions.fill(-1);
  for (let slot = 0; slot < capacity; slot += 1) {
    pool.freeSlots[slot] = capacity - slot - 1;
    pool.views[slot] = createSlotRecord(pool, slot);
  }
  pool.query = createQueryView(pool);
  return pool;
}

function removeActiveSlot(pool, slot) {
  const position = pool.activePositions[slot];
  const lastPosition = pool.count - 1;
  const lastSlot = pool.activeSlots[lastPosition];
  if (position !== lastPosition) {
    pool.activeSlots[position] = lastSlot;
    pool.activePositions[lastSlot] = position;
  }
  pool.activeSlots[lastPosition] = 0;
  pool.activePositions[slot] = -1;
  pool.count -= 1;
  pool.alive[slot] = 0;
}

function releaseSlot(pool, slot) {
  const reusable = pool.generations[slot] < pool.maxGeneration;
  removeActiveSlot(pool, slot);
  if (reusable) {
    pool.generations[slot] += 1;
    pool.freeSlots[pool.freeCount++] = slot;
  } else {
    pool.retired[slot] = 1;
    pool.retiredCount += 1;
  }
}

function rebuildFreeSlots(pool) {
  pool.freeCount = 0;
  for (let slot = pool.capacity - 1; slot >= 0; slot -= 1) {
    if (!pool.alive[slot] && !pool.retired[slot]) pool.freeSlots[pool.freeCount++] = slot;
  }
}

export function createEntityWorld({ capacities = {}, maxGeneration: requestedMaxGeneration } = {}) {
  if (!capacities || typeof capacities !== 'object' || Array.isArray(capacities)) {
    throw new TypeError('entity capacities must be an object');
  }
  for (const kind of Object.keys(capacities)) assertKind(kind);
  const resolvedCapacities = {};
  let totalCapacity = 0;
  for (const kind of ENTITY_KINDS) {
    resolvedCapacities[kind] = readCapacity(capacities, kind);
    totalCapacity += resolvedCapacities[kind];
  }
  if (!Number.isSafeInteger(totalCapacity) || totalCapacity < 1) {
    throw new RangeError('total entity capacity must be a positive safe integer');
  }
  const safeMaxGeneration = Math.floor((Number.MAX_SAFE_INTEGER - totalCapacity) / totalCapacity);
  const maxGeneration = requestedMaxGeneration ?? safeMaxGeneration;
  if (!Number.isSafeInteger(maxGeneration) || maxGeneration < 1 || maxGeneration > safeMaxGeneration) {
    throw new RangeError(`maxGeneration must be an integer from 1 to ${safeMaxGeneration}`);
  }

  const pools = {};
  let offset = 0;
  for (const kind of ENTITY_KINDS) {
    pools[kind] = createPool(kind, resolvedCapacities[kind], offset, totalCapacity, maxGeneration);
    offset += resolvedCapacities[kind];
  }

  let disposed = false;
  let count = 0;
  let spawned = 0;
  let despawned = 0;
  let rejectedSpawns = 0;
  let resets = 0;

  function decode(id) {
    if (!Number.isSafeInteger(id) || id < totalCapacity) return null;
    const generation = Math.floor(id / totalCapacity);
    const globalSlot = id - generation * totalCapacity;
    if (generation < 1 || globalSlot < 0 || globalSlot >= totalCapacity) return null;
    for (const kind of ENTITY_KINDS) {
      const pool = pools[kind];
      if (globalSlot >= pool.offset && globalSlot < pool.offset + pool.capacity) {
        return { pool, slot: globalSlot - pool.offset, generation };
      }
    }
    return null;
  }

  function spawn(kind, data = {}) {
    assertKind(kind);
    validateData(data);
    if (disposed) return null;
    const pool = pools[kind];
    if (pool.freeCount === 0) {
      rejectedSpawns += 1;
      return null;
    }
    const slot = pool.freeSlots[--pool.freeCount];
    pool.alive[slot] = 1;
    pool.activePositions[slot] = pool.count;
    pool.activeSlots[pool.count] = slot;
    pool.count += 1;
    try {
      resetSlot(pool, slot, data);
    } catch (error) {
      removeActiveSlot(pool, slot);
      pool.freeSlots[pool.freeCount++] = slot;
      throw error;
    }
    count += 1;
    spawned += 1;
    return pool.views[slot].id;
  }

  function despawn(id) {
    if (disposed) return false;
    const decoded = decode(id);
    if (!decoded) return false;
    const { pool, slot, generation } = decoded;
    if (!pool.alive[slot] || pool.generations[slot] !== generation) return false;
    releaseSlot(pool, slot);
    count -= 1;
    despawned += 1;
    return true;
  }

  function get(id) {
    if (disposed) return null;
    const decoded = decode(id);
    if (!decoded) return null;
    const { pool, slot, generation } = decoded;
    if (!pool.alive[slot] || pool.generations[slot] !== generation) return null;
    return pool.views[slot];
  }

  function query(kind) {
    assertKind(kind);
    return pools[kind].query;
  }

  function clearPools(incrementReset) {
    for (const kind of ENTITY_KINDS) {
      const pool = pools[kind];
      for (let slot = 0; slot < pool.capacity; slot += 1) {
        if (!pool.alive[slot]) continue;
        removeActiveSlot(pool, slot);
        if (pool.generations[slot] < pool.maxGeneration) pool.generations[slot] += 1;
        else {
          pool.retired[slot] = 1;
          pool.retiredCount += 1;
        }
      }
      rebuildFreeSlots(pool);
      releaseSnapshot(pool);
    }
    count = 0;
    if (incrementReset) resets += 1;
  }

  function reset() {
    if (disposed) return false;
    clearPools(true);
    return true;
  }

  function dispose() {
    if (disposed) return false;
    clearPools(false);
    disposed = true;
    return true;
  }

  function getStats() {
    const poolStats = {};
    for (const kind of ENTITY_KINDS) {
      const pool = pools[kind];
      poolStats[kind] = Object.freeze({
        capacity: pool.capacity,
        count: pool.count,
        available: pool.freeCount,
        retired: pool.retiredCount,
      });
    }
    return Object.freeze({
      capacity: totalCapacity,
      count,
      spawned,
      despawned,
      rejectedSpawns,
      resets,
      retired: ENTITY_KINDS.reduce((total, kind) => total + pools[kind].retiredCount, 0),
      disposed,
      pools: Object.freeze(poolStats),
    });
  }

  return Object.freeze({ spawn, despawn, query, get, reset, dispose, getStats });
}
