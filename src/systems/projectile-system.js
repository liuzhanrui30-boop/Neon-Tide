import { createEntityReadTarget } from '../game/entity-world.js';

const PROJECTILE_KINDS = Object.freeze(['friendlyProjectile', 'enemyProjectile']);
const DEFAULT_WORLD_LIMIT = 32;
const DEFAULT_DESPAWN_CAPACITY = 256;
const EPSILON = 1e-9;

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

function shortestAngleDelta(from, to) {
  let delta = (to - from) % (Math.PI * 2);
  if (delta > Math.PI) delta -= Math.PI * 2;
  if (delta < -Math.PI) delta += Math.PI * 2;
  return delta;
}

export function createProjectileSystem({
  worldLimit = DEFAULT_WORLD_LIMIT,
  despawnCapacity = DEFAULT_DESPAWN_CAPACITY,
} = {}) {
  const safeWorldLimit = clamp(finite(worldLimit, DEFAULT_WORLD_LIMIT), 1, 1_000_000);
  const safeDespawnCapacity = clamp(Math.trunc(finite(despawnCapacity, DEFAULT_DESPAWN_CAPACITY)), 1, 4_096);
  const despawnIds = new Float64Array(safeDespawnCapacity);
  const projectileRead = createEntityReadTarget();
  const targetRead = createEntityReadTarget();
  const ownerRead = createEntityReadTarget();
  const movementPatch = {
    previousX: 0,
    previousY: 0,
    previousZ: 0,
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    rotation: 0,
    previousRotation: 0,
    age: 0,
    orbitAngle: 0,
  };
  let updates = 0;
  let moved = 0;
  let despawned = 0;
  let overflowedDespawns = 0;

  function scheduleDespawn(id, count) {
    if (count >= safeDespawnCapacity) {
      overflowedDespawns += 1;
      return count;
    }
    despawnIds[count] = id;
    return count + 1;
  }

  function updateDrone(world, id, projectile, dt) {
    const owner = world.readInto(projectile.ownerId, ownerRead);
    if (!owner) return false;
    const angle = projectile.orbitAngle + finite(projectile.speed, 1.9) * dt;
    const radius = projectile.orbitRadius > 0 ? projectile.orbitRadius : 1.15;
    movementPatch.previousX = projectile.x;
    movementPatch.previousY = projectile.y;
    movementPatch.previousZ = projectile.z;
    movementPatch.x = owner.x + Math.cos(angle) * radius;
    movementPatch.y = owner.y + Math.sin(angle) * radius;
    movementPatch.z = owner.z + 0.04;
    movementPatch.vx = 0;
    movementPatch.vy = 0;
    movementPatch.vz = 0;
    movementPatch.previousRotation = projectile.rotation;
    movementPatch.rotation = angle + Math.PI / 2;
    movementPatch.age = projectile.age + dt;
    movementPatch.orbitAngle = angle;
    return world.write(id, movementPatch);
  }

  function updateProjectile(world, id, projectile, dt) {
    let vx = finite(projectile.vx);
    let vy = finite(projectile.vy);
    let vz = finite(projectile.vz);
    const target = projectile.homing && projectile.targetId
      ? world.readInto(projectile.targetId, targetRead)
      : null;
    if (target && target.hp > 0) {
      const desiredX = target.x - projectile.x;
      const desiredY = target.y - projectile.y;
      if (Math.hypot(desiredX, desiredY) > EPSILON) {
        const currentAngle = Math.hypot(vx, vy) > EPSILON
          ? Math.atan2(vy, vx)
          : Math.atan2(desiredY, desiredX);
        const desiredAngle = Math.atan2(desiredY, desiredX);
        const maximumTurn = Math.max(0, projectile.turnRate) * dt;
        const angle = currentAngle + clamp(shortestAngleDelta(currentAngle, desiredAngle), -maximumTurn, maximumTurn);
        const speed = projectile.maxSpeed > 0
          ? projectile.maxSpeed
          : projectile.speed > 0
            ? projectile.speed
            : Math.hypot(vx, vy);
        vx = Math.cos(angle) * speed;
        vy = Math.sin(angle) * speed;
      }
    }
    const x = projectile.x + vx * dt;
    const y = projectile.y + vy * dt;
    const z = projectile.z + vz * dt;
    movementPatch.previousX = projectile.x;
    movementPatch.previousY = projectile.y;
    movementPatch.previousZ = projectile.z;
    movementPatch.x = x;
    movementPatch.y = y;
    movementPatch.z = z;
    movementPatch.vx = vx;
    movementPatch.vy = vy;
    movementPatch.vz = vz;
    movementPatch.previousRotation = projectile.rotation;
    movementPatch.rotation = Math.hypot(vx, vy) > EPSILON ? Math.atan2(vy, vx) : projectile.rotation;
    movementPatch.age = projectile.age + dt;
    movementPatch.orbitAngle = projectile.orbitAngle;
    return world.write(id, movementPatch);
  }

  function update(world, dt, events = null) {
    if (!world?.query || !world?.readInto || !world?.write || !world?.despawn) {
      throw new TypeError('EntityWorld is required');
    }
    if (!Number.isFinite(dt) || dt <= 0) throw new TypeError('projectile dt must be positive and finite');
    let despawnCount = 0;
    let movedThisStep = 0;
    for (const kind of PROJECTILE_KINDS) {
      const query = world.query(kind);
      for (let index = 0; index < query.length; index += 1) {
        const id = query.at(index);
        const projectile = world.readInto(id, projectileRead);
        if (!projectile) continue;
        if (projectile.ownerKind === 'boss') continue;
        const lifetime = projectile.lifetime;
        const expired = lifetime > 0 && projectile.age + dt >= lifetime - EPSILON;
        const escaped = projectile.type !== 'arc-drone'
          && (Math.abs(projectile.x) > safeWorldLimit || Math.abs(projectile.y) > safeWorldLimit);
        if (expired || escaped) {
          despawnCount = scheduleDespawn(id, despawnCount);
          continue;
        }
        const changed = projectile.type === 'tide-lance'
          ? world.write(id, { age: projectile.age + dt })
          : projectile.type === 'arc-drone'
          ? updateDrone(world, id, projectile, dt)
          : updateProjectile(world, id, projectile, dt);
        if (changed) movedThisStep += 1;
      }
    }
    let despawnedThisStep = 0;
    for (let index = 0; index < despawnCount; index += 1) {
      if (world.despawn(despawnIds[index])) despawnedThisStep += 1;
    }
    if (despawnedThisStep > 0) {
      events?.emit?.('projectilesExpired', Object.freeze({ count: despawnedThisStep }));
    }
    moved += movedThisStep;
    despawned += despawnedThisStep;
    updates += 1;
    return Object.freeze({ moved: movedThisStep, despawned: despawnedThisStep });
  }

  function reset() {
    despawnIds.fill(0);
    return true;
  }

  function getStats() {
    return Object.freeze({ updates, moved, despawned, overflowedDespawns, worldLimit: safeWorldLimit });
  }

  return Object.freeze({ update, reset, getStats });
}
