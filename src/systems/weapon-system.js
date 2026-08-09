import { createEntityReadTarget } from '../game/entity-world.js';
import { AUTO_PULSE_BUFF_MULTIPLIER } from './player-system.js';

export const TIDE_LANCE_CHARGE_SECONDS = 0.28;
export const TIDE_LANCE_RETARGET_SECONDS = TIDE_LANCE_CHARGE_SECONDS / 2;
export const WEAPON_IDS = Object.freeze(['pulse-cannon', 'arc-drones', 'prism-missiles']);

export const WEAPON_CONFIG = Object.freeze({
  'pulse-cannon': Object.freeze({
    interval: 0.18,
    damage: 0.65,
    speed: 13.5,
    turnRate: 3.2,
    lifetime: 1.35,
    radius: 0.13,
  }),
  'arc-drones': Object.freeze({
    interval: 0.82,
    damage: 0.72,
    speed: 15,
    turnRate: 8,
    lifetime: 1.05,
    radius: 0.16,
    droneCount: 2,
    chainCount: 2,
  }),
  'prism-missiles': Object.freeze({
    interval: 1.35,
    damage: 2,
    speed: 4.8,
    turnRate: 2.4,
    lifetime: 4,
    radius: 0.22,
    splitCount: 3,
  }),
});

const DEFAULT_TARGET_RANGE = 30;
const DEFAULT_MAX_CANDIDATES = 96;
const DEFAULT_LANCE_LENGTH = 7.2;
const DEFAULT_LANCE_HALF_WIDTH = 0.275;
const DEFAULT_LANCE_TARGETS = 8;
const MAX_LANCE_TARGETS = 16;
const DEFAULT_BEARINGS = 24;
const TARGET_KINDS = Object.freeze(['bossPart', 'enemy', 'objective']);
const EPSILON = 1e-9;
const LANCE_SPEC_CACHE = new WeakMap();

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function candidateId(candidate, fallback) {
  return Number.isSafeInteger(candidate?.id) ? candidate.id : fallback;
}

function candidatePriority(candidate, options = {}) {
  const threat = clamp(finite(candidate?.threat), 0, 100);
  const role = candidate?.role ?? candidate?.type;
  return (candidate?.executingTelegraph || candidate?.executing ? 10_000 : 0)
    + (candidate?.weakPoint ? 8_000 * clamp(finite(options.weakPointPriority, 1), 1, 1.8) : 0)
    + (candidate?.objective || candidate?.objectiveType ? 7_000 : 0)
    + (role === 'boss' || candidate?.type === 'boss' ? 6_000 : 0)
    + threat * 100;
}

function isCandidate(candidate) {
  return candidate
    && candidate.visible !== false
    && !candidate.dead
    && finite(candidate.hp, 1) > 0
    && Number.isFinite(Number(candidate.x))
    && Number.isFinite(Number(candidate.y));
}

export function selectAutoTarget(player, candidates, context = {}) {
  if (!Array.isArray(candidates)) throw new TypeError('automatic target candidates must be an array');
  const originX = finite(player?.x ?? player?.position?.x);
  const originY = finite(player?.y ?? player?.position?.y);
  const range = clamp(finite(context.range, DEFAULT_TARGET_RANGE), 0, 1_000);
  const maxCandidates = clamp(
    Math.trunc(finite(context.maxCandidates, DEFAULT_MAX_CANDIDATES)),
    1,
    DEFAULT_MAX_CANDIDATES,
  );
  const candidateCount = Number.isInteger(context.candidateCount)
    ? clamp(context.candidateCount, 0, candidates.length)
    : candidates.length;
  const limited = Math.min(candidateCount, maxCandidates);
  let best = null;
  let bestPriority = -Infinity;
  let bestDistance = Infinity;
  let bestId = Number.MAX_SAFE_INTEGER;
  for (let index = 0; index < limited; index += 1) {
    const candidate = candidates[index];
    if (!isCandidate(candidate)) continue;
    const distance = Math.hypot(finite(candidate.x) - originX, finite(candidate.y) - originY);
    if (!Number.isFinite(distance) || distance > range) continue;
    const priority = candidatePriority(candidate, context);
    const id = candidateId(candidate, index);
    const better = priority > bestPriority
      || (priority === bestPriority && distance < bestDistance - EPSILON)
      || (priority === bestPriority && Math.abs(distance - bestDistance) <= EPSILON && id < bestId);
    if (!better) continue;
    best = candidate;
    bestPriority = priority;
    bestDistance = distance;
    bestId = id;
  }
  return best;
}

