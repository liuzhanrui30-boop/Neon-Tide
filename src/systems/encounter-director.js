import { getEncounterTemplate, getThreatBudget } from '../content/encounters.js';
import {
  applyAuthoredChapterBeat,
  commitObjectiveShift,
  completeObjectiveForDeterministicTest,
  createObjectiveShiftPlan,
  createObjective,
  getDataLaneEffect,
  getObjectiveSnapshot,
  updateObjective,
} from './objective-system.js';
import { createAntiOrbitDirector } from './anti-orbit-director.js';
import { ENEMY_ROLE_IDS, ENEMY_ROLES } from '../content/enemies.js';
import { createEnemySystem } from './enemy-system.js';
import {
  estimateCampaignObjectiveSeconds,
  tuneCampaignObjectiveTemplate,
} from '../game/campaign-pacing.js';
import { getAbyssRoomDefinition } from '../content/chapters/abyss.js';
import { ABYSS_MAW } from '../content/bosses/abyss-maw.js';
import { getLoadedChapterContent } from '../content/chapter-registry.js';
import { createBossSystem } from './boss-system.js';


const THREAT_LIMITS = Object.freeze({
  standard: Object.freeze({
    desktop: Object.freeze({ activeEnemyCap: 48, projectileCap: 96, simultaneousWarningCap: 3, blockedAreaBudget: 0.45 }),
    coarse: Object.freeze({ activeEnemyCap: 36, projectileCap: 72, simultaneousWarningCap: 2, blockedAreaBudget: 0.38 }),
  }),
  abyss: Object.freeze({
    desktop: Object.freeze({ activeEnemyCap: 56, projectileCap: 96, simultaneousWarningCap: 4, blockedAreaBudget: 0.5 }),
    coarse: Object.freeze({ activeEnemyCap: 42, projectileCap: 72, simultaneousWarningCap: 3, blockedAreaBudget: 0.42 }),
  }),
});

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function coarseQuality(quality) {
  const value = typeof quality === 'string' ? quality : quality?.tier ?? (quality?.coarsePointer ? 'coarse' : 'desktop');
  return ['coarse', 'mobile', 'touch', 'compact'].includes(value);
}

export function getThreatLimits({ mode = 'standard', quality = 'desktop' } = {}) {
  if (!['standard', 'abyss'].includes(mode)) throw new TypeError('threat mode must be standard or abyss');
  return THREAT_LIMITS[mode][coarseQuality(quality) ? 'coarse' : 'desktop'];
}

function normalizedRandom(random) {
  const value = finite(random(), 0.5);
  return clamp(value, 0, 0.999999);
}

export function selectThreatWave(context = {}, random = Math.random) {
  if (typeof random !== 'function') throw new TypeError('threat random must be a function');
  const mode = context.mode ?? 'standard';
  const quality = context.quality ?? 'desktop';
  const limits = getThreatLimits({ mode, quality });
  const chapter = Math.max(0, Math.trunc(finite(context.chapter)));
  const waveIndex = Math.max(0, Math.trunc(finite(context.waveIndex)));
  const activeEnemies = Math.max(0, Math.trunc(finite(context.activeEnemies)));
  const highDamageWarnings = Math.max(0, Math.trunc(finite(context.highDamageWarnings)));
  const blockedArea = Math.max(0, finite(context.blockedArea));
  const enemyProjectiles = Math.max(0, Math.trunc(finite(context.enemyProjectiles)));
  const objectiveBurden = clamp(finite(context.objectiveBurden, 0.25), 0, 1);
  const playerHealthRatio = clamp(finite(context.playerHealthRatio, 1), 0, 1);
  const clearRate = clamp(finite(context.clearRate, 0.8), 0, 4);
  const untouchedSeconds = clamp(finite(context.untouchedSeconds, 0), 0, 120);
  const totalBudget = Math.max(1, finite(context.totalBudget, 30));
  const roleCounts = context.roleCounts ?? {};
  const reliefApplied = playerHealthRatio <= 0.4;
  const healthFactor = reliefApplied ? (mode === 'abyss' ? 0.65 : 0.2) : playerHealthRatio < 0.7 ? 0.86 : 1;
  const masteryFactor = 1 + clamp((clearRate - 0.75) * 0.14, -0.12, 0.24)
    + clamp((untouchedSeconds - 8) / 80, 0, 0.18);
  const burdenFactor = 1 - objectiveBurden * (mode === 'abyss' ? 0.22 : 0.34);
  const baseWaveBudget = Math.min(totalBudget, 6 + chapter * 2.25 + (mode === 'abyss' ? 1.5 : 0));
  const scaledBudget = Math.floor(baseWaveBudget * healthFactor * masteryFactor * burdenFactor);
  const budget = reliefApplied && mode === 'standard' ? 0 : Math.max(1, scaledBudget);
  const availableSlots = Math.max(0, limits.activeEnemyCap - activeEnemies);
  if (availableSlots === 0) return Object.freeze({
    roles: Object.freeze([]), cost: 0, budget, projectileCost: 0, blockedAreaCost: 0,
    highDamageWarnings: 0, reliefApplied, limits, admissionCharges: Object.freeze([]),
  });

  const roles = [];
  const admissionCharges = [];
  const localCounts = Object.fromEntries(ENEMY_ROLE_IDS.map((id) => [id, Math.max(0, Math.trunc(finite(roleCounts[id])))]));
  let cost = 0;
  let projectileCost = 0;
  let blockedAreaCost = 0;
  let localWarnings = 0;
  let cursor = waveIndex % ENEMY_ROLE_IDS.length;
  let misses = 0;
  while (roles.length < availableSlots && misses < ENEMY_ROLE_IDS.length * 2) {
    const roleId = ENEMY_ROLE_IDS[cursor % ENEMY_ROLE_IDS.length];
    cursor += 1;
    const role = ENEMY_ROLES[roleId];
    const jitteredCost = role.threatCost + (normalizedRandom(random) < 0.08 ? 1 : 0);
    const allowed = role.minChapter <= chapter
      && localCounts[roleId] < role.activeCap
      && cost + jitteredCost <= budget
      && projectileCost + role.projectileCost + enemyProjectiles <= limits.projectileCap
      && blockedAreaCost + role.blockedAreaCost + blockedArea <= limits.blockedAreaBudget + 1e-9
      && (!role.highDamage || highDamageWarnings + localWarnings < limits.simultaneousWarningCap);
    if (!allowed) {
      misses += 1;
      continue;
    }
    roles.push(roleId);
    admissionCharges.push(Object.freeze({
      role: roleId,
      authoredCost: role.threatCost,
      costJitter: jitteredCost - role.threatCost,
      chargedCost: jitteredCost,
    }));
    localCounts[roleId] += 1;
    cost += jitteredCost;
    projectileCost += role.projectileCost;
    blockedAreaCost += role.blockedAreaCost;
    if (role.highDamage) localWarnings += 1;
    misses = 0;
    if (cost >= budget) break;
  }
  return Object.freeze({
    roles: Object.freeze(roles), cost, budget, projectileCost, blockedAreaCost,
    highDamageWarnings: localWarnings, reliefApplied, limits,
    admissionCharges: Object.freeze(admissionCharges),
  });
}

