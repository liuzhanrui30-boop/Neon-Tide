import { getEncounterTemplate, getThreatBudget } from '../content/encounters.js';
import { createObjective, getObjectiveSnapshot, updateObjective } from './objective-system.js';
import { createAntiOrbitDirector } from './anti-orbit-director.js';
import { ENEMY_ROLE_IDS, ENEMY_ROLES } from '../content/enemies.js';
import { createEnemySystem } from './enemy-system.js';


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
  const healthFactor = reliefApplied ? (mode === 'abyss' ? 0.82 : 0.58) : playerHealthRatio < 0.7 ? 0.86 : 1;
  const masteryFactor = 1 + clamp((clearRate - 0.75) * 0.14, -0.12, 0.24)
    + clamp((untouchedSeconds - 8) / 80, 0, 0.18);
  const burdenFactor = 1 - objectiveBurden * (mode === 'abyss' ? 0.22 : 0.34);
  const baseWaveBudget = Math.min(totalBudget, 6 + chapter * 2.25 + (mode === 'abyss' ? 1.5 : 0));
  const budget = Math.max(1, Math.floor(baseWaveBudget * healthFactor * masteryFactor * burdenFactor));
  const availableSlots = Math.max(0, limits.activeEnemyCap - activeEnemies);
  if (availableSlots === 0) return Object.freeze({
    roles: Object.freeze([]), cost: 0, budget, projectileCost: 0, blockedAreaCost: 0,
    highDamageWarnings: 0, reliefApplied, limits,
  });

  const roles = [];
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