function normalizeDirection(x, y, fallbackX = 0, fallbackY = 1) {
  const length = Math.hypot(x, y);
  if (length > EPSILON) return { x: x / length, y: y / length };
  const fallbackLength = Math.hypot(fallbackX, fallbackY);
  if (fallbackLength > EPSILON) return { x: fallbackX / fallbackLength, y: fallbackY / fallbackLength };
  return { x: 0, y: 1 };
}

function lineTargetScore(target, along, options = {}) {
  const distanceScore = Math.max(0, 180 - along * 12);
  return distanceScore
    + clamp(finite(target.threat), 0, 100) * 70
    + (target.executingTelegraph || target.executing ? 2_400 : 0)
    + (target.objective || target.objectiveType ? 2_000 : 0)
    + (target.weakPoint ? 2_800 * clamp(finite(options.weakPointPriority, 1), 1, 1.8) : 0)
    + (target.role === 'boss' || target.type === 'boss' ? 1_200 : 0);
}

function addBearing(bearings, count, x, y) {
  const direction = normalizeDirection(x, y, 0, 0);
  if (Math.hypot(direction.x, direction.y) <= EPSILON) return count;
  for (let index = 0; index < count; index += 1) {
    if (Math.abs(bearings[index * 2] - direction.x) <= 1e-6
      && Math.abs(bearings[index * 2 + 1] - direction.y) <= 1e-6) return count;
  }
  bearings[count * 2] = direction.x;
  bearings[count * 2 + 1] = direction.y;
  return count + 1;
}

