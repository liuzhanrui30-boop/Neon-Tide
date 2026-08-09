import { createEntityReadTarget } from '../game/entity-world.js';
import { ABYSS_MAW } from '../content/bosses/abyss-maw.js';

const TAU = Math.PI * 2;
const EPSILON = 1e-9;
const OWNED_KINDS = Object.freeze(['bossPart', 'enemy', 'enemyProjectile', 'warning', 'enemyHazard']);
const PHASE_ORDER = Object.freeze(['hunt', 'suction', 'weakPoints', 'enraged']);
const ROUTE_SAMPLE_CAPACITY = 64;

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function cloneFrozen(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(cloneFrozen));
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, cloneFrozen(entry)]),
  ));
}

function emit(events, type, payload) {
  events?.emit?.(type, cloneFrozen(payload));
}

function normalized(x, y, fallbackX = 1, fallbackY = 0) {
  const length = Math.hypot(x, y);
  if (length > EPSILON) return { x: x / length, y: y / length };
  const fallbackLength = Math.hypot(fallbackX, fallbackY);
  return fallbackLength > EPSILON
    ? { x: fallbackX / fallbackLength, y: fallbackY / fallbackLength }
    : { x: 1, y: 0 };
}

function angularDelta(previous, current) {
  let delta = (current - previous) % TAU;
  if (delta > Math.PI) delta -= TAU;
  if (delta < -Math.PI) delta += TAU;
  return delta;
}

function hitLineCircle(originX, originY, directionX, directionY, length, halfWidth, target) {
  const offsetX = target.x - originX;
  const offsetY = target.y - originY;
  const along = offsetX * directionX + offsetY * directionY;
  if (along < 0 || along > length) return false;
  const perpendicular = Math.abs(offsetX * directionY - offsetY * directionX);
  return perpendicular <= halfWidth + Math.max(0, finite(target.radius, 0.5));
}

function bossObjective(definition, targetDurationSeconds) {
  const timeout = Math.max(0.1, finite(targetDurationSeconds, 100));
  return {
    id: `${definition.id}:objective`,
    templateId: definition.id,
    type: 'boss',
    label: definition.label,
    status: 'active',
    completed: false,
    failed: false,
    failureReason: null,
    elapsed: 0,
    timeout,
    timeoutRemaining: timeout,
    progress: 0,
    target: 100,
    progressRatio: 0,
    phase: 'hunt',
    arena: { ...definition.arena },
    safeZone: null,
    cleanup: [...definition.cleanupKinds],
    bossId: definition.id,
    stability: definition.phases.hunt.stability,
    maxStability: definition.phases.hunt.stability,
    destroyedOrgans: 0,
    organCount: definition.phases.weakPoints.organCount,
  };
}

function validateDefinition(definition) {
  if (!definition || definition.id !== 'abyss-maw') {
    throw new TypeError('BossSystem currently requires the Abyss Maw definition');
  }
  if (!PHASE_ORDER.every((phase) => definition.phases?.[phase])) {
    throw new TypeError('Boss definition must include hunt, suction, weakPoints, and enraged');
  }
  return definition;
}