function createThreatRandom(seed) {
  let value = Math.trunc(finite(seed)) >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function objectiveBurdenFor(objective) {
  const burden = {
    purge: 0.12, anchors: 0.45, 'moving-zone': 0.62, escort: 0.72,
    'elite-hunt': 0.28, 'storm-corridor': 0.82, 'core-harvest': 0.55, 'dual-crisis': 0.88,
  };
  return burden[objective?.type] ?? 0.35;
}

export function scanThreatWorld(world) {
  const roleCounts = Object.fromEntries(ENEMY_ROLE_IDS.map((id) => [id, 0]));
  let highDamageWarnings = 0;
  let blockedArea = 0;
  const warned = new Set();
  const blockers = new Set();
  const ownerRoles = new Map();
  const enemies = world?.query?.('enemy');
  if (enemies) {
    for (let index = 0; index < enemies.length; index += 1) {
      const enemy = world.get(enemies.at(index));
      if (!enemy || !ENEMY_ROLES[enemy.role]) continue;
      roleCounts[enemy.role] += 1;
      ownerRoles.set(enemy.id, enemy.role);
    }
  }
  const warnings = world?.query?.('warning');
  if (warnings) {
    for (let index = 0; index < warnings.length; index += 1) {
      const warning = world.get(warnings.at(index));
      const role = ENEMY_ROLES[warning?.role] ? warning.role : ownerRoles.get(warning?.ownerId);
      if (!role || !ENEMY_ROLES[role]?.highDamage || warned.has(warning.ownerId)) continue;
      warned.add(warning.ownerId);
      highDamageWarnings += 1;
      if (!blockers.has(warning.ownerId)) {
        blockers.add(warning.ownerId);
        blockedArea += ENEMY_ROLES[role].blockedAreaCost;
      }
    }
  }
  const hazards = world?.query?.('enemyHazard');
  if (hazards) {
    for (let index = 0; index < hazards.length; index += 1) {
      const hazard = world.get(hazards.at(index));
      if (!hazard?.collidable || blockers.has(hazard.ownerId)) continue;
      const role = ENEMY_ROLES[hazard.role] ? hazard.role : ownerRoles.get(hazard.ownerId);
      if (!role || !ENEMY_ROLES[role]) continue;
      blockers.add(hazard.ownerId);
      blockedArea += ENEMY_ROLES[role].blockedAreaCost;
    }
  }
  return {
    activeEnemies: enemies?.length ?? 0,
    roleCounts,
    highDamageWarnings,
    blockedArea,
    enemyProjectiles: world?.query?.('enemyProjectile').length ?? 0,
  };
}

function summarizeMaterializedRoles(roles) {
  const accepted = [];
  let cost = 0;
  let projectileCost = 0;
  let blockedAreaCost = 0;
  let highDamageWarnings = 0;
  for (const roleId of roles) {
    const role = ENEMY_ROLES[roleId];
    if (!role) continue;
    accepted.push(roleId);
    cost += role.threatCost;
    projectileCost += role.projectileCost;
    blockedAreaCost += role.blockedAreaCost;
    if (role.highDamage) highDamageWarnings += 1;
  }
  return Object.freeze({
    roles: Object.freeze(accepted), cost, projectileCost, blockedAreaCost, highDamageWarnings,
  });
}

function partitionAdmissionCharges(selectedCharges, materializedRoles) {
  const remaining = Object.fromEntries(ENEMY_ROLE_IDS.map((role) => [role, 0]));
  for (const role of materializedRoles) if (ENEMY_ROLES[role]) remaining[role] += 1;
  const materialized = [];
  const rejected = [];
  for (const charge of selectedCharges) {
    if (remaining[charge.role] > 0) {
      remaining[charge.role] -= 1;
      materialized.push(charge);
    } else rejected.push(charge);
  }
  return { materialized, rejected };
}

function summarizeAdmissionCharges(charges) {
  const roles = [];
  let authoredCost = 0;
  let costJitter = 0;
  let chargedCost = 0;
  let projectileCost = 0;
  let blockedAreaCost = 0;
  let highDamageWarnings = 0;
  for (const charge of charges) {
    const role = ENEMY_ROLES[charge.role];
    if (!role) continue;
    roles.push(charge.role);
    authoredCost += charge.authoredCost;
    costJitter += charge.costJitter;
    chargedCost += charge.chargedCost;
    projectileCost += role.projectileCost;
    blockedAreaCost += role.blockedAreaCost;
    if (role.highDamage) highDamageWarnings += 1;
  }
  return Object.freeze({
    roles: Object.freeze(roles),
    charges: Object.freeze([...charges]),
    authoredCost,
    costJitter,
    chargedCost,
    projectileCost,
    blockedAreaCost,
    highDamageWarnings,
  });
}

function createMaterializedWave(selectedWave, materializedRoles, bossVariant = null) {
  const materialized = summarizeMaterializedRoles(materializedRoles);
  const partitioned = partitionAdmissionCharges(selectedWave.admissionCharges, materialized.roles);
  const selectedDiagnostics = summarizeAdmissionCharges(selectedWave.admissionCharges);
  const materializedDiagnostics = summarizeAdmissionCharges(partitioned.materialized);
  const rejectedDiagnostics = summarizeAdmissionCharges(partitioned.rejected);
  return Object.freeze({
    roles: materialized.roles,
    cost: materialized.cost,
    projectileCost: materialized.projectileCost,
    blockedAreaCost: materialized.blockedAreaCost,
    highDamageWarnings: materialized.highDamageWarnings,
    budget: selectedWave.budget,
    reliefApplied: selectedWave.reliefApplied,
    limits: selectedWave.limits,
    materialized,
    selectedDiagnostics,
    materializedDiagnostics,
    rejectedDiagnostics,
    ...(bossVariant ? {
      bossVariantIndex: bossVariant.index,
      bossVariantCount: bossVariant.count,
    } : {}),
  });
}

function clone(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
}

function cloneFrozen(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(cloneFrozen));
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, cloneFrozen(entry)]),
  ));
}