function scanThreatWorld(world) {
  const roleCounts = Object.fromEntries(ENEMY_ROLE_IDS.map((id) => [id, 0]));
  let highDamageWarnings = 0;
  let blockedArea = 0;
  const warned = new Set();
  const enemies = world?.query?.('enemy');
  if (enemies) {
    for (let index = 0; index < enemies.length; index += 1) {
      const enemy = world.get(enemies.at(index));
      if (!enemy || !ENEMY_ROLES[enemy.role]) continue;
      roleCounts[enemy.role] += 1;
      if (enemy.executingTelegraph && ENEMY_ROLES[enemy.role].highDamage && !warned.has(enemy.id)) {
        warned.add(enemy.id);
        highDamageWarnings += 1;
        blockedArea += ENEMY_ROLES[enemy.role].blockedAreaCost;
      }
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

function scaledTemplate(template, scale) {
  if (scale >= 0.999) return template;
  return {
    ...template,
    timeout: Math.max(6, template.timeout * scale),
    killTarget: Math.max(3, Math.ceil((template.killTarget ?? 1) * scale)),
    anchorSeconds: Math.max(0.2, (template.anchorSeconds ?? 1) * scale),
    holdSeconds: Math.max(1, (template.holdSeconds ?? 1) * scale),
    escortDistance: Math.max(3, (template.escortDistance ?? 1) * scale),
    eliteTarget: Math.max(1, Math.ceil((template.eliteTarget ?? 1) * scale)),
    survivalSeconds: Math.max(2, (template.survivalSeconds ?? 1) * scale),
    coreCount: Math.max(2, Math.ceil((template.coreCount ?? 2) * scale)),
    crisisSeconds: Math.max(0.4, (template.crisisSeconds ?? 1) * scale),
  };
}

export function createEncounterDirector({
  mode = 'standard', quality = 'desktop', seed = 0, roomIndex: initialRoomIndex = 0, durationScale = 1,
  objectiveAuthority = null,
} = {}) {
  if (!['standard', 'abyss'].includes(mode)) throw new TypeError('encounter mode must be standard or abyss');
  if (!Number.isFinite(Number(seed))) throw new TypeError('encounter seed must be finite');
  if (!Number.isInteger(initialRoomIndex) || initialRoomIndex < 0) throw new TypeError('encounter roomIndex must be a non-negative integer');
  if (!Number.isFinite(durationScale) || durationScale <= 0 || durationScale > 1) throw new TypeError('durationScale must be in (0, 1]');
  if (objectiveAuthority !== null && (!objectiveAuthority || typeof objectiveAuthority !== 'object' || Array.isArray(objectiveAuthority))) {
    throw new TypeError('objectiveAuthority must be an internal channel object');
  }
  const qualityName = typeof quality === 'string' ? quality : quality?.tier ?? 'desktop';
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
  const enemySystem = createEnemySystem({
    random: () => threatRandom(),
    projectileCap: getThreatLimits({ mode, quality }).projectileCap,
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
      ...(phase === 'idle' ? {} : { threatState: Object.freeze({
        chapterIndex, waveIndex, wavesSelected, wavesSpawned, enemiesDestroyed,
        roomElapsed, untouchedSeconds, rolesSeen: Object.freeze([...rolesSeen]),
        lastWave: lastWave ? cloneFrozen(lastWave) : null,
        enemySystem: enemySystem.getStats(),
      }) }),
    });
  }

  function startRoom(templateValue, context = {}) {
    const authored = getEncounterTemplate(templateValue);
    const template = authored ? scaledTemplate(authored, durationScale) : null;
    if (!template) throw new TypeError('startRoom requires a known encounter template');
    const currentIndex = roomIndex;
    const selectedRoomSeed = roomSeed(seed, currentIndex, template.id);
    objective = createObjective(template, selectedRoomSeed);
    antiOrbitDirector = createAntiOrbitDirector({ seed: selectedRoomSeed });
    threatRandom = createThreatRandom(selectedRoomSeed);
    chapterIndex = Math.max(0, Math.trunc(finite(context.chapterIndex, context.chapter ?? currentIndex)));
    waveTimer = 0;
    roomElapsed = 0;
    untouchedSeconds = 0;
    lastHull = null;
    objectiveTargetsSpawned = false;
    lastWave = null;
    threatBudget = getThreatBudget(template, { mode, quality });
    templateId = template.id;
    roomIndex += 1;
    phase = 'active';
    combatFrozen = false;
    upgradeOffered = false;
    completionAcknowledged = false;
    updateRevision += 1;
    return getSnapshot();
  }

  function spawnObjectiveTargets(world, events) {
    if (objectiveTargetsSpawned || !world?.spawn || objective?.type !== 'elite-hunt') return 0;
    objectiveTargetsSpawned = true;
    let count = 0;
    for (const target of objective.eliteTargets ?? []) {
      const id = enemySystem.spawnRole(world, 'bulwark', {
        x: target.x, y: target.y, sourceId: target.sourceId, armored: false, weakPoint: true, events,
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
    const wave = selectThreatWave({
      mode, quality, chapter: chapterIndex, waveIndex, ...scanned,
      objectiveBurden: objectiveBurdenFor(objective),
      playerHealthRatio: hull / maxHull,
      clearRate: roomElapsed > 0 ? enemiesDestroyed / roomElapsed : 0,
      untouchedSeconds, totalBudget: threatBudget?.total ?? 30,
    }, threatRandom);
    waveIndex += 1;
    wavesSelected += 1;
    lastWave = wave;
    if (wave.roles.length > 0) {
      const ids = enemySystem.spawnWave(world, wave.roles, { arena: objective.arena, events });
      if (ids.length > 0) {
        wavesSpawned += 1;
        for (const role of wave.roles) rolesSeen.add(role);
        emit(events, 'encounter:threat-wave', {
          templateId, chapterIndex, waveIndex: waveIndex - 1, roles: wave.roles,
          cost: wave.cost, budget: wave.budget, activeEnemyCap: wave.limits.activeEnemyCap,
        });
      }
    }
    const relief = wave.reliefApplied ? (mode === 'abyss' ? 1.35 : 1.65) : 1;
    waveTimer = (mode === 'abyss' ? 1.8 : 2.4) * relief;
    return wave;
  }

  function update(context = {}, dt = 0, events = null) {
    if (phase === 'idle' || completionAcknowledged) return Object.freeze({ phase, combatFrozen, updateRevision, changed: false });
    const previousPhase = phase;
    const previousStatus = objective?.status;
    const previousProgressBucket = Math.floor((objective?.progressRatio ?? 0) * 20);
    let enteredDraining = false;
    if (phase === 'active') {
      updateObjective(objective, context.world ?? null, context.player ?? null, dt, events);
      if (objective.status === 'active') {
        antiOrbitDirector.update({ player: context.player ?? null, objective }, dt, events);
        selectAndSpawnThreat(context, Math.max(0, finite(dt)), events);
      } else {
        antiOrbitDirector.reset({ seed: objective.seed, objectiveId: objective.id });
        if (objective.antiOrbit) objective.antiOrbit.activeCounter = null;
      }
      if (objective.status === 'completed') {
        phase = 'draining';
        enteredDraining = true;
        combatFrozen = true;
        if (context.world) enemySystem.cleanup(context.world);
        emit(events, 'encounter:combat-frozen', { templateId, objective: getObjectiveSnapshot(objective) });
      } else if (objective.status === 'failed') {
        phase = 'failed';
        combatFrozen = true;
        if (context.world) enemySystem.cleanup(context.world);
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

  function completeRoom() {
    if (phase !== 'complete' || completionAcknowledged) return false;
    completionAcknowledged = true;
    return true;
  }

  function reset() {
    roomIndex = initialRoomIndex;
    phase = 'idle';
    objective = null;
    templateId = null;
    threatBudget = null;
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
    updateRevision += 1;
    return getSnapshot();
  }

  return Object.freeze({
    startRoom, update, completeRoom, reset, getSnapshot,
  });
}
