export const ENTITY_KINDS = Object.freeze([
  'player',
  'enemy',
  'friendlyProjectile',
  'enemyProjectile',
  'warning',
  'enemyHazard',
  'pickup',
  'objective',
  'bossPart',
]);

export const DEFAULT_ENTITY_CAPACITIES = Object.freeze({
  player: 1,
  enemy: 56,
  friendlyProjectile: 96,
  enemyProjectile: 96,
  warning: 96,
  enemyHazard: 96,
  pickup: 32,
  objective: 24,
  bossPart: 32,
});

export const COARSE_ENTITY_CAPACITIES = Object.freeze({
  ...DEFAULT_ENTITY_CAPACITIES,
  friendlyProjectile: 72,
  enemyProjectile: 72,
  warning: 72,
  enemyHazard: 72,
});

export function selectEntityCapacities({ coarsePointer = false } = {}) {
  return coarsePointer ? COARSE_ENTITY_CAPACITIES : DEFAULT_ENTITY_CAPACITIES;
}

export const ENTITY_FLAG_HIDDEN = 1;

const MAX_KIND_CAPACITY = 1_000_000;
const CALLBACK_SCRATCH_DEPTH = 8;
const ACCESS_SCRATCH_DEPTH = 8;
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
  turnRate: [0, VELOCITY_LIMIT, 0],
  orbitAngle: [-POSITION_LIMIT, POSITION_LIMIT, 0],
  orbitRadius: [0, SCALE_LIMIT, 0],
  impactRadius: [0, SCALE_LIMIT, 0],
  hitCooldown: [0, GENERAL_LIMIT, 0],
  contactRadius: [0, SCALE_LIMIT, 0],
  energy: [0, GENERAL_LIMIT, 0],
  value: [-GENERAL_LIMIT, GENERAL_LIMIT, 0],
  amount: [-GENERAL_LIMIT, GENERAL_LIMIT, 0],
  ownerId: [0, Number.MAX_SAFE_INTEGER, 0],
  targetId: [0, Number.MAX_SAFE_INTEGER, 0],
  parentId: [0, Number.MAX_SAFE_INTEGER, 0],
  sourceId: [0, Number.MAX_SAFE_INTEGER, 0],
});
const FLOAT_FIELDS = Object.freeze(Object.keys(FLOAT_RULES));
const UINT_FIELDS = Object.freeze([
  'color', 'flags', 'team', 'phase', 'variantIndex', 'splitCount', 'chainCount', 'pierceCount', 'sequence',
  'counterToken', 'dashToken', 'lanceToken', 'warningGroup',
]);
const BOOLEAN_FIELDS = Object.freeze([
  'executingTelegraph', 'objective', 'invulnerable', 'collidable', 'homing', 'weakPoint',
  'piercing', 'splitOnImpact', 'completed', 'contactDamaging', 'armored',
]);
const STRING_FIELDS = Object.freeze([
  'role', 'state', 'type', 'variant', 'weaponId', 'objectiveType', 'partId', 'attackKind', 'ownerKind',
]);
const STORAGE_FIELDS = Object.freeze([
  ...FLOAT_FIELDS,
  ...UINT_FIELDS,
  ...BOOLEAN_FIELDS,
  ...STRING_FIELDS,
  'dashCharge0',
  'dashCharge1',
]);
const STORAGE_FIELD_INDEX = Object.freeze(Object.fromEntries(
  STORAGE_FIELDS.map((field, index) => [field, index]),
));
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
  warning: 0xff9f43,
  enemyHazard: 0xff506f,
  pickup: 0xffd166,
  objective: 0x36e0ff,
  bossPart: 0xff9f43,
});

export const ENTITY_COMPONENT_FIELDS = Object.freeze([...COMPONENT_FIELDS]);

export function createEntityReadTarget() {
  const target = {
    id: null,
    kind: null,
    slot: -1,
    active: false,
    dashCharge0: 0,
    dashCharge1: 0,
  };
  for (const field of FLOAT_FIELDS) target[field] = FLOAT_RULES[field][2];
  for (const field of UINT_FIELDS) target[field] = 0;
  for (const field of BOOLEAN_FIELDS) target[field] = false;
  for (const field of STRING_FIELDS) target[field] = null;
  return target;
}

function createWriteScratch() {
  return {
    values: createEntityReadTarget(),
    present: new Uint8Array(STORAGE_FIELDS.length),
  };
}

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
  return value.length <= STRING_LIMIT ? value : value.slice(0, STRING_LIMIT);
}

