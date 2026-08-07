const CURRENT_VERSION = 1;
const DEFAULT_KEY = 'neon-tide:v3:checkpoint';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
}

function isFiniteNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

export function isRunCheckpoint(value) {
  if (!isRecord(value)
    || value.version !== CURRENT_VERSION
    || value.mode !== 'standard'
    || !Number.isFinite(value.seed)
    || !isFiniteNonNegativeInteger(value.chapterIndex)
    || !isRecord(value.build)
    || !Number.isFinite(value.hull) || value.hull <= 0
    || (value.maxHull !== undefined && (!Number.isFinite(value.maxHull) || value.maxHull < value.hull))
    || !isRecord(value.stats)
    || !Number.isFinite(value.savedAt) || value.savedAt < 0) {
    return false;
  }
  return true;
}

/**
 * Small, versioned boundary around browser storage. The game owns checkpoint
 * timing; this module only validates and atomically serializes a checkpoint.
 */
export function createRunSave(storage, key = DEFAULT_KEY) {
  const status = {
    key,
    saves: 0,
    loads: 0,
    clears: 0,
    corruptions: 0,
    failures: 0,
    lastError: null,
  };

  const usable = storage
    && typeof storage.getItem === 'function'
    && typeof storage.setItem === 'function'
    && typeof storage.removeItem === 'function';

  function recordFailure(error, { corruption = false } = {}) {
    if (corruption) status.corruptions += 1;
    else status.failures += 1;
    status.lastError = error instanceof Error ? error.message : String(error);
  }

  function discardCorruptValue() {
    if (!usable) return;
    try {
      storage.removeItem(key);
      status.clears += 1;
    } catch (error) {
      recordFailure(error);
    }
  }

  function save(checkpoint) {
    if (!isRunCheckpoint(checkpoint)) return false;
    if (!usable) {
      recordFailure('checkpoint storage is unavailable');
      return false;
    }
    try {
      // Serialize before mutating storage, so cyclic/unsupported values cannot
      // replace a previously valid checkpoint.
      const serialized = JSON.stringify(clone(checkpoint));
      storage.setItem(key, serialized);
      status.saves += 1;
      status.lastError = null;
      return true;
    } catch (error) {
      recordFailure(error);
      return false;
    }
  }

  function load() {
    if (!usable) {
      recordFailure('checkpoint storage is unavailable');
      return null;
    }
    let raw;
    try {
      raw = storage.getItem(key);
    } catch (error) {
      recordFailure(error);
      return null;
    }
    if (raw == null) return null;
    try {
      const checkpoint = JSON.parse(raw);
      if (!isRunCheckpoint(checkpoint)) throw new TypeError('checkpoint schema is invalid or incompatible');
      status.loads += 1;
      status.lastError = null;
      return Object.freeze(clone(checkpoint));
    } catch (error) {
      recordFailure(error, { corruption: true });
      discardCorruptValue();
      return null;
    }
  }

  function clear() {
    if (!usable) {
      recordFailure('checkpoint storage is unavailable');
      return false;
    }
    try {
      storage.removeItem(key);
      status.clears += 1;
      status.lastError = null;
      return true;
    } catch (error) {
      recordFailure(error);
      return false;
    }
  }

  function getStatus() {
    return Object.freeze({ ...status, available: Boolean(usable) });
  }

  return Object.freeze({ save, load, clear, getStatus });
}

export { CURRENT_VERSION as RUN_SAVE_VERSION, DEFAULT_KEY as RUN_SAVE_KEY };
