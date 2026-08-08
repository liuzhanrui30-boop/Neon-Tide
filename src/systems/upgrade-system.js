import { BOSS_CORE_UPGRADE_IDS, STARTER_WEAPON_IDS, UPGRADES } from '../content/upgrades.js';

const BY_ID = new Map(UPGRADES.map((entry) => [entry.id, entry]));
const STARTERS = new Set(STARTER_WEAPON_IDS);
const BOSS_IDS = new Set(BOSS_CORE_UPGRADE_IDS);

export const DEFAULT_BUILD_STATS = Object.freeze({
  weaponDamageMultiplier: 1,
  fireIntervalMultiplier: 1,
  projectileSpeedMultiplier: 1,
  projectilePierce: 0,
  pulseProjectiles: 1,
  missileSplit: 3,
  missileImpactRadius: 0.75,
  weakPointMultiplier: 1.5,
  weakPointPriority: 1,
  chainTargets: 2,
  chainDamageMultiplier: 0.78,
  propagationRadius: 6,
  droneCount: 2,
  droneArcTargets: 2,
  droneObjectiveDamageMultiplier: 1,
  phaseDurationBonus: 0,
  perfectPhaseWindowBonus: 0,
  perfectFireBuffMultiplier: 0.75,
  dashRecoveryMultiplier: 1,
  dashSpeedMultiplier: 1,
  moveSpeedMultiplier: 1,
  steeringMultiplier: 1,
  lanceLength: 7.2,
  lanceHalfWidth: 0.275,
  lanceTargetCap: 8,
  lancePierce: 0,
  lanceWeakPointMultiplier: 1,
  lancePropagation: 0,
  lanceEnergyGainMultiplier: 1,
  lanceDamageMultiplier: 1,
  pickupRadiusMultiplier: 1,
  pickupAttractionSpeed: 0,
  pickupValueMultiplier: 1,
  escortRepairPerSecond: 0,
  objectiveProximityMultiplier: 1,
  objectiveDamageMultiplier: 1,
  hullBonus: 0,
  immediateRepair: 0,
  roomRepair: 0,
});

function cloneFrozen(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(cloneFrozen));
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneFrozen(entry)])));
}

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizePendingOffer(value) {
  if (value == null) return null;
  if (!isRecord(value) || !Number.isFinite(value.seed) || !['normal', 'boss'].includes(value.rewardKind)
    || !Array.isArray(value.cards) || value.cards.length !== 3 || new Set(value.cards).size !== 3
    || value.cards.some((id) => !BY_ID.has(id) || (value.rewardKind === 'boss') !== BOSS_IDS.has(id))) return null;
  return Object.freeze({ seed: value.seed, rewardKind: value.rewardKind, cards: Object.freeze([...value.cards]) });
}

export function getUpgradeById(id) {
  return BY_ID.get(id) ?? null;
}

export function createUpgradeBuild(value = {}) {
  if (!isRecord(value)) throw new TypeError('upgrade build must be an object');
  const starterWeapon = value.starterWeapon ?? 'pulse-cannon';
  if (!STARTERS.has(starterWeapon)) throw new TypeError('unknown starter weapon');
  const sourceStacks = isRecord(value.upgradeStacks) ? value.upgradeStacks : {};
  const legacyOwned = Array.isArray(value.ownedUpgrades) ? value.ownedUpgrades : [];
  const upgradeStacks = {};
  for (const id of legacyOwned) {
    if (!BY_ID.has(id) || Object.hasOwn(upgradeStacks, id)) throw new TypeError('owned upgrades must be unique known IDs');
    upgradeStacks[id] = 1;
  }
  for (const [id, rawStack] of Object.entries(sourceStacks)) {
    const definition = BY_ID.get(id);
    if (!definition || !Number.isInteger(rawStack) || rawStack < 1 || rawStack > definition.maxStacks) {
      throw new TypeError(`invalid upgrade stack: ${id}`);
    }
    upgradeStacks[id] = rawStack;
  }
  const ownedUpgrades = Object.keys(upgradeStacks).sort();
  const offerSequence = value.offerSequence ?? 0;
  if (!Number.isInteger(offerSequence) || offerSequence < 0 || offerSequence > 1_000_000) {
    throw new TypeError('offer sequence must be a bounded non-negative integer');
  }
  const pendingOffer = normalizePendingOffer(value.pendingOffer);
  if (value.pendingOffer != null && !pendingOffer) throw new TypeError('pending upgrade offer is invalid');
  return Object.freeze({
    ownedUpgrades: Object.freeze(ownedUpgrades),
    starterWeapon,
    upgradeStacks: cloneFrozen(upgradeStacks),
    offerSequence,
    pendingOffer,
  });
}