function validateVector(key, value) {
  if (value == null) return;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${key} must be a vector object`);
}

function validateData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new TypeError('entity data must be an object');
  for (const key in data) {
    if (!Object.hasOwn(data, key)) continue;
    if (!COMPONENT_FIELDS.has(key)) throw new TypeError(`unknown entity component: ${key}`);
    if (STRING_FIELDS.includes(key) && data[key] != null && typeof data[key] !== 'string') {
      throw new TypeError(`${key} must be a string or null`);
    }
    if (SPECIAL_FIELDS.has(key) && key !== 'dashCharges') validateVector(key, data[key]);
    if (key === 'dashCharges' && data[key] != null
      && (!Array.isArray(data[key]) || data[key].length !== 2)) {
      throw new TypeError('dashCharges must contain exactly two values');
    }
  }
}

function setVector(pool, slot, key, value) {
  if (value == null) return;
  const fields = VECTOR_FIELDS[key];
  for (const axis in fields) {
    if (Object.hasOwn(value, axis)) {
      const field = fields[axis];
      pool[field][slot] = sanitizeFloat(field, value[axis]);
    }
  }
}

function setComponent(pool, slot, key, value) {
  if (Object.hasOwn(FLOAT_RULES, key)) pool[key][slot] = sanitizeFloat(key, value);
  else if (UINT_FIELDS.includes(key)) {
    pool[key][slot] = key === 'color' ? sanitizeColor(value, DEFAULT_COLORS[pool.kind]) : sanitizeUint(value);
  } else if (BOOLEAN_FIELDS.includes(key)) pool[key][slot] = value ? 1 : 0;
  else if (STRING_FIELDS.includes(key)) pool[key][slot] = sanitizeString(value);
  else if (Object.hasOwn(VECTOR_FIELDS, key)) setVector(pool, slot, key, value);
  else if (key === 'dashCharges' && value != null) {
    pool.dashCharge0[slot] = sanitizeFloat('value', value[0]);
    pool.dashCharge1[slot] = sanitizeFloat('value', value[1]);
  }
}

function initializeSlot(pool, slot, data) {
  for (const field of FLOAT_FIELDS) pool[field][slot] = FLOAT_RULES[field][2];
  for (const field of UINT_FIELDS) pool[field][slot] = 0;
  for (const field of BOOLEAN_FIELDS) pool[field][slot] = 0;
  for (const field of STRING_FIELDS) pool[field][slot] = null;
  pool.dashCharge0[slot] = 0;
  pool.dashCharge1[slot] = 0;

  const x = sanitizeFloat('x', data.x ?? data.position?.x ?? 0);
  const y = sanitizeFloat('y', data.y ?? data.position?.y ?? 0);
  const z = sanitizeFloat('z', data.z ?? data.position?.z ?? 0);
  pool.x[slot] = x;
  pool.y[slot] = y;
  pool.z[slot] = z;
  pool.previousX[slot] = sanitizeFloat('previousX', data.previousX ?? data.previousPosition?.x ?? x);
  pool.previousY[slot] = sanitizeFloat('previousY', data.previousY ?? data.previousPosition?.y ?? y);
  pool.previousZ[slot] = sanitizeFloat('previousZ', data.previousZ ?? data.previousPosition?.z ?? z);
  pool.vx[slot] = sanitizeFloat('vx', data.vx ?? data.velocity?.x ?? 0);
  pool.vy[slot] = sanitizeFloat('vy', data.vy ?? data.velocity?.y ?? 0);
  pool.vz[slot] = sanitizeFloat('vz', data.vz ?? data.velocity?.z ?? 0);
  pool.rotation[slot] = sanitizeFloat('rotation', data.rotation ?? 0);
  pool.previousRotation[slot] = sanitizeFloat('previousRotation', data.previousRotation ?? pool.rotation[slot]);
  pool.scale[slot] = sanitizeFloat('scale', data.scale ?? 1);
  pool.scaleX[slot] = sanitizeFloat('scaleX', data.scaleX ?? 1);
  pool.scaleY[slot] = sanitizeFloat('scaleY', data.scaleY ?? 1);
  pool.scaleZ[slot] = sanitizeFloat('scaleZ', data.scaleZ ?? 1);
  pool.hp[slot] = sanitizeFloat('hp', data.hp ?? 1);
  pool.maxHp[slot] = sanitizeFloat('maxHp', data.maxHp ?? pool.hp[slot]);
  pool.radius[slot] = sanitizeFloat('radius', data.radius ?? 0.5);
  pool.opacity[slot] = sanitizeFloat('opacity', data.opacity ?? 1);
  pool.color[slot] = sanitizeColor(data.color, DEFAULT_COLORS[pool.kind]);

  for (const key in data) {
    if (Object.hasOwn(data, key)) setComponent(pool, slot, key, data[key]);
  }
}

function captureWriteField(pool, scratch, field, value) {
  const index = STORAGE_FIELD_INDEX[field];
  scratch.present[index] = 1;
  if (Object.hasOwn(FLOAT_RULES, field)) scratch.values[field] = sanitizeFloat(field, value);
  else if (UINT_FIELDS.includes(field)) {
    scratch.values[field] = field === 'color'
      ? sanitizeColor(value, DEFAULT_COLORS[pool.kind])
      : sanitizeUint(value);
  } else if (BOOLEAN_FIELDS.includes(field)) scratch.values[field] = Boolean(value);
  else if (STRING_FIELDS.includes(field)) scratch.values[field] = sanitizeString(value);
  else scratch.values[field] = sanitizeFloat('value', value);
}

function capturePatch(pool, patch, scratch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('entity data must be an object');
  }
  scratch.present.fill(0);
  for (const key in patch) {
    if (!Object.hasOwn(patch, key)) continue;
    if (!COMPONENT_FIELDS.has(key)) throw new TypeError(`unknown entity component: ${key}`);
    const value = patch[key];
    if (STRING_FIELDS.includes(key)) {
      if (value != null && typeof value !== 'string') throw new TypeError(`${key} must be a string or null`);
      captureWriteField(pool, scratch, key, value);
    } else if (Object.hasOwn(VECTOR_FIELDS, key)) {
      validateVector(key, value);
      if (value == null) continue;
      const fields = VECTOR_FIELDS[key];
      for (const axis in fields) {
        if (!Object.hasOwn(value, axis)) continue;
        const field = fields[axis];
        captureWriteField(pool, scratch, field, value[axis]);
      }
    } else if (key === 'dashCharges') {
      if (value == null) continue;
      if (!Array.isArray(value) || value.length !== 2) {
        throw new TypeError('dashCharges must contain exactly two values');
      }
      captureWriteField(pool, scratch, 'dashCharge0', value[0]);
      captureWriteField(pool, scratch, 'dashCharge1', value[1]);
    } else {
      captureWriteField(pool, scratch, key, value);
    }
  }
}

function commitPatch(pool, slot, scratch) {
  for (const field of FLOAT_FIELDS) {
    if (scratch.present[STORAGE_FIELD_INDEX[field]]) pool[field][slot] = scratch.values[field];
  }
  for (const field of UINT_FIELDS) {
    if (scratch.present[STORAGE_FIELD_INDEX[field]]) pool[field][slot] = scratch.values[field];
  }
  for (const field of BOOLEAN_FIELDS) {
    if (scratch.present[STORAGE_FIELD_INDEX[field]]) pool[field][slot] = scratch.values[field] ? 1 : 0;
  }
  for (const field of STRING_FIELDS) {
    if (scratch.present[STORAGE_FIELD_INDEX[field]]) pool[field][slot] = scratch.values[field];
  }
  if (scratch.present[STORAGE_FIELD_INDEX.dashCharge0]) {
    pool.dashCharge0[slot] = scratch.values.dashCharge0;
  }
  if (scratch.present[STORAGE_FIELD_INDEX.dashCharge1]) {
    pool.dashCharge1[slot] = scratch.values.dashCharge1;
  }
}

function copySlotToScratch(pool, slot, id, scratch) {
  scratch.id = id;
  scratch.kind = pool.kind;
  scratch.slot = slot;
  scratch.active = true;
  for (const field of FLOAT_FIELDS) scratch[field] = pool[field][slot];
  for (const field of UINT_FIELDS) scratch[field] = pool[field][slot];
  for (const field of BOOLEAN_FIELDS) scratch[field] = pool[field][slot] === 1;
  for (const field of STRING_FIELDS) scratch[field] = pool[field][slot];
  scratch.dashCharge0 = pool.dashCharge0[slot];
  scratch.dashCharge1 = pool.dashCharge1[slot];
}

function copyScratchToTarget(scratch, target) {
  target.id = scratch.id;
  target.kind = scratch.kind;
  target.slot = scratch.slot;
  target.active = scratch.active;
  for (const field of FLOAT_FIELDS) target[field] = scratch[field];
  for (const field of UINT_FIELDS) target[field] = scratch[field];
  for (const field of BOOLEAN_FIELDS) target[field] = scratch[field];
  for (const field of STRING_FIELDS) target[field] = scratch[field];
  target.dashCharge0 = scratch.dashCharge0;
  target.dashCharge1 = scratch.dashCharge1;
}

function entityId(pool, slot) {
  return pool.generations[slot] * pool.idStride + pool.offset + slot;
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
    callbackScratch: new Array(CALLBACK_SCRATCH_DEPTH),
    callbackScratchLeases: new Uint8Array(CALLBACK_SCRATCH_DEPTH),
    readScratch: new Array(ACCESS_SCRATCH_DEPTH),
    readScratchLeases: new Uint8Array(ACCESS_SCRATCH_DEPTH),
    writeScratch: new Array(ACCESS_SCRATCH_DEPTH),
    writeScratchLeases: new Uint8Array(ACCESS_SCRATCH_DEPTH),
    count: 0,
    freeCount: capacity,
    retiredCount: 0,
  };
  for (const field of FLOAT_FIELDS) pool[field] = new Float64Array(capacity);
  for (const field of UINT_FIELDS) pool[field] = new Uint32Array(capacity);
  for (const field of BOOLEAN_FIELDS) pool[field] = new Uint8Array(capacity);
  for (const field of STRING_FIELDS) pool[field] = new Array(capacity).fill(null);
  pool.dashCharge0 = new Float64Array(capacity);
  pool.dashCharge1 = new Float64Array(capacity);
  pool.generations.fill(1);
  pool.activePositions.fill(-1);
  for (let slot = 0; slot < capacity; slot += 1) pool.freeSlots[slot] = capacity - slot - 1;
  for (let index = 0; index < CALLBACK_SCRATCH_DEPTH; index += 1) {
    pool.callbackScratch[index] = new Float64Array(capacity);
  }
  for (let index = 0; index < ACCESS_SCRATCH_DEPTH; index += 1) {
    pool.readScratch[index] = createEntityReadTarget();
    pool.writeScratch[index] = createWriteScratch();
  }
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

  function resolveLivePool(id) {
    if (disposed || !Number.isSafeInteger(id) || id < totalCapacity) return null;
    const generation = Math.floor(id / totalCapacity);
    const globalSlot = id - generation * totalCapacity;
    if (generation < 1 || globalSlot < 0 || globalSlot >= totalCapacity) return null;
    for (const kind of ENTITY_KINDS) {
      const pool = pools[kind];
      if (globalSlot >= pool.offset && globalSlot < pool.offset + pool.capacity) {
        const slot = globalSlot - pool.offset;
        return pool.alive[slot] && pool.generations[slot] === generation ? pool : null;
      }
    }
    return null;
  }

  function slotFromId(pool, id) {
    const generation = Math.floor(id / totalCapacity);
    return id - generation * totalCapacity - pool.offset;
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
    initializeSlot(pool, slot, data);
    pool.alive[slot] = 1;
    pool.activePositions[slot] = pool.count;
    pool.activeSlots[pool.count] = slot;
    pool.count += 1;
    count += 1;
    spawned += 1;
    return entityId(pool, slot);
  }

  function despawn(id) {
    const pool = resolveLivePool(id);
    if (!pool) return false;
    releaseSlot(pool, slotFromId(pool, id));
    count -= 1;
    despawned += 1;
    return true;
  }

  function readInto(id, target) {
    if (!target || typeof target !== 'object' || Array.isArray(target)) {
      throw new TypeError('read target must be an object');
    }
    const pool = resolveLivePool(id);
    if (!pool) return null;
    const slot = slotFromId(pool, id);
    const lease = acquireAccessScratch(pool.readScratchLeases, pool.kind, 'read');
    const scratch = pool.readScratch[lease];
    copySlotToScratch(pool, slot, id, scratch);
    try {
      copyScratchToTarget(scratch, target);
      return target;
    } finally {
      pool.readScratchLeases[lease] = 0;
    }
  }

  function get(id) {
    const snapshot = createEntityReadTarget();
    if (!readInto(id, snapshot)) return null;
    snapshot.position = Object.freeze({ x: snapshot.x, y: snapshot.y, z: snapshot.z });
    snapshot.previousPosition = Object.freeze({
      x: snapshot.previousX,
      y: snapshot.previousY,
      z: snapshot.previousZ,
    });
    snapshot.velocity = Object.freeze({ x: snapshot.vx, y: snapshot.vy, z: snapshot.vz });
    snapshot.cameraLead = Object.freeze({ x: snapshot.cameraLeadX, y: snapshot.cameraLeadY });
    snapshot.dashCharges = Object.freeze([snapshot.dashCharge0, snapshot.dashCharge1]);
    return Object.freeze(snapshot);
  }

  function write(id, patch) {
    const pool = resolveLivePool(id);
    if (!pool) return false;
    const lease = acquireAccessScratch(pool.writeScratchLeases, pool.kind, 'write');
    const scratch = pool.writeScratch[lease];
    try {
      capturePatch(pool, patch, scratch);
      if (resolveLivePool(id) !== pool) return false;
      commitPatch(pool, slotFromId(pool, id), scratch);
      return true;
    } finally {
      pool.writeScratchLeases[lease] = 0;
    }
  }

  function acquireAccessScratch(leases, kind, operation) {
    for (let index = 0; index < ACCESS_SCRATCH_DEPTH; index += 1) {
      if (leases[index]) continue;
      leases[index] = 1;
      return index;
    }
    throw new RangeError(`${kind} ${operation} nesting exceeds ${ACCESS_SCRATCH_DEPTH}`);
  }

  function acquireCallbackScratch(pool) {
    for (let index = 0; index < CALLBACK_SCRATCH_DEPTH; index += 1) {
      if (pool.callbackScratchLeases[index]) continue;
      pool.callbackScratchLeases[index] = 1;
      return index;
    }
    throw new RangeError(`${pool.kind} query callback nesting exceeds ${CALLBACK_SCRATCH_DEPTH}`);
  }

  function snapshotIds(pool, target) {
    const snapshotCount = pool.count;
    for (let index = 0; index < snapshotCount; index += 1) {
      const slot = pool.activeSlots[index];
      target[index] = entityId(pool, slot);
    }
    return snapshotCount;
  }

  function createIterator(pool) {
    const ids = new Float64Array(pool.count);
    const snapshotCount = snapshotIds(pool, ids);
    let cursor = 0;
    const result = { value: undefined, done: false };
    return Object.freeze({
      next() {
        while (cursor < snapshotCount) {
          const id = ids[cursor];
          cursor += 1;
          if (!resolveLivePool(id)) continue;
          result.value = id;
          result.done = false;
          return result;
        }
        result.value = undefined;
        result.done = true;
        return result;
      },
      [Symbol.iterator]() {
        return this;
      },
    });
  }

  function createQuery(pool) {
    let queryView;
    const traverse = (callback, thisArg, stopOnMatch) => {
      if (typeof callback !== 'function') throw new TypeError('query callback must be a function');
      const lease = acquireCallbackScratch(pool);
      const ids = pool.callbackScratch[lease];
      const snapshotCount = snapshotIds(pool, ids);
      let visibleIndex = 0;
      try {
        for (let index = 0; index < snapshotCount; index += 1) {
          const id = ids[index];
          if (!resolveLivePool(id)) continue;
          const matched = callback.call(thisArg, id, visibleIndex, queryView);
          visibleIndex += 1;
          if (stopOnMatch && matched) return id;
        }
        return undefined;
      } finally {
        pool.callbackScratchLeases[lease] = 0;
      }
    };

    queryView = Object.freeze({
      kind: pool.kind,
      capacity: pool.capacity,
      get length() {
        return pool.count;
      },
      at(index) {
        const normalized = index < 0 ? pool.count + index : index;
        if (!Number.isInteger(normalized) || normalized < 0 || normalized >= pool.count) return undefined;
        return entityId(pool, pool.activeSlots[normalized]);
      },
      forEach(callback, thisArg) {
        traverse(callback, thisArg, false);
      },
      find(callback, thisArg) {
        return traverse(callback, thisArg, true);
      },
      some(callback, thisArg) {
        return traverse(callback, thisArg, true) !== undefined;
      },
      [Symbol.iterator]() {
        return createIterator(pool);
      },
    });
    return queryView;
  }

  for (const kind of ENTITY_KINDS) pools[kind].query = createQuery(pools[kind]);

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

  return Object.freeze({ spawn, despawn, query, get, readInto, write, reset, dispose, getStats });
}
