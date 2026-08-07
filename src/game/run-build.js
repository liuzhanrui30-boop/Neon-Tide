import { UPGRADES } from './config.js';

const BUILD_KEYS = new Set(['ownedUpgrades']);
const UPGRADE_IDS = new Set(UPGRADES.map((upgrade) => upgrade.id));
const REPAIR_SWARM_ID = 'repair-swarm';
const REPAIR_SWARM_MAX_HULL = 4;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Returns a canonical build or null; persisted builds are never permissively coerced. */
export function normalizeRunBuild(value) {
  if (!isRecord(value)
    || Object.keys(value).length !== BUILD_KEYS.size
    || Object.keys(value).some((key) => !BUILD_KEYS.has(key))
    || !Array.isArray(value.ownedUpgrades)
    || value.ownedUpgrades.length > UPGRADE_IDS.size) return null;

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
  return normalized.ownedUpgrades.includes(REPAIR_SWARM_ID)
    ? Math.max(baseMaxHull, REPAIR_SWARM_MAX_HULL)
    : baseMaxHull;
}