export function serializeUpgradeBuild(build) {
  const normalized = createUpgradeBuild(build);
  return {
    ownedUpgrades: [...normalized.ownedUpgrades],
    starterWeapon: normalized.starterWeapon,
    upgradeStacks: { ...normalized.upgradeStacks },
    offerSequence: normalized.offerSequence,
    pendingOffer: normalized.pendingOffer ? {
      seed: normalized.pendingOffer.seed,
      rewardKind: normalized.pendingOffer.rewardKind,
      cards: [...normalized.pendingOffer.cards],
    } : null,
  };
}

function seed32(value) {
  let seed = Math.trunc(Number(value)) >>> 0;
  seed ^= seed >>> 16;
  seed = Math.imul(seed, 0x7feb352d);
  seed ^= seed >>> 15;
  seed = Math.imul(seed, 0x846ca68b);
  seed ^= seed >>> 16;
  return seed >>> 0;
}

function randomFrom(seed) {
  let state = seed32(seed) || 0x6d2b79f5;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

function offerFromPool(build, seed, count, bossCore) {
  const normalized = createUpgradeBuild(build);
  const safeCount = Math.max(1, Math.min(3, Math.trunc(Number(count) || 3)));
  const eligible = UPGRADES.filter((entry) => entry.bossCore === bossCore
    && entry.compatibleStarterWeapons.includes(normalized.starterWeapon)
    && (normalized.upgradeStacks[entry.id] ?? 0) < entry.maxStacks);
  if (eligible.length < safeCount) throw new RangeError('not enough compatible upgrades remain for an offer');
  const random = randomFrom(seed);
  const shuffled = eligible.map((entry) => ({ entry, order: random() }))
    .sort((left, right) => left.order - right.order || left.entry.id.localeCompare(right.entry.id));
  return Object.freeze(shuffled.slice(0, safeCount).map(({ entry }) => entry));
}

export function offerUpgrades(build, seed, count = 3) {
  if (!Number.isFinite(seed)) throw new TypeError('upgrade offer seed must be finite');
  return offerFromPool(build, seed, count, false);
}

export function offerBossCoreUpgrades(build, seed, count = 3) {
  if (!Number.isFinite(seed)) throw new TypeError('boss upgrade offer seed must be finite');
  return offerFromPool(build, seed, count, true);
}

export function attachPendingOffer(build, seed, rewardKind = 'normal') {
  const normalized = createUpgradeBuild(build);
  const offer = rewardKind === 'boss'
    ? offerBossCoreUpgrades(normalized, seed)
    : offerUpgrades(normalized, seed);
  return createUpgradeBuild({
    ...serializeUpgradeBuild(normalized),
    offerSequence: normalized.offerSequence + 1,
    pendingOffer: { seed, rewardKind, cards: offer.map(({ id }) => id) },
  });
}

export function applyUpgradeChoice(build, id) {
  const normalized = createUpgradeBuild(build);
  const definition = BY_ID.get(id);
  if (!definition || !definition.compatibleStarterWeapons.includes(normalized.starterWeapon)) {
    throw new TypeError('upgrade choice is unknown or incompatible');
  }
  if (normalized.pendingOffer && !normalized.pendingOffer.cards.includes(id)) {
    throw new TypeError('upgrade choice is not in the pending offer');
  }
  const current = normalized.upgradeStacks[id] ?? 0;
  if (current >= definition.maxStacks) throw new RangeError('upgrade is already at maximum stacks');
  return createUpgradeBuild({
    ...serializeUpgradeBuild(normalized),
    upgradeStacks: { ...normalized.upgradeStacks, [id]: current + 1 },
    pendingOffer: null,
  });
}

export function deriveBuildStats(build) {
  const normalized = createUpgradeBuild(build);
  const stats = { ...DEFAULT_BUILD_STATS };
  for (const id of normalized.ownedUpgrades) {
    const definition = BY_ID.get(id);
    const stacks = normalized.upgradeStacks[id] ?? 0;
    for (const [key, effect] of Object.entries(definition.effects)) {
      const current = Number.isFinite(stats[key]) ? stats[key] : effect.base;
      stats[key] = Math.max(effect.min, Math.min(effect.max, current + effect.perStack * stacks));
    }
  }
  for (const [key, value] of Object.entries(stats)) {
    if (!Number.isFinite(value)) throw new RangeError(`derived upgrade stat is nonfinite: ${key}`);
  }
  return Object.freeze(stats);
}