export function selectTideLanceLine(player, candidates, objectives = [], options = {}) {
  if (!Array.isArray(candidates) || !Array.isArray(objectives)) {
    throw new TypeError('Tide Lance candidates and objectives must be arrays');
  }
  const originX = finite(player?.x ?? player?.position?.x);
  const originY = finite(player?.y ?? player?.position?.y);
  const facing = normalizeDirection(
    finite(player?.facing?.x ?? player?.directionX),
    finite(player?.facing?.y ?? player?.directionY, 1),
  );
  const length = clamp(finite(options.length, DEFAULT_LANCE_LENGTH), 0.1, 100);
  const halfWidth = clamp(finite(options.halfWidth, DEFAULT_LANCE_HALF_WIDTH), 0.01, 10);
  const maxBearings = clamp(Math.trunc(finite(options.maxBearings, DEFAULT_BEARINGS)), 1, DEFAULT_BEARINGS);
  const maxTargets = clamp(
    Math.trunc(finite(options.hitCap ?? options.maxTargets, DEFAULT_LANCE_TARGETS)),
    1,
    MAX_LANCE_TARGETS,
  );
  const all = candidates.concat(objectives);
  const bearings = new Float64Array(maxBearings * 2);
  let bearingCount = addBearing(bearings, 0, facing.x, facing.y);
  const bearingSources = all.flatMap((target, index) => {
    if (!isCandidate(target)) return [];
    const offsetX = finite(target.x) - originX;
    const offsetY = finite(target.y) - originY;
    const distance = Math.hypot(offsetX, offsetY);
    if (distance <= EPSILON || distance > length + finite(target.radius, 0.5)) return [];
    return [{ target, index, offsetX, offsetY, distance }];
  }).sort((left, right) => candidatePriority(right.target, options) - candidatePriority(left.target, options)
    || left.distance - right.distance
    || candidateId(left.target, left.index) - candidateId(right.target, right.index));
  for (let index = 0; index < bearingSources.length && bearingCount < maxBearings; index += 1) {
    const source = bearingSources[index];
    bearingCount = addBearing(bearings, bearingCount, source.offsetX, source.offsetY);
  }

  let bestDirectionX = facing.x;
  let bestDirectionY = facing.y;
  let bestScore = -Infinity;
  let bestBearingIndex = Number.MAX_SAFE_INTEGER;
  let bestHits = [];
  for (let bearingIndex = 0; bearingIndex < bearingCount; bearingIndex += 1) {
    const directionX = bearings[bearingIndex * 2];
    const directionY = bearings[bearingIndex * 2 + 1];
    const hits = [];
    let score = 0;
    for (let targetIndex = 0; targetIndex < all.length; targetIndex += 1) {
      const target = all[targetIndex];
      if (!isCandidate(target)) continue;
      const offsetX = finite(target.x) - originX;
      const offsetY = finite(target.y) - originY;
      const along = offsetX * directionX + offsetY * directionY;
      if (along < 0 || along > length) continue;
      const perpendicular = Math.abs(offsetX * directionY - offsetY * directionX);
      if (perpendicular > halfWidth + Math.max(0, finite(target.radius, 0.5))) continue;
      hits.push({ id: candidateId(target, targetIndex), along, target });
      score += lineTargetScore(target, along, options);
    }
    hits.sort((left, right) => left.along - right.along || left.id - right.id);
    const cappedHits = hits.slice(0, maxTargets);
    if (hits.length > maxTargets) {
      score -= hits.slice(maxTargets).reduce((total, hit) => total + lineTargetScore(hit.target, hit.along, options), 0);
    }
    const better = score > bestScore + EPSILON
      || (Math.abs(score - bestScore) <= EPSILON && cappedHits.length > bestHits.length)
      || (Math.abs(score - bestScore) <= EPSILON
        && cappedHits.length === bestHits.length
        && bearingIndex < bestBearingIndex);
    if (!better) continue;
    bestDirectionX = directionX;
    bestDirectionY = directionY;
    bestScore = score;
    bestBearingIndex = bearingIndex;
    bestHits = cappedHits;
  }
  return Object.freeze({
    directionX: bestDirectionX,
    directionY: bestDirectionY,
    score: Math.max(0, bestScore),
    targetIds: Object.freeze(bestHits.map(({ id }) => id)),
    length,
    halfWidth,
    width: halfWidth * 2,
    hitCap: maxTargets,
  });
}

export function deriveTideLanceSpec(buildStats = {}) {
  if (buildStats && typeof buildStats === 'object') {
    const cached = LANCE_SPEC_CACHE.get(buildStats);
    if (cached) return cached;
  }
  const length = clamp(finite(buildStats?.lanceLength, DEFAULT_LANCE_LENGTH), DEFAULT_LANCE_LENGTH, 12);
  const halfWidth = clamp(finite(buildStats?.lanceHalfWidth, DEFAULT_LANCE_HALF_WIDTH), DEFAULT_LANCE_HALF_WIDTH, 0.7);
  const baseHitCap = clamp(Math.trunc(finite(buildStats?.lanceTargetCap, DEFAULT_LANCE_TARGETS)), 1, 12);
  const pierce = clamp(Math.trunc(finite(buildStats?.lancePierce)), 0, 4);
  const spec = Object.freeze({
    length,
    halfWidth,
    width: halfWidth * 2,
    baseHitCap,
    pierce,
    hitCap: Math.min(MAX_LANCE_TARGETS, baseHitCap + pierce),
    weakPointMultiplier: clamp(finite(buildStats?.lanceWeakPointMultiplier, 1), 1, 2),
    objectiveMultiplier: clamp(finite(buildStats?.objectiveDamageMultiplier, 1), 1, 1.8),
    damageMultiplier: clamp(finite(buildStats?.lanceDamageMultiplier, 1), 1, 1.6),
    propagation: clamp(Math.trunc(finite(buildStats?.lancePropagation)), 0, 2),
    propagationRadius: clamp(finite(buildStats?.propagationRadius, 6), 0, 8),
    propagationDamageMultiplier: clamp(finite(buildStats?.chainDamageMultiplier, 0.78), 0.5, 1),
    weakPointPriority: clamp(finite(buildStats?.weakPointPriority, 1), 1, 1.8),
  });
  if (buildStats && typeof buildStats === 'object') LANCE_SPEC_CACHE.set(buildStats, spec);
  return spec;
}