function emit(events, type, payload) {
  events?.emit?.(type, Object.freeze(clone(payload)));
}

function roomSeed(seed, roomIndex, templateId) {
  let value = (Math.trunc(Number(seed) || 0) ^ Math.imul(roomIndex + 1, 0x9e3779b1)) >>> 0;
  for (const character of String(templateId)) value = Math.imul(value ^ character.charCodeAt(0), 16777619) >>> 0;
  return value;
}

function scaledTemplate(template, scale, authoredTargetDurationSeconds = null) {
  if (authoredTargetDurationSeconds === null && scale >= 0.999) return template;
  const targetDuration = authoredTargetDurationSeconds === null
    ? template.timeout
    : authoredTargetDurationSeconds;
  const effectiveTargetDuration = Math.max(0.1, targetDuration * scale);
  const objectiveScale = effectiveTargetDuration / Math.max(0.1, template.timeout);
  return {
    ...template,
    timeout: effectiveTargetDuration,
    killTarget: Math.max(3, Math.ceil((template.killTarget ?? 1) * objectiveScale)),
    anchorSeconds: Math.max(0.2, (template.anchorSeconds ?? 1) * objectiveScale),
    holdSeconds: Math.max(1, (template.holdSeconds ?? 1) * objectiveScale),
    escortDistance: Math.max(3, (template.escortDistance ?? 1) * objectiveScale),
    eliteTarget: Math.max(1, Math.ceil((template.eliteTarget ?? 1) * objectiveScale)),
    survivalSeconds: Math.max(2, (template.survivalSeconds ?? 1) * objectiveScale),
    coreCount: Math.max(2, Math.ceil((template.coreCount ?? 2) * objectiveScale)),
    crisisSeconds: Math.max(0.4, (template.crisisSeconds ?? 1) * objectiveScale),
    escalationSeconds: Math.max(2, (template.escalationSeconds ?? 8) * objectiveScale),
  };
}

function normalizePressure(value, mode) {
  if (value == null) return Object.freeze({
    threatBudget: 1,
    enemySpeed: 1,
    selectionCadence: mode === 'abyss' ? 4 / 3 : 1,
    waveIntervalSeconds: mode === 'abyss' ? 1.8 : 2.4,
    telegraphFloorSeconds: 0.55,
  });
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('encounter pressure must be a contract object');
  }
  const threatBudget = finite(value.threatBudget, 1);
  const enemySpeed = finite(value.enemySpeed, 1);
  const selectionCadence = finite(value.eliteFrequency ?? value.selectionCadence, 1);
  const telegraphFloorSeconds = finite(value.telegraphFloorSeconds, 0.55);
  if (threatBudget < 1 || threatBudget > 2 || enemySpeed < 1 || enemySpeed > 2
    || selectionCadence < 1 || selectionCadence > 2 || telegraphFloorSeconds < 0.4) {
    throw new TypeError('encounter pressure contract is outside fair bounds');
  }
  return Object.freeze({
    threatBudget,
    enemySpeed,
    selectionCadence,
    waveIntervalSeconds: 2.4 / selectionCadence,
    telegraphFloorSeconds,
  });
}

