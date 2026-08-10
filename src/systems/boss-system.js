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
const DAMAGE_WEAPON_KEYS = new Set(['pulse-cannon', 'arc-drones', 'prism-missiles', 'tide-lance']);

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const damageWeaponKey = (value) => DAMAGE_WEAPON_KEYS.has(String(value)) ? String(value) : 'other';

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

function createAbyssMawBossSystem({ seed = 0, mode = 'standard' } = {}) {
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
    if (ownedCount() >= MAX_OWNED_ENTITIES) {
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
    const velocityLength = Math.hypot(player.vx, player.vy);
    const travelDirection = velocityLength > EPSILON
      ? normalized(player.vx, player.vy)
      : normalized(player.x - lastPlayerX, player.y - lastPlayerY);
    const speed = clamp(velocityLength, 4.5, 6.5);
    const normalX = -travelDirection.y;
    const normalY = travelDirection.x;
    const gatePositions = [];
    let spawned = 0;
    const spawnCounterGate = (x, y, rotation) => {
      gatePositions.push(Object.freeze({ x, y }));
      const id = spawnWarning(world, {
        x,
        y,
        rotation,
        radius: 0.45,
        scaleX: 5.2,
        scaleY: 0.9,
        team: 2,
        ownerId: bodyId,
        attackKind: 'orbit-counter',
        duration: 0.8,
        opacity: 0.85,
        color: 0xffc857,
        variant: 'oriented-box',
      });
      if (id) spawned += 1;
    };
    for (const leadSeconds of [0.95, 1.35]) {
      const x = clamp(
        player.x + travelDirection.x * speed * leadSeconds,
        arenaCenterX - definition.arena.halfWidth + 0.45,
        arenaCenterX + definition.arena.halfWidth - 0.45,
      );
      const y = clamp(
        player.y + travelDirection.y * speed * leadSeconds,
        arenaCenterY - definition.arena.halfHeight + 0.45,
        arenaCenterY + definition.arena.halfHeight - 0.45,
      );
      spawnCounterGate(x, y, Math.atan2(normalY, normalX));
    }
    const semiWidth = Math.max(1, definition.arena.halfWidth - 1.3);
    const semiHeight = Math.max(1, definition.arena.halfHeight - 1.7);
    const orbitAngle = Math.atan2(
      (player.y - arenaCenterY) / semiHeight,
      (player.x - arenaCenterX) / semiWidth,
    );
    const trackScale = clamp(lastOrbitRadius, 0.86, 1.05);
    for (const leadAngle of [0.48, 0.82]) {
      const angle = orbitAngle + (orbitDirection || 1) * leadAngle;
      const x = arenaCenterX + Math.cos(angle) * semiWidth * trackScale;
      const y = arenaCenterY + Math.sin(angle) * semiHeight * trackScale;
      const normal = normalized(Math.cos(angle) / semiWidth, Math.sin(angle) / semiHeight);
      spawnCounterGate(x, y, Math.atan2(normal.y, normal.x));
    }
    if (spawned > 0) {
      attackCounts.telegraph += spawned;
      attacksSeen.add('orbit-counter');
      emit(events, 'boss:orbit-counter', {
        bossId: definition.id,
        gatePositions: Object.freeze(gatePositions),
        escape: 'move-inward-or-reverse',
        trigger: orbitCounterTriggers,
      });
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
        x: warning.x, y: warning.y, rotation: warning.rotation, radius: warning.radius,
        scaleX: warning.scaleX, scaleY: warning.scaleY,
        variant: 'oriented-box', team: 2, ownerId: bodyId,
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
        const weaponId = damageWeaponKey(record.weaponId);
        damageByWeapon[weaponId] = (damageByWeapon[weaponId] ?? 0) + amount;
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

const PROTOCOL_PHASES = Object.freeze(['firewall', 'trafficGrid', 'cloneNodes', 'kernel']);
const PROTOCOL_OWNED_KINDS = Object.freeze([...OWNED_KINDS, 'objective']);
const PROTOCOL_NODE_KINDS = Object.freeze(['enemy', 'bossPart', 'objective']);
const PROTOCOL_NODE_POSITIONS = Object.freeze([
  Object.freeze({ x: -4.6, y: -2.8 }),
  Object.freeze({ x: 4.6, y: -2.8 }),
  Object.freeze({ x: 0, y: 3.6 }),
]);
const PROTOCOL_FIREWALL_ORDER = Object.freeze([0, 2, 1, 3]);
const PROTOCOL_FIREWALL_KINDS = Object.freeze(['objective', 'enemy', 'bossPart', 'enemy']);
const PROTOCOL_PRESENTATION_RETRY_SECONDS = 2.5;
const PROTOCOL_TRAFFIC_ATTACK_KINDS = new Set(['grid-lock', 'traffic-wall', 'predictive-beam']);
const PROTOCOL_TRAFFIC_CORRIDOR_MARGIN = 0.35;

function pointSegmentDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= EPSILON) return Math.hypot(point.x - start.x, point.y - start.y);
  const amount = clamp(((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared, 0, 1);
  return Math.hypot(point.x - (start.x + dx * amount), point.y - (start.y + dy * amount));
}

function routeLength(points) {
  let length = 0;
  for (let index = 1; index < points.length; index += 1) {
    length += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
  }
  return length;
}

function routePoints(corridor = {}) {
  return [corridor.start, ...(corridor.waypoints ?? []), corridor.target]
    .filter((entry) => Number.isFinite(entry?.x) && Number.isFinite(entry?.y));
}

function segmentIntersectsExpandedBox(start, end, box, clearance) {
  const rotation = finite(box?.rotation);
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const halfX = Math.max(0, finite(box?.scaleX)) * 0.5 + clearance;
  const halfY = Math.max(0, finite(box?.scaleY)) * 0.5 + clearance;
  const centerX = finite(box?.x);
  const centerY = finite(box?.y);
  const transform = (point) => {
    const dx = point.x - centerX;
    const dy = point.y - centerY;
    return { x: dx * cosine + dy * sine, y: -dx * sine + dy * cosine };
  };
  const localStart = transform(start);
  const localEnd = transform(end);
  const distance = Math.hypot(localEnd.x - localStart.x, localEnd.y - localStart.y);
  const samples = Math.max(1, Math.ceil(distance / 0.18));
  for (let sample = 0; sample <= samples; sample += 1) {
    const amount = sample / samples;
    const x = localStart.x + (localEnd.x - localStart.x) * amount;
    const y = localStart.y + (localEnd.y - localStart.y) * amount;
    if (Math.abs(x) <= halfX && Math.abs(y) <= halfY) return true;
  }
  return false;
}

function boxIntersectsCorridor(box, corridor) {
  const points = routePoints(corridor);
  const clearance = Math.max(0, finite(corridor?.clearance, 0.75));
  for (let index = 1; index < points.length; index += 1) {
    if (segmentIntersectsExpandedBox(points[index - 1], points[index], box, clearance)) return true;
  }
  return false;
}

export function createProtocolTrafficCorridor(
  startValue,
  targetValue,
  arena = { halfWidth: 10.5, halfHeight: 7.2 },
  bodyRadius = 1.65,
  playerRadius = 0.4,
) {
  const clearance = Math.max(0.2, finite(playerRadius, 0.4) + PROTOCOL_TRAFFIC_CORRIDOR_MARGIN);
  const halfWidth = Math.max(2, finite(arena?.halfWidth, 10.5));
  const halfHeight = Math.max(2, finite(arena?.halfHeight, 7.2));
  const clampPoint = (value) => Object.freeze({
    x: clamp(finite(value?.x), -halfWidth + clearance, halfWidth - clearance),
    y: clamp(finite(value?.y), -halfHeight + clearance, halfHeight - clearance),
  });
  const start = clampPoint(startValue);
  const target = clampPoint(targetValue);
  const bodyClearance = Math.max(0, finite(bodyRadius, 1.65)) + clearance + 0.2;
  const detourX = Math.min(halfWidth - clearance, bodyClearance);
  const detourY = Math.min(halfHeight - clearance, bodyClearance);
  const candidates = [
    [start, target],
    [start, clampPoint({ x: target.x, y: start.y }), target],
    [start, clampPoint({ x: start.x, y: target.y }), target],
    [start, clampPoint({ x: detourX, y: start.y }), clampPoint({ x: detourX, y: target.y }), target],
    [start, clampPoint({ x: -detourX, y: start.y }), clampPoint({ x: -detourX, y: target.y }), target],
    [start, clampPoint({ x: start.x, y: detourY }), clampPoint({ x: target.x, y: detourY }), target],
    [start, clampPoint({ x: start.x, y: -detourY }), clampPoint({ x: target.x, y: -detourY }), target],
  ].map((points) => points.filter((point, index) => index === 0
    || Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y) > EPSILON));
  const clear = candidates.filter((points) => {
    for (let index = 1; index < points.length; index += 1) {
      if (pointSegmentDistance({ x: 0, y: 0 }, points[index - 1], points[index]) < bodyClearance) return false;
    }
    return true;
  });
  const selected = (clear.length ? clear : candidates)
    .sort((left, right) => routeLength(left) - routeLength(right))[0];
  return Object.freeze({
    start,
    target,
    waypoints: Object.freeze(selected.slice(1, -1).map((point) => Object.freeze({ ...point }))),
    clearance,
    targetHalfWidth: Math.max(0.2, finite(targetValue?.halfWidth, 1.35)),
    targetHalfHeight: Math.max(0.2, finite(targetValue?.halfHeight, 1.45)),
  });
}

export function protocolTemporalRouteReachesTruthfulCell({
  corridor,
  frames = [],
  speed = 6.15,
  dt = 1 / 60,
} = {}) {
  const points = routePoints(corridor);
  if (points.length < 2 || !Array.isArray(frames) || frames.length === 0) return false;
  const seconds = finite(dt);
  const movementPerFrame = finite(speed) * seconds;
  if (seconds <= 0 || movementPerFrame <= 0) return false;
  let position = { ...points[0] };
  let targetIndex = 1;
  for (const frame of frames) {
    const boxes = Array.isArray(frame) ? frame : [];
    if (boxes.some((box) => segmentIntersectsExpandedBox(position, position, box, corridor.clearance))) return false;
    let remaining = movementPerFrame;
    while (remaining > EPSILON && targetIndex < points.length) {
      const target = points[targetIndex];
      const distance = Math.hypot(target.x - position.x, target.y - position.y);
      if (distance <= remaining + EPSILON) {
        if (boxes.some((box) => segmentIntersectsExpandedBox(position, target, box, corridor.clearance))) return false;
        position = { ...target };
        remaining -= distance;
        targetIndex += 1;
      } else {
        const amount = remaining / distance;
        const next = {
          x: position.x + (target.x - position.x) * amount,
          y: position.y + (target.y - position.y) * amount,
        };
        if (boxes.some((box) => segmentIntersectsExpandedBox(position, next, box, corridor.clearance))) return false;
        position = next;
        remaining = 0;
      }
    }
  }
  return targetIndex >= points.length;
}

function createProtocolZeroBossSystem({ seed = 0, mode = 'standard' } = {}) {
  let definition = null;
  let behaviorContract = null;
  let objective = null;
  let worldReference = null;
  let phase = 'idle';
  let elapsed = 0;
  let phaseElapsed = 0;
  let bodyId = 0;
  let attackTimer = 0;
  let attackCursor = 0;
  let firewallIndex = 0;
  let firewallClears = 0;
  let firewallMarkerId = 0;
  let firewallMarkerKind = null;
  let firewallAwaitingCenter = true;
  let firewallStepElapsed = 0;
  let firewallRouteChanges = 0;
  let safeCellIndex = 0;
  let safeCellHold = 0;
  let safeCellClears = 0;
  let safeCells = [];
  let trafficCorridor = null;
  let safeRoute = { openLanes: 1, laneIndex: 1, evidence: 'shape-and-rhythm' };
  let clean = false;
  let cleanupReason = null;
  let spawnFailures = 0;
  let maxOwnedEntityCount = 0;
  let maxSimultaneousWarnings = 0;
  let diagnosticReconciliations = 0;
  let presentationBlockedSeconds = 0;
  let presentationRetries = 0;
  let updates = 0;
  const nodeIds = new Float64Array(3);
  const nodeDestroyed = new Uint8Array(3);
  const nodeHp = new Float64Array(3);
  const owned = Object.fromEntries(PROTOCOL_OWNED_KINDS.map((kind) => [kind, new Set()]));
  const attacksSeen = new Set();
  const attackCounts = { telegraph: 0, active: 0, trafficWall: 0, predictiveBeam: 0, gridLock: 0, cloneBurst: 0 };
  const damageByWeapon = Object.create(null);
  const read = createEntityReadTarget();
  const playerRead = createEntityReadTarget();

  function ownedCount() {
    return PROTOCOL_OWNED_KINDS.reduce((sum, kind) => sum + owned[kind].size, 0);
  }

  function currentWarningCount() {
    return owned.warning.size;
  }

  function reconcileOwned(world = worldReference) {
    diagnosticReconciliations += 1;
    if (!world?.readInto) return ownedCount();
    for (const kind of PROTOCOL_OWNED_KINDS) {
      for (const id of [...owned[kind]]) {
        const entity = world.readInto(id, read);
        if (!entity || entity.kind !== kind || entity.ownerKind !== 'boss') owned[kind].delete(id);
      }
    }
    return ownedCount();
  }

  function spawnOwned(world, kind, data, reserve = false) {
    if (ownedCount() >= definition.maxOwnedEntities) {
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
    if (kind === 'warning') maxSimultaneousWarnings = Math.max(maxSimultaneousWarnings, currentWarningCount());
    return id;
  }

  function despawnOwned(world, kind, id) {
    if (!id) return false;
    owned[kind]?.delete(id);
    return world?.despawn?.(id) ?? false;
  }

  function validateProtocolDefinition(value) {
    if (!value || value.id !== 'protocol-zero') throw new TypeError('Protocol Zero definition is required');
    if (!PROTOCOL_PHASES.every((entry) => value.phases?.[entry])) {
      throw new TypeError('Protocol Zero must include firewall, trafficGrid, cloneNodes, and kernel');
    }
    if (value.maxOwnedEntities > MAX_OWNED_ENTITIES || value.maxOwnedEntities < 8) {
      throw new TypeError('Protocol Zero entity budget is outside Boss runtime bounds');
    }
    return value;
  }

  function protocolObjective(targetDurationSeconds) {
    const timeout = Math.max(0.1, finite(targetDurationSeconds, 110));
    return {
      id: `${definition.id}:objective`, templateId: definition.id, type: 'boss', label: definition.label,
      status: 'active', completed: false, failed: false, failureReason: null,
      elapsed: 0, timeout, timeoutRemaining: timeout, progress: 0, target: 100, progressRatio: 0,
      phase: 'firewall', arena: { ...definition.arena }, safeZone: null,
      cleanup: [...definition.cleanupKinds], bossId: definition.id,
      firewallClears: 0, requiredQuadrants: definition.phases.firewall.requiredQuadrants,
      safeCellClears: 0, requiredSafeCells: definition.phases.trafficGrid.requiredSafeCells,
      destroyedNodes: 0, nodeCount: definition.phases.cloneNodes.nodeCount,
    };
  }

  function markedQuadrant() {
    const cycle = PROTOCOL_FIREWALL_ORDER[(Math.trunc(seed) + firewallIndex) & 3];
    const outer = (firewallIndex & 1) === 0;
    const radius = outer ? definition.phases.firewall.outerRadius : definition.phases.firewall.innerRadius;
    const angle = [Math.PI / 4, Math.PI * 3 / 4, Math.PI * 5 / 4, Math.PI * 7 / 4][cycle];
    return Object.freeze({
      index: cycle,
      xSign: cycle === 0 || cycle === 3 ? 1 : -1,
      ySign: cycle < 2 ? 1 : -1,
      shape: ['cut-corner-square', 'chevron', 'double-bar', 'open-diamond'][cycle],
      pulseBeat: firewallIndex % 4,
      radiusBand: outer ? 'outer' : 'inner',
      targetX: Math.cos(angle) * radius,
      targetY: Math.sin(angle) * radius * 0.68,
      sequence: firewallIndex + 1,
      requiresCenterHandshake: firewallAwaitingCenter,
      routeRevision: firewallRouteChanges,
    });
  }

  function firewallPrompt(marked = markedQuadrant()) {
    const horizontal = marked.xSign > 0 ? '右' : '左';
    const vertical = marked.ySign > 0 ? '上' : '下';
    return firewallAwaitingCenter
      ? `防火墙 ${marked.sequence}/4：先返回中心握手，再进入${horizontal}${vertical}${marked.radiusBand === 'outer' ? '外环' : '内环'}${marked.shape}`
      : `防火墙 ${marked.sequence}/4：进入${horizontal}${vertical}${marked.radiusBand === 'outer' ? '外环' : '内环'}${marked.shape}`;
  }

  function clearFirewallMarker(world) {
    if (firewallMarkerId && firewallMarkerKind) despawnOwned(world, firewallMarkerKind, firewallMarkerId);
    firewallMarkerId = 0;
    firewallMarkerKind = null;
  }

  function spawnFirewallMarker(world) {
    const marked = markedQuadrant();
    if (firewallMarkerId) {
      const existing = world.readInto(firewallMarkerId, read);
      if (existing?.type === 'protocol-firewall-marker') return true;
      owned[firewallMarkerKind]?.delete(firewallMarkerId);
      firewallMarkerId = 0;
      firewallMarkerKind = null;
    }
    const kind = PROTOCOL_FIREWALL_KINDS[marked.index];
    const id = spawnOwned(world, kind, {
      x: marked.targetX, y: marked.targetY, radius: definition.phases.firewall.targetTolerance,
      scale: 1.05, scaleX: marked.radiusBand === 'outer' ? 1.3 : 0.86,
      scaleY: marked.radiusBand === 'outer' ? 1.3 : 0.86,
      rotation: marked.shape === 'open-diamond' ? Math.PI / 4 : 0,
      team: 1, role: 'firewall-marker', type: 'protocol-firewall-marker',
      partId: `firewall-${marked.sequence}`, objective: kind === 'objective',
      objectiveType: kind === 'objective' ? 'protocol-firewall-marker' : null,
      invulnerable: true, collidable: false, contactDamaging: false, weakPoint: false,
      color: 0xb8ff45, variant: marked.shape, state: marked.radiusBand,
      sequence: marked.pulseBeat, phase: marked.pulseBeat, opacity: 1,
    });
    if (!id) return false;
    firewallMarkerId = id;
    firewallMarkerKind = kind;
    return true;
  }

  function setObjectiveProgress() {
    if (!objective) return;
    let ratio = 0;
    if (phase === 'firewall') ratio = 0.25 * firewallClears / definition.phases.firewall.requiredQuadrants;
    else if (phase === 'trafficGrid') ratio = 0.25 + 0.25 * safeCellClears / definition.phases.trafficGrid.requiredSafeCells;
    else if (phase === 'cloneNodes') {
      ratio = 0.5 + 0.3 * nodeDestroyed.reduce((sum, value) => sum + value, 0) / nodeDestroyed.length;
    } else if (phase === 'kernel') {
      const body = worldReference?.readInto?.(bodyId, read);
      ratio = 0.8 + 0.2 * (1 - clamp(finite(body?.hp, definition.phases.kernel.coreHp)
        / definition.phases.kernel.coreHp, 0, 1));
    } else if (phase === 'complete') ratio = 1;
    objective.phase = phase;
    objective.firewallClears = firewallClears;
    objective.safeCellClears = safeCellClears;
    objective.destroyedNodes = nodeDestroyed.reduce((sum, value) => sum + value, 0);
    if (phase === 'firewall') {
      const marked = markedQuadrant();
      objective.presentation = {
        kind: 'protocol-firewall', prompt: firewallPrompt(marked), sequence: marked.sequence,
        shape: marked.shape, radiusBand: marked.radiusBand, xSign: marked.xSign, ySign: marked.ySign,
        routeRevision: marked.routeRevision,
      };
    } else if (phase === 'trafficGrid') {
      objective.presentation = {
        kind: 'protocol-traffic-grid', prompt: '辨认唯一主节拍缺口；形状与离散节拍均为证据',
        rhythmStep: Math.floor(phaseElapsed / 0.25) & 3,
      };
    } else objective.presentation = { kind: `protocol-${phase}`, prompt: null };
    objective.progressRatio = clamp(ratio, 0, 1);
    objective.progress = objective.progressRatio * objective.target;
  }

  function publishPhase(events) {
    setObjectiveProgress();
    emit(events, 'boss:state', {
      bossId: definition.id, phase, firewallClears, safeCellClears,
      destroyedNodes: nodeDestroyed.reduce((sum, value) => sum + value, 0),
      safeRoute,
    });
    emit(events, 'boss:music-layer', {
      bossId: definition.id, phase, layer: definition.musicLayers[phase] ?? null,
    });
  }

  function spawnBody(world) {
    if (bodyId && world.readInto(bodyId, read)) return true;
    bodyId = spawnOwned(world, 'bossPart', {
      x: 0, y: 0, hp: definition.phases.kernel.coreHp, maxHp: definition.phases.kernel.coreHp,
      radius: definition.silhouette.bodyRadius, scale: definition.silhouette.bodyRadius,
      scaleX: 1.2, scaleY: 1.2, team: 2, role: 'boss', type: 'protocol-zero-body',
      partId: 'kernel', threat: 100, invulnerable: true, collidable: true,
      weakPoint: false, armored: true, color: definition.silhouette.bodyColor, variant: 'protocol-core',
    }, true);
    return bodyId > 0;
  }

  function clearSafeCellVisuals(world) {
    for (const kind of ['bossPart', 'enemy', 'objective']) {
      for (const id of [...owned[kind]]) {
        const entity = world?.readInto?.(id, read);
        if (entity?.type === 'protocol-safe-cell') despawnOwned(world, kind, id);
      }
    }
  }

  function clearTrafficAttackEntities(world) {
    for (const kind of ['warning', 'enemyHazard', 'enemyProjectile']) {
      for (const id of [...owned[kind]]) {
        const entity = world?.readInto?.(id, read);
        if (PROTOCOL_TRAFFIC_ATTACK_KINDS.has(entity?.attackKind)) despawnOwned(world, kind, id);
      }
    }
  }

  function generateSafeCells(world, player = null) {
    clearTrafficAttackEntities(world);
    clearSafeCellVisuals(world);
    const columns = definition.phases.trafficGrid.gridColumns;
    const rows = definition.phases.trafficGrid.gridRows;
    const count = columns * rows;
    const trueIndex = (Math.trunc(seed) + safeCellIndex * 5) % count;
    const falseShapes = definition.safeCellShapes.standardFalse;
    const candidates = Array.from({ length: count }, (_, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const truthful = index === trueIndex;
      const decoy = mode === 'abyss' && !truthful && (index + safeCellIndex) % 3 === 0;
      const shape = truthful
        ? definition.safeCellShapes.truthful
        : decoy
          ? definition.safeCellShapes.abyssDecoy[(index + safeCellIndex) % definition.safeCellShapes.abyssDecoy.length]
          : falseShapes[index % falseShapes.length];
      return Object.freeze({
        id: `safe-cell-${safeCellIndex}-${index}`,
        x: (column - 1) * 5.6,
        y: (row - 0.5) * 5.2,
        halfWidth: 1.35,
        halfHeight: 1.45,
        truthful,
        decoy,
        shape,
        pulseBeat: truthful ? 0 : decoy ? 2 : (index % 3) + 1,
      });
    });
    const spawned = [];
    for (const cell of candidates) {
      const kind = cell.truthful ? 'bossPart' : cell.decoy ? 'enemy' : 'objective';
      const id = spawnOwned(world, kind, {
        x: cell.x, y: cell.y, radius: 0.92,
        scale: 0.92,
        scaleX: cell.truthful ? 1.15 : cell.decoy ? 1 : 1.25,
        scaleY: cell.truthful ? 1.15 : cell.decoy ? 1 : 0.82,
        rotation: cell.decoy ? Math.PI / 4 : 0,
        team: 1,
        role: 'safe-cell',
        type: 'protocol-safe-cell',
        partId: cell.id,
        objective: kind === 'objective',
        objectiveType: 'protocol-safe-cell',
        invulnerable: true,
        collidable: false,
        contactDamaging: false,
        weakPoint: false,
        color: cell.truthful ? 0xb8ff45 : cell.decoy ? 0x936cff : 0x27e5ff,
        variant: cell.shape,
        state: cell.truthful ? 'truthful' : cell.decoy ? 'decoy' : 'false',
        sequence: cell.pulseBeat,
        opacity: cell.truthful ? 1 : 0.72,
      });
      if (!id) {
        for (const entry of spawned) despawnOwned(world, entry.kind, entry.id);
        safeCells = [];
        presentationRetries += 1;
        return false;
      }
      spawned.push({ kind, id });
    }
    safeCells = candidates;
    const truthful = candidates.find((cell) => cell.truthful);
    const start = player && Number.isFinite(player.x) && Number.isFinite(player.y)
      ? player
      : trafficCorridor?.target ?? { x: 0, y: 0 };
    trafficCorridor = createProtocolTrafficCorridor(
      start,
      truthful,
      definition.arena,
      definition.silhouette.bodyRadius,
      Math.max(0.2, finite(player?.radius, 0.4)),
    );
    safeRoute = Object.freeze({
      openLanes: 1,
      laneIndex: trueIndex % columns,
      evidence: 'unique-shape-and-primary-beat',
      start: trafficCorridor.start,
      target: trafficCorridor.target,
      waypoints: trafficCorridor.waypoints,
      clearance: trafficCorridor.clearance,
    });
    presentationBlockedSeconds = 0;
    return true;
  }

  function spawnNode(world, index) {
    if (nodeDestroyed[index]) return true;
    if (nodeIds[index] && world.readInto(nodeIds[index], read)) return true;
    const position = PROTOCOL_NODE_POSITIONS[index];
    const shape = definition.phases.cloneNodes.shapes[index];
    const kind = PROTOCOL_NODE_KINDS[index];
    const scale = shape === 'diamond'
      ? { scaleX: 0.92, scaleY: 0.92, rotation: 0 }
      : shape === 'hexagon'
        ? { scaleX: 1.08, scaleY: 1.08, rotation: 0 }
        : { scaleX: 1.18, scaleY: 1.18, rotation: 0 };
    nodeHp[index] = definition.phases.cloneNodes.nodeHp;
    nodeIds[index] = spawnOwned(world, kind, {
      ...position, ...scale, hp: nodeHp[index], maxHp: nodeHp[index], radius: 0.68, scale: 0.68,
      team: 2, role: 'boss', type: 'protocol-clone-node', partId: `node-${index + 1}`,
      objective: kind === 'objective', objectiveType: kind === 'objective' ? 'protocol-clone-node' : null,
      threat: 85 - index, invulnerable: false, collidable: true, weakPoint: true,
      armored: false, color: definition.silhouette.nodeColor, variant: shape,
    }, true);
    return nodeIds[index] > 0;
  }

  function generateCloneNodes(world) {
    const spawned = [];
    for (let index = 0; index < nodeIds.length; index += 1) {
      if (spawnNode(world, index)) {
        spawned.push(index);
        continue;
      }
      for (const spawnedIndex of spawned) {
        despawnOwned(world, PROTOCOL_NODE_KINDS[spawnedIndex], nodeIds[spawnedIndex]);
        nodeIds[spawnedIndex] = 0;
        nodeHp[spawnedIndex] = 0;
      }
      presentationRetries += 1;
      return false;
    }
    presentationBlockedSeconds = 0;
    return true;
  }

  function transition(nextPhase, world, events, player = null) {
    if (phase === nextPhase || clean) return false;
    phase = nextPhase;
    phaseElapsed = 0;
    attackTimer = 0;
    presentationBlockedSeconds = 0;
    if (phase !== 'firewall') clearFirewallMarker(world);
    if (phase === 'trafficGrid') generateSafeCells(world, player);
    else if (phase === 'cloneNodes') {
      clearSafeCellVisuals(world);
      safeCells = [];
      trafficCorridor = null;
      generateCloneNodes(world);
    } else if (phase === 'kernel') {
      for (let index = 0; index < nodeIds.length; index += 1) {
        if (nodeIds[index]) despawnOwned(world, PROTOCOL_NODE_KINDS[index], nodeIds[index]);
        nodeIds[index] = 0;
      }
      world.write(bodyId, {
        hp: definition.phases.kernel.coreHp, maxHp: definition.phases.kernel.coreHp,
        invulnerable: false, armored: false, weakPoint: true,
        color: definition.silhouette.kernelColor, variant: 'exposed-kernel',
      });
    }
    setObjectiveProgress();
    publishPhase(events);
    emit(events, 'boss:phase-changed', { bossId: definition.id, phase });
    return true;
  }

  function updateSafeCellRhythm(world) {
    const rhythmStep = Math.floor(phaseElapsed / 0.25) & 3;
    for (const kind of ['bossPart', 'enemy', 'objective']) {
      for (const id of owned[kind]) {
        const entity = world.readInto(id, read);
        if (entity?.type === 'protocol-safe-cell') world.write(id, { phase: rhythmStep });
      }
    }
  }

  function ensureProtocolPresentation(world, dt, events, player = null) {
    let ready = true;
    if (phase === 'firewall') ready = spawnFirewallMarker(world);
    else if (phase === 'trafficGrid') ready = safeCells.length > 0 || generateSafeCells(world, player);
    else if (phase === 'cloneNodes') ready = nodeIds.every((id, index) => nodeDestroyed[index] || (id && world.readInto(id, read)))
      || generateCloneNodes(world);
    if (ready) {
      presentationBlockedSeconds = 0;
      return true;
    }
    presentationBlockedSeconds += dt;
    if (presentationBlockedSeconds >= PROTOCOL_PRESENTATION_RETRY_SECONDS - EPSILON) {
      cleanup(world, events, 'boss-presentation-capacity');
    }
    return false;
  }

  function warningCap() {
    return definition.warningCap[mode];
  }

  function spawnWarning(world, data) {
    if (currentWarningCount() >= warningCap()) return 0;
    const duration = Math.max(finite(data.duration), behaviorContract.telegraphFloorSeconds);
    const id = spawnOwned(world, 'warning', {
      ...data, duration, lifetime: duration, age: 0, collidable: false,
      contactDamaging: false, state: 'telegraph', team: 2,
    });
    if (id) attackCounts.telegraph += 1;
    return id;
  }

  function spawnTrafficWarning(world, data) {
    if (trafficCorridor && boxIntersectsCorridor(data, trafficCorridor)) return 0;
    return spawnWarning(world, data);
  }

  function spawnTrafficWall(world) {
    const safeLane = clamp(Math.trunc(finite(safeRoute.laneIndex, 1)), 0, 2);
    let spawned = 0;
    for (let lane = 0; lane < 3; lane += 1) {
      if (lane === safeLane) continue;
      spawned += Boolean(spawnTrafficWarning(world, {
        x: (lane - 1) * 5.6, y: 0, rotation: 0, radius: 0.55,
        scaleX: 1.5, scaleY: 6.4, attackKind: 'traffic-wall',
        variant: 'oriented-box', color: 0xff4fd8,
        duration: definition.attacks.trafficWall.telegraphSeconds,
      }));
    }
    if (spawned) {
      attackCounts.trafficWall += 1;
      attacksSeen.add('traffic-wall');
    }
  }

  function spawnPredictiveBeams(world, player) {
    const safeLane = clamp(Math.trunc(finite(safeRoute.laneIndex, 1)), 0, 2);
    let spawned = 0;
    for (const lane of [0, 1, 2]) {
      if (lane === safeLane) continue;
      spawned += Boolean(spawnTrafficWarning(world, {
        x: (lane - 1) * 5.6,
        y: clamp(finite(player.y) + (lane === 0 ? -1.4 : 1.4), -4.8, 4.8),
        rotation: Math.PI / 2, radius: 0.35, scaleX: 3.4, scaleY: 0.55,
        attackKind: 'predictive-beam', variant: 'oriented-box', color: 0x936cff,
        duration: definition.attacks.predictiveBeam.telegraphSeconds,
      }));
    }
    if (spawned) {
      attackCounts.predictiveBeam += 1;
      attacksSeen.add('predictive-beam');
    }
  }

  function spawnGridLock(world) {
    const truthful = safeCells.find((cell) => cell.truthful);
    if (!truthful) return;
    let spawned = 0;
    for (const cell of safeCells) {
      if (cell.truthful || spawned >= warningCap()) continue;
      spawned += Boolean(spawnTrafficWarning(world, {
        x: cell.x, y: cell.y, radius: 0.4, scaleX: cell.halfWidth, scaleY: cell.halfHeight,
        attackKind: 'grid-lock', variant: 'oriented-box', color: 0xff4fd8,
        duration: definition.attacks.gridLock.telegraphSeconds,
      }));
    }
    if (spawned) {
      attackCounts.gridLock += 1;
      attacksSeen.add('grid-lock');
    }
  }

  function spawnCloneBurst(world) {
    let spawned = 0;
    for (let index = 0; index < nodeIds.length && spawned < warningCap(); index += 1) {
      if (nodeDestroyed[index]) continue;
      const node = world.readInto(nodeIds[index], read);
      if (!node) continue;
      const direction = normalized(-node.x, -node.y);
      spawned += Boolean(spawnWarning(world, {
        x: node.x + direction.x * 1.4, y: node.y + direction.y * 1.4,
        rotation: Math.atan2(direction.y, direction.x), radius: 0.35,
        scaleX: 4.2, scaleY: 0.55, attackKind: 'clone-burst',
        variant: 'oriented-box', color: definition.silhouette.nodeColor,
        duration: definition.attacks.cloneBurst.telegraphSeconds,
      }));
    }
    if (spawned) {
      attackCounts.cloneBurst += 1;
      attacksSeen.add('clone-burst');
      safeRoute = Object.freeze({ openLanes: 1, laneIndex: 1, evidence: 'between-distinct-node-rays' });
    }
  }

  function scheduleAttack(world, player) {
    if (attackTimer > 0 || phase === 'firewall') return;
    if (phase === 'trafficGrid') {
      if (attackCursor % 3 === 0) spawnGridLock(world);
      else if (attackCursor % 3 === 1) spawnTrafficWall(world);
      else spawnPredictiveBeams(world, player);
    } else if (phase === 'cloneNodes') {
      if (attackCursor % 2 === 0) spawnCloneBurst(world);
      else spawnPredictiveBeams(world, player);
    } else if (phase === 'kernel') {
      if (attackCursor % 2 === 0) spawnTrafficWall(world);
      else spawnPredictiveBeams(world, player);
    }
    attackCursor += 1;
    attackTimer = (phase === 'kernel' ? 1.7 : 2.1) * behaviorContract.recoveryMultiplier;
  }

  function updateOwnedLifetimes(world, dt) {
    for (const kind of ['warning', 'enemyHazard', 'enemyProjectile']) {
      for (const id of [...owned[kind]]) {
        const entity = world.readInto(id, read);
        if (!entity) {
          owned[kind].delete(id);
          continue;
        }
        const age = finite(entity.age) + dt;
        if (age < finite(entity.lifetime, Infinity) - EPSILON) {
          world.write(id, { age });
          continue;
        }
        if (kind === 'warning') {
          const hazardData = {
            x: entity.x, y: entity.y, rotation: entity.rotation, radius: entity.radius,
            scaleX: entity.scaleX, scaleY: entity.scaleY, team: 2,
            ownerId: bodyId, attackKind: entity.attackKind, role: 'boss',
            variant: entity.variant, color: entity.color, state: 'active', age: 0,
            lifetime: entity.attackKind === 'traffic-wall' ? 1.05 : 0.72,
            damage: 0.65, contactDamaging: true, collidable: true,
          };
          despawnOwned(world, kind, id);
          const hazardId = spawnOwned(world, 'enemyHazard', {
            ...hazardData,
          });
          if (hazardId) attackCounts.active += 1;
          continue;
        }
        despawnOwned(world, kind, id);
      }
    }
  }

  function updateFirewall(player, world, dt, events) {
    const marked = markedQuadrant();
    firewallStepElapsed += dt;
    if (firewallStepElapsed >= definition.phases.firewall.routeCounterSeconds) {
      firewallStepElapsed = 0;
      firewallRouteChanges += 1;
      setObjectiveProgress();
      emit(events, 'boss:firewall-route-counter', {
        bossId: definition.id, sequence: marked.sequence, routeRevision: firewallRouteChanges,
        prompt: firewallPrompt(marked),
      });
    }
    if (firewallAwaitingCenter) {
      if (Math.hypot(finite(player.x), finite(player.y)) > definition.phases.firewall.centerHandshakeRadius) return;
      firewallAwaitingCenter = false;
      firewallStepElapsed = 0;
      setObjectiveProgress();
      emit(events, 'boss:firewall-handshake', {
        bossId: definition.id, sequence: marked.sequence, prompt: firewallPrompt(marked),
      });
      return;
    }
    if (Math.hypot(finite(player.x) - marked.targetX, finite(player.y) - marked.targetY)
      > definition.phases.firewall.targetTolerance) return;
    firewallClears += 1;
    firewallIndex += 1;
    firewallAwaitingCenter = true;
    firewallStepElapsed = 0;
    clearFirewallMarker(world);
    emit(events, 'boss:firewall-cleared', {
      bossId: definition.id, clear: firewallClears, required: definition.phases.firewall.requiredQuadrants,
    });
    if (firewallClears >= definition.phases.firewall.requiredQuadrants) transition('trafficGrid', world, events, player);
    else {
      spawnFirewallMarker(world);
      setObjectiveProgress();
    }
  }

  function updateTrafficGrid(player, world, dt, events) {
    const truthful = safeCells.find((cell) => cell.truthful);
    if (!truthful) return;
    const inside = Math.abs(player.x - truthful.x) <= truthful.halfWidth
      && Math.abs(player.y - truthful.y) <= truthful.halfHeight;
    safeCellHold = inside ? safeCellHold + dt : 0;
    if (safeCellHold < definition.phases.trafficGrid.holdSeconds - EPSILON) return;
    safeCellHold = 0;
    safeCellClears += 1;
    safeCellIndex += 1;
    emit(events, 'boss:safe-cell-cleared', {
      bossId: definition.id, clear: safeCellClears, required: definition.phases.trafficGrid.requiredSafeCells,
      evidence: truthful.shape,
    });
    if (safeCellClears >= definition.phases.trafficGrid.requiredSafeCells) transition('cloneNodes', world, events, player);
    else generateSafeCells(world, player);
  }

  function applyDamageRecords(world, damageRecords, events) {
    for (const record of damageRecords) {
      if (!record) continue;
      const weaponId = damageWeaponKey(record.weaponId ?? record.sourceKind);
      damageByWeapon[weaponId] = finite(damageByWeapon[weaponId]) + Math.max(0, finite(record.amount));
      const nodeIndex = nodeIds.findIndex((id) => id && id === record.targetId);
      if (nodeIndex >= 0 && phase === 'cloneNodes' && !nodeDestroyed[nodeIndex]) {
        const entity = world.readInto(nodeIds[nodeIndex], read);
        nodeHp[nodeIndex] = Math.max(0, finite(record.hpAfter, entity?.hp ?? nodeHp[nodeIndex] - finite(record.amount)));
        if (record.destroyed || nodeHp[nodeIndex] <= EPSILON || !entity) {
          nodeDestroyed[nodeIndex] = 1;
          despawnOwned(world, PROTOCOL_NODE_KINDS[nodeIndex], nodeIds[nodeIndex]);
          nodeIds[nodeIndex] = 0;
          emit(events, 'boss:weak-point-destroyed', {
            bossId: definition.id, partId: `node-${nodeIndex + 1}`, shape: definition.phases.cloneNodes.shapes[nodeIndex],
          });
        }
      } else if (record.targetKind === 'bossPart' && record.targetId === bodyId && phase === 'kernel') {
        const body = world.readInto(bodyId, read);
        const hp = Math.max(0, finite(record.hpAfter, body?.hp ?? definition.phases.kernel.coreHp - finite(record.amount)));
        if (body) world.write(bodyId, { hp });
        if (record.destroyed || hp <= EPSILON || !body) {
          owned.bossPart.delete(bodyId);
          bodyId = 0;
          objective.status = 'completed';
          objective.completed = true;
          objective.failed = false;
          objective.failureReason = null;
          phase = 'complete';
          emit(events, 'boss:defeated', { bossId: definition.id });
          emit(events, 'objective:completed', cloneFrozen(objective));
        }
      }
    }
  }

  function cleanup(world = worldReference, events = null, reason = 'reset') {
    if (clean) return false;
    clean = true;
    cleanupReason = reason;
    if (world?.despawn) {
      for (const kind of PROTOCOL_OWNED_KINDS) {
        for (const id of [...owned[kind]]) despawnOwned(world, kind, id);
      }
    } else for (const kind of PROTOCOL_OWNED_KINDS) owned[kind].clear();
    bodyId = 0;
    firewallMarkerId = 0;
    firewallMarkerKind = null;
    nodeIds.fill(0);
    safeCells = [];
    trafficCorridor = null;
    if (objective && objective.status === 'active') {
      objective.status = 'failed';
      objective.completed = false;
      objective.failed = true;
      objective.failureReason = reason;
    }
    emit(events, 'boss:music-layer', { bossId: definition?.id ?? 'protocol-zero', phase: 'cleanup', layer: null });
    emit(events, 'objective:cleanup', {
      id: objective?.id ?? null, kinds: definition?.cleanupKinds ?? PROTOCOL_OWNED_KINDS,
      status: objective?.status ?? 'failed',
    });
    emit(events, 'boss:cleanup', { bossId: definition?.id ?? 'protocol-zero', reason });
    worldReference = null;
    return true;
  }

  function start(value, { targetDurationSeconds = 110, behaviorContract: contract = null } = {}) {
    definition = validateProtocolDefinition(value);
    behaviorContract = validateBehaviorContract(contract, mode);
    objective = protocolObjective(targetDurationSeconds);
    worldReference = null;
    phase = 'firewall';
    elapsed = 0;
    phaseElapsed = 0;
    bodyId = 0;
    attackTimer = 0;
    attackCursor = 0;
    firewallIndex = 0;
    firewallClears = 0;
    firewallMarkerId = 0;
    firewallMarkerKind = null;
    firewallAwaitingCenter = true;
    firewallStepElapsed = 0;
    firewallRouteChanges = 0;
    safeCellIndex = 0;
    safeCellHold = 0;
    safeCellClears = 0;
    safeCells = [];
    trafficCorridor = null;
    safeRoute = Object.freeze({ openLanes: 1, laneIndex: 1, evidence: 'marked-quadrant' });
    nodeIds.fill(0);
    nodeDestroyed.fill(0);
    nodeHp.fill(0);
    for (const kind of PROTOCOL_OWNED_KINDS) owned[kind].clear();
    attacksSeen.clear();
    for (const key of Object.keys(attackCounts)) attackCounts[key] = 0;
    for (const key of Object.keys(damageByWeapon)) delete damageByWeapon[key];
    clean = false;
    cleanupReason = null;
    spawnFailures = 0;
    maxOwnedEntityCount = 0;
    maxSimultaneousWarnings = 0;
    diagnosticReconciliations = 0;
    presentationBlockedSeconds = 0;
    presentationRetries = 0;
    updates = 0;
    return cloneFrozen(objective);
  }

  function update(context = {}, dt = 0, events = null) {
    const seconds = Number(dt);
    const world = context.world;
    if (!Number.isFinite(seconds) || seconds < 0) throw new TypeError('BossSystem dt must be non-negative finite');
    if (!definition || !objective || phase === 'idle') throw new Error('BossSystem must be started before update');
    if (clean || objective.status !== 'active') return Object.freeze({ phase, status: objective.status, changed: false });
    if (!world?.readInto || !world?.write || !world?.spawn || !world?.despawn) throw new TypeError('BossSystem requires EntityWorld');
    worldReference = world;
    // CollisionSystem may generation-safely despawn a lethal Boss part before
    // handing its immutable damage record to the Director in the same fixed
    // step. Consume that outcome against the retained handle before attempting
    // any capacity retry, otherwise a fresh kernel could replace the destroyed
    // one and orphan the real collision victory.
    applyDamageRecords(world, context.damageRecords ?? [], events);
    if (objective.status !== 'active') {
      setObjectiveProgress();
      updates += 1;
      return Object.freeze({ phase, status: objective.status, changed: true });
    }
    if (!spawnBody(world)) {
      cleanup(world, events, 'boss-spawn-capacity');
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
    updateOwnedLifetimes(world, seconds);
    if (!ensureProtocolPresentation(world, seconds, events, player) || objective.status !== 'active') {
      setObjectiveProgress();
      updates += 1;
      return Object.freeze({ phase, status: objective.status, changed: true });
    }
    if (phase === 'trafficGrid') updateSafeCellRhythm(world);
    if (objective.status === 'active' && phase === 'firewall') updateFirewall(player, world, seconds, events);
    else if (objective.status === 'active' && phase === 'trafficGrid') updateTrafficGrid(player, world, seconds, events);
    if (objective.status === 'active' && phase === 'cloneNodes' && nodeDestroyed.every((value) => value === 1)) {
      transition('kernel', world, events);
    }
    // Protocol Zero remains the sole mutable owner of its kernel flags. Reassert
    // the phase contract every fixed step so compatibility projections cannot
    // make the real weak point untargetable between collision passes.
    if (objective.status === 'active' && phase === 'kernel' && bodyId) {
      world.write(bodyId, {
        invulnerable: false,
        armored: false,
        weakPoint: true,
        color: definition.silhouette.kernelColor,
        variant: 'exposed-kernel',
      });
    }
    if (objective.status === 'active' && elapsed >= objective.timeout - EPSILON) cleanup(world, events, 'boss-timeout');
    else if (objective.status === 'active') scheduleAttack(world, player);
    setObjectiveProgress();
    updates += 1;
    maxOwnedEntityCount = Math.max(maxOwnedEntityCount, ownedCount());
    return Object.freeze({ phase, status: objective.status, changed: true });
  }

  function completeForDeterministicTest(events = null) {
    if (!objective || objective.status !== 'active') return false;
    objective.status = 'completed';
    objective.completed = true;
    objective.failed = false;
    objective.failureReason = null;
    objective.progress = objective.target;
    objective.progressRatio = 1;
    phase = 'complete';
    emit(events, 'objective:completed', cloneFrozen(objective));
    return true;
  }

  function getSnapshot() {
    reconcileOwned(worldReference);
    const body = worldReference?.readInto?.(bodyId, read);
    const nodes = Array.from({ length: nodeIds.length }, (_, index) => {
      const entity = worldReference?.readInto?.(nodeIds[index], read);
      return Object.freeze({
        index, entityId: nodeIds[index] || 0, destroyed: Boolean(nodeDestroyed[index]),
        hp: entity?.hp ?? nodeHp[index], maxHp: definition?.phases.cloneNodes.nodeHp ?? 0,
        weakPoint: entity?.weakPoint ?? phase === 'cloneNodes',
        invulnerable: entity?.invulnerable ?? phase !== 'cloneNodes',
        shape: definition?.phases.cloneNodes.shapes[index] ?? null,
      });
    }).filter(({ entityId, destroyed }) => entityId || destroyed);
    return Object.freeze({
      bossId: definition?.id ?? null, mode, phase, elapsed, phaseElapsed,
      firewall: Object.freeze({
        clears: firewallClears, markedQuadrant: markedQuadrant(), markerEntityId: firewallMarkerId,
        awaitingCenter: firewallAwaitingCenter, routeChanges: firewallRouteChanges,
      }),
      trafficGrid: Object.freeze({ clears: safeCellClears, hold: safeCellHold }),
      safeCells: Object.freeze([...safeCells]), safeRoute,
      destroyedNodes: nodeDestroyed.reduce((sum, value) => sum + value, 0),
      partsReady: Boolean(bodyId), spawnFailures, behaviorContract,
      parts: Object.freeze({
        body: Object.freeze({
          entityId: bodyId || 0, hp: body?.hp ?? 0, maxHp: definition?.phases.kernel.coreHp ?? 0,
          weakPoint: body?.weakPoint ?? phase === 'kernel',
          invulnerable: body?.invulnerable ?? phase !== 'kernel',
        }),
        nodes: Object.freeze(nodes),
      }),
      attacksSeen: Object.freeze([...attacksSeen]), attackCounts: Object.freeze({ ...attackCounts }),
      damageByWeapon: Object.freeze({ ...damageByWeapon }), ownedEntityCount: ownedCount(),
      maxOwnedEntityCount, maxSimultaneousWarnings, diagnosticReconciliations,
      presentationBlockedSeconds, presentationRetries,
      clean, cleanupReason, updates,
    });
  }

  return Object.freeze({
    start, update, cleanup, completeForDeterministicTest, getSnapshot,
    getObjective: () => cloneFrozen(objective),
  });
}

export function createBossSystem(options = {}) {
  let implementation = null;
  return Object.freeze({
    start(definitionValue = ABYSS_MAW, context = {}) {
      if (definitionValue?.id === 'abyss-maw') implementation = createAbyssMawBossSystem(options);
      else if (definitionValue?.id === 'protocol-zero') implementation = createProtocolZeroBossSystem(options);
      else throw new TypeError(`unsupported Boss definition: ${String(definitionValue?.id ?? 'missing')}`);
      return implementation.start(definitionValue, context);
    },
    update: (...args) => implementation?.update(...args)
      ?? (() => { throw new Error('BossSystem must be started before update'); })(),
    cleanup: (...args) => implementation?.cleanup(...args) ?? false,
    completeForDeterministicTest: (...args) => implementation?.completeForDeterministicTest(...args) ?? false,
    getSnapshot: (...args) => implementation?.getSnapshot(...args) ?? Object.freeze({
      bossId: null, phase: 'idle', clean: true, ownedEntityCount: 0,
    }),
    getObjective: (...args) => implementation?.getObjective(...args) ?? null,
  });
}