export function createBossSystem({ seed = 0, mode = 'standard' } = {}) {
  if (!Number.isFinite(Number(seed))) throw new TypeError('Boss seed must be finite');
  if (!['standard', 'abyss'].includes(mode)) throw new TypeError('Boss mode must be standard or abyss');
  let definition = null;
  let objective = null;
  let worldReference = null;
  let phase = 'idle';
  let phaseElapsed = 0;
  let elapsed = 0;
  let attackTimer = 0;
  let attackCursor = 0;
  let bodyId = 0;
  let spawned = false;
  const organIds = new Float64Array(3);
  const organDestroyed = new Uint8Array(3);
  const organHp = new Float64Array(3);
  let stability = 0;
  let routeBreaks = 0;
  let suctionCrossings = 0;
  let suctionSucceeded = false;
  let arenaCenterX = 0;
  let arenaCenterY = 0;
  let lastPlayerX = 0;
  let lastPlayerY = 0;
  let lastRadius = 0;
  let lastOrbitRadius = 0;
  let lastAngle = 0;
  let lastQuadrant = -1;
  let routeInitialized = false;
  let lastLanceToken = 0;
  let orbitDirection = 0;
  let orbitConsistentSeconds = 0;
  let orbitCounterCooldown = 0;
  let orbitCounterTriggers = 0;
  const routeX = new Float64Array(ROUTE_SAMPLE_CAPACITY);
  const routeY = new Float64Array(ROUTE_SAMPLE_CAPACITY);
  let routeCursor = 0;
  let routeCount = 0;
  const attacksSeen = new Set();
  const attackCounts = {
    telegraph: 0, active: 0, jelly: 0, bite: 0, tentacle: 0, current: 0, projectile: 0,
  };
  let clean = false;
  let cleanupReason = null;
  let updates = 0;
  let maxOwnedEntityCount = 0;
  const read = createEntityReadTarget();
  const playerRead = createEntityReadTarget();

  function ownedCount(world) {
    if (!world?.query) return 0;
    let count = 0;
    for (const kind of OWNED_KINDS) {
      const query = world.query(kind);
      for (let index = 0; index < query.length; index += 1) {
        const entity = world.readInto(query.at(index), read);
        if (entity?.ownerKind === 'boss') count += 1;
      }
    }
    return count;
  }

  function spawn(world, kind, data) {
    const id = world.spawn(kind, { ...data, ownerKind: 'boss' });
    return id ?? 0;
  }

  function setObjectiveProgress() {
    if (!objective) return;
    let ratio = 0;
    if (phase === 'hunt') ratio = 0.2 * (1 - stability / Math.max(1, definition.phases.hunt.stability));
    else if (phase === 'suction') {
      ratio = 0.2 + 0.2 * clamp(
        suctionCrossings / definition.phases.suction.gate.requiredCrossings,
        0,
        1,
      );
    } else if (phase === 'weakPoints') {
      ratio = 0.4 + 0.4 * (organDestroyed.reduce((sum, value) => sum + value, 0) / organDestroyed.length);
    } else if (phase === 'enraged') {
      const body = worldReference?.readInto?.(bodyId, read);
      ratio = 0.8 + 0.2 * (1 - clamp(finite(body?.hp, definition.phases.enraged.coreHp)
        / definition.phases.enraged.coreHp, 0, 1));
    } else if (phase === 'complete') ratio = 1;
    objective.phase = phase;
    objective.stability = stability;
    objective.destroyedOrgans = organDestroyed.reduce((sum, value) => sum + value, 0);
    objective.progressRatio = clamp(ratio, 0, 1);
    objective.progress = objective.progressRatio * objective.target;
  }

  function publishPhase(events) {
    emit(events, 'boss:state', {
      bossId: definition.id,
      phase,
      stability,
      destroyedOrgans: organDestroyed.reduce((sum, value) => sum + value, 0),
      organCount: organDestroyed.length,
      arenaCenter: { x: arenaCenterX, y: arenaCenterY },
    });
    emit(events, 'boss:music-layer', {
      bossId: definition.id,
      phase,
      layer: definition.musicLayers[phase] ?? null,
    });
  }

  function spawnBody(world) {
    bodyId = spawn(world, 'bossPart', {
      x: arenaCenterX,
      y: arenaCenterY,
      hp: definition.phases.enraged.coreHp,
      maxHp: definition.phases.enraged.coreHp,
      radius: definition.silhouette.bodyRadius,
      scale: definition.silhouette.bodyRadius,
      scaleX: 1.25,
      scaleY: 0.86,
      team: 2,
      role: 'boss',
      type: 'abyss-maw-body',
      partId: 'body',
      threat: 100,
      invulnerable: true,
      collidable: true,
      weakPoint: false,
      armored: true,
      color: definition.silhouette.bodyColor,
    });
  }

  function spawnOrgans(world) {
    for (let index = 0; index < organIds.length; index += 1) {
      const angle = -Math.PI / 2 + index * TAU / organIds.length;
      organHp[index] = definition.phases.weakPoints.organHp;
      organIds[index] = spawn(world, 'bossPart', {
        x: arenaCenterX + Math.cos(angle) * 2.15,
        y: arenaCenterY + Math.sin(angle) * 1.65,
        hp: organHp[index],
        maxHp: organHp[index],
        radius: 0.58,
        scale: 0.58,
        team: 2,
        role: 'boss',
        type: 'abyss-maw-organ',
        partId: `organ-${index + 1}`,
        variantIndex: index,
        threat: 96 - index,
        invulnerable: true,
        collidable: true,
        weakPoint: true,
        armored: false,
        opacity: 0.26,
        color: definition.silhouette.organColor,
      });
    }
  }

  function ensureSpawned(world, events) {
    if (spawned) return;
    spawnBody(world);
    spawnOrgans(world);
    spawned = true;
    emit(events, 'boss:spawned', {
      bossId: definition.id,
      bodyId,
      organIds: [...organIds],
      silhouette: definition.silhouette,
    });
    publishPhase(events);
  }

  function transition(nextPhase, world, events) {
    if (phase === nextPhase || clean) return false;
    phase = nextPhase;
    phaseElapsed = 0;
    attackTimer = 0;
    if (phase === 'weakPoints') {
      arenaCenterX = definition.phases.weakPoints.shiftedCenter.x;
      arenaCenterY = definition.phases.weakPoints.shiftedCenter.y;
      world.write(bodyId, {
        x: arenaCenterX, y: arenaCenterY, invulnerable: true, armored: true,
        color: definition.silhouette.bodyColor,
      });
    } else if (phase === 'enraged') {
      arenaCenterX = definition.phases.enraged.shiftedCenter.x;
      arenaCenterY = definition.phases.enraged.shiftedCenter.y;
      world.write(bodyId, {
        x: arenaCenterX, y: arenaCenterY,
        hp: definition.phases.enraged.coreHp,
        maxHp: definition.phases.enraged.coreHp,
        invulnerable: false, armored: false, weakPoint: true,
        color: definition.silhouette.enragedColor,
      });
      for (const id of organIds) if (id) world.despawn(id);
    }
    setObjectiveProgress();
    publishPhase(events);
    emit(events, 'boss:phase-changed', { bossId: definition.id, phase });
    return true;
  }

  function quadrant(x, y) {
    if (x >= arenaCenterX && y >= arenaCenterY) return 0;
    if (x < arenaCenterX && y >= arenaCenterY) return 1;
    if (x < arenaCenterX && y < arenaCenterY) return 2;
    return 3;
  }

  function triggerOrbitCounter(world, player, events) {
    if (orbitCounterCooldown > 0) return;
    orbitCounterTriggers += 1;
    orbitCounterCooldown = 5.5;
    const angle = Math.atan2(player.y - arenaCenterY, player.x - arenaCenterX) + Math.PI;
    const gap = angle + (orbitDirection || 1) * 0.75;
    for (let index = 0; index < 10; index += 1) {
      const nodeAngle = angle + index * TAU / 10;
      if (Math.abs(angularDelta(gap, nodeAngle)) < 0.42) continue;
      spawn(world, 'warning', {
        x: arenaCenterX + Math.cos(nodeAngle) * 6.3,
        y: arenaCenterY + Math.sin(nodeAngle) * 4.2,
        radius: 0.45,
        scale: 0.7,
        team: 2,
        ownerId: bodyId,
        attackKind: 'orbit-counter',
        state: 'telegraph',
        duration: 0.8,
        lifetime: 0.8,
        opacity: 0.85,
        collidable: false,
        color: 0xffc857,
      });
    }
    emit(events, 'boss:orbit-counter', { bossId: definition.id, gapAngle: gap, trigger: orbitCounterTriggers });
  }

  function sampleRoute(world, player, dt, events) {
    const x = finite(player?.x);
    const y = finite(player?.y);
    const offsetX = x - arenaCenterX;
    const offsetY = y - arenaCenterY;
    const radius = Math.hypot(offsetX, offsetY);
    const orbitRadius = Math.hypot(
      offsetX / Math.max(1, definition.arena.halfWidth - 1.3),
      offsetY / Math.max(1, definition.arena.halfHeight - 1.7),
    );
    const angle = Math.atan2(offsetY, offsetX);
    const currentQuadrant = quadrant(x, y);
    routeX[routeCursor] = x;
    routeY[routeCursor] = y;
    routeCursor = (routeCursor + 1) % ROUTE_SAMPLE_CAPACITY;
    routeCount = Math.min(ROUTE_SAMPLE_CAPACITY, routeCount + 1);

    if (routeInitialized) {
      const radiusDelta = Math.abs(radius - lastRadius);
      const moved = Math.hypot(x - lastPlayerX, y - lastPlayerY);
      const changedQuadrant = currentQuadrant !== lastQuadrant;
      const crossedCenter = radius < 2.25 && lastRadius > 4.5;
      if (moved > 1.2 && (radiusDelta > 1.8 || changedQuadrant || crossedCenter)) {
        routeBreaks += 1;
        if (phase === 'hunt') stability = Math.max(0, stability - definition.phases.hunt.routeBreakDamage);
        if (phase === 'suction' && (radius < definition.phases.suction.centerRadius || changedQuadrant)) {
          suctionCrossings += 1;
        }
      }

      const delta = angularDelta(lastAngle, angle);
      const direction = Math.sign(delta);
      const stableOuterOrbit = orbitRadius > 0.82 && Math.abs(orbitRadius - lastOrbitRadius) < 0.08
        && direction !== 0 && (orbitDirection === 0 || direction === orbitDirection);
      if (stableOuterOrbit) {
        orbitDirection = direction;
        orbitConsistentSeconds += dt;
        if (orbitConsistentSeconds >= 3.5) {
          triggerOrbitCounter(world, player, events);
          orbitConsistentSeconds = 0;
        }
      } else {
        orbitConsistentSeconds = Math.max(0, orbitConsistentSeconds - dt * 2);
        if (radius < 6.5 || radiusDelta > 1.2) orbitDirection = direction;
      }
    }
    routeInitialized = true;
    lastPlayerX = x;
    lastPlayerY = y;
    lastRadius = radius;
    lastOrbitRadius = orbitRadius;
    lastAngle = angle;
    lastQuadrant = currentQuadrant;
    orbitCounterCooldown = Math.max(0, orbitCounterCooldown - dt);
  }

  function applyTideLance(world, player, events) {
    if (player?.attackKind !== 'tide-lance' || player.sequence === lastLanceToken) return;
    lastLanceToken = player.sequence;
    const direction = normalized(player.directionX, player.directionY, 0, 1);
    if (phase === 'hunt') {
      const body = world.readInto(bodyId, read);
      if (body && hitLineCircle(player.x, player.y, direction.x, direction.y, 7.2, 0.35, body)) {
        stability = Math.max(0, stability - definition.phases.hunt.tideLanceDamage);
        emit(events, 'boss:stability-hit', {
          bossId: definition.id, weaponId: 'tide-lance', amount: definition.phases.hunt.tideLanceDamage,
        });
      }
    }
  }

  function applySuction(world, player, dt, applyPlayerForce = null) {
    if (phase !== 'suction' || !Number.isSafeInteger(player?.id)) return;
    const dx = arenaCenterX - player.x;
    const dy = arenaCenterY - player.y;
    const direction = normalized(dx, dy);
    const acceleration = definition.phases.suction.pullAcceleration * dt;
    const forceX = direction.x * acceleration;
    const forceY = direction.y * acceleration;
    world.write(player.id, { vx: player.vx + forceX, vy: player.vy + forceY });
    applyPlayerForce?.(forceX, forceY);
  }

  function moveOrgans(world, player) {
    if (phase !== 'weakPoints') return;
    const exposureRadius = definition.phases.weakPoints.exposureRadius;
    const exposed = Math.hypot(player.x - arenaCenterX, player.y - arenaCenterY) <= exposureRadius;
    for (let index = 0; index < organIds.length; index += 1) {
      if (organDestroyed[index] || !organIds[index]) continue;
      const angle = phaseElapsed * (index % 2 ? -0.42 : 0.42) - Math.PI / 2 + index * TAU / organIds.length;
      world.write(organIds[index], {
        previousX: arenaCenterX + Math.cos(angle - 0.02) * 2.15,
        previousY: arenaCenterY + Math.sin(angle - 0.02) * 1.65,
        x: arenaCenterX + Math.cos(angle) * 2.15,
        y: arenaCenterY + Math.sin(angle) * 1.65,
        invulnerable: !exposed,
        opacity: exposed ? 1 : 0.32,
      });
    }
  }

  function updateJellies(world, player, dt) {
    const enemies = world.query('enemy');
    for (let index = 0; index < enemies.length; index += 1) {
      const jelly = world.readInto(enemies.at(index), read);
      if (!jelly || jelly.ownerKind !== 'boss' || jelly.type !== 'abyss-jelly') continue;
      const direction = normalized(player.x - jelly.x, player.y - jelly.y);
      const turn = 1 - Math.exp(-4.2 * dt);
      const speed = definition.attacks.trackingJelly.speed * (mode === 'abyss' ? 1.18 : 1);
      const vx = jelly.vx * (1 - turn) + direction.x * speed * turn;
      const vy = jelly.vy * (1 - turn) + direction.y * speed * turn;
      const age = jelly.age + dt;
      if (age >= jelly.lifetime) {
        world.despawn(jelly.id);
        continue;
      }
      let stateTimer = Math.max(0, jelly.stateTimer - dt);
      if (stateTimer <= EPSILON && world.query('enemyProjectile').length < 24) {
        const shotDirection = normalized(
          player.x + player.vx * 0.28 - jelly.x,
          player.y + player.vy * 0.28 - jelly.y,
        );
        const shotSpeed = mode === 'abyss' ? 5.4 : 4.8;
        if (spawn(world, 'enemyProjectile', {
          x: jelly.x, y: jelly.y, previousX: jelly.x, previousY: jelly.y,
          vx: shotDirection.x * shotSpeed, vy: shotDirection.y * shotSpeed,
          speed: shotSpeed, maxSpeed: shotSpeed, turnRate: 1.1,
          damage: 0.18, lifetime: 3.2, radius: 0.18,
          targetId: player.id, ownerId: jelly.id,
          team: 2, attackKind: 'tracking-jelly', type: 'abyss-jelly-bolt',
          homing: true, collidable: true, color: 0xd9ff61,
        })) attackCounts.projectile += 1;
        stateTimer = mode === 'abyss' ? 0.9 : 1.2;
      }
      world.write(jelly.id, {
        previousX: jelly.x, previousY: jelly.y,
        x: jelly.x + vx * dt, y: jelly.y + vy * dt,
        vx, vy, age, stateTimer,
      });
    }
  }

  function spawnActiveFromWarning(world, warning) {
    if (warning.attackKind === 'tentacle-fan') {
      spawn(world, 'enemyHazard', {
        x: warning.x, y: warning.y, rotation: warning.rotation,
        scaleX: warning.scaleX, scaleY: warning.scaleY,
        radius: 0.5, contactRadius: 0.68,
        team: 2, ownerId: bodyId, attackKind: 'tentacle-fan', state: 'active',
        damage: 0.45, contactDamaging: true, collidable: true,
        age: 0, lifetime: definition.attacks.tentacleFan.activeSeconds,
        color: 0x7df6ff,
      });
    } else if (warning.attackKind === 'bite-zone') {
      spawn(world, 'enemyHazard', {
        x: warning.x, y: warning.y, rotation: warning.rotation,
        scaleX: warning.scaleX, scaleY: warning.scaleY,
        radius: definition.attacks.biteZone.halfHeight,
        contactRadius: definition.attacks.biteZone.halfHeight,
        team: 2, ownerId: bodyId, attackKind: 'bite-zone', state: 'closed',
        damage: definition.attacks.biteZone.damage, contactDamaging: true, collidable: true,
        age: 0, lifetime: definition.attacks.biteZone.activeSeconds,
        color: 0xffc857,
      });
    } else if (warning.attackKind === 'tracking-jelly') {
      const angle = Math.atan2(warning.y - arenaCenterY, warning.x - arenaCenterX);
      spawn(world, 'enemy', {
        x: warning.x, y: warning.y,
        vx: Math.cos(angle + Math.PI) * 2.5, vy: Math.sin(angle + Math.PI) * 2.5,
        hp: 2, maxHp: 2, radius: definition.attacks.trackingJelly.radius,
        contactRadius: definition.attacks.trackingJelly.radius,
        team: 2, ownerId: bodyId, role: 'swarm', type: 'abyss-jelly',
        damage: 0.24, contactDamaging: true, collidable: true,
        age: 0, lifetime: definition.attacks.trackingJelly.activeSeconds, stateTimer: 0.45,
        color: 0xd9ff61,
      });
    }
    attackCounts.active += 1;
  }

  function updateOwnedLifetimes(world, dt) {
    for (const kind of ['warning', 'enemyHazard']) {
      const query = world.query(kind);
      for (let index = 0; index < query.length; index += 1) {
        const entity = world.readInto(query.at(index), read);
        if (!entity || entity.ownerKind !== 'boss') continue;
        const age = entity.age + dt;
        if (entity.lifetime > 0 && age >= entity.lifetime - EPSILON) {
          if (kind === 'warning' && entity.state === 'telegraph') spawnActiveFromWarning(world, entity);
          world.despawn(entity.id);
        } else world.write(entity.id, { age });
      }
    }
  }

  function spawnSuctionCurrent(world, events) {
    const attack = definition.attacks.suctionCurrent;
    for (let index = 0; index < attack.currentCount; index += 1) {
      const angle = index * TAU / attack.currentCount + phaseElapsed * 0.25;
      spawn(world, 'enemyHazard', {
        x: arenaCenterX + Math.cos(angle) * 4.3,
        y: arenaCenterY + Math.sin(angle) * 3.1,
        rotation: angle + Math.PI / 2,
        scaleX: 3.4, scaleY: 0.55, radius: attack.radius,
        team: 2, ownerId: bodyId, attackKind: attack.id, state: 'current',
        contactDamaging: false, collidable: false,
        age: 0, lifetime: attack.activeSeconds,
        opacity: 0.7, color: 0x13d9ce,
      });
    }
    attackCounts.current += 1;
    attacksSeen.add(attack.id);
    emit(events, 'boss:attack', { bossId: definition.id, phase, attack: attack.id, currentCount: attack.currentCount });
  }

  function spawnTentacleFan(world, player, events) {
    const attack = definition.attacks.tentacleFan;
    const baseAngle = Math.atan2(player.y - arenaCenterY, player.x - arenaCenterX) - Math.PI * 0.62;
    const safeStart = (attackCursor * 2) % attack.tentacleCount;
    const gaps = new Set([safeStart, (safeStart + 1) % attack.tentacleCount]);
    for (let index = 0; index < attack.tentacleCount; index += 1) {
      if (gaps.has(index)) continue;
      const angle = baseAngle + index * (Math.PI * 1.24 / (attack.tentacleCount - 1));
      spawn(world, 'warning', {
        x: arenaCenterX + Math.cos(angle) * attack.reach * 0.5,
        y: arenaCenterY + Math.sin(angle) * attack.reach * 0.5,
        rotation: angle,
        scaleX: attack.reach, scaleY: attack.radius * 2,
        radius: attack.radius,
        team: 2, ownerId: bodyId, attackKind: attack.id, state: 'telegraph',
        duration: attack.telegraphSeconds, age: 0, lifetime: attack.telegraphSeconds,
        opacity: 0.78, collidable: false, color: 0x7df6ff,
      });
    }
    attackCounts.telegraph += attack.tentacleCount - gaps.size;
    attackCounts.tentacle += 1;
    attacksSeen.add(attack.id);
    emit(events, 'boss:attack', {
      bossId: definition.id, phase, attack: attack.id,
      safeGapIndexes: [...gaps], telegraphSeconds: attack.telegraphSeconds,
    });
  }

  function spawnJellies(world, player, events) {
    const attack = definition.attacks.trackingJelly;
    const count = mode === 'abyss' ? attack.count + 1 : attack.count;
    for (let index = 0; index < count; index += 1) {
      const angle = Math.atan2(player.y - arenaCenterY, player.x - arenaCenterX)
        + Math.PI + (index - (count - 1) / 2) * 0.45;
      spawn(world, 'warning', {
        x: arenaCenterX + Math.cos(angle) * 6.2,
        y: arenaCenterY + Math.sin(angle) * 4.5,
        scale: 0.72, radius: 0.58,
        team: 2, ownerId: bodyId, attackKind: attack.id, state: 'telegraph',
        duration: attack.telegraphSeconds, age: 0, lifetime: attack.telegraphSeconds,
        opacity: 0.82, collidable: false, color: 0xd9ff61,
      });
    }
    attackCounts.telegraph += count;
    attackCounts.jelly += count;
    attacksSeen.add(attack.id);
    emit(events, 'boss:attack', { bossId: definition.id, phase, attack: attack.id, count });
  }

  function spawnBite(world, player, events) {
    const attack = definition.attacks.biteZone;
    const direction = normalized(player.x - arenaCenterX, player.y - arenaCenterY);
    spawn(world, 'warning', {
      x: arenaCenterX + direction.x * 4.2,
      y: arenaCenterY + direction.y * 3.2,
      rotation: Math.atan2(direction.y, direction.x),
      scaleX: attack.halfWidth * 2, scaleY: attack.halfHeight * 2,
      radius: attack.halfHeight,
      team: 2, ownerId: bodyId, attackKind: attack.id, state: 'telegraph',
      duration: attack.telegraphSeconds, age: 0, lifetime: attack.telegraphSeconds,
      opacity: 0.84, collidable: false, color: 0xffc857,
    });
    attackCounts.telegraph += 1;
    attackCounts.bite += 1;
    attacksSeen.add(attack.id);
    emit(events, 'boss:attack', {
      bossId: definition.id, phase, attack: attack.id, telegraphSeconds: attack.telegraphSeconds,
    });
  }

  function scheduleAttack(world, player, events) {
    if (attackTimer > 0 || phase === 'hunt') return;
    const families = phase === 'suction'
      ? ['suction', 'tentacle', 'jelly']
      : phase === 'weakPoints'
        ? ['tentacle', 'jelly', 'bite']
        : ['bite', 'tentacle', 'jelly', 'suction'];
    const selected = families[attackCursor % families.length];
    attackCursor += 1;
    if (selected === 'suction') spawnSuctionCurrent(world, events);
    else if (selected === 'tentacle') spawnTentacleFan(world, player, events);
    else if (selected === 'jelly') spawnJellies(world, player, events);
    else spawnBite(world, player, events);
    const baseRecovery = phase === 'enraged' ? 1.55 : phase === 'weakPoints' ? 1.9 : 2.1;
    attackTimer = baseRecovery * (mode === 'abyss' ? 0.8 : 1);
  }

  function applyDamageRecords(world, records, events) {
    if (!Array.isArray(records)) return;
    for (const record of records) {
      if (record?.targetKind !== 'bossPart') continue;
      const organIndex = organIds.findIndex((id) => id > 0 && id === record.targetId);
      if (organIndex >= 0 && phase === 'weakPoints' && !organDestroyed[organIndex]) {
        organHp[organIndex] = Math.max(0, finite(record.hpAfter, organHp[organIndex] - finite(record.amount)));
        if (record.destroyed || organHp[organIndex] <= EPSILON) {
          organDestroyed[organIndex] = 1;
          world.despawn(organIds[organIndex]);
          emit(events, 'boss:organ-destroyed', {
            bossId: definition.id, organIndex, entityId: organIds[organIndex],
          });
        }
      } else if (record.targetId === bodyId && phase === 'enraged') {
        const body = world.readInto(bodyId, read);
        if (record.destroyed || finite(record.hpAfter, body?.hp ?? 1) <= EPSILON || !body) {
          complete(world, events);
        }
      }
    }
  }

  function complete(world, events) {
    if (!objective || objective.status !== 'active') return false;
    phase = 'complete';
    objective.status = 'completed';
    objective.completed = true;
    objective.failed = false;
    objective.failureReason = null;
    setObjectiveProgress();
    emit(events, 'boss:defeated', { bossId: definition.id, elapsed });
    cleanup(world, events, 'victory');
    return true;
  }

  function cleanup(world = worldReference, events = null, reason = 'reset') {
    if (clean) return false;
    clean = true;
    cleanupReason = reason;
    if (world?.query) {
      for (const kind of OWNED_KINDS) {
        const ids = [];
        const query = world.query(kind);
        for (let index = 0; index < query.length; index += 1) {
          const entity = world.readInto(query.at(index), read);
          if (entity?.ownerKind === 'boss') ids.push(entity.id);
        }
        for (const id of ids) world.despawn(id);
      }
    }
    bodyId = 0;
    spawned = false;
    organIds.fill(0);
    if (objective && objective.status === 'active') {
      objective.status = 'failed';
      objective.completed = false;
      objective.failed = true;
      objective.failureReason = reason;
    }
    emit(events, 'boss:music-layer', { bossId: definition?.id ?? 'abyss-maw', phase: 'cleanup', layer: null });
    emit(events, 'objective:cleanup', {
      id: objective?.id ?? null, kinds: definition?.cleanupKinds ?? OWNED_KINDS, status: objective?.status ?? 'failed',
    });
    emit(events, 'boss:cleanup', { bossId: definition?.id ?? 'abyss-maw', reason });
    worldReference = null;
    return true;
  }

  function start(definitionValue = ABYSS_MAW, { targetDurationSeconds = 100 } = {}) {
    definition = validateDefinition(definitionValue);
    objective = bossObjective(definition, targetDurationSeconds);
    phase = 'hunt';
    phaseElapsed = 0;
    elapsed = 0;
    attackTimer = 0;
    attackCursor = 0;
    bodyId = 0;
    spawned = false;
    organIds.fill(0);
    organDestroyed.fill(0);
    organHp.fill(0);
    stability = definition.phases.hunt.stability;
    routeBreaks = 0;
    suctionCrossings = 0;
    suctionSucceeded = false;
    arenaCenterX = 0;
    arenaCenterY = 0;
    routeInitialized = false;
    lastOrbitRadius = 0;
    lastLanceToken = 0;
    orbitDirection = 0;
    orbitConsistentSeconds = 0;
    orbitCounterCooldown = 0;
    orbitCounterTriggers = 0;
    routeCursor = 0;
    routeCount = 0;
    attacksSeen.clear();
    for (const key of Object.keys(attackCounts)) attackCounts[key] = 0;
    clean = false;
    cleanupReason = null;
    worldReference = null;
    return objective;
  }

  function update(context = {}, dt = 0, events = null) {
    const world = context.world;
    const seconds = Number(dt);
    if (!Number.isFinite(seconds) || seconds < 0) throw new TypeError('BossSystem dt must be non-negative finite');
    if (!definition || !objective || phase === 'idle') throw new Error('BossSystem must be started before update');
    if (clean || objective.status !== 'active') return Object.freeze({ phase, status: objective.status, changed: false });
    if (!world?.query || !world?.readInto || !world?.write || !world?.spawn || !world?.despawn) {
      throw new TypeError('BossSystem requires EntityWorld');
    }
    worldReference = world;
    ensureSpawned(world, events);
    const player = Number.isSafeInteger(context.player?.id)
      ? world.readInto(context.player.id, playerRead)
      : context.player;
    if (!player) return Object.freeze({ phase, status: objective.status, changed: false });
    elapsed += seconds;
    phaseElapsed += seconds;
    attackTimer -= seconds;
    objective.elapsed = elapsed;
    objective.timeoutRemaining = Math.max(0, objective.timeout - elapsed);
    sampleRoute(world, player, seconds, events);
    applyTideLance(world, player, events);
    applySuction(world, player, seconds, context.applyPlayerForce);
    moveOrgans(world, player);
    updateJellies(world, player, seconds);
    updateOwnedLifetimes(world, seconds);
    applyDamageRecords(world, context.damageRecords ?? [], events);

    if (objective.status === 'active' && phase === 'hunt'
      && stability <= definition.phases.hunt.gate.threshold
      && routeBreaks >= definition.phases.hunt.minimumRouteBreaks) {
      transition('suction', world, events);
    }
    if (objective.status === 'active' && phase === 'suction'
      && suctionCrossings >= definition.phases.suction.gate.requiredCrossings
      && phaseElapsed >= definition.phases.suction.gate.minimumSeconds) {
      suctionSucceeded = true;
      transition('weakPoints', world, events);
    }
    if (objective.status === 'active' && phase === 'weakPoints'
      && organDestroyed.every((value) => value === 1)) {
      transition('enraged', world, events);
    }
    if (objective.status === 'active' && elapsed >= objective.timeout - EPSILON) {
      cleanup(world, events, 'boss-timeout');
    } else if (objective.status === 'active') {
      scheduleAttack(world, player, events);
    }
    setObjectiveProgress();
    updates += 1;
    maxOwnedEntityCount = Math.max(maxOwnedEntityCount, ownedCount(world));
    return Object.freeze({ phase, status: objective.status, changed: true });
  }

  function getSnapshot() {
    const organs = Array.from({ length: organIds.length }, (_, index) => {
      const entity = worldReference?.readInto?.(organIds[index], read);
      return Object.freeze({
        index,
        entityId: organIds[index] || 0,
        destroyed: Boolean(organDestroyed[index]),
        hp: entity?.hp ?? organHp[index],
        maxHp: definition?.phases.weakPoints.organHp ?? 0,
        weakPoint: entity?.weakPoint ?? true,
        invulnerable: entity?.invulnerable ?? phase !== 'weakPoints',
      });
    });
    const body = worldReference?.readInto?.(bodyId, read);
    return Object.freeze({
      bossId: definition?.id ?? null,
      mode,
      phase,
      elapsed,
      phaseElapsed,
      stability,
      routeBreaks,
      orbitCounterTriggers,
      arenaCenter: Object.freeze({ x: arenaCenterX, y: arenaCenterY }),
      suctionOutcome: Object.freeze({ crossings: suctionCrossings, succeeded: suctionSucceeded }),
      destroyedOrgans: organDestroyed.reduce((sum, value) => sum + value, 0),
      parts: Object.freeze({
        body: Object.freeze({
          entityId: bodyId || 0,
          hp: body?.hp ?? 0,
          maxHp: definition?.phases.enraged.coreHp ?? 0,
          weakPoint: body?.weakPoint ?? false,
          invulnerable: body?.invulnerable ?? true,
        }),
        organs: Object.freeze(organs),
      }),
      attacksSeen: Object.freeze([...attacksSeen]),
      attackCounts: Object.freeze({ ...attackCounts }),
      ownedEntityCount: ownedCount(worldReference),
      maxOwnedEntityCount,
      routeSampleCount: routeCount,
      clean,
      cleanupReason,
      updates,
    });
  }

  return Object.freeze({ start, update, cleanup, getSnapshot, getObjective: () => objective });
}
