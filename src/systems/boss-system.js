import { createEntityReadTarget } from '../game/entity-world.js';
import { ABYSS_MAW } from '../content/bosses/abyss-maw.js';

const TAU = Math.PI * 2;
const EPSILON = 1e-9;
const OWNED_KINDS = Object.freeze(['bossPart', 'enemy', 'enemyProjectile', 'warning', 'enemyHazard']);
const PHASE_ORDER = Object.freeze(['hunt', 'suction', 'weakPoints', 'enraged']);
const MAX_OWNED_ENTITIES = 48;
const SPAWN_FAILURE_SECONDS = 2.5;
const ROUTE_OUTER_RADIUS = 4.8;
const ROUTE_INNER_RADIUS = 2.2;

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

function validateDefinition(definition) {
  if (!definition || definition.id !== 'abyss-maw') {
    throw new TypeError('BossSystem currently requires the Abyss Maw definition');
  }
  if (!PHASE_ORDER.every((entry) => definition.phases?.[entry])) {
    throw new TypeError('Boss definition must include hunt, suction, weakPoints, and enraged');
  }
  return definition;
}

function validateBehaviorContract(value, mode) {
  const candidate = value ?? {
    recoveryMultiplier: mode === 'abyss' ? 0.8 : 1,
    variantCount: mode === 'abyss' ? 4 : 3,
    telegraphFloorSeconds: mode === 'abyss' ? 0.58 : 0.72,
  };
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
    || !Number.isFinite(candidate.recoveryMultiplier)
    || candidate.recoveryMultiplier <= 0 || candidate.recoveryMultiplier > 1.5
    || !Number.isInteger(candidate.variantCount) || candidate.variantCount < 1 || candidate.variantCount > 8
    || !Number.isFinite(candidate.telegraphFloorSeconds) || candidate.telegraphFloorSeconds < 0.55) {
    throw new TypeError('Boss behavior contract is outside fair runtime bounds');
  }
  return cloneFrozen({
    recoveryMultiplier: candidate.recoveryMultiplier,
    variantCount: candidate.variantCount,
    telegraphFloorSeconds: candidate.telegraphFloorSeconds,
  });
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

