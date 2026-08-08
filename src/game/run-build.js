import { UPGRADES } from '../content/upgrades.js';
import { createUpgradeBuild, deriveBuildStats } from '../systems/upgrade-system.js';

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
  return Object.freeze({ ownedUpgrades: Object.freeze(ownedUpgrades) });
}

export function maxHullForRunBuild(build, baseMaxHull) {
  const normalized = normalizeRunBuild(build);
  if (!normalized) return null;
  if (Object.hasOwn(normalized, 'upgradeStacks')) {
    return Math.max(baseMaxHull, baseMaxHull + deriveBuildStats(normalized).hullBonus);
  }
  return normalized.ownedUpgrades.includes(REPAIR_SWARM_ID) ? Math.max(baseMaxHull, REPAIR_SWARM_MAX_HULL) : baseMaxHull;
}