export function createEncounterDirector({
  mode = 'standard', quality = 'desktop', seed = 0, roomIndex: initialRoomIndex = 0, durationScale = 1,
  objectiveAuthority = null, pressure = null, deterministicTestAuthority = null,
} = {}) {
  if (!['standard', 'abyss'].includes(mode)) throw new TypeError('encounter mode must be standard or abyss');
  if (!Number.isFinite(Number(seed))) throw new TypeError('encounter seed must be finite');
  if (!Number.isInteger(initialRoomIndex) || initialRoomIndex < 0) throw new TypeError('encounter roomIndex must be a non-negative integer');
  if (!Number.isFinite(durationScale) || durationScale <= 0 || durationScale > 1) throw new TypeError('durationScale must be in (0, 1]');
  if (objectiveAuthority !== null && (!objectiveAuthority || typeof objectiveAuthority !== 'object' || Array.isArray(objectiveAuthority))) {
    throw new TypeError('objectiveAuthority must be an internal channel object');
  }
  if (deterministicTestAuthority !== null
    && (!deterministicTestAuthority || typeof deterministicTestAuthority !== 'object' || Array.isArray(deterministicTestAuthority))) {
    throw new TypeError('deterministicTestAuthority must be an internal channel object');
  }
  const qualityName = typeof quality === 'string' ? quality : quality?.tier ?? 'desktop';
  const pressureContract = normalizePressure(pressure, mode);
  const usesCampaignPressure = pressure !== null;
  let roomIndex = initialRoomIndex;
  let phase = 'idle';
  let objective = null;
  let templateId = null;
  let threatBudget = null;
  let combatFrozen = false;
  let upgradeOffered = false;
  let completionAcknowledged = false;
  let updateRevision = 0;
  let antiOrbitDirector = createAntiOrbitDirector({ seed });
  let threatRandom = createThreatRandom(seed);
  let bossContract = null;
  let abyssRoomDefinition = null;
  let dataCityRoomDefinition = null;
  let dataCityBossDefinition = null;
  let bossSystem = null;
  let bossWorld = null;
  const runtimeThreatLimits = getThreatLimits({ mode, quality });
  const enemySystem = createEnemySystem({
    random: () => threatRandom(),
    enemyCap: runtimeThreatLimits.activeEnemyCap,
    projectileCap: runtimeThreatLimits.projectileCap,
    warningCap: () => abyssRoomDefinition?.warningCap
      ?? dataCityRoomDefinition?.warningCap
      ?? runtimeThreatLimits.simultaneousWarningCap,
    speedMultiplier: pressureContract.enemySpeed,
    telegraphFloorSeconds: () => bossContract?.telegraphFloorSeconds
      ?? pressureContract.telegraphFloorSeconds,
  });
  let chapterIndex = 0;
  let waveTimer = 0;
  let waveIndex = 0;
  let wavesSelected = 0;
  let wavesSpawned = 0;
  let enemiesDestroyed = 0;
  let roomElapsed = 0;
  let untouchedSeconds = 0;
  let lastHull = null;
  let objectiveTargetsSpawned = false;
  const rolesSeen = new Set();
  let lastWave = null;
  let timingContract = null;
  let bossCurrentVariantIndex = null;
  let bossAttacksSelected = 0;
  const bossVariantsSeen = new Set();
  let chapterBeatIndex = 0;
  let chapterRouteChangesCommitted = 0;
  const chapterRolesIntroduced = new Set();

  function bossRecoverySeconds() {
    return pressureContract.waveIntervalSeconds * (bossContract?.recoveryMultiplier ?? 1);
  }

  function bossBehaviorSnapshot() {
    if (!bossContract) return null;
    const generic = {
      recoverySeconds: bossRecoverySeconds(),
      variantCount: bossContract.variantCount,
      currentVariantIndex: bossCurrentVariantIndex,
      variantsSeen: Object.freeze([...bossVariantsSeen]),
      attacksSelected: bossAttacksSelected,
      telegraphFloorSeconds: bossContract.telegraphFloorSeconds,
    };
    return bossSystem
      ? Object.freeze({ ...generic, ...bossSystem.getSnapshot() })
      : Object.freeze(generic);
  }
  if (objectiveAuthority) {
    Object.defineProperty(objectiveAuthority, 'visit', {
      configurable: true,
      value(visitor) {
        if (typeof visitor !== 'function') throw new TypeError('objective authority visitor must be a function');
        if (!objective) return false;
        visitor(objective);
        return true;
      },
    });
  }
  if (deterministicTestAuthority) {
    Object.defineProperty(deterministicTestAuthority, 'completeObjective', {
      configurable: true,
      value() {
        if (phase !== 'active' || !objective) return false;
        if (bossSystem) {
          const completed = bossSystem.completeForDeterministicTest();
          objective = bossSystem.getObjective();
          return completed;
        }
        return completeObjectiveForDeterministicTest(objective);
      },
    });
  }

  function getSnapshot() {
    return Object.freeze({
      mode,
      quality: qualityName,
      seed: Number(seed),
      roomIndex,
      phase,
      combatFrozen,
      upgradeOffered,
      objective: getObjectiveSnapshot(objective),
      threatBudget: threatBudget ? cloneFrozen(threatBudget) : null,
      templateId,
      antiOrbit: antiOrbitDirector.getSnapshot(),
      ...(phase === 'idle' ? {} : {
        pressure: pressureContract,
        timing: timingContract ? cloneFrozen(timingContract) : null,
        boss: bossContract ? cloneFrozen(bossContract) : null,
        bossBehavior: bossBehaviorSnapshot(),
        chapterPacing: (abyssRoomDefinition || dataCityRoomDefinition) ? Object.freeze({
          chapterId: abyssRoomDefinition ? 'abyss' : 'data-city',
          roomId: (abyssRoomDefinition ?? dataCityRoomDefinition).id,
          teachingStage: dataCityRoomDefinition?.teachingStage ?? null,
          safeRoutes: cloneFrozen(dataCityRoomDefinition?.safeRoutes ?? []),
          warningCap: (abyssRoomDefinition ?? dataCityRoomDefinition).warningCap,
          nextBeatIndex: chapterBeatIndex,
          routeChangesCommitted: chapterRouteChangesCommitted,
          rolesIntroduced: Object.freeze([...chapterRolesIntroduced]),
        }) : null,
        threatState: Object.freeze({
          chapterIndex, waveIndex, wavesSelected, wavesSpawned, enemiesDestroyed,
          roomElapsed, untouchedSeconds, rolesSeen: Object.freeze([...rolesSeen]),
          lastWave: lastWave ? cloneFrozen(lastWave) : null,
          enemySystem: enemySystem.getStats(),
        }),
      }),
    });
  }

  function startRoom(templateValue, context = {}) {
    const authored = getEncounterTemplate(templateValue);
    const authoredTargetDurationSeconds = Number.isFinite(context?.timing?.targetDurationSeconds)
      ? Number(context.timing.targetDurationSeconds)
      : null;
    const template = authored
      ? authoredTargetDurationSeconds === null
        ? scaledTemplate(authored, durationScale)
        : tuneCampaignObjectiveTemplate(authored, {
          targetDurationSeconds: authoredTargetDurationSeconds,
          durationScale,
        })
      : null;
    if (!template) throw new TypeError('startRoom requires a known encounter template');
    const currentIndex = roomIndex;
    const selectedRoomSeed = roomSeed(seed, currentIndex, template.id);
    abyssRoomDefinition = context?.campaign?.chapterId === 'abyss'
      && context?.timing?.kind !== 'boss'
      ? getAbyssRoomDefinition(template.id)
      : null;
    const loadedDataCity = context?.campaign?.chapterId === 'data-city'
      ? getLoadedChapterContent('data-city')
      : null;
    dataCityRoomDefinition = loadedDataCity
      && context?.timing?.kind !== 'boss'
      ? loadedDataCity.chapter?.rooms?.find(({ objectiveTemplate }) => objectiveTemplate === template.id) ?? null
      : null;
    dataCityBossDefinition = loadedDataCity?.boss ?? null;
    const startsAbyssBoss = context?.campaign?.chapterId === 'abyss'
      && context?.timing?.kind === 'boss'
      && context?.boss?.id === ABYSS_MAW.id;
    const startsDataCityBoss = context?.campaign?.chapterId === 'data-city'
      && context?.timing?.kind === 'boss'
      && context?.boss?.id === dataCityBossDefinition?.id;
    if (context.boss) {
      const candidate = clone(context.boss);
      if (!Number.isFinite(candidate.recoveryMultiplier)
        || candidate.recoveryMultiplier <= 0 || candidate.recoveryMultiplier > 1.5
        || !Number.isInteger(candidate.variantCount) || candidate.variantCount < 1 || candidate.variantCount > 8
        || !Number.isFinite(candidate.telegraphFloorSeconds) || candidate.telegraphFloorSeconds < 0.55) {
        throw new TypeError('Boss behavior contract is outside fair runtime bounds');
      }
      bossContract = Object.freeze(candidate);
    } else bossContract = null;
    bossSystem = startsAbyssBoss || startsDataCityBoss
      ? createBossSystem({ seed: selectedRoomSeed, mode })
      : null;
    objective = bossSystem
      ? bossSystem.start(startsAbyssBoss ? ABYSS_MAW : dataCityBossDefinition, {
        targetDurationSeconds: (authoredTargetDurationSeconds ?? 100) * durationScale,
        behaviorContract: bossContract,
      })
      : createObjective(template, selectedRoomSeed);
    bossWorld = null;
    antiOrbitDirector = createAntiOrbitDirector({ seed: selectedRoomSeed });
    threatRandom = createThreatRandom(selectedRoomSeed);
    chapterIndex = Math.max(0, Math.trunc(finite(context.chapterIndex, context.chapter ?? currentIndex)));
    waveTimer = 0;
    roomElapsed = 0;
    untouchedSeconds = 0;
    lastHull = null;
    objectiveTargetsSpawned = false;
    chapterBeatIndex = 0;
    chapterRouteChangesCommitted = 0;
    chapterRolesIntroduced.clear();
    for (const role of (abyssRoomDefinition ?? dataCityRoomDefinition)?.inheritedRoles ?? []) {
      chapterRolesIntroduced.add(role);
    }
    lastWave = null;
    const baseThreatBudget = getThreatBudget(template, {
      mode: usesCampaignPressure ? 'standard' : mode,
      quality,
    });
    threatBudget = Object.freeze({
      ...baseThreatBudget,
      total: Math.max(1, Math.round(baseThreatBudget.total * pressureContract.threatBudget)),
    });
    timingContract = authoredTargetDurationSeconds === null ? null : Object.freeze({
      kind: context.timing.kind === 'boss' ? 'boss' : 'room',
      authoredTargetDurationSeconds,
      effectiveTargetDurationSeconds: authoredTargetDurationSeconds * durationScale,
      objectiveScale: (authoredTargetDurationSeconds * durationScale) / Math.max(0.1, authored.timeout),
      estimatedObjectiveSeconds: estimateCampaignObjectiveSeconds(template),
      completesOnObjective: true,
    });
    bossCurrentVariantIndex = null;
    bossAttacksSelected = 0;
    bossVariantsSeen.clear();
    templateId = template.id;
    roomIndex += 1;
    phase = 'active';
    combatFrozen = false;
    upgradeOffered = false;
    completionAcknowledged = false;
    updateRevision += 1;
    return getSnapshot();
  }

  function spawnChapterIntroduction(world, definition, chapterId, beat, events) {
    if (!ENEMY_ROLES[beat.role]) return 0;
    const count = Math.max(1, Math.min(8, Math.trunc(finite(beat.count, 1))));
    const roles = Array.from({ length: count }, () => beat.role);
    const ids = enemySystem.spawnWave(world, roles, { arena: objective.arena, events });
    if (ids.length > 0) {
      chapterRolesIntroduced.add(beat.role);
      ids.forEach((id) => {
        const role = world.get(id)?.role;
        if (role) rolesSeen.add(role);
      });
      emit(events, 'chapter:enemy-introduced', {
        chapterId, roomId: definition.id, role: beat.role, count: ids.length,
      });
    }
    return ids.length;
  }

  function commitChapterRouteChange(world, definition, chapterId, beat, events) {
    if (chapterId === 'data-city') {
      const applied = applyAuthoredChapterBeat(objective, beat);
      chapterRouteChangesCommitted += 1;
      if (applied && beat.kind === 'route-change' && objective.type === 'storm-corridor') {
        const destination = objective.nextSafeZone ?? objective.safeZone;
        world.spawn('warning', {
          x: destination.x, y: destination.y, radius: destination.radius ?? objective.corridor.width,
          scaleX: destination.radius ?? objective.corridor.width,
          scaleY: destination.radius ?? objective.corridor.width,
          duration: 0.9, lifetime: 0.9, age: 0, ownerKind: 'chapter', ownerId: objective.seed,
          attackKind: 'data-city-route-change', state: 'telegraph', variant: 'corridor-gap',
          contactDamaging: false, collidable: false, opacity: 0.86, color: 0x27e5ff,
        });
      }
      emit(events, beat.kind === 'data-lane' ? 'chapter:data-lane' : 'chapter:route-changed', {
        chapterId, roomId: definition.id, kind: beat.kind, route: beat.route ?? null,
        lane: beat.lane ?? null, applied, routeChangesCommitted: chapterRouteChangesCommitted,
        objectiveType: objective.type,
      });
      return applied;
    }
    const plan = createObjectiveShiftPlan(objective, {
      pathNodes: 7,
      variant: chapterRouteChangesCommitted,
    });
    const shifted = plan ? commitObjectiveShift(objective, plan) : false;
    chapterRouteChangesCommitted += 1;
    // Objectives without shift authority materialize harmless route geometry.
    // This remains visible and pooled without becoming a second objective writer.
    if (!shifted && world?.spawn) {
      const direction = chapterRouteChangesCommitted % 2 ? 1 : -1;
      for (let index = 0; index < 2; index += 1) world.spawn('enemyHazard', {
        x: direction * (3.6 + index * 1.5),
        y: (index ? -1 : 1) * 2.2,
        radius: 0.7,
        scaleX: 2.4,
        scaleY: 0.5,
        team: 2,
        ownerKind: 'chapter',
        attackKind: chapterId === 'data-city' ? 'data-city-safe-route' : 'abyss-route-current',
        state: 'route-change',
        contactDamaging: false,
        collidable: false,
        opacity: 0.64,
        color: chapterId === 'data-city' ? 0x27e5ff : 0x13d9ce,
      });
    }
    emit(events, 'chapter:route-changed', {
      chapterId, roomId: definition.id, route: beat.route,
      shifted, routeChangesCommitted: chapterRouteChangesCommitted,
      destination: plan?.destination ?? null,
    });
  }

  function applyAbyssChapterBeats(context, events) {
    const definition = abyssRoomDefinition ?? dataCityRoomDefinition;
    const chapterId = abyssRoomDefinition ? 'abyss' : dataCityRoomDefinition ? 'data-city' : null;
    if (!definition || !chapterId || !context.world) return;
    const beats = definition.beats;
    while (chapterBeatIndex < beats.length
      && beats[chapterBeatIndex].at * durationScale <= roomElapsed + 1e-9) {
      const beat = beats[chapterBeatIndex++];
      if (beat.kind === 'enemy-introduction') {
        spawnChapterIntroduction(context.world, definition, chapterId, beat, events);
      } else if (beat.kind === 'route-change' || beat.kind === 'safe-route' || beat.kind === 'data-lane') {
        commitChapterRouteChange(context.world, definition, chapterId, beat, events);
      }
      else emit(events, 'chapter:beat', {
        chapterId, roomId: definition.id, ...beat,
      });
    }
  }

  function spawnObjectiveTargets(world, events) {
    if (objectiveTargetsSpawned || !world?.spawn || objective?.type !== 'elite-hunt') return 0;
    objectiveTargetsSpawned = true;
    let count = 0;
    for (const target of objective.eliteTargets ?? []) {
      const id = enemySystem.spawnRole(world, 'bulwark', {
        x: target.x, y: target.y, sourceId: target.sourceId,
        hp: target.hp, maxHp: target.hp,
        armored: false, weakPoint: true, events,
      });
      if (id != null) { count += 1; rolesSeen.add('bulwark'); }
    }
    return count;
  }

  function selectAndSpawnThreat(context, dt, events) {
    const world = context.world;
    const player = context.player;
    if (!world?.query || !player || objective?.status !== 'active') return null;
    spawnObjectiveTargets(world, events);
    roomElapsed += dt;
    applyAbyssChapterBeats(context, events);
    const hull = finite(player.hp ?? player.hull, 1);
    const maxHull = Math.max(1, finite(player.maxHp ?? player.maxHull, hull));
    if (lastHull === null || hull >= lastHull - 1e-9) untouchedSeconds += dt;
    else untouchedSeconds = 0;
    lastHull = hull;
    const destroyedThisStep = Array.isArray(events?.input)
      ? events.input.filter((event) => event?.type === 'enemy:destroyed').length
      : 0;
    enemiesDestroyed += destroyedThisStep;
    waveTimer -= dt;
    if (waveTimer > 0) return null;
    const scanned = scanThreatWorld(world);
    const bossVariant = bossContract ? {
      index: waveIndex % bossContract.variantCount,
      count: bossContract.variantCount,
    } : null;
    const selectionWaveIndex = bossVariant ? waveIndex + bossVariant.index * 2 : waveIndex;
    let wave = selectThreatWave({
      mode, quality, chapter: chapterIndex, waveIndex: selectionWaveIndex, ...scanned,
      objectiveBurden: objectiveBurdenFor(objective),
      playerHealthRatio: hull / maxHull,
      clearRate: roomElapsed > 0 ? enemiesDestroyed / roomElapsed : 0,
      untouchedSeconds, totalBudget: threatBudget?.total ?? 30,
    }, threatRandom);
    const authoredRoomDefinition = abyssRoomDefinition ?? dataCityRoomDefinition;
    if (authoredRoomDefinition) {
      const reservedIntroductions = authoredRoomDefinition.beats
        .slice(chapterBeatIndex)
        .filter(({ kind }) => kind === 'enemy-introduction')
        .reduce((sum, beat) => sum + Math.max(1, Math.trunc(finite(beat.count, 1))), 0);
      const tutorialSlots = Math.max(
        0,
        authoredRoomDefinition.activeEnemyCap - reservedIntroductions - scanned.activeEnemies,
      );
      const admissionCharges = wave.admissionCharges
        .filter(({ role }) => chapterRolesIntroduced.has(role))
        .slice(0, tutorialSlots);
      const roles = admissionCharges.map(({ role }) => role);
      wave = Object.freeze({
        ...wave,
        roles: Object.freeze(roles),
        admissionCharges: Object.freeze(admissionCharges),
        cost: admissionCharges.reduce((sum, charge) => sum + charge.chargedCost, 0),
        projectileCost: admissionCharges.reduce((sum, charge) => sum + ENEMY_ROLES[charge.role].projectileCost, 0),
        blockedAreaCost: admissionCharges.reduce((sum, charge) => sum + ENEMY_ROLES[charge.role].blockedAreaCost, 0),
        highDamageWarnings: admissionCharges.reduce((sum, charge) => (
          sum + (ENEMY_ROLES[charge.role].highDamage ? 1 : 0)
        ), 0),
      });
    }
    waveIndex += 1;
    wavesSelected += 1;
    const materializedRoles = [];
    if (wave.roles.length > 0) {
      const ids = enemySystem.spawnWave(world, wave.roles, {
        arena: objective.arena,
        events,
        variantOffset: bossVariant?.index ?? 0,
        variantCount: bossVariant?.count ?? 3,
      });
      if (ids.length > 0) {
        wavesSpawned += 1;
        for (const id of ids) {
          const role = world.get(id)?.role;
          if (!ENEMY_ROLES[role]) continue;
          rolesSeen.add(role);
          materializedRoles.push(role);
        }
      }
    }
    if (bossVariant) {
      bossCurrentVariantIndex = bossVariant.index;
      bossVariantsSeen.add(bossVariant.index);
      bossAttacksSelected += 1;
    }
    lastWave = createMaterializedWave(wave, materializedRoles, bossVariant);
    if (materializedRoles.length > 0) {
      emit(events, 'encounter:threat-wave', {
        templateId, chapterIndex, waveIndex: waveIndex - 1,
        roles: lastWave.roles,
        cost: lastWave.cost,
        projectileCost: lastWave.projectileCost,
        blockedAreaCost: lastWave.blockedAreaCost,
        highDamageWarnings: lastWave.highDamageWarnings,
        budget: lastWave.budget,
        activeEnemyCap: lastWave.limits.activeEnemyCap,
        materialized: lastWave.materialized,
        selectedDiagnostics: lastWave.selectedDiagnostics,
        materializedDiagnostics: lastWave.materializedDiagnostics,
        rejectedDiagnostics: lastWave.rejectedDiagnostics,
        bossVariantIndex: lastWave.bossVariantIndex ?? null,
        bossVariantCount: lastWave.bossVariantCount ?? null,
        bossRecoverySeconds: bossContract ? bossRecoverySeconds() : null,
        telegraphFloorSeconds: bossContract?.telegraphFloorSeconds ?? pressureContract.telegraphFloorSeconds,
      });
    }
    waveTimer = bossRecoverySeconds();
    return lastWave;
  }

  function update(context = {}, dt = 0, events = null) {
    if (phase === 'idle' || completionAcknowledged) return Object.freeze({ phase, combatFrozen, updateRevision, changed: false });
    const previousPhase = phase;
    const previousStatus = objective?.status;
    const previousProgressBucket = Math.floor((objective?.progressRatio ?? 0) * 20);
    let enteredDraining = false;
    if (phase === 'active') {
      if (bossSystem) {
        bossWorld = context.world ?? bossWorld;
        bossSystem.update({
          world: context.world,
          player: context.player,
          damageRecords: context.damageRecords ?? [],
          applyPlayerForce: context.applyPlayerForce,
        }, dt, events);
        objective = bossSystem.getObjective();
      } else updateObjective(objective, context.world ?? null, context.player ?? null, dt, events);
      if (objective.status === 'active') {
        if (!bossSystem) {
          antiOrbitDirector.update({ player: context.player ?? null, objective }, dt, events);
          selectAndSpawnThreat(context, Math.max(0, finite(dt)), events);
        }
      } else {
        antiOrbitDirector.reset({ seed: objective.seed, objectiveId: objective.id });
        if (objective.antiOrbit) objective.antiOrbit.activeCounter = null;
      }
      if (objective.status === 'completed') {
        phase = 'draining';
        enteredDraining = true;
        combatFrozen = true;
        const cleanupWorld = context.world ?? bossWorld;
        if (cleanupWorld) {
          enemySystem.cleanup(cleanupWorld);
          cleanupChapterEntities(cleanupWorld);
          bossSystem?.cleanup(cleanupWorld, events, 'victory');
        }
        emit(events, 'encounter:combat-frozen', { templateId, objective: getObjectiveSnapshot(objective) });
      } else if (objective.status === 'failed') {
        phase = 'failed';
        combatFrozen = true;
        const cleanupWorld = context.world ?? bossWorld;
        if (cleanupWorld) {
          enemySystem.cleanup(cleanupWorld);
          cleanupChapterEntities(cleanupWorld);
          bossSystem?.cleanup(cleanupWorld, events, objective.failureReason ?? 'failed');
        }
        emit(events, 'encounter:failed', { templateId, objective: getObjectiveSnapshot(objective) });
      }
    }
    if (!enteredDraining && phase === 'draining' && Math.max(0, Number(context.presentationPending) || 0) === 0) {
      phase = 'complete';
      upgradeOffered = true;
      emit(events, 'encounter:upgrade-offered', { templateId, objective: getObjectiveSnapshot(objective) });
    }
    updateRevision += 1;
    return Object.freeze({
      phase,
      combatFrozen,
      updateRevision,
      changed: phase !== previousPhase || objective?.status !== previousStatus
        || Math.floor((objective?.progressRatio ?? 0) * 20) !== previousProgressBucket,
      objectiveStatus: objective?.status ?? null,
      progress: objective?.progress ?? 0,
      progressRatio: objective?.progressRatio ?? 0,
    });
  }

  function cleanupChapterEntities(world) {
    if (!world?.query) return 0;
    let removed = 0;
    for (const kind of ['enemyHazard', 'warning']) {
      const ids = [];
      const query = world.query(kind);
      for (let index = 0; index < query.length; index += 1) {
        const entity = world.get(query.at(index));
        if (entity?.ownerKind === 'chapter') ids.push(entity.id);
      }
      for (const id of ids) if (world.despawn(id)) removed += 1;
    }
    return removed;
  }

  function completeRoom() {
    if (phase !== 'complete' || completionAcknowledged) return false;
    completionAcknowledged = true;
    return true;
  }

  function reset(events = null) {
    bossSystem?.cleanup(bossWorld, events, 'reset');
    roomIndex = initialRoomIndex;
    phase = 'idle';
    objective = null;
    templateId = null;
    threatBudget = null;
    timingContract = null;
    bossContract = null;
    bossSystem = null;
    bossWorld = null;
    abyssRoomDefinition = null;
    dataCityRoomDefinition = null;
    dataCityBossDefinition = null;
    bossCurrentVariantIndex = null;
    bossAttacksSelected = 0;
    bossVariantsSeen.clear();
    combatFrozen = false;
    upgradeOffered = false;
    completionAcknowledged = false;
    antiOrbitDirector = createAntiOrbitDirector({ seed });
    threatRandom = createThreatRandom(seed);
    enemySystem.reset();
    chapterIndex = 0;
    waveTimer = 0;
    waveIndex = 0;
    wavesSelected = 0;
    wavesSpawned = 0;
    enemiesDestroyed = 0;
    roomElapsed = 0;
    untouchedSeconds = 0;
    lastHull = null;
    objectiveTargetsSpawned = false;
    rolesSeen.clear();
    lastWave = null;
    chapterBeatIndex = 0;
    chapterRouteChangesCommitted = 0;
    chapterRolesIntroduced.clear();
    updateRevision += 1;
    return getSnapshot();
  }

  return Object.freeze({
    startRoom, update, completeRoom, reset, getSnapshot,
    getAuthoredDataLaneEffect: (environmentFrame, point) => getDataLaneEffect(
      objective?.dataLane && environmentFrame?.type === 'data-lane'
        ? { ...objective.dataLane, phase: environmentFrame.phase }
        : environmentFrame,
      point,
    ),
  });
}
