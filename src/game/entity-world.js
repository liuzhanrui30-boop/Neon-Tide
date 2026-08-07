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
const FLOAT_FIELDS = Object.freeze([
  'x', 'y', 'z',
  'previousX', 'previousY', 'previousZ',
  'vx', 'vy', 'vz',
  'rotation', 'previousRotation',
  'scale', 'scaleX', 'scaleY', 'scaleZ',
  'hp', 'maxHp', 'radius', 'damage',
  'lifetime', 'age', 'speed', 'threat', 'opacity',
]);
const UINT_FIELDS = Object.freeze(['color', 'flags', 'team']);
const RESERVED_DATA_KEYS = new Set([
  'id', 'kind', 'slot', 'active', 'position', 'previousPosition', 'velocity',
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

function readCapacity(capacities, kind) {
  const value = capacities?.[kind] ?? DEFAULT_ENTITY_CAPACITIES[kind];
  if (!Number.isInteger(value) || value < 0 || value > MAX_KIND_CAPACITY) {
    throw new RangeError(`capacity for ${kind} must be an integer from 0 to ${MAX_KIND_CAPACITY}`);
  }
  return value;
}

function assertKind(kind) {
  if (!KIND_SET.has(kind)) throw new RangeError(`unknown entity kind: ${String(kind)}`);
}

function nextGeneration(pool, slot) {
  const generation = pool.generations[slot] + 1;
  if (generation > pool.maxGeneration) {
    throw new RangeError(`entity generation exhausted for ${pool.kind} slot ${slot}`);
  }
  pool.generations[slot] = generation;
}

function normalizeColor(value, fallback) {
  if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) return Number.parseInt(value.slice(1), 16);
  const number = Number(value);
  return Number.isFinite(number) ? number >>> 0 : fallback;
}

function createVectorView(pool, slot, generation, fields) {
  const vector = {};
  for (const [axis, field] of Object.entries(fields)) {
    Object.defineProperty(vector, axis, {
      enumerable: true,
      get: () => pool.generations[slot] === generation && pool.alive[slot] ? pool[field][slot] : undefined,
      set(value) {
        if (pool.generations[slot] === generation && pool.alive[slot]) pool[field][slot] = Number(value);
      },
    });
  }
  return vector;
}

function createEntityView(pool, slot, generation) {
  const entity = {};
  const isCurrent = () => pool.generations[slot] === generation && pool.alive[slot] === 1;
  const id = generation * pool.idStride + pool.offset + slot;

  Object.defineProperties(entity, {
    id: { enumerable: true, value: id },
    kind: { enumerable: true, value: pool.kind },
    slot: { enumerable: true, value: slot },
    active: { enumerable: true, get: isCurrent },
  });

  for (const field of FLOAT_FIELDS) {
    Object.defineProperty(entity, field, {
      enumerable: true,
      get: () => isCurrent() ? pool[field][slot] : undefined,
      set(value) {
        if (isCurrent()) pool[field][slot] = Number(value);
      },
    });
  }
  for (const field of UINT_FIELDS) {
    Object.defineProperty(entity, field, {
      enumerable: true,
      get: () => isCurrent() ? pool[field][slot] : undefined,
      set(value) {
        if (!isCurrent()) return;
        pool[field][slot] = field === 'color'
          ? normalizeColor(value, DEFAULT_COLORS[pool.kind])
          : Number(value) >>> 0;
      },
    });
  }

  Object.defineProperties(entity, {
    position: {
      enumerable: true,
      value: createVectorView(pool, slot, generation, { x: 'x', y: 'y', z: 'z' }),
    },
    previousPosition: {
      enumerable: true,
      value: createVectorView(pool, slot, generation, {
        x: 'previousX', y: 'previousY', z: 'previousZ',
      }),
    },
    velocity: {
      enumerable: true,
      value: createVectorView(pool, slot, generation, { x: 'vx', y: 'vy', z: 'vz' }),
    },
  });
  return entity;
}

function setVector(entity, key, value) {
  if (!value || typeof value !== 'object') return;
  if ('x' in value) entity[key].x = value.x;
  if ('y' in value) entity[key].y = value.y;
  if ('z' in value) entity[key].z = value.z;
}

function initializeSlot(pool, slot, data, generation) {
  for (const field of FLOAT_FIELDS) pool[field][slot] = 0;
  for (const field of UINT_FIELDS) pool[field][slot] = 0;

  const x = Number(data.x ?? data.position?.x ?? 0);
  const y = Number(data.y ?? data.position?.y ?? 0);
  const z = Number(data.z ?? data.position?.z ?? 0);
  pool.x[slot] = x;
  pool.y[slot] = y;
  pool.z[slot] = z;
  pool.previousX[slot] = Number(data.previousX ?? data.previousPosition?.x ?? x);
  pool.previousY[slot] = Number(data.previousY ?? data.previousPosition?.y ?? y);
  pool.previousZ[slot] = Number(data.previousZ ?? data.previousPosition?.z ?? z);
  pool.vx[slot] = Number(data.vx ?? data.velocity?.x ?? 0);
  pool.vy[slot] = Number(data.vy ?? data.velocity?.y ?? 0);
  pool.vz[slot] = Number(data.vz ?? data.velocity?.z ?? 0);
  pool.rotation[slot] = Number(data.rotation ?? 0);
  pool.previousRotation[slot] = Number(data.previousRotation ?? pool.rotation[slot]);
  pool.scale[slot] = Number(data.scale ?? 1);
  pool.scaleX[slot] = Number(data.scaleX ?? 1);
  pool.scaleY[slot] = Number(data.scaleY ?? 1);
  pool.scaleZ[slot] = Number(data.scaleZ ?? 1);
  pool.hp[slot] = Number(data.hp ?? 1);
  pool.maxHp[slot] = Number(data.maxHp ?? pool.hp[slot]);
  pool.radius[slot] = Number(data.radius ?? 0.5);
  pool.damage[slot] = Number(data.damage ?? 0);
  pool.lifetime[slot] = Number(data.lifetime ?? 0);
  pool.age[slot] = Number(data.age ?? 0);
  pool.speed[slot] = Number(data.speed ?? 0);
  pool.threat[slot] = Number(data.threat ?? 0);
  pool.opacity[slot] = Number(data.opacity ?? 1);
  pool.color[slot] = normalizeColor(data.color, DEFAULT_COLORS[pool.kind]);
  pool.flags[slot] = Number(data.flags ?? 0) >>> 0;
  pool.team[slot] = Number(data.team ?? 0) >>> 0;

  const entity = createEntityView(pool, slot, generation);
  setVector(entity, 'position', data.position);
  setVector(entity, 'previousPosition', data.previousPosition);
  setVector(entity, 'velocity', data.velocity);
  for (const [key, value] of Object.entries(data)) {
    if (RESERVED_DATA_KEYS.has(key) || FLOAT_FIELDS.includes(key) || UINT_FIELDS.includes(key)) continue;
    entity[key] = value;
  }
  return entity;
}

function createQueryView(pool) {
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
      const count = pool.count;
      for (let index = 0; index < count; index += 1) {
        callback.call(thisArg, pool.views[pool.activeSlots[index]], index, this);
      }
    },
    find(callback, thisArg) {
      if (typeof callback !== 'function') throw new TypeError('query callback must be a function');
      const count = pool.count;
      for (let index = 0; index < count; index += 1) {
        const entity = pool.views[pool.activeSlots[index]];
        if (callback.call(thisArg, entity, index, this)) return entity;
      }
      return undefined;
    },
    some(callback, thisArg) {
      return this.find(callback, thisArg) !== undefined;
    },
    *[Symbol.iterator]() {
      const count = pool.count;
      for (let index = 0; index < count; index += 1) yield pool.views[pool.activeSlots[index]];
    },
  });
}

