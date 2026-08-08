import { createEntityReadTarget } from '../game/entity-world.js';
import { AUTO_PULSE_BUFF_MULTIPLIER, PERFECT_PHASE_REFUND } from './player-system.js';

const FRIENDLY_TARGET_KINDS = Object.freeze(['bossPart', 'enemy', 'objective']);
const DEFAULT_OUTCOME_CAPACITY = 512;
const DEFAULT_SPAWN_CAPACITY = 192;
const PERFECT_PHASE_BUFF_SECONDS = 0.8;
const PERFECT_PHASE_COOLDOWN = 0.55 * AUTO_PULSE_BUFF_MULTIPLIER;
const EPSILON = 1e-9;

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function overlaps(left, right) {
  const radius = Math.max(0, finite(left.radius, 0.5)) + Math.max(0, finite(right.radius, 0.5));
  return (left.x - right.x) ** 2 + (left.y - right.y) ** 2 <= radius ** 2 + EPSILON;
}

function overlapsWithRadius(left, right, rightRadius) {
  const radius = Math.max(0, finite(left.radius, 0.5)) + Math.max(0, finite(rightRadius, 0.5));
  return (left.x - right.x) ** 2 + (left.y - right.y) ** 2 <= radius ** 2 + EPSILON;
}

export function sweptCircleHit(projectile, target) {
  const startX = Number(projectile?.previousX);
  const startY = Number(projectile?.previousY);
  const endX = Number(projectile?.x);
  const endY = Number(projectile?.y);
  const targetX = Number(target?.x);
  const targetY = Number(target?.y);
  const radius = Math.max(0, finite(projectile?.radius, 0.5)) + Math.max(0, finite(target?.radius, 0.5));
  if (![startX, startY, endX, endY, targetX, targetY, radius].every(Number.isFinite)) return false;
  const dx = endX - startX;
  const dy = endY - startY;
  const offsetX = targetX - startX;
  const offsetY = targetY - startY;
  if (![dx, dy, offsetX, offsetY].every(Number.isFinite)) return false;
  const scale = Math.max(1, Math.abs(dx), Math.abs(dy), Math.abs(offsetX), Math.abs(offsetY), radius);
  const scaledDx = dx / scale;
  const scaledDy = dy / scale;
  const scaledOffsetX = offsetX / scale;
  const scaledOffsetY = offsetY / scale;
  const scaledRadius = radius / scale;
  const lengthSquared = scaledDx * scaledDx + scaledDy * scaledDy;
  const projection = lengthSquared > 0
    ? clamp((scaledOffsetX * scaledDx + scaledOffsetY * scaledDy) / lengthSquared, 0, 1)
    : 0;
  const nearestX = scaledDx * projection;
  const nearestY = scaledDy * projection;
  const distanceX = scaledOffsetX - nearestX;
  const distanceY = scaledOffsetY - nearestY;
  return distanceX * distanceX + distanceY * distanceY
    <= scaledRadius * scaledRadius + Number.EPSILON * 8;
}

function addUnique(ids, count, id) {
  for (let index = 0; index < count; index += 1) {
    if (ids[index] === id) return count;
  }
  if (count >= ids.length) return count;
  ids[count] = id;
  return count + 1;
}

function containsId(ids, count, id) {
  for (let index = 0; index < count; index += 1) if (ids[index] === id) return true;
  return false;
}

