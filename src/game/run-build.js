import { UPGRADES } from '../content/upgrades.js';
import {
  createUpgradeBuild,
  deriveBuildStats,
  deriveUpgradeOfferSeed,
  deserializeUpgradeBuild,
} from '../systems/upgrade-system.js';

const BUILD_KEYS = new Set(['ownedUpgrades']);
const PROGRESSION_BUILD_KEYS = new Set(['ownedUpgrades', 'starterWeapon', 'upgradeStacks', 'offerSequence', 'pendingOffer']);
const UPGRADE_IDS = new Set(UPGRADES.map((upgrade) => upgrade.id));
const REPAIR_SWARM_ID = 'repair-swarm';
const REPAIR_SWARM_MAX_HULL = 4;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Returns a canonical build or null; persisted builds are never permissively coerced. */
export function normalizeRunBuild(value) {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length === PROGRESSION_BUILD_KEYS.size && keys.every((key) => PROGRESSION_BUILD_KEYS.has(key))) {
    try {
      return createUpgradeBuild(value);
    } catch {
      return null;
    }
  }
  if (keys.length !== BUILD_KEYS.size || keys.some((key) => !BUILD_KEYS.has(key))
    || !Array.isArray(value.ownedUpgrades) || value.ownedUpgrades.length > UPGRADE_IDS.size) return null;

  const ownedUpgrades = [];
  const seen = new Set();
  for (const id of value.ownedUpgrades) {
    if (typeof id !== 'string' || !UPGRADE_IDS.has(id) || seen.has(id)) return null;
    seen.add(id);
    ownedUpgrades.push(id);
  }
  try {
    return createUpgradeBuild({ ownedUpgrades });
  } catch {
    return null;
  }
}

/** Persisted v1 checkpoints require the full exact progression schema. */
export function normalizePersistedRunBuild(value) {
  try {
    return deserializeUpgradeBuild(value);
  } catch {
    return null;
  }
}

export function isRunBuildProgressionConsistent(build, stats, runSeed = null) {
  const normalized = normalizePersistedRunBuild(build);
  if (!normalized || !stats || typeof stats !== 'object') return false;
  const selectedStacks = Object.values(normalized.upgradeStacks)
    .reduce((total, stack) => total + stack, 0);
  const expectedOfferSequence = selectedStacks + (normalized.pendingOffer ? 1 : 0);
  if (normalized.offerSequence !== expectedOfferSequence
    || normalized.offerSequence > stats.roomsCompleted) return false;
  if (normalized.pendingOffer && Number.isFinite(runSeed)) {
    const selectedSequence = normalized.offerSequence - 1;
    if (normalized.pendingOffer.seed !== deriveUpgradeOfferSeed(
      runSeed,
      stats.roomsCompleted,
      selectedSequence,
    )) return false;
  }
  return true;
}

export function maxHullForRunBuild(build, baseMaxHull) {
  const normalized = normalizeRunBuild(build);
  if (!normalized) return null;
  const derived = Math.max(baseMaxHull, baseMaxHull + deriveBuildStats(normalized).hullBonus);
  // Legacy Repair Swarm checkpoints encoded the capacity as a one-key build.
  return normalized.ownedUpgrades.includes(REPAIR_SWARM_ID)
    ? Math.max(derived, REPAIR_SWARM_MAX_HULL)
    : derived;
}