function createPool(kind, capacity, offset, idStride) {
  const pool = {
    kind,
    capacity,
    offset,
    idStride,
    maxGeneration: Math.floor((Number.MAX_SAFE_INTEGER - idStride) / idStride),
    alive: new Uint8Array(capacity),
    generations: new Float64Array(capacity),
    freeSlots: new Uint32Array(capacity),
    activeSlots: new Uint32Array(capacity),
    activePositions: new Int32Array(capacity),
    views: new Array(capacity).fill(null),
    count: 0,
    freeCount: capacity,
  };
  for (const field of FLOAT_FIELDS) pool[field] = new Float64Array(capacity);
  for (const field of UINT_FIELDS) pool[field] = new Uint32Array(capacity);
  pool.generations.fill(1);
  pool.activePositions.fill(-1);
  for (let index = 0; index < capacity; index += 1) pool.freeSlots[index] = capacity - index - 1;
  pool.query = createQueryView(pool);
  return pool;
}

export function createEntityWorld({ capacities = {} } = {}) {
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

  const pools = {};
  let offset = 0;
  for (const kind of ENTITY_KINDS) {
    pools[kind] = createPool(kind, resolvedCapacities[kind], offset, totalCapacity);
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
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('entity data must be an object');
    if (disposed) return null;
    const pool = pools[kind];
    if (pool.freeCount === 0) {
      rejectedSpawns += 1;
      return null;
    }
    const slot = pool.freeSlots[--pool.freeCount];
    const generation = pool.generations[slot];
    pool.alive[slot] = 1;
    pool.activePositions[slot] = pool.count;
    pool.activeSlots[pool.count] = slot;
    pool.count += 1;
    pool.views[slot] = initializeSlot(pool, slot, data, generation);
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
    pool.views[slot] = null;
    nextGeneration(pool, slot);
    pool.freeSlots[pool.freeCount++] = slot;
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
      pool.freeCount = pool.capacity;
      pool.count = 0;
      for (let slot = 0; slot < pool.capacity; slot += 1) {
        if (pool.alive[slot]) nextGeneration(pool, slot);
        pool.alive[slot] = 0;
        pool.activePositions[slot] = -1;
        pool.activeSlots[slot] = 0;
        pool.freeSlots[slot] = pool.capacity - slot - 1;
        pool.views[slot] = null;
      }
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
      });
    }
    return Object.freeze({
      capacity: totalCapacity,
      count,
      spawned,
      despawned,
      rejectedSpawns,
      resets,
      disposed,
      pools: Object.freeze(poolStats),
    });
  }

  return Object.freeze({ spawn, despawn, query, get, reset, dispose, getStats });
}
