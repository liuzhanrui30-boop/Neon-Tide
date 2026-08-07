import { normalizeRunBuild } from '../game/run-build.js';

const CURRENT_VERSION = 1;
const DEFAULT_KEY = 'neon-tide:v3:checkpoint';
const CHECKPOINT_KEYS = new Set(['version', 'mode', 'seed', 'chapterIndex', 'build', 'hull', 'stats', 'savedAt']);

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

const MAX_CHECKPOINT_STAT = 1_000_000_000;

export function isCheckpointStats(value) {
  const keys = ['roomsStarted', 'roomsCompleted', 'damageTaken', 'score'];
  return isRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key))
    && isFiniteNonNegativeInteger(value.roomsStarted)
    && isFiniteNonNegativeInteger(value.roomsCompleted)
    && value.roomsCompleted <= value.roomsStarted
    && Number.isFinite(value.damageTaken) && value.damageTaken >= 0 && value.damageTaken <= MAX_CHECKPOINT_STAT
    && Number.isFinite(value.score) && value.score >= 0 && value.score <= MAX_CHECKPOINT_STAT;
}

export function isRunCheckpoint(value) {
  if (!isRecord(value)
    || Object.keys(value).length !== CHECKPOINT_KEYS.size
    || Object.keys(value).some((key) => !CHECKPOINT_KEYS.has(key))
    || value.version !== CURRENT_VERSION
    || value.mode !== 'standard'
    || !Number.isFinite(value.seed)
    || !isFiniteNonNegativeInteger(value.chapterIndex)
    || !normalizeRunBuild(value.build)
    || !Number.isFinite(value.hull) || value.hull <= 0
    || !isCheckpointStats(value.stats)
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

  function clear({ corruption = false } = {}) {
    if (!usable) {
      recordFailure('checkpoint storage is unavailable');
      return false;
    }
    try {
      storage.removeItem(key);
      status.clears += 1;
      if (corruption) {
        status.corruptions += 1;
        status.lastError = 'checkpoint is incompatible with the active run configuration';
      } else status.lastError = null;
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