export function createCollisionSystem({
  outcomeCapacity = DEFAULT_OUTCOME_CAPACITY,
  spawnCapacity = DEFAULT_SPAWN_CAPACITY,
} = {}) {
  const outcomes = clamp(Math.trunc(finite(outcomeCapacity, DEFAULT_OUTCOME_CAPACITY)), 8, 4_096);
  const spawns = clamp(Math.trunc(finite(spawnCapacity, DEFAULT_SPAWN_CAPACITY)), 8, 2_048);
  const damageSourceIds = new Float64Array(outcomes);
  const damageTargetIds = new Float64Array(outcomes);
  const damageAmounts = new Float64Array(outcomes);
  const damageWeakPoints = new Uint8Array(outcomes);
  const damageFriendly = new Uint8Array(outcomes);
  const damageWeapons = new Array(outcomes).fill(null);
  const damageTargetKinds = new Array(outcomes).fill(null);
  const despawnIds = new Float64Array(outcomes);
  const targetDespawnIds = new Float64Array(outcomes);
  const spawnX = new Float64Array(spawns);
  const spawnY = new Float64Array(spawns);
  const spawnVx = new Float64Array(spawns);
  const spawnVy = new Float64Array(spawns);
  const spawnDamage = new Float64Array(spawns);
  const spawnOwnerId = new Float64Array(spawns);
  const spawnTargetId = new Float64Array(spawns);
  const spawnTeam = new Uint32Array(spawns);
  const spawnChainCount = new Uint32Array(spawns);
  const spawnColors = new Uint32Array(spawns);
  const spawnTypes = new Array(spawns).fill(null);
  const spawnWeapons = new Array(spawns).fill(null);
  const projectileRead = createEntityReadTarget();
  const targetRead = createEntityReadTarget();
  const targetApplyRead = createEntityReadTarget();
  const playerRead = createEntityReadTarget();
  const pickupRead = createEntityReadTarget();
  const objectiveRead = createEntityReadTarget();
  const hazardRead = createEntityReadTarget();
  const chainRead = createEntityReadTarget();
  const spawnData = {
    x: 0,
    y: 0,
    previousX: 0,
    previousY: 0,
    vx: 0,
    vy: 0,
    speed: 0,
    maxSpeed: 0,
    turnRate: 0,
    damage: 0,
    lifetime: 0,
    radius: 0,
    ownerId: 0,
    targetId: 0,
    team: 0,
    weaponId: null,
    type: null,
    chainCount: 0,
    splitCount: 0,
    homing: false,
    collidable: true,
    color: 0xffffff,
  };
  let resolves = 0;
  let totalHits = 0;
  let totalDamage = 0;
  let totalSpawns = 0;
  let totalDespawns = 0;
  let queueOverflows = 0;
  let hitEvents = 0;

  function queueDamage(state, projectile, target, amount, weakPoint, friendly = true) {
    if (state.damageCount >= outcomes) {
      queueOverflows += 1;
      return false;
    }
    const index = state.damageCount;
    damageSourceIds[index] = projectile.id;
    damageTargetIds[index] = target.id;
    damageAmounts[index] = Math.max(0, amount);
    damageWeakPoints[index] = weakPoint ? 1 : 0;
    damageFriendly[index] = friendly ? 1 : 0;
    damageWeapons[index] = projectile.weaponId;
    damageTargetKinds[index] = target.kind;
    state.damageCount += 1;
    return true;
  }

  function queueSpawn(state, data) {
    if (state.spawnCount >= spawns) {
      queueOverflows += 1;
      return false;
    }
    const index = state.spawnCount;
    spawnX[index] = data.x;
    spawnY[index] = data.y;
    spawnVx[index] = data.vx;
    spawnVy[index] = data.vy;
    spawnDamage[index] = data.damage;
    spawnOwnerId[index] = data.ownerId;
    spawnTargetId[index] = data.targetId ?? 0;
    spawnTeam[index] = data.team;
    spawnChainCount[index] = data.chainCount ?? 0;
    spawnColors[index] = data.color;
    spawnTypes[index] = data.type;
    spawnWeapons[index] = data.weaponId;
    state.spawnCount += 1;
    return true;
  }

  function queueImpactSpawns(state, projectile, target) {
    if (projectile.splitOnImpact && projectile.splitCount > 0) {
      const baseAngle = Math.atan2(projectile.vy, projectile.vx);
      for (let index = 0; index < projectile.splitCount; index += 1) {
        const offset = projectile.splitCount === 1
          ? 0
          : (index / (projectile.splitCount - 1) - 0.5) * 1.15;
        const angle = baseAngle + offset;
        queueSpawn(state, {
          x: projectile.x,
          y: projectile.y,
          vx: Math.cos(angle) * 7.2,
          vy: Math.sin(angle) * 7.2,
          damage: Math.max(0.35, projectile.damage * 0.36),
          ownerId: projectile.ownerId,
          team: projectile.team,
          chainCount: 0,
          color: 0xff9f43,
          type: 'prism-shard',
          weaponId: projectile.weaponId || 'prism-missiles',
        });
      }
    }
    if (projectile.type === 'arc-chain' && projectile.chainCount > 0) {
      queueSpawn(state, {
        x: target.x,
        y: target.y,
        vx: projectile.vx,
        vy: projectile.vy,
        damage: Math.max(0.25, projectile.damage * 0.78),
        ownerId: projectile.ownerId,
        targetId: -target.id,
        team: projectile.team,
        chainCount: projectile.chainCount - 1,
        color: projectile.color || 0x8af7ff,
        type: 'arc-chain',
        weaponId: projectile.weaponId || 'arc-drones',
      });
    }
  }

  function targetCanTakeFriendlyHit(projectile, target) {
    if (!target.collidable || target.hp <= 0 || target.invulnerable) return false;
    if (projectile.team !== 0 && projectile.team === target.team) return false;
    if (target.kind === 'objective' && target.team !== 2) return false;
    return true;
  }

  function collectFriendlyHits(world, state) {
    const query = world.query('friendlyProjectile');
    for (let projectileIndex = 0; projectileIndex < query.length; projectileIndex += 1) {
      const projectile = world.readInto(query.at(projectileIndex), projectileRead);
      if (!projectile || !projectile.collidable || projectile.type === 'arc-drone') continue;
      let hit = false;
      for (const kind of FRIENDLY_TARGET_KINDS) {
        const targets = world.query(kind);
        for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
          const target = world.readInto(targets.at(targetIndex), targetRead);
          if (!target || !targetCanTakeFriendlyHit(projectile, target) || !sweptCircleHit(projectile, target)) continue;
          const armoredBossPart = target.kind === 'bossPart' && (target.armored || !target.weakPoint);
          const armoredEnemy = target.kind === 'enemy' && target.armored && !target.weakPoint;
          if (!armoredBossPart && !armoredEnemy) {
            const multiplier = target.kind === 'bossPart' && target.weakPoint ? 1.5 : 1;
            queueDamage(state, projectile, target, projectile.damage * multiplier, target.weakPoint);
          }
          queueImpactSpawns(state, projectile, target);
          hit = true;
          if (!projectile.piercing || projectile.pierceCount === 0) break;
        }
        if (hit && (!projectile.piercing || projectile.pierceCount === 0)) break;
      }
      if (hit && (!projectile.piercing || projectile.pierceCount === 0)) {
        state.despawnCount = addUnique(despawnIds, state.despawnCount, projectile.id);
      } else if (hit && projectile.pierceCount > 0) {
        world.write(projectile.id, { pierceCount: projectile.pierceCount - 1 });
      }
    }
  }

  function applyPerfectPhase(world, player, events) {
    const refundIndex = player.dashCharge0 <= player.dashCharge1 ? 0 : 1;
    const charges = [player.dashCharge0, player.dashCharge1];
    const before = charges[refundIndex];
    charges[refundIndex] = clamp(before + PERFECT_PHASE_REFUND, 0, 1);
    const cooldown = player.cooldown > 0
      ? Math.min(player.cooldown * AUTO_PULSE_BUFF_MULTIPLIER, PERFECT_PHASE_COOLDOWN)
      : PERFECT_PHASE_COOLDOWN;
    world.write(player.id, {
      perfectPhaseWindow: 0,
      phaseTimer: Math.max(player.phaseTimer, 0.08),
      fireTimer: Math.max(player.fireTimer, PERFECT_PHASE_BUFF_SECONDS),
      cooldown,
      dashCharges: charges,
      invulnerable: true,
    });
    events?.emit?.('perfectPhase', Object.freeze({
      refundIndex,
      refunded: charges[refundIndex] - before,
      fireRateMultiplier: AUTO_PULSE_BUFF_MULTIPLIER,
      duration: PERFECT_PHASE_BUFF_SECONDS,
    }));
  }

  function collectPlayerHits(world, state, player, events) {
    let perfectAvailable = player.perfectPhaseWindow > 0;
    let phaseProtected = player.invulnerable;
    const projectiles = world.query('enemyProjectile');
    for (let index = 0; index < projectiles.length; index += 1) {
      const projectile = world.readInto(projectiles.at(index), projectileRead);
      if (!projectile || !projectile.collidable
        || containsId(despawnIds, state.despawnCount, projectile.id)
        || !sweptCircleHit(projectile, player)) continue;
      state.despawnCount = addUnique(despawnIds, state.despawnCount, projectile.id);
      if (perfectAvailable) {
        applyPerfectPhase(world, player, events);
        perfectAvailable = false;
        phaseProtected = true;
        state.perfectPhases += 1;
      } else if (!phaseProtected) {
        state.playerDamage += Math.max(0, projectile.damage || 1);
      }
    }
    const enemies = world.query('enemy');
    for (let index = 0; index < enemies.length; index += 1) {
      const enemy = world.readInto(enemies.at(index), targetRead);
      if (!enemy || !enemy.collidable || !enemy.contactDamaging || enemy.hp <= 0) continue;
      if (!overlapsWithRadius(player, enemy, enemy.contactRadius > 0 ? enemy.contactRadius : enemy.radius)) continue;
      if (perfectAvailable) {
        applyPerfectPhase(world, player, events);
        perfectAvailable = false;
        phaseProtected = true;
        state.perfectPhases += 1;
      } else if (!phaseProtected) {
        state.playerDamage += Math.max(0, enemy.damage || 1);
      }
    }
    const objectives = world.query('objective');
    for (let index = 0; index < objectives.length; index += 1) {
      const hazard = world.readInto(objectives.at(index), objectiveRead);
      if (!hazard || !hazard.collidable || !hazard.contactDamaging || hazard.team !== 2) continue;
      if (!overlapsWithRadius(player, hazard, hazard.contactRadius > 0 ? hazard.contactRadius : hazard.radius)) continue;
      if (perfectAvailable) {
        applyPerfectPhase(world, player, events);
        perfectAvailable = false;
        phaseProtected = true;
        state.perfectPhases += 1;
      } else if (!phaseProtected) {
        state.playerDamage += Math.max(0, hazard.damage || 1);
      }
      break;
    }
    const hazards = world.query('enemyHazard');
    for (let index = 0; index < hazards.length; index += 1) {
      const hazard = world.readInto(hazards.at(index), hazardRead);
      if (!hazard || !hazard.collidable || !hazard.contactDamaging || hazard.team !== 2) continue;
      if (!overlapsWithRadius(player, hazard, hazard.contactRadius > 0 ? hazard.contactRadius : hazard.radius)) continue;
      if (perfectAvailable) {
        applyPerfectPhase(world, player, events);
        perfectAvailable = false;
        phaseProtected = true;
        state.perfectPhases += 1;
      } else if (!phaseProtected) {
        state.playerDamage += Math.max(0, hazard.damage || 1);
      }
      break;
    }
  }

  function collectEnemyObjectiveHits(world, state) {
    const projectiles = world.query('enemyProjectile');
    const objectives = world.query('objective');
    for (let projectileIndex = 0; projectileIndex < projectiles.length; projectileIndex += 1) {
      const projectile = world.readInto(projectiles.at(projectileIndex), projectileRead);
      if (!projectile || !projectile.collidable) continue;
      for (let targetIndex = 0; targetIndex < objectives.length; targetIndex += 1) {
        const objective = world.readInto(objectives.at(targetIndex), objectiveRead);
        if (!objective || !objective.collidable || objective.hp <= 0 || objective.invulnerable) continue;
        if (objective.team !== 1 || !sweptCircleHit(projectile, objective)) continue;
        queueDamage(state, projectile, objective, projectile.damage || 1, false, false);
        state.despawnCount = addUnique(despawnIds, state.despawnCount, projectile.id);
        break;
      }
    }
  }

  function collectPickupsAndObjectives(world, state, player, dt, events) {
    const pickups = world.query('pickup');
    let pickupValue = 0;
    for (let index = 0; index < pickups.length; index += 1) {
      const pickup = world.readInto(pickups.at(index), pickupRead);
      if (!pickup || !pickup.collidable || !overlaps(player, pickup)) continue;
      state.despawnCount = addUnique(despawnIds, state.despawnCount, pickup.id);
      state.pickups += 1;
      pickupValue += pickup.value;
      state.pickupSourceIds.push(pickup.sourceId || pickup.id);
    }
    if (state.pickups > 0) events?.emit?.('pickupCollected', Object.freeze({
      count: state.pickups, value: pickupValue, ids: Object.freeze([...state.pickupSourceIds]),
    }));

    const objectives = world.query('objective');
    for (let index = 0; index < objectives.length; index += 1) {
      const objective = world.readInto(objectives.at(index), objectiveRead);
      if (!objective || !objective.collidable || objective.completed || objective.team === 2
        || !overlaps(player, objective)) continue;
      const progress = objective.progress + dt;
      const completed = objective.duration > 0 && progress >= objective.duration - EPSILON;
      world.write(objective.id, {
        progress: objective.duration > 0 ? Math.min(objective.duration, progress) : progress,
        completed,
        state: completed ? 'completed' : objective.state,
        collidable: completed ? false : objective.collidable,
      });
      state.objectiveOverlaps += 1;
      if (completed) {
        const record = Object.freeze({ id: objective.sourceId || objective.id, type: objective.objectiveType });
        state.objectiveCompletions.push(record);
        events?.emit?.('objectiveCompleted', record);
      }
    }
  }

  function applyDamage(world, state) {
    const records = [];
    const byWeapon = Object.create(null);
    let destroyed = 0;
    let appliedDamage = 0;
    let friendlyHits = 0;
    let friendlyDamage = 0;
    let friendlyDestroyed = 0;
    for (let index = 0; index < state.damageCount; index += 1) {
      const target = world.readInto(damageTargetIds[index], targetApplyRead);
      if (!target || target.hp <= 0) continue;
      const amount = Math.min(target.hp, damageAmounts[index]);
      const hpAfter = Math.max(0, target.hp - amount);
      const executionProtected = hpAfter <= 0 && target.kind === 'enemy' && target.executingTelegraph;
      world.write(target.id, {
        hp: hpAfter,
        state: hpAfter <= 0 ? (executionProtected ? target.state : 'destroyed') : target.state,
      });
      if (hpAfter <= 0 && !executionProtected) {
        state.targetDespawnCount = addUnique(targetDespawnIds, state.targetDespawnCount, target.id);
        destroyed += 1;
      }
      const weaponId = damageWeapons[index] || 'unknown';
      if (damageFriendly[index] === 1) {
        byWeapon[weaponId] = (byWeapon[weaponId] ?? 0) + 1;
        friendlyHits += 1;
        friendlyDamage += amount;
        if (hpAfter <= 0 && !executionProtected) friendlyDestroyed += 1;
      }
      appliedDamage += amount;
      records.push(Object.freeze({
        sourceId: damageSourceIds[index],
        targetId: target.id,
        targetSourceId: target.sourceId || null,
        targetKind: damageTargetKinds[index],
        weaponId,
        amount,
        hpBefore: target.hp,
        hpAfter,
        destroyed: hpAfter <= 0 && !executionProtected,
        executionProtected,
        weakPoint: damageWeakPoints[index] === 1,
      }));
    }
    return {
      records,
      byWeapon,
      destroyed,
      appliedDamage,
      friendlyHits,
      friendlyDamage,
      friendlyDestroyed,
    };
  }

  function findChainTarget(world, x, y, excludedId, team) {
    let bestId = 0;
    let bestDistance = Infinity;
    for (const kind of ['bossPart', 'enemy']) {
      const query = world.query(kind);
      for (let index = 0; index < query.length; index += 1) {
        const target = world.readInto(query.at(index), chainRead);
        if (!target || target.id === excludedId || target.hp <= 0 || !target.collidable || target.invulnerable) continue;
        if (team !== 0 && target.team === team) continue;
        const distance = Math.hypot(target.x - x, target.y - y);
        if (distance > 6 || distance > bestDistance + EPSILON) continue;
        if (distance < bestDistance - EPSILON || target.id < bestId || bestId === 0) {
          bestId = target.id;
          bestDistance = distance;
        }
      }
    }
    return bestId;
  }

  function applySpawns(world, state) {
    let spawned = 0;
    for (let index = 0; index < state.spawnCount; index += 1) {
      let targetId = spawnTargetId[index];
      if (targetId < 0) targetId = findChainTarget(world, spawnX[index], spawnY[index], -targetId, spawnTeam[index]);
      if (spawnTypes[index] === 'arc-chain' && targetId === 0) continue;
      let vx = spawnVx[index];
      let vy = spawnVy[index];
      if (spawnTypes[index] === 'arc-chain' && targetId) {
        const target = world.readInto(targetId, chainRead);
        if (target) {
          const length = Math.hypot(target.x - spawnX[index], target.y - spawnY[index]) || 1;
          vx = ((target.x - spawnX[index]) / length) * 15;
          vy = ((target.y - spawnY[index]) / length) * 15;
        }
      }
      spawnData.x = spawnX[index];
      spawnData.y = spawnY[index];
      spawnData.previousX = spawnX[index];
      spawnData.previousY = spawnY[index];
      spawnData.vx = vx;
      spawnData.vy = vy;
      spawnData.speed = Math.hypot(vx, vy);
      spawnData.maxSpeed = spawnData.speed;
      spawnData.turnRate = spawnTypes[index] === 'arc-chain' ? 8 : 0;
      spawnData.damage = spawnDamage[index];
      spawnData.lifetime = spawnTypes[index] === 'arc-chain' ? 0.8 : 0.75;
      spawnData.radius = spawnTypes[index] === 'arc-chain' ? 0.14 : 0.12;
      spawnData.ownerId = spawnOwnerId[index];
      spawnData.targetId = targetId;
      spawnData.team = spawnTeam[index];
      spawnData.weaponId = spawnWeapons[index];
      spawnData.type = spawnTypes[index];
      spawnData.chainCount = spawnChainCount[index];
      spawnData.splitCount = 0;
      spawnData.homing = spawnTypes[index] === 'arc-chain';
      spawnData.color = spawnColors[index];
      if (world.spawn('friendlyProjectile', spawnData) != null) spawned += 1;
    }
    return spawned;
  }

  function resolve(world, session, dt, events = null) {
    if (!world?.query || !world?.readInto || !world?.write || !world?.spawn || !world?.despawn) {
      throw new TypeError('EntityWorld is required');
    }
    if (!Number.isFinite(dt) || dt <= 0) throw new TypeError('collision dt must be positive and finite');
    const state = {
      damageCount: 0,
      despawnCount: 0,
      targetDespawnCount: 0,
      spawnCount: 0,
      playerDamage: 0,
      perfectPhases: 0,
      pickups: 0,
      objectiveOverlaps: 0,
      pickupSourceIds: [],
      objectiveCompletions: [],
    };
    collectFriendlyHits(world, state);
    collectEnemyObjectiveHits(world, state);
    const playerId = world.query('player').at(0);
    const player = Number.isSafeInteger(playerId) ? world.readInto(playerId, playerRead) : null;
    if (player?.collidable) {
      collectPlayerHits(world, state, player, events);
      collectPickupsAndObjectives(world, state, player, dt, events);
    }
    const damage = applyDamage(world, state);
    let weaponHitEventEmitted = false;
    if (damage.friendlyHits > 0) {
      const accepted = events?.emit?.('weaponHit', Object.freeze({
        count: damage.friendlyHits,
        totalDamage: damage.friendlyDamage,
        destroyed: damage.friendlyDestroyed,
        byWeapon: Object.freeze({ ...damage.byWeapon }),
      })) ?? false;
      if (accepted) {
        hitEvents += 1;
        weaponHitEventEmitted = true;
      }
    }
    if (state.playerDamage > 0) {
      session?.damageHull?.(state.playerDamage);
      events?.emit?.('player:damaged', Object.freeze({ amount: state.playerDamage }));
    }
    let despawned = 0;
    for (let index = 0; index < state.despawnCount; index += 1) {
      if (world.despawn(despawnIds[index])) despawned += 1;
    }
    for (let index = 0; index < state.targetDespawnCount; index += 1) {
      if (world.despawn(targetDespawnIds[index])) despawned += 1;
    }
    const spawned = applySpawns(world, state);
    const summary = Object.freeze({
      hits: damage.records.length,
      damage: damage.appliedDamage,
      destroyed: damage.destroyed,
      despawned,
      deferredSpawns: spawned,
      playerDamage: state.playerDamage,
      perfectPhases: state.perfectPhases,
      pickups: state.pickups,
      objectiveOverlaps: state.objectiveOverlaps,
      pickupSourceIds: Object.freeze([...state.pickupSourceIds]),
      objectiveCompletions: Object.freeze([...state.objectiveCompletions]),
      weaponHitEventEmitted,
      damageRecords: Object.freeze(damage.records),
    });
    resolves += 1;
    totalHits += summary.hits;
    totalDamage += summary.damage;
    totalSpawns += spawned;
    totalDespawns += despawned;
    return summary;
  }

  function reset() {
    damageWeapons.fill(null);
    damageTargetKinds.fill(null);
    spawnTypes.fill(null);
    spawnWeapons.fill(null);
    return true;
  }

  function getStats() {
    return Object.freeze({ resolves, totalHits, totalDamage, totalSpawns, totalDespawns, queueOverflows, hitEvents });
  }

  return Object.freeze({ resolve, reset, getStats });
}

const defaultCollisionSystem = createCollisionSystem();

export function resolveCollisions(world, session, dt, events) {
  return defaultCollisionSystem.resolve(world, session, dt, events);
}