export function createBossSystem({ seed = 0, mode = 'standard' } = {}) {
  if (!Number.isFinite(Number(seed))) throw new TypeError('Boss seed must be finite');
  if (!['standard', 'abyss'].includes(mode)) throw new TypeError('Boss mode must be standard or abyss');

  let definition = null;
  let behaviorContract = null;
  let objective = null;
  let worldReference = null;
  let phase = 'idle';
  let phaseElapsed = 0;
  let elapsed = 0;
  let attackTimer = 0;
  let attackCursor = 0;
  let bodyId = 0;
  let partsReady = false;
  let spawnEventPublished = false;
  let spawnFailures = 0;
  let spawnBlockedSeconds = 0;
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
  let lastMovementAngle = 0;
  let routeInitialized = false;
  let routeArmed = false;
  let routeDistance = 0;
  let routeTurn = 0;
  let cumulativeRouteDistance = 0;
  let cumulativeRouteTurn = 0;
  let orbitDirection = 0;
  let orbitConsistentSeconds = 0;
  let orbitCounterCooldown = 0;
  let orbitCounterTriggers = 0;
  const attacksSeen = new Set();
  const damageByWeapon = Object.create(null);
  const attackCounts = {
    telegraph: 0, active: 0, jelly: 0, bite: 0, tentacle: 0, current: 0, projectile: 0,
  };
  const owned = Object.fromEntries(OWNED_KINDS.map((kind) => [kind, new Set()]));
  let clean = false;
  let cleanupReason = null;
  let updates = 0;
  let maxOwnedEntityCount = 0;
  let diagnosticReconciliations = 0;
  const read = createEntityReadTarget();
  const playerRead = createEntityReadTarget();

  function ownedCount() {
    return OWNED_KINDS.reduce((sum, kind) => sum + owned[kind].size, 0);
  }

  function reconcileOwned(world = worldReference) {
    diagnosticReconciliations += 1;
    if (!world?.readInto) return ownedCount();
    for (const kind of OWNED_KINDS) {
      for (const id of [...owned[kind]]) {
        const entity = world.readInto(id, read);
        if (!entity || entity.kind !== kind || entity.ownerKind !== 'boss') owned[kind].delete(id);
      }
    }
    return ownedCount();
  }

  function spawnOwned(world, kind, data, { reserve = false } = {}) {
    if (!reserve && ownedCount() >= MAX_OWNED_ENTITIES) {
      spawnFailures += 1;
      return 0;
    }
    const id = world.spawn(kind, { ...data, ownerKind: 'boss' });
    if (id == null) {
      spawnFailures += 1;
      return 0;
    }
    owned[kind].add(id);
    maxOwnedEntityCount = Math.max(maxOwnedEntityCount, ownedCount());
    return id;
  }

  function despawnOwned(world, kind, id) {
    if (!id) return false;
    owned[kind]?.delete(id);
    return world?.despawn?.(id) ?? false;
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
      ratio = 0.8 + 0.2 * (1 - clamp(
        finite(body?.hp, definition.phases.enraged.coreHp) / definition.phases.enraged.coreHp,
        0,
        1,
      ));
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
    if (bodyId && world.readInto(bodyId, read)) return true;
    bodyId = spawnOwned(world, 'bossPart', {
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
    }, { reserve: true });
    return bodyId > 0;
  }

  function spawnOrgan(world, index) {
    if (organDestroyed[index]) return true;
    if (organIds[index] && world.readInto(organIds[index], read)) return true;
    const angle = -Math.PI / 2 + index * TAU / organIds.length;
    organHp[index] = definition.phases.weakPoints.organHp;
    organIds[index] = spawnOwned(world, 'bossPart', {
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
    }, { reserve: true });
    return organIds[index] > 0;
  }

  function ensureParts(world, dt, events) {
    if (partsReady) return true;
    const ready = spawnBody(world)
      && Array.from({ length: organIds.length }, (_, index) => spawnOrgan(world, index)).every(Boolean);
    partsReady = ready;
    if (!ready) {
      spawnBlockedSeconds += dt;
      if (spawnBlockedSeconds >= SPAWN_FAILURE_SECONDS - EPSILON) cleanup(world, events, 'boss-spawn-capacity');
      return false;
    }
    spawnBlockedSeconds = 0;
    if (!spawnEventPublished) {
      spawnEventPublished = true;
      emit(events, 'boss:spawned', {
        bossId: definition.id,
        bodyId,
        organIds: [...organIds],
        silhouette: definition.silhouette,
      });
      publishPhase(events);
    }
    return true;
  }

  function resetRouteDetector(player = null) {
    routeInitialized = Boolean(player);
    routeArmed = false;
    routeDistance = 0;
    routeTurn = 0;
    if (player) {
      lastPlayerX = finite(player.x);
      lastPlayerY = finite(player.y);
      lastRadius = Math.hypot(lastPlayerX - arenaCenterX, lastPlayerY - arenaCenterY);
      lastOrbitRadius = 0;
      lastAngle = Math.atan2(lastPlayerY - arenaCenterY, lastPlayerX - arenaCenterX);
      lastMovementAngle = lastAngle;
    }
  }

  function transition(nextPhase, world, events) {
    if (phase === nextPhase || clean) return false;
    phase = nextPhase;
    phaseElapsed = 0;
    attackTimer = 0;
    resetRouteDetector();
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
      for (let index = 0; index < organIds.length; index += 1) {
        if (organIds[index]) despawnOwned(world, 'bossPart', organIds[index]);
        organIds[index] = 0;
      }
    }
    setObjectiveProgress();
    publishPhase(events);
    emit(events, 'boss:phase-changed', { bossId: definition.id, phase });
    return true;
  }

  function telegraphSeconds(authored) {
    return Math.max(finite(authored), behaviorContract.telegraphFloorSeconds);
  }

  function spawnWarning(world, data) {
    const duration = telegraphSeconds(data.duration ?? data.lifetime);
    return spawnOwned(world, 'warning', {
      ...data,
      duration,
      lifetime: duration,
      age: 0,
      collidable: false,
      state: 'telegraph',
    });
  }

  function triggerOrbitCounter(world, player, events) {
    if (orbitCounterCooldown > 0) return;
    orbitCounterTriggers += 1;
    orbitCounterCooldown = 5.5;
    const angle = Math.atan2(player.y - arenaCenterY, player.x - arenaCenterX) + Math.PI;
    const gap = angle + (orbitDirection || 1) * 0.75;
    let spawned = 0;
    for (let index = 0; index < 10; index += 1) {
      const nodeAngle = angle + index * TAU / 10;
      if (Math.abs(angularDelta(gap, nodeAngle)) < 0.42) continue;
      if (spawnWarning(world, {
        x: arenaCenterX + Math.cos(nodeAngle) * 6.3,
        y: arenaCenterY + Math.sin(nodeAngle) * 4.2,
        radius: 0.45,
        scale: 0.7,
        team: 2,
        ownerId: bodyId,
        attackKind: 'orbit-counter',
        duration: 0.8,
        opacity: 0.85,
        color: 0xffc857,
        variant: 'circle',
      })) spawned += 1;
    }
    if (spawned > 0) {
      attackCounts.telegraph += spawned;
      attacksSeen.add('orbit-counter');
      emit(events, 'boss:orbit-counter', { bossId: definition.id, gapAngle: gap, trigger: orbitCounterTriggers });
    }
  }

  function registerRouteCrossing() {
    routeBreaks += 1;
    if (phase === 'hunt') {
      const damage = Math.max(
        finite(definition.phases.hunt.routeBreakDamage, 0),
        definition.phases.hunt.stability / Math.max(1, definition.phases.hunt.minimumRouteBreaks),
      );
      stability = Math.max(0, stability - damage);
    } else if (phase === 'suction') suctionCrossings += 1;
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
    if (!routeInitialized) {
      routeInitialized = true;
      lastPlayerX = x;
      lastPlayerY = y;
      lastRadius = radius;
      lastOrbitRadius = orbitRadius;
      lastAngle = angle;
      lastMovementAngle = angle;
      return;
    }

    const dx = x - lastPlayerX;
    const dy = y - lastPlayerY;
    const moved = Math.hypot(dx, dy);
    const maximumNaturalStep = Math.max(0.36, dt * 18);
    if (moved > maximumNaturalStep + EPSILON) {
      routeArmed = false;
      routeDistance = 0;
      routeTurn = 0;
      orbitConsistentSeconds = 0;
    } else if (moved > EPSILON) {
      const movementAngle = Math.atan2(dy, dx);
      const movementTurn = Math.abs(angularDelta(lastMovementAngle, movementAngle));
      routeDistance += moved;
      routeTurn += movementTurn;
      cumulativeRouteDistance += moved;
      cumulativeRouteTurn += movementTurn;
      lastMovementAngle = movementAngle;
      if (!routeArmed && radius >= ROUTE_OUTER_RADIUS) {
        routeArmed = true;
        routeDistance = 0;
        routeTurn = 0;
      } else if (routeArmed && lastRadius > ROUTE_INNER_RADIUS && radius <= ROUTE_INNER_RADIUS) {
        if (routeDistance >= ROUTE_OUTER_RADIUS - ROUTE_INNER_RADIUS - 0.2) registerRouteCrossing();
        routeArmed = false;
        routeDistance = 0;
        routeTurn = 0;
      }
    }

    const radiusDelta = Math.abs(radius - lastRadius);
    const delta = angularDelta(lastAngle, angle);
    const direction = Math.sign(delta);
    const stableOuterOrbit = orbitRadius > 0.82 && Math.abs(orbitRadius - lastOrbitRadius) < 0.08
      && direction !== 0 && (orbitDirection === 0 || direction === orbitDirection)
      && moved <= maximumNaturalStep + EPSILON;
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
    lastPlayerX = x;
    lastPlayerY = y;
    lastRadius = radius;
    lastOrbitRadius = orbitRadius;
    lastAngle = angle;
    orbitCounterCooldown = Math.max(0, orbitCounterCooldown - dt);
  }

  function hasActiveSuctionCurrent(world) {
    for (const id of owned.enemyHazard) {
      const hazard = world.readInto(id, read);
      if (hazard?.attackKind === 'suction-current' && hazard.state === 'active') return true;
    }
    return false;
  }

  function applySuction(world, player, dt, applyPlayerForce = null) {
    if (phase !== 'suction' || !Number.isSafeInteger(player?.id) || !hasActiveSuctionCurrent(world)) return;
    const direction = normalized(arenaCenterX - player.x, arenaCenterY - player.y);
    const acceleration = definition.phases.suction.pullAcceleration * dt;
    const forceX = direction.x * acceleration;
    const forceY = direction.y * acceleration;
    world.write(player.id, { vx: player.vx + forceX, vy: player.vy + forceY });
    applyPlayerForce?.(forceX, forceY);
  }

  function moveOrgans(world, player) {
    if (phase !== 'weakPoints') return;
    const exposed = Math.hypot(player.x - arenaCenterX, player.y - arenaCenterY)
      <= definition.phases.weakPoints.exposureRadius;
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

  function spawnBossBolt(world, jelly, player) {
    if (owned.enemyProjectile.size >= 24) return 0;
    const shotDirection = normalized(
      player.x + player.vx * 0.28 - jelly.x,
      player.y + player.vy * 0.28 - jelly.y,
    );
    const shotSpeed = mode === 'abyss' ? 5.4 : 4.8;
    const id = spawnOwned(world, 'enemyProjectile', {
      x: jelly.x, y: jelly.y, previousX: jelly.x, previousY: jelly.y,
      vx: shotDirection.x * shotSpeed, vy: shotDirection.y * shotSpeed,
      speed: shotSpeed, maxSpeed: shotSpeed, turnRate: 1.1,
      damage: 0.18, lifetime: 3.2, radius: 0.18,
      targetId: player.id, ownerId: jelly.id,
      team: 2, attackKind: 'tracking-jelly', type: 'abyss-jelly-bolt',
      homing: true, collidable: true, color: 0xd9ff61,
    });
    if (id) attackCounts.projectile += 1;
    return id;
  }

  function updateJellies(world, player, dt) {
    for (const id of [...owned.enemy]) {
      const jelly = world.readInto(id, read);
      if (!jelly) { owned.enemy.delete(id); continue; }
      if (jelly.type !== 'abyss-jelly') continue;
      const direction = normalized(player.x - jelly.x, player.y - jelly.y);
      const turn = 1 - Math.exp(-4.2 * dt);
      const speed = definition.attacks.trackingJelly.speed * (mode === 'abyss' ? 1.18 : 1);
      const vx = jelly.vx * (1 - turn) + direction.x * speed * turn;
      const vy = jelly.vy * (1 - turn) + direction.y * speed * turn;
      const age = jelly.age + dt;
      if (age >= jelly.lifetime - EPSILON || jelly.hp <= 0) {
        despawnOwned(world, 'enemy', id);
        continue;
      }
      let stateTimer = Math.max(0, jelly.stateTimer - dt);
      if (stateTimer <= EPSILON) {
        spawnBossBolt(world, jelly, player);
        stateTimer = mode === 'abyss' ? 0.9 : 1.2;
      }
      world.write(id, {
        previousX: jelly.x, previousY: jelly.y,
        x: jelly.x + vx * dt, y: jelly.y + vy * dt,
        vx, vy, age, stateTimer,
        hitCooldown: Math.max(0, jelly.hitCooldown - dt),
      });
    }
  }

  function updateBossProjectiles(world, player, dt) {
    for (const id of [...owned.enemyProjectile]) {
      const projectile = world.readInto(id, read);
      if (!projectile) { owned.enemyProjectile.delete(id); continue; }
      const age = projectile.age + dt;
      if (age >= projectile.lifetime - EPSILON || Math.abs(projectile.x) > 32 || Math.abs(projectile.y) > 32) {
        despawnOwned(world, 'enemyProjectile', id);
        continue;
      }
      let vx = projectile.vx;
      let vy = projectile.vy;
      if (projectile.homing && player) {
        const desired = Math.atan2(player.y - projectile.y, player.x - projectile.x);
        const current = Math.atan2(vy, vx);
        const turn = clamp(angularDelta(current, desired), -projectile.turnRate * dt, projectile.turnRate * dt);
        const speed = projectile.maxSpeed || projectile.speed || Math.hypot(vx, vy);
        vx = Math.cos(current + turn) * speed;
        vy = Math.sin(current + turn) * speed;
      }
      world.write(id, {
        previousX: projectile.x, previousY: projectile.y,
        x: projectile.x + vx * dt, y: projectile.y + vy * dt,
        vx, vy, age, previousRotation: projectile.rotation,
        rotation: Math.atan2(vy, vx),
      });
    }
  }

  function spawnActiveFromWarning(world, warning) {
    let id = 0;
    if (warning.attackKind === 'tentacle-fan') {
      id = spawnOwned(world, 'enemyHazard', {
        x: warning.x, y: warning.y, rotation: warning.rotation,
        scaleX: warning.scaleX, scaleY: warning.scaleY,
        radius: warning.radius, variant: 'oriented-box',
        team: 2, ownerId: bodyId, attackKind: warning.attackKind, state: 'active',
        damage: 0.45, contactDamaging: true, collidable: true,
        age: 0, lifetime: definition.attacks.tentacleFan.activeSeconds,
        color: 0x7df6ff,
      });
    } else if (warning.attackKind === 'bite-zone') {
      id = spawnOwned(world, 'enemyHazard', {
        x: warning.x, y: warning.y, rotation: warning.rotation,
        scaleX: warning.scaleX, scaleY: warning.scaleY,
        radius: warning.radius, variant: 'oriented-box',
        team: 2, ownerId: bodyId, attackKind: warning.attackKind, state: 'active',
        damage: definition.attacks.biteZone.damage, contactDamaging: true, collidable: true,
        age: 0, lifetime: definition.attacks.biteZone.activeSeconds,
        color: 0xffc857,
      });
    } else if (warning.attackKind === 'tracking-jelly') {
      const angle = Math.atan2(warning.y - arenaCenterY, warning.x - arenaCenterX);
      id = spawnOwned(world, 'enemy', {
        x: warning.x, y: warning.y,
        vx: Math.cos(angle + Math.PI) * 2.5, vy: Math.sin(angle + Math.PI) * 2.5,
        hp: 2, maxHp: 2, radius: definition.attacks.trackingJelly.radius,
        contactRadius: definition.attacks.trackingJelly.radius,
        team: 2, ownerId: bodyId, role: 'swarm', type: 'abyss-jelly',
        damage: 0.24, contactDamaging: true, collidable: true,
        age: 0, lifetime: definition.attacks.trackingJelly.activeSeconds, stateTimer: 0.45,
        color: 0xd9ff61,
      });
      if (id) attackCounts.jelly += 1;
    } else if (warning.attackKind === 'suction-current') {
      id = spawnOwned(world, 'enemyHazard', {
        x: warning.x, y: warning.y, rotation: warning.rotation,
        scaleX: warning.scaleX, scaleY: warning.scaleY,
        radius: warning.radius, variant: 'oriented-box',
        team: 2, ownerId: bodyId, attackKind: warning.attackKind, state: 'active',
        contactDamaging: false, collidable: false,
        age: 0, lifetime: definition.attacks.suctionCurrent.activeSeconds,
        opacity: 0.7, color: 0x13d9ce,
      });
      if (id) attackCounts.current += 1;
    } else if (warning.attackKind === 'orbit-counter') {
      id = spawnOwned(world, 'enemyHazard', {
        x: warning.x, y: warning.y, radius: warning.radius,
        scale: warning.scale, scaleX: warning.scaleX, scaleY: warning.scaleY,
        variant: 'circle', team: 2, ownerId: bodyId,
        attackKind: warning.attackKind, state: 'active', damage: 0.5,
        contactDamaging: true, collidable: true,
        age: 0, lifetime: 1.6, color: 0xffc857,
      });
    }
    if (id) attackCounts.active += 1;
    return id;
  }

  function updateOwnedLifetimes(world, dt) {
    for (const id of [...owned.warning]) {
      const warning = world.readInto(id, read);
      if (!warning) { owned.warning.delete(id); continue; }
      const age = warning.age + dt;
      if (warning.lifetime > 0 && age >= warning.lifetime - EPSILON) {
        spawnActiveFromWarning(world, warning);
        despawnOwned(world, 'warning', id);
      } else {
        world.write(id, {
          age,
          progress: warning.lifetime > 0 ? clamp(age / warning.lifetime, 0, 1) : 0,
        });
      }
    }
    for (const id of [...owned.enemyHazard]) {
      const hazard = world.readInto(id, read);
      if (!hazard) { owned.enemyHazard.delete(id); continue; }
      const age = hazard.age + dt;
      if (hazard.lifetime > 0 && age >= hazard.lifetime - EPSILON) {
        despawnOwned(world, 'enemyHazard', id);
      } else {
        world.write(id, { age, hitCooldown: Math.max(0, hazard.hitCooldown - dt) });
      }
    }
  }

  function spawnSuctionCurrent(world, events) {
    const attack = definition.attacks.suctionCurrent;
    let spawned = 0;
    for (let index = 0; index < attack.currentCount; index += 1) {
      const variant = attackCursor % behaviorContract.variantCount;
      const angle = index * TAU / attack.currentCount + variant * TAU / (attack.currentCount * behaviorContract.variantCount);
      if (spawnWarning(world, {
        x: arenaCenterX + Math.cos(angle) * 4.3,
        y: arenaCenterY + Math.sin(angle) * 3.1,
        rotation: angle + Math.PI / 2,
        scaleX: 3.4, scaleY: 0.55, radius: attack.radius,
        variant: 'oriented-box', team: 2, ownerId: bodyId,
        attackKind: attack.id, duration: attack.telegraphSeconds,
        opacity: 0.7, color: 0x13d9ce,
      })) spawned += 1;
    }
    if (spawned > 0) {
      attackCounts.telegraph += spawned;
      attacksSeen.add(attack.id);
      emit(events, 'boss:attack', {
        bossId: definition.id, phase, attack: attack.id,
        currentCount: spawned, telegraphSeconds: telegraphSeconds(attack.telegraphSeconds),
      });
    }
    return spawned;
  }

  function spawnTentacleFan(world, player, events) {
    const attack = definition.attacks.tentacleFan;
    const variant = attackCursor % behaviorContract.variantCount;
    const baseAngle = Math.atan2(player.y - arenaCenterY, player.x - arenaCenterX)
      - Math.PI * 0.62 + (variant - (behaviorContract.variantCount - 1) / 2) * 0.08;
    const safeStart = (variant * 2) % attack.tentacleCount;
    const gaps = new Set([safeStart, (safeStart + 1) % attack.tentacleCount]);
    let spawned = 0;
    for (let index = 0; index < attack.tentacleCount; index += 1) {
      if (gaps.has(index)) continue;
      const angle = baseAngle + index * (Math.PI * 1.24 / (attack.tentacleCount - 1));
      if (spawnWarning(world, {
        x: arenaCenterX + Math.cos(angle) * attack.reach * 0.5,
        y: arenaCenterY + Math.sin(angle) * attack.reach * 0.5,
        rotation: angle,
        scaleX: attack.reach, scaleY: attack.radius * 2,
        radius: attack.radius, variant: 'oriented-box',
        team: 2, ownerId: bodyId, attackKind: attack.id,
        duration: attack.telegraphSeconds, opacity: 0.78, color: 0x7df6ff,
      })) spawned += 1;
    }
    if (spawned > 0) {
      attackCounts.telegraph += spawned;
      attackCounts.tentacle += 1;
      attacksSeen.add(attack.id);
      emit(events, 'boss:attack', {
        bossId: definition.id, phase, attack: attack.id,
        safeGapIndexes: [...gaps], telegraphSeconds: telegraphSeconds(attack.telegraphSeconds),
      });
    }
    return spawned;
  }

  function spawnJellies(world, player, events) {
    const attack = definition.attacks.trackingJelly;
    const variant = attackCursor % behaviorContract.variantCount;
    const count = attack.count + (mode === 'abyss' ? 1 : 0) + (variant === behaviorContract.variantCount - 1 ? 1 : 0);
    let spawned = 0;
    for (let index = 0; index < count; index += 1) {
      const angle = Math.atan2(player.y - arenaCenterY, player.x - arenaCenterX)
        + Math.PI + (index - (count - 1) / 2) * 0.45;
      if (spawnWarning(world, {
        x: arenaCenterX + Math.cos(angle) * 6.2,
        y: arenaCenterY + Math.sin(angle) * 4.5,
        scale: 0.72, radius: 0.58, variant: 'circle',
        team: 2, ownerId: bodyId, attackKind: attack.id,
        duration: attack.telegraphSeconds, opacity: 0.82, color: 0xd9ff61,
      })) spawned += 1;
    }
    if (spawned > 0) {
      attackCounts.telegraph += spawned;
      attacksSeen.add(attack.id);
      emit(events, 'boss:attack', {
        bossId: definition.id, phase, attack: attack.id, count: spawned,
        telegraphSeconds: telegraphSeconds(attack.telegraphSeconds),
      });
    }
    return spawned;
  }

  function spawnBite(world, player, events) {
    const attack = definition.attacks.biteZone;
    const direction = normalized(player.x - arenaCenterX, player.y - arenaCenterY);
    const id = spawnWarning(world, {
      x: arenaCenterX + direction.x * 4.2,
      y: arenaCenterY + direction.y * 3.2,
      rotation: Math.atan2(direction.y, direction.x),
      scaleX: attack.halfWidth * 2, scaleY: attack.halfHeight * 2,
      radius: attack.halfHeight, variant: 'oriented-box',
      team: 2, ownerId: bodyId, attackKind: attack.id,
      duration: attack.telegraphSeconds, opacity: 0.84, color: 0xffc857,
    });
    if (id) {
      attackCounts.telegraph += 1;
      attackCounts.bite += 1;
      attacksSeen.add(attack.id);
      emit(events, 'boss:attack', {
        bossId: definition.id, phase, attack: attack.id,
        telegraphSeconds: telegraphSeconds(attack.telegraphSeconds),
      });
      return 1;
    }
    return 0;
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
    let spawned = 0;
    if (selected === 'suction') spawned = spawnSuctionCurrent(world, events);
    else if (selected === 'tentacle') spawned = spawnTentacleFan(world, player, events);
    else if (selected === 'jelly') spawned = spawnJellies(world, player, events);
    else spawned = spawnBite(world, player, events);
    const baseRecovery = phase === 'enraged' ? 1.55 : phase === 'weakPoints' ? 1.9 : 2.1;
    attackTimer = spawned > 0 ? baseRecovery * behaviorContract.recoveryMultiplier : 0.2;
  }

  function applyDamageRecords(world, records, events) {
    if (!Array.isArray(records)) return;
    for (const record of records) {
      if (record?.targetKind !== 'bossPart') continue;
      const amount = Math.max(0, finite(record.amount));
      if (amount > 0 && record.weaponId) {
        damageByWeapon[record.weaponId] = (damageByWeapon[record.weaponId] ?? 0) + amount;
      }
      const organIndex = organIds.findIndex((id) => id > 0 && id === record.targetId);
      if (organIndex >= 0 && phase === 'weakPoints' && !organDestroyed[organIndex]) {
        organHp[organIndex] = Math.max(0, finite(record.hpAfter, organHp[organIndex] - amount));
        if (record.destroyed || organHp[organIndex] <= EPSILON) {
          const destroyedId = organIds[organIndex];
          organDestroyed[organIndex] = 1;
          despawnOwned(world, 'bossPart', destroyedId);
          emit(events, 'boss:organ-destroyed', {
            bossId: definition.id, organIndex, entityId: destroyedId,
          });
        }
      } else if (record.targetId === bodyId && phase === 'enraged') {
        const body = world.readInto(bodyId, read);
        if (record.destroyed || finite(record.hpAfter, body?.hp ?? 1) <= EPSILON || !body) complete(world, events);
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

  function completeForDeterministicTest(events = null) {
    if (objective?.status !== 'active') return false;
    if (worldReference) return complete(worldReference, events);
    phase = 'complete';
    objective.status = 'completed';
    objective.completed = true;
    objective.failed = false;
    objective.failureReason = null;
    setObjectiveProgress();
    emit(events, 'boss:defeated', { bossId: definition.id, elapsed, deterministic: true });
    return true;
  }

  function cleanup(world = worldReference, events = null, reason = 'reset') {
    if (clean) return false;
    clean = true;
    cleanupReason = reason;
    if (world?.despawn) {
      for (const kind of OWNED_KINDS) {
        for (const id of [...owned[kind]]) world.despawn(id);
        owned[kind].clear();
      }
    } else {
      for (const kind of OWNED_KINDS) owned[kind].clear();
    }
    bodyId = 0;
    partsReady = false;
    organIds.fill(0);
    if (objective && objective.status === 'active') {
      objective.status = 'failed';
      objective.completed = false;
      objective.failed = true;
      objective.failureReason = reason;
    }
    emit(events, 'boss:music-layer', { bossId: definition?.id ?? 'abyss-maw', phase: 'cleanup', layer: null });
    emit(events, 'objective:cleanup', {
      id: objective?.id ?? null,
      kinds: definition?.cleanupKinds ?? OWNED_KINDS,
      status: objective?.status ?? 'failed',
    });
    emit(events, 'boss:cleanup', { bossId: definition?.id ?? 'abyss-maw', reason });
    worldReference = null;
    return true;
  }

  function start(definitionValue = ABYSS_MAW, {
    targetDurationSeconds = 100,
    behaviorContract: behaviorContractValue = null,
  } = {}) {
    definition = validateDefinition(definitionValue);
    behaviorContract = validateBehaviorContract(behaviorContractValue, mode);
    objective = bossObjective(definition, targetDurationSeconds);
    phase = 'hunt';
    phaseElapsed = 0;
    elapsed = 0;
    attackTimer = 0;
    attackCursor = 0;
    bodyId = 0;
    partsReady = false;
    spawnEventPublished = false;
    spawnFailures = 0;
    spawnBlockedSeconds = 0;
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
    routeArmed = false;
    routeDistance = 0;
    routeTurn = 0;
    cumulativeRouteDistance = 0;
    cumulativeRouteTurn = 0;
    lastOrbitRadius = 0;
    orbitDirection = 0;
    orbitConsistentSeconds = 0;
    orbitCounterCooldown = 0;
    orbitCounterTriggers = 0;
    attacksSeen.clear();
    for (const key of Object.keys(damageByWeapon)) delete damageByWeapon[key];
    for (const key of Object.keys(attackCounts)) attackCounts[key] = 0;
    for (const kind of OWNED_KINDS) owned[kind].clear();
    clean = false;
    cleanupReason = null;
    worldReference = null;
    maxOwnedEntityCount = 0;
    diagnosticReconciliations = 0;
    return cloneFrozen(objective);
  }

  function update(context = {}, dt = 0, events = null) {
    const world = context.world;
    const seconds = Number(dt);
    if (!Number.isFinite(seconds) || seconds < 0) throw new TypeError('BossSystem dt must be non-negative finite');
    if (!definition || !objective || phase === 'idle') throw new Error('BossSystem must be started before update');
    if (clean || objective.status !== 'active') return Object.freeze({ phase, status: objective.status, changed: false });
    if (!world?.readInto || !world?.write || !world?.spawn || !world?.despawn) {
      throw new TypeError('BossSystem requires EntityWorld');
    }
    worldReference = world;
    if (!ensureParts(world, seconds, events)) {
      setObjectiveProgress();
      updates += 1;
      return Object.freeze({ phase, status: objective.status, changed: true });
    }
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
    moveOrgans(world, player);
    updateJellies(world, player, seconds);
    updateBossProjectiles(world, player, seconds);
    updateOwnedLifetimes(world, seconds);
    applySuction(world, player, seconds, context.applyPlayerForce);
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
    maxOwnedEntityCount = Math.max(maxOwnedEntityCount, ownedCount());
    return Object.freeze({ phase, status: objective.status, changed: true });
  }

  function getSnapshot() {
    reconcileOwned(worldReference);
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
      routeDistance: cumulativeRouteDistance,
      routeTurn: cumulativeRouteTurn,
      orbitCounterTriggers,
      arenaCenter: Object.freeze({ x: arenaCenterX, y: arenaCenterY }),
      suctionOutcome: Object.freeze({ crossings: suctionCrossings, succeeded: suctionSucceeded }),
      destroyedOrgans: organDestroyed.reduce((sum, value) => sum + value, 0),
      partsReady,
      spawnFailures,
      spawnBlockedSeconds,
      behaviorContract,
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
      damageByWeapon: Object.freeze({ ...damageByWeapon }),
      ownedEntityCount: ownedCount(),
      maxOwnedEntityCount,
      routeSampleCount: updates,
      diagnosticReconciliations,
      clean,
      cleanupReason,
      updates,
    });
  }

  return Object.freeze({
    start,
    update,
    cleanup,
    completeForDeterministicTest,
    getSnapshot,
    getObjective: () => cloneFrozen(objective),
  });
}