function createCandidate() {
  return {
    id: null,
    x: 0,
    y: 0,
    hp: 0,
    radius: 0,
    role: null,
    type: null,
    objectiveType: null,
    threat: 0,
    team: 0,
    executingTelegraph: false,
    objective: false,
    weakPoint: false,
    visible: true,
    dead: false,
  };
}

function copyCandidate(target, entity) {
  target.id = entity.id;
  target.x = entity.x;
  target.y = entity.y;
  target.hp = entity.hp;
  target.radius = entity.radius;
  target.role = entity.role;
  target.type = entity.type;
  target.objectiveType = entity.objectiveType;
  target.threat = entity.threat;
  target.team = entity.team;
  target.executingTelegraph = entity.executingTelegraph;
  target.objective = entity.objective || entity.kind === 'objective';
  target.weakPoint = entity.weakPoint;
  target.visible = entity.opacity > 0;
  target.dead = entity.hp <= 0 || !entity.collidable || entity.invulnerable;
}

export function createWeaponSystem({ maxCandidates = DEFAULT_MAX_CANDIDATES } = {}) {
  const candidateCapacity = clamp(Math.trunc(finite(maxCandidates, DEFAULT_MAX_CANDIDATES)), 1, DEFAULT_MAX_CANDIDATES);
  const candidates = Array.from({ length: candidateCapacity }, createCandidate);
  const candidateRead = createEntityReadTarget();
  const playerRead = createEntityReadTarget();
  const droneRead = Array.from({ length: 4 }, createEntityReadTarget);
  const droneIds = new Float64Array(4);
  const timers = new Float64Array([0, 0.15, 0.45]);
  const weaponShotCounts = new Uint32Array(3);
  const stepShotCounts = new Uint8Array(3);
  let updates = 0;
  let shotsFired = 0;
  let rejectedShots = 0;
  let fireEvents = 0;
  let sequence = 0;
  let lastTargetId = null;
  let wasBuffed = false;
  let lastBuildStats = null;

  function collectCandidates(world, playerTeam) {
    let count = 0;
    for (const kind of TARGET_KINDS) {
      const query = world.query(kind);
      for (let index = 0; index < query.length && count < candidateCapacity; index += 1) {
        const entity = world.readInto(query.at(index), candidateRead);
        if (!entity || entity.hp <= 0 || !entity.collidable || entity.invulnerable) continue;
        if (playerTeam !== 0 && entity.team === playerTeam) continue;
        copyCandidate(candidates[count], entity);
        count += 1;
      }
    }
    return count;
  }

  function ensureDrones(world, player, buildStats) {
    const config = WEAPON_CONFIG['arc-drones'];
    const droneCount = clamp(Math.trunc(finite(buildStats?.droneCount, config.droneCount)), 2, 4);
    for (let index = 0; index < droneCount; index += 1) {
      if (droneIds[index] && world.readInto(droneIds[index], droneRead[index])) continue;
      const angle = index * Math.PI;
      const id = world.spawn('friendlyProjectile', {
        x: player.x + Math.cos(angle) * 1.15,
        y: player.y + Math.sin(angle) * 1.15,
        previousX: player.x,
        previousY: player.y,
        ownerId: player.id,
        ownerKind: 'player',
        team: player.team || 1,
        weaponId: 'arc-drones',
        type: 'arc-drone',
        orbitAngle: angle,
        orbitRadius: 1.15 + index * 0.08,
        speed: 1.9,
        lifetime: 1_000_000_000,
        radius: 0.2,
        collidable: false,
        color: index === 0 ? 0x8af7ff : 0xa56bff,
      });
      droneIds[index] = id ?? 0;
    }
    for (let index = droneCount; index < droneIds.length; index += 1) {
      if (droneIds[index]) world.despawn(droneIds[index]);
      droneIds[index] = 0;
    }
  }

  function clearDrones(world) {
    for (let index = 0; index < droneIds.length; index += 1) {
      if (droneIds[index]) world.despawn(droneIds[index]);
      droneIds[index] = 0;
    }
  }

  function spawnPulse(world, player, target, buildStats, projectileIndex = 0, projectileCount = 1) {
    const config = WEAPON_CONFIG['pulse-cannon'];
    const baseDirection = normalizeDirection(target.x - player.x, target.y - player.y, 0, 1);
    const angle = projectileCount <= 1 ? 0 : (projectileIndex / (projectileCount - 1) - 0.5) * 0.18;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const direction = {
      x: baseDirection.x * cosine - baseDirection.y * sine,
      y: baseDirection.x * sine + baseDirection.y * cosine,
    };
    const speed = config.speed * clamp(finite(buildStats?.projectileSpeedMultiplier, 1), 0.5, 1.5);
    const pierceCount = clamp(Math.trunc(finite(buildStats?.projectilePierce)), 0, 4);
    return world.spawn('friendlyProjectile', {
      x: player.x + direction.x * 0.55,
      y: player.y + direction.y * 0.55,
      previousX: player.x,
      previousY: player.y,
      vx: direction.x * speed,
      vy: direction.y * speed,
      speed,
      maxSpeed: speed,
      turnRate: config.turnRate,
      damage: config.damage * clamp(finite(buildStats?.weaponDamageMultiplier, 1), 0.5, 2.2),
      lifetime: config.lifetime,
      radius: config.radius,
      targetId: target.id,
      ownerId: player.id,
      ownerKind: 'player',
      team: player.team || 1,
      weaponId: 'pulse-cannon',
      type: 'pulse-round',
      homing: true,
      piercing: pierceCount > 0,
      pierceCount,
      hitBudgetRemaining: 1 + pierceCount,
      weakPointMultiplier: clamp(finite(buildStats?.weakPointMultiplier, 1.5), 1, 2.5),
      objectiveDamageMultiplier: clamp(finite(buildStats?.objectiveDamageMultiplier, 1), 1, 1.8),
      collidable: true,
      color: 0x64f5ff,
      sequence: ++sequence,
    });
  }

  function spawnArc(world, player, target, droneIndex, buildStats) {
    const config = WEAPON_CONFIG['arc-drones'];
    const drone = world.readInto(droneIds[droneIndex], droneRead[droneIndex]);
    const originX = drone?.x ?? player.x;
    const originY = drone?.y ?? player.y;
    const direction = normalizeDirection(target.x - originX, target.y - originY, 0, 1);
    const speed = config.speed * clamp(finite(buildStats?.projectileSpeedMultiplier, 1), 0.5, 1.5);
    const chainCount = clamp(Math.trunc(Math.max(
      finite(buildStats?.chainTargets, config.chainCount),
      finite(buildStats?.droneArcTargets, config.chainCount),
    )), 0, 6);
    return world.spawn('friendlyProjectile', {
      x: originX,
      y: originY,
      previousX: originX,
      previousY: originY,
      vx: direction.x * speed,
      vy: direction.y * speed,
      speed,
      maxSpeed: speed,
      turnRate: config.turnRate,
      damage: config.damage * clamp(finite(buildStats?.weaponDamageMultiplier, 1), 0.5, 2.2),
      lifetime: config.lifetime,
      radius: config.radius,
      targetId: target.id,
      ownerId: player.id,
      ownerKind: 'player',
      team: player.team || 1,
      weaponId: 'arc-drones',
      type: 'arc-chain',
      chainCount,
      hitBudgetRemaining: 1,
      chainDamageMultiplier: clamp(finite(buildStats?.chainDamageMultiplier, 0.78), 0.5, 1),
      chainRadius: clamp(finite(buildStats?.propagationRadius, 6), 0, 8),
      weakPointMultiplier: clamp(finite(buildStats?.weakPointMultiplier, 1.5), 1, 2.5),
      objectiveDamageMultiplier: clamp(finite(buildStats?.droneObjectiveDamageMultiplier, 1), 1, 1.4),
      homing: true,
      collidable: true,
      color: droneIndex === 0 ? 0x8af7ff : 0xa56bff,
      sequence: ++sequence,
    });
  }

  function spawnPrism(world, player, target, buildStats) {
    const config = WEAPON_CONFIG['prism-missiles'];
    const direction = normalizeDirection(target.x - player.x, target.y - player.y, 0, 1);
    const speed = config.speed * clamp(finite(buildStats?.projectileSpeedMultiplier, 1), 0.5, 1.5);
    const pierceCount = clamp(Math.trunc(finite(buildStats?.projectilePierce)), 0, 4);
    return world.spawn('friendlyProjectile', {
      x: player.x + direction.x * 0.45,
      y: player.y + direction.y * 0.45,
      previousX: player.x,
      previousY: player.y,
      vx: direction.x * speed,
      vy: direction.y * speed,
      speed,
      maxSpeed: speed,
      turnRate: config.turnRate,
      damage: config.damage * clamp(finite(buildStats?.weaponDamageMultiplier, 1), 0.5, 2.2),
      lifetime: config.lifetime,
      radius: config.radius,
      impactRadius: clamp(finite(buildStats?.missileImpactRadius, 0.75), 0.5, 1.2),
      targetId: target.id,
      ownerId: player.id,
      ownerKind: 'player',
      team: player.team || 1,
      weaponId: 'prism-missiles',
      type: 'prism-missile',
      splitCount: clamp(Math.trunc(finite(buildStats?.missileSplit, config.splitCount)), 3, 5),
      piercing: pierceCount > 0,
      pierceCount,
      hitBudgetRemaining: 1 + pierceCount,
      weakPointMultiplier: clamp(finite(buildStats?.weakPointMultiplier, 1.5), 1, 2.5),
      objectiveDamageMultiplier: clamp(finite(buildStats?.objectiveDamageMultiplier, 1), 1, 1.8),
      splitOnImpact: true,
      homing: true,
      collidable: true,
      color: 0xffd166,
      sequence: ++sequence,
    });
  }

  function registerShot(index, id, counts) {
    if (id == null) {
      rejectedShots += 1;
      return false;
    }
    weaponShotCounts[index] += 1;
    shotsFired += 1;
    counts[index] += 1;
    return true;
  }

  function update(world, playerId, dt, events = null, buildStats = null) {
    if (!world?.query || !world?.readInto || !world?.spawn) throw new TypeError('EntityWorld is required');
    if (!Number.isFinite(dt) || dt <= 0) throw new TypeError('weapon dt must be positive and finite');
    const player = Number.isSafeInteger(playerId) ? world.readInto(playerId, playerRead) : playerId;
    if (!player || !Number.isFinite(player.x) || !Number.isFinite(player.y)) {
      return Object.freeze({ fired: 0, targetId: null, buffed: false });
    }
    const starterWeapon = WEAPON_IDS.includes(buildStats?.starterWeapon) ? buildStats.starterWeapon : 'pulse-cannon';
    if (starterWeapon === 'arc-drones') ensureDrones(world, player, buildStats);
    else clearDrones(world);
    lastBuildStats = buildStats ?? null;
    const candidateCount = collectCandidates(world, player.team);
    const target = candidateCount > 0
      ? selectAutoTarget(player, candidates, {
        maxCandidates: candidateCapacity,
        candidateCount,
        weakPointPriority: buildStats?.weakPointPriority,
      })
      : null;
    const buffed = player.fireTimer > 0 || player.autoFireRateBuffTimer > 0;
    const perfectBuffMultiplier = clamp(finite(buildStats?.perfectFireBuffMultiplier, AUTO_PULSE_BUFF_MULTIPLIER), 0.6, 0.75);
    if (buffed && !wasBuffed) {
      for (let index = 0; index < timers.length; index += 1) {
        timers[index] *= perfectBuffMultiplier;
      }
    }
    wasBuffed = buffed;
    const buildCadence = clamp(finite(buildStats?.fireIntervalMultiplier, 1), 0.55, 1);
    const cadenceMultiplier = (buffed ? perfectBuffMultiplier : 1) * buildCadence;
    const counts = stepShotCounts;
    counts.fill(0);
    for (let index = 0; index < timers.length; index += 1) timers[index] -= dt;
    if (target) {
      let guard = 0;
      while (starterWeapon === 'pulse-cannon' && timers[0] <= EPSILON && guard < 4) {
        const projectileCount = clamp(Math.trunc(finite(buildStats?.pulseProjectiles, 1)), 1, 3);
        for (let projectileIndex = 0; projectileIndex < projectileCount; projectileIndex += 1) {
          registerShot(0, spawnPulse(world, player, target, buildStats, projectileIndex, projectileCount), counts);
        }
        timers[0] += WEAPON_CONFIG['pulse-cannon'].interval * cadenceMultiplier;
        guard += 1;
      }
      guard = 0;
      while (starterWeapon === 'arc-drones' && timers[1] <= EPSILON && guard < 2) {
        const droneCount = clamp(Math.trunc(finite(buildStats?.droneCount, 2)), 2, 4);
        for (let droneIndex = 0; droneIndex < droneCount; droneIndex += 1) {
          registerShot(1, spawnArc(world, player, target, droneIndex, buildStats), counts);
        }
        timers[1] += WEAPON_CONFIG['arc-drones'].interval * cadenceMultiplier;
        guard += 1;
      }
      guard = 0;
      while (starterWeapon === 'prism-missiles' && timers[2] <= EPSILON && guard < 2) {
        registerShot(2, spawnPrism(world, player, target, buildStats), counts);
        timers[2] += WEAPON_CONFIG['prism-missiles'].interval * cadenceMultiplier;
        guard += 1;
      }
    } else {
      for (let index = 0; index < timers.length; index += 1) timers[index] = Math.max(0, timers[index]);
    }
    const total = counts[0] + counts[1] + counts[2];
    if (total > 0) {
      lastTargetId = target?.id ?? null;
      const accepted = events?.emit?.('weaponFire', Object.freeze({
        total,
        targetId: target?.id ?? null,
        buffed,
        counts: Object.freeze({
          'pulse-cannon': counts[0],
          'arc-drones': counts[1],
          'prism-missiles': counts[2],
        }),
      })) ?? false;
      if (accepted) fireEvents += 1;
    }
    updates += 1;
    return Object.freeze({ fired: total, targetId: target?.id ?? null, buffed });
  }

  function reset() {
    timers[0] = 0;
    timers[1] = 0.15;
    timers[2] = 0.45;
    droneIds.fill(0);
    lastTargetId = null;
    wasBuffed = false;
    return true;
  }

  function getStats() {
    return Object.freeze({
      updates,
      shotsFired,
      rejectedShots,
      fireEvents,
      lastTargetId,
      cooldowns: Object.freeze(Object.fromEntries(WEAPON_IDS.map((id, index) => [id, timers[index]]))),
      droneIds: Object.freeze([...droneIds]),
      shotsByWeapon: Object.freeze(Object.fromEntries(WEAPON_IDS.map((id, index) => [id, weaponShotCounts[index]]))),
      lastBuildStats,
    });
  }

  return Object.freeze({ update, reset, getStats });
}
