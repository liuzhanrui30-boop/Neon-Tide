import {
  isRunBuildProgressionConsistent,
  maxHullForRunBuild,
  migrateLegacyRunBuild,
  normalizePersistedRunBuild,
} from '../game/run-build.js';
import {
  AUTHORED_CAMPAIGN_ROOM_COUNT,
  COMPATIBILITY_BOSS_TEMPLATE_ID,
  MAX_CAMPAIGN_CHAPTER_INDEX,
  createNextStandardRunRoute,
  createCompatibilityRunRoute,
  normalizeRunRoute,
} from '../game/run-route.js';
import { serializeUpgradeBuild } from '../systems/upgrade-system.js';

const CURRENT_VERSION = 2;
const DEFAULT_KEY = 'neon-tide:v3:checkpoint';
const V1_CHECKPOINT_KEYS = new Set(['version', 'mode', 'seed', 'chapterIndex', 'build', 'hull', 'stats', 'savedAt']);
const V2_CHECKPOINT_KEYS = new Set([...V1_CHECKPOINT_KEYS, 'route']);

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
const BASE_RUN_MAX_HULL = 3;

function isSemanticallyPossibleProgress(chapterIndex, stats) {
  return stats.roomsStarted === stats.roomsCompleted
    && stats.roomsCompleted >= 1
    && chapterIndex <= Math.min(MAX_CAMPAIGN_CHAPTER_INDEX, stats.roomsCompleted);
}

function hullMatchesBuild(hull, build) {
  const maxHull = maxHullForRunBuild(build, BASE_RUN_MAX_HULL);
  return Number.isFinite(maxHull) && hull <= maxHull;
}

function createHistoricalCompatibilityRoute(roomIndex, chapterIndex) {
  return createCompatibilityRunRoute({
    roomIndex,
    chapterIndex,
    templateId: chapterIndex === MAX_CAMPAIGN_CHAPTER_INDEX
      ? COMPATIBILITY_BOSS_TEMPLATE_ID
      : `v2.2-compatibility-chapter-${chapterIndex}`,
  });
}

export function isCheckpointStats(value) {
  const keys = ['roomsStarted', 'roomsCompleted', 'damageTaken', 'score'];
  return isRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key))
    && isFiniteNonNegativeInteger(value.roomsStarted)
    && value.roomsStarted <= MAX_CHECKPOINT_STAT
    && isFiniteNonNegativeInteger(value.roomsCompleted)
    && value.roomsCompleted <= MAX_CHECKPOINT_STAT
    && value.roomsCompleted <= value.roomsStarted
    && Number.isFinite(value.damageTaken) && value.damageTaken >= 0 && value.damageTaken <= MAX_CHECKPOINT_STAT
    && Number.isFinite(value.score) && value.score >= 0 && value.score <= MAX_CHECKPOINT_STAT;
}

export function isRunCheckpoint(value) {
  if (!isRecord(value)
    || Object.keys(value).length !== V2_CHECKPOINT_KEYS.size
    || Object.keys(value).some((key) => !V2_CHECKPOINT_KEYS.has(key))
    || value.version !== CURRENT_VERSION
    || value.mode !== 'standard'
    || !Number.isFinite(value.seed)
    || !isFiniteNonNegativeInteger(value.chapterIndex)
    || value.chapterIndex > MAX_CAMPAIGN_CHAPTER_INDEX
    || !normalizePersistedRunBuild(value.build)
    || !Number.isFinite(value.hull) || value.hull <= 0
    || !isCheckpointStats(value.stats)
    || !isSemanticallyPossibleProgress(value.chapterIndex, value.stats)
    || !isRunBuildProgressionConsistent(value.build, value.stats, value.seed)
    || !hullMatchesBuild(value.hull, value.build)
    || !normalizeRunRoute(value.route, {
      seed: value.seed,
      stats: value.stats,
      chapterIndex: value.chapterIndex,
    })
    || !Number.isFinite(value.savedAt) || value.savedAt < 0) {
    return false;
  }
  return true;
}

export function migrateV1Checkpoint(value) {
  if (!isRecord(value)
    || Object.keys(value).length !== V1_CHECKPOINT_KEYS.size
    || Object.keys(value).some((key) => !V1_CHECKPOINT_KEYS.has(key))
    || value.version !== 1
    || value.mode !== 'standard'
    || !Number.isFinite(value.seed)
    || !isFiniteNonNegativeInteger(value.chapterIndex)
    || value.chapterIndex > MAX_CAMPAIGN_CHAPTER_INDEX
    || !Number.isFinite(value.hull) || value.hull <= 0
    || !isCheckpointStats(value.stats)
    || !Number.isFinite(value.savedAt) || value.savedAt < 0) return null;

  const legacyBuildShape = isRecord(value.build)
    && Object.keys(value.build).length === 1
    && Object.hasOwn(value.build, 'ownedUpgrades');
  const canonicalBuild = legacyBuildShape ? null : normalizePersistedRunBuild(value.build);
  const stats = legacyBuildShape
    ? {
      ...clone(value.stats),
      // The one-field schema allowed an uncommitted started-room surplus.
      roomsStarted: value.stats.roomsCompleted,
    }
    : clone(value.stats);
  if (!isSemanticallyPossibleProgress(value.chapterIndex, stats)) return null;
  const build = legacyBuildShape
    ? migrateLegacyRunBuild(value.build, stats.roomsCompleted)
    : canonicalBuild;
  if (!build
    || (!legacyBuildShape && !isRunBuildProgressionConsistent(build, stats, value.seed))
    || !hullMatchesBuild(value.hull, build)) return null;

  let route;
  if (legacyBuildShape) {
    route = createHistoricalCompatibilityRoute(stats.roomsStarted, value.chapterIndex);
  } else if (stats.roomsStarted < AUTHORED_CAMPAIGN_ROOM_COUNT
    && value.chapterIndex === Math.min(MAX_CAMPAIGN_CHAPTER_INDEX, stats.roomsStarted)) {
    route = createNextStandardRunRoute(stats.roomsStarted, value.seed);
  } else {
    route = createHistoricalCompatibilityRoute(stats.roomsStarted, value.chapterIndex);
  }
  const migrated = {
    version: CURRENT_VERSION,
    mode: 'standard',
    seed: value.seed,
    chapterIndex: route.chapterIndex,
    route: clone(route),
    build: serializeUpgradeBuild(build),
    hull: value.hull,
    stats,
    savedAt: value.savedAt,
  };
  return isRunCheckpoint(migrated) ? migrated : null;
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
    migrations: 0,
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
      let checkpoint = JSON.parse(raw);
      if (checkpoint?.version === 1) {
        checkpoint = migrateV1Checkpoint(checkpoint);
        if (!checkpoint) throw new TypeError('legacy checkpoint schema is invalid or incompatible');
        const serialized = JSON.stringify(clone(checkpoint));
        try {
          storage.setItem(key, serialized);
        } catch (error) {
          // Keep the valid v1 source untouched when the atomic replacement
          // cannot commit; a later load can retry the one-way migration.
          recordFailure(error);
          return null;
        }
        status.migrations += 1;
      } else if (!isRunCheckpoint(checkpoint)) {
        throw new TypeError('checkpoint schema is invalid or incompatible');
      }
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
