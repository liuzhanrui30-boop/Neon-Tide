import { createEntityReadTarget } from '../game/entity-world.js';
import { ENEMY_ROLE_IDS, ENEMY_ROLES, getEnemyRole } from '../content/enemies.js';

const EPSILON = 1e-9;
const DEFAULT_ARENA = Object.freeze({ halfWidth: 10.5, halfHeight: 7.2 });
const TAU = Math.PI * 2;
const EXECUTION_STATES = new Set([
  'cut-dash', 'strike-dash', 'beam-active', 'detonate', 'wall-active', 'counter-active',
]);

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const normalize = (x, y, fallbackX = 0, fallbackY = 1) => {
  const length = Math.hypot(x, y);
  return length > EPSILON ? { x: x / length, y: y / length } : { x: fallbackX, y: fallbackY };
};

function frozen(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(frozen));
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, frozen(entry)])));
}

export function predictHunterTarget(enemy, player, { maximumLeadDistance = 3, maximumLeadSeconds = 0.75 } = {}) {
  const relativeDistance = Math.hypot(finite(player?.x) - finite(enemy?.x), finite(player?.y) - finite(enemy?.y));
  const speed = Math.max(0.1, finite(enemy?.speed, 3.2));
  const velocityX = finite(player?.vx);
  const velocityY = finite(player?.vy);
  const leadSeconds = Math.hypot(velocityX, velocityY) <= EPSILON
    ? maximumLeadSeconds
    : Math.min(maximumLeadSeconds, relativeDistance / speed * 0.35 + 0.18);
  const leadLength = Math.hypot(velocityX, velocityY) * leadSeconds;
  const scale = leadLength > maximumLeadDistance ? maximumLeadDistance / leadLength : 1;
  return Object.freeze({
    x: finite(player?.x) + velocityX * leadSeconds * scale,
    y: finite(player?.y) + velocityY * leadSeconds * scale,
    leadSeconds: Math.round(leadSeconds * 1e6) / 1e6,
  });
}

export function selectInterceptorCut(enemy, player, antiOrbit = null, random = Math.random, arena = DEFAULT_ARENA) {
  const sample = clamp(finite(random(), 0.5), 0, 0.999999);
  const angleDegrees = 35 + sample * 20;
  const direction = finite(antiOrbit?.direction, 0) || (finite(player?.vx) * finite(player?.y) - finite(player?.vy) * finite(player?.x) >= 0 ? 1 : -1);
  const baseAngle = Number.isFinite(Number(antiOrbit?.normalizedAngle))
    ? Number(antiOrbit.normalizedAngle)
    : Math.atan2(finite(player?.y), finite(player?.x));
  const angle = baseAngle + direction * angleDegrees * Math.PI / 180;
  const radius = clamp(finite(antiOrbit?.normalizedRadius, 0.86), 0.35, 0.95);
  const halfWidth = Math.max(2, finite(arena?.halfWidth, DEFAULT_ARENA.halfWidth) - 1.3);
  const halfHeight = Math.max(2, finite(arena?.halfHeight, DEFAULT_ARENA.halfHeight) - 1.2);
  return Object.freeze({
    x: Math.cos(angle) * halfWidth * radius,
    y: Math.sin(angle) * halfHeight * radius,
    angleDegrees,
    direction,
  });
}

function randomRange(random, range) {
  return range[0] + clamp(finite(random(), 0.5), 0, 0.999999) * (range[1] - range[0]);
}

function objectiveArena(objective) {
  return objective?.arena ?? DEFAULT_ARENA;
}

function contactRadius(role) {
  return role.id === 'bulwark' ? role.radius * 0.92 : role.radius;
}

function isPendingExecution(enemy) {
  return enemy.hp <= 0 && (enemy.executingTelegraph || EXECUTION_STATES.has(enemy.state));
}

export function createEnemySystem({
  random = Math.random,
  projectileCap = 96,
  warningCap = 3,
  worldLimit = 18,
} = {}) {
  if (typeof random !== 'function') throw new TypeError('enemy random must be a function');
  if (typeof warningCap !== 'function' && (!Number.isFinite(Number(warningCap)) || Number(warningCap) < 1)) {
    throw new TypeError('enemy warningCap must be a positive number or function');
  }
  const safeProjectileCap = clamp(Math.trunc(finite(projectileCap, 96)), 1, 96);
  const enemyRead = createEntityReadTarget();
  const playerRead = createEntityReadTarget();
  const auxiliaryRead = createEntityReadTarget();
  const mineRead = createEntityReadTarget();
  const movementPatch = {
    previousX: 0, previousY: 0, x: 0, y: 0, vx: 0, vy: 0,
    rotation: 0, previousRotation: 0, stateTimer: 0, telegraphTimer: 0,
    targetX: 0, targetY: 0, directionX: 0, directionY: 0,
    executingTelegraph: false, contactDamaging: false, armored: false, weakPoint: false,
  };
  const auxiliaryPatch = {
    previousX: 0, previousY: 0, x: 0, y: 0, age: 0, lifetime: 0,
    progress: 0, opacity: 0, collidable: false,
  };
  let sequence = 0;
  let warningSequence = 0;
  let updates = 0;
  let spawned = 0;
  let destroyed = 0;
  let rejectedSpawns = 0;
  let warningsSpawned = 0;
  let hazardsSpawned = 0;
  let projectilesSpawned = 0;
  let chainTriggers = 0;
  let executionProtected = 0;
  let cleanupCount = 0;

  function emit(events, type, payload) {
    events?.emit?.(type, frozen(payload));
  }

  function sourceIdFor(role, requested) {
    if (Number.isSafeInteger(requested) && requested > 0) return requested;
    let hash = (++sequence * 0x9e3779b1) >>> 0;
    for (const character of role) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
    return 0x20000000 + (hash % 0x1fffffff);
  }

  function spawnRole(world, roleId, overrides = {}) {
    const role = getEnemyRole(roleId);
    if (!role) throw new TypeError(`unknown enemy role: ${String(roleId)}`);
    const x = finite(overrides.x);
    const y = finite(overrides.y);
    const speed = Number.isFinite(Number(overrides.speed))
      ? clamp(Number(overrides.speed), role.speedRange[0], role.speedRange[1])
      : randomRange(random, role.speedRange);
    const stateByRole = {
      hunter: 'hunt', interceptor: 'approach', striker: 'track', lancer: 'lock',
      swarm: 'formation-merge', mine: 'deploy', warden: 'patrol', bulwark: 'chase',
    };
    const timerByRole = {
      hunter: 1.1, interceptor: 0, striker: 0.65, lancer: 0.9,
      swarm: 0.7, mine: 0.55, warden: 1.2, bulwark: 1.1,
    };
    const id = world.spawn('enemy', {
      x, y, previousX: x, previousY: y,
      vx: finite(overrides.vx), vy: finite(overrides.vy),
      hp: finite(overrides.hp, role.hp), maxHp: finite(overrides.maxHp, overrides.hp ?? role.hp),
      radius: role.radius, contactRadius: contactRadius(role), damage: role.damage,
      speed, maxSpeed: role.speedRange[1], turnRate: roleId === 'interceptor' ? 8 : 4.5,
      threat: role.threatCost, role: roleId, type: roleId, state: overrides.state ?? stateByRole[roleId],
      stateTimer: finite(overrides.stateTimer, timerByRole[roleId]),
      telegraphTimer: 0, duration: role.telegraphSeconds,
      sourceId: sourceIdFor(roleId, overrides.sourceId), parentId: finite(overrides.parentId),
      variantIndex: finite(overrides.variantIndex, sequence % 3),
      team: 2, color: role.color, opacity: 1,
      collidable: true, contactDamaging: !['lancer', 'mine', 'warden'].includes(roleId),
      armored: overrides.armored ?? roleId === 'bulwark', weakPoint: overrides.weakPoint ?? false, executingTelegraph: false,
      sequence: 0, counterToken: 0, dashToken: 0, lanceToken: 0,
    });
    if (id == null) rejectedSpawns += 1;
    else {
      spawned += 1;
      emit(overrides.events, 'enemy:spawned', { id, sourceId: world.get(id).sourceId, role: roleId });
    }
    return id;
  }

  function spawnWarning(world, owner, type, data = {}) {
    const id = world.spawn('warning', {
      x: finite(data.x, owner.x), y: finite(data.y, owner.y),
      previousX: finite(data.x, owner.x), previousY: finite(data.y, owner.y),
      rotation: finite(data.rotation), previousRotation: finite(data.rotation),
      scale: finite(data.scale, 1), scaleX: finite(data.scaleX, 1), scaleY: finite(data.scaleY, 1),
      radius: finite(data.radius, 0.25), duration: finite(data.duration, owner.duration),
      telegraphTimer: finite(data.duration, owner.duration), progress: 0,
      ownerId: owner.id, sourceId: owner.sourceId, warningGroup: ++warningSequence,
      role: data.role ?? owner.role, type, state: data.state ?? 'telegraph',
      color: data.color ?? 0xff9f43, opacity: finite(data.opacity, 0.72),
      team: 2, collidable: false, contactDamaging: false,
      directionX: finite(data.directionX), directionY: finite(data.directionY),
      sequence: finite(data.sequence),
    });
    if (id != null) warningsSpawned += 1;
    return id;
  }

  function spawnHazard(world, owner, data = {}) {
    const id = world.spawn('enemyHazard', {
      x: finite(data.x, owner.x), y: finite(data.y, owner.y),
      previousX: finite(data.x, owner.x), previousY: finite(data.y, owner.y),
      vx: finite(data.vx), vy: finite(data.vy),
      rotation: finite(data.rotation), previousRotation: finite(data.rotation),
      scale: finite(data.scale, 1), scaleX: finite(data.scaleX, 1), scaleY: finite(data.scaleY, 1),
      radius: finite(data.radius, 0.32), contactRadius: finite(data.contactRadius, data.radius ?? 0.32),
      damage: finite(data.damage, getEnemyRole(owner.role)?.damage ?? 1),
      lifetime: finite(data.lifetime, 0.8), age: 0,
      ownerId: owner.id, sourceId: owner.sourceId, role: data.role ?? owner.role,
      type: data.type ?? `${owner.role}-hazard`, state: data.state ?? 'active',
      color: data.color ?? 0xff506f, opacity: finite(data.opacity, 0.86),
      team: 2, collidable: data.collidable !== false, contactDamaging: data.collidable !== false,
      directionX: finite(data.directionX), directionY: finite(data.directionY),
      sequence: finite(data.sequence),
    });
    if (id != null) hazardsSpawned += 1;
    return id;
  }

  function spawnEnemyProjectile(world, owner, angle, options = {}) {
    if (world.query('enemyProjectile').length >= safeProjectileCap) return null;
    const speed = finite(options.speed, 3.2);
    const id = world.spawn('enemyProjectile', {
      x: owner.x, y: owner.y, previousX: owner.x, previousY: owner.y,
      vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed,
      speed, maxSpeed: speed, damage: finite(options.damage, getEnemyRole(owner.role)?.damage ?? 0.35),
      lifetime: finite(options.lifetime, 2.4), radius: finite(options.radius, 0.18),
      ownerId: owner.id, sourceId: owner.sourceId, ownerKind: 'enemy',
      role: owner.role, type: options.type ?? `${owner.role}-bolt`,
      team: 2, collidable: true, color: options.color ?? 0xff506f,
    });
    if (id != null) projectilesSpawned += 1;
    return id;
  }

  function removeOwned(world, ownerId, kinds = ['warning', 'enemyHazard']) {
    let removed = 0;
    for (const kind of kinds) {
      const query = world.query(kind);
      for (let index = query.length - 1; index >= 0; index -= 1) {
        const entity = world.readInto(query.at(index), auxiliaryRead);
        if (entity?.ownerId === ownerId && world.despawn(entity.id)) removed += 1;
      }
    }
    return removed;
  }

  function syncWarnings(world, owner, remaining, duration) {
    const progress = clamp(1 - remaining / Math.max(EPSILON, duration), 0, 1);
    const query = world.query('warning');
    for (let index = 0; index < query.length; index += 1) {
      const warning = world.readInto(query.at(index), auxiliaryRead);
      if (!warning || warning.ownerId !== owner.id) continue;
      world.write(warning.id, {
        telegraphTimer: Math.max(0, remaining), progress,
        opacity: warning.role?.includes('gap') || warning.type?.includes('gap') ? 0.92 : 0.5 + progress * 0.42,
      });
    }
  }

  function currentWarningCap() {
    const value = typeof warningCap === 'function' ? warningCap() : warningCap;
    return clamp(Math.trunc(finite(value, 3)), 1, 4);
  }

  function canBeginHighDamage(world, ownerId) {
    const warnedOwners = new Set();
    const query = world.query('warning');
    for (let index = 0; index < query.length; index += 1) {
      const warning = world.readInto(query.at(index), auxiliaryRead);
      if (!warning || !ENEMY_ROLES[warning.role]?.highDamage) continue;
      warnedOwners.add(warning.ownerId);
    }
    return warnedOwners.has(ownerId) || warnedOwners.size < currentWarningCap();
  }

  function beginInterceptor(world, enemy, player, objective) {
    const antiOrbit = objective?.antiOrbit?.analysis ?? objective?.antiOrbit ?? null;
    const cut = selectInterceptorCut(enemy, player, antiOrbit, random, objectiveArena(objective));
    removeOwned(world, enemy.id);
    const direction = normalize(cut.x - enemy.x, cut.y - enemy.y);
    world.write(enemy.id, {
      state: 'cut-telegraph', stateTimer: getEnemyRole('interceptor').telegraphSeconds,
      telegraphTimer: getEnemyRole('interceptor').telegraphSeconds, duration: getEnemyRole('interceptor').telegraphSeconds,
      targetX: cut.x, targetY: cut.y, directionX: direction.x, directionY: direction.y,
      value: cut.angleDegrees, executingTelegraph: true, contactDamaging: false,
    });
    spawnWarning(world, enemy, 'interceptor-cut', {
      x: (enemy.x + cut.x) * 0.5, y: (enemy.y + cut.y) * 0.5,
      rotation: Math.atan2(direction.y, direction.x), scaleX: Math.hypot(cut.x - enemy.x, cut.y - enemy.y), scaleY: 0.12,
      duration: getEnemyRole('interceptor').telegraphSeconds, color: 0xff506f,
    });
  }

  function beginStriker(world, enemy, player) {
    removeOwned(world, enemy.id);
    const base = Math.atan2(player.y - enemy.y, player.x - enemy.x);
    const selected = Math.abs(enemy.variantIndex) % 3;
    const offsets = [-0.22, 0, 0.22];
    for (let index = 0; index < 3; index += 1) {
      const angle = base + offsets[index];
      spawnWarning(world, enemy, 'striker-line', {
        rotation: angle, scaleX: 16, scaleY: index === selected ? 0.13 : 0.08,
        duration: getEnemyRole('striker').telegraphSeconds,
        color: index === selected ? 0xff506f : 0xff9f43, sequence: index,
      });
    }
    const dash = base + offsets[selected];
    world.write(enemy.id, {
      state: 'strike-telegraph', stateTimer: getEnemyRole('striker').telegraphSeconds,
      telegraphTimer: getEnemyRole('striker').telegraphSeconds, duration: getEnemyRole('striker').telegraphSeconds,
      directionX: Math.cos(dash), directionY: Math.sin(dash), executingTelegraph: true,
      contactDamaging: false, variantIndex: (selected + 1) % 3,
    });
  }

  function beginLancer(world, enemy, player) {
    removeOwned(world, enemy.id);
    const direction = normalize(player.x - enemy.x, player.y - enemy.y);
    spawnWarning(world, enemy, 'lancer-beam', {
      rotation: Math.atan2(direction.y, direction.x), scaleX: 18, scaleY: 0.16,
      duration: getEnemyRole('lancer').telegraphSeconds, color: 0xffd166,
    });
    world.write(enemy.id, {
      state: 'beam-telegraph', stateTimer: getEnemyRole('lancer').telegraphSeconds,
      telegraphTimer: getEnemyRole('lancer').telegraphSeconds, duration: getEnemyRole('lancer').telegraphSeconds,
      directionX: direction.x, directionY: direction.y, executingTelegraph: true,
      contactDamaging: false,
    });
  }

  function activateLancer(world, enemy, player) {
    removeOwned(world, enemy.id);
    const direction = normalize(enemy.directionX, enemy.directionY);
    const safeAlong = clamp((player.x - enemy.x) * direction.x + (player.y - enemy.y) * direction.y, 2.4, 6.2);
    const safeX = enemy.x + direction.x * safeAlong;
    const safeY = enemy.y + direction.y * safeAlong;
    const safeRadius = 1.35;
    for (let along = 0.9; along <= 15; along += 1.05) {
      const x = enemy.x + direction.x * along;
      const y = enemy.y + direction.y * along;
      if (Math.hypot(x - safeX, y - safeY) < safeRadius + 0.3) continue;
      spawnHazard(world, enemy, { x, y, radius: 0.28, lifetime: 0.8, type: 'lancer-beam-node' });
    }
    spawnHazard(world, enemy, {
      x: safeX, y: safeY, radius: safeRadius, lifetime: 0.8,
      role: 'safe-sector', type: 'lancer-safe-sector', color: 0x78fff1, opacity: 0.95, collidable: false,
    });
    const base = Math.atan2(direction.y, direction.x);
    for (const offset of [-0.2, 0, 0.2]) spawnEnemyProjectile(world, enemy, base + offset, { speed: 3.2 });
    world.write(enemy.id, {
      state: 'beam-active', stateTimer: 0.8, telegraphTimer: 0,
      executingTelegraph: false, contactDamaging: false,
    });
  }

  function beginMine(world, enemy, chained = false, delay = null) {
    removeOwned(world, enemy.id);
    const duration = delay ?? getEnemyRole('mine').telegraphSeconds;
    for (let index = 0; index < 8; index += 1) {
      const angle = index / 8 * TAU;
      spawnWarning(world, enemy, 'mine-ring', {
        x: enemy.x + Math.cos(angle) * 1.45, y: enemy.y + Math.sin(angle) * 1.45,
        rotation: angle, scaleX: 0.5, scaleY: 0.11, duration, color: 0xff9f43, sequence: index,
      });
    }
    world.write(enemy.id, {
      state: chained ? 'chain-telegraph' : 'arming', stateTimer: duration,
      telegraphTimer: duration, duration, executingTelegraph: true, contactDamaging: false,
    });
  }

  function chainMines(world, source) {
    const candidates = [];
    const query = world.query('enemy');
    for (let index = 0; index < query.length; index += 1) {
      const mine = world.readInto(query.at(index), mineRead);
      if (!mine || mine.id === source.id || mine.role !== 'mine' || mine.hp <= 0) continue;
      if (!['deploy', 'arming', 'chain-telegraph'].includes(mine.state)) continue;
      const distance = Math.hypot(mine.x - source.x, mine.y - source.y);
      if (distance <= 3.2) candidates.push({ id: mine.id, distance });
    }
    candidates.sort((left, right) => left.distance - right.distance || left.id - right.id);
    for (let index = 0; index < candidates.length; index += 1) {
      const mine = world.readInto(candidates[index].id, mineRead);
      if (!mine) continue;
      if (!canBeginHighDamage(world, mine.id)) continue;
      const delay = 0.45 + index * 0.12;
      if (mine.state === 'chain-telegraph' && mine.stateTimer >= delay) continue;
      beginMine(world, mine, true, Math.max(delay, mine.state === 'chain-telegraph' ? mine.stateTimer : 0));
      chainTriggers += 1;
    }
  }

  function detonateMine(world, enemy) {
    removeOwned(world, enemy.id, ['warning']);
    for (let index = 0; index < 12; index += 1) {
      const angle = index / 12 * TAU;
      spawnHazard(world, enemy, {
        x: enemy.x + Math.cos(angle) * 1.8, y: enemy.y + Math.sin(angle) * 1.8,
        radius: 0.38, lifetime: 0.78, type: 'mine-explosion', sequence: index,
      });
    }
    chainMines(world, enemy);
    world.write(enemy.id, {
      state: 'detonate', stateTimer: 0.78, telegraphTimer: 0,
      executingTelegraph: false, contactDamaging: false, collidable: false,
    });
  }

  function beginWarden(world, enemy, player) {
    removeOwned(world, enemy.id);
    const gapX = clamp(player.x, -5.8, 5.8);
    for (let x = -8.4; x <= 8.4; x += 1.2) {
      if (Math.abs(x - gapX) < 1.6) continue;
      spawnWarning(world, enemy, 'warden-wall-preview', {
        x, y: enemy.y, scaleX: 0.9, scaleY: 0.16,
        duration: getEnemyRole('warden').telegraphSeconds, color: 0xa56bff,
      });
    }
    spawnWarning(world, enemy, 'warden-gap', {
      x: gapX, y: enemy.y, scaleX: 2.4, scaleY: 0.2, radius: 1.2,
      duration: getEnemyRole('warden').telegraphSeconds, color: 0x78fff1, role: 'warden-gap',
    });
    world.write(enemy.id, {
      state: 'wall-telegraph', stateTimer: getEnemyRole('warden').telegraphSeconds,
      telegraphTimer: getEnemyRole('warden').telegraphSeconds, duration: getEnemyRole('warden').telegraphSeconds,
      targetX: gapX, directionX: enemy.variantIndex % 2 ? -1 : 1,
      executingTelegraph: true, contactDamaging: false, weakPoint: true,
    });
  }

  function activateWarden(world, enemy) {
    removeOwned(world, enemy.id);
    const velocity = (enemy.directionX || 1) * 1.2;
    const gapX = enemy.targetX;
    for (let x = -8.4; x <= 8.4; x += 1.2) {
      if (Math.abs(x - gapX) < 1.6) continue;
      spawnHazard(world, enemy, {
        x, y: enemy.y, vx: velocity, radius: 0.34, lifetime: 2.8,
        type: 'warden-wall-node', role: 'warden-wall',
      });
    }
    spawnHazard(world, enemy, {
      x: gapX, y: enemy.y, vx: velocity, radius: 1.2, lifetime: 2.8,
      type: 'warden-gap', role: 'warden-gap', color: 0x78fff1, opacity: 0.95, collidable: false,
    });
    world.write(enemy.id, {
      state: 'wall-active', stateTimer: 2.8, telegraphTimer: 0,
      executingTelegraph: false, weakPoint: false,
    });
  }

  function beginBulwarkCounter(world, enemy, token) {
    removeOwned(world, enemy.id);
    const role = getEnemyRole('bulwark');
    for (let index = 0; index < 10; index += 1) {
      const angle = index / 10 * TAU;
      spawnWarning(world, enemy, 'bulwark-counter-ring', {
        x: enemy.x + Math.cos(angle) * 1.4, y: enemy.y + Math.sin(angle) * 1.4,
        rotation: angle, scaleX: 0.52, scaleY: 0.12, duration: role.telegraphSeconds,
        color: 0x64f5ff, sequence: index,
      });
    }
    world.write(enemy.id, {
      state: 'counter-telegraph', stateTimer: role.telegraphSeconds,
      telegraphTimer: role.telegraphSeconds, duration: role.telegraphSeconds,
      executingTelegraph: true, contactDamaging: false, armored: true,
      counterToken: token,
    });
  }

  function activateBulwarkCounter(world, enemy) {
    removeOwned(world, enemy.id);
    for (let index = 0; index < 14; index += 1) {
      const angle = index / 14 * TAU;
      spawnHazard(world, enemy, {
        x: enemy.x + Math.cos(angle) * 1.1, y: enemy.y + Math.sin(angle) * 1.1,
        vx: Math.cos(angle) * 4.6, vy: Math.sin(angle) * 4.6,
        radius: 0.3, lifetime: 0.65, type: 'bulwark-counter-wave', sequence: index,
      });
    }
    world.write(enemy.id, {
      state: 'counter-active', stateTimer: 0.65, telegraphTimer: 0,
      executingTelegraph: false, contactDamaging: false,
    });
  }

  function applyBulwarkBreak(world, enemy, player) {
    if (enemy.role !== 'bulwark' || !player) return false;
    let token = 0;
    let damage = 0;
    if (player.dashTimer > 0 && player.attackKind === 'dash') {
      const dashToken = player.sequence >>> 0;
      if (dashToken !== enemy.dashToken && Math.hypot(player.x - enemy.x, player.y - enemy.y) <= player.radius + enemy.radius + 0.4) {
        token = dashToken;
        damage = 1;
        world.write(enemy.id, { dashToken });
      }
    } else if (player.attackKind === 'tide-lance' && player.sequence !== enemy.lanceToken) {
      const direction = normalize(player.directionX, player.directionY);
      const offsetX = enemy.x - player.x;
      const offsetY = enemy.y - player.y;
      const along = offsetX * direction.x + offsetY * direction.y;
      const across = Math.abs(offsetX * direction.y - offsetY * direction.x);
      if (along >= 0 && along <= 18 && across <= enemy.radius + 0.5) {
        token = player.sequence >>> 0;
        damage = 2;
        world.write(enemy.id, { lanceToken: token });
      }
    }
    if (!token || token === enemy.counterToken) return false;
    const hp = Math.max(0, enemy.hp - damage);
    world.write(enemy.id, { hp, armored: false, weakPoint: true });
    const updated = world.readInto(enemy.id, enemyRead);
    if (updated && hp > 0) {
      if (canBeginHighDamage(world, updated.id)) beginBulwarkCounter(world, updated, token);
      else world.write(updated.id, { state: 'counter-pending', stateTimer: 0.1, counterToken: token, contactDamaging: false });
    }
    return true;
  }

  function steer(world, enemy, targetX, targetY, dt, response = 4, speed = enemy.speed) {
    const direction = normalize(targetX - enemy.x, targetY - enemy.y);
    const blend = 1 - Math.exp(-response * dt);
    const vx = enemy.vx + (direction.x * speed - enemy.vx) * blend;
    const vy = enemy.vy + (direction.y * speed - enemy.vy) * blend;
    movementPatch.previousX = enemy.x;
    movementPatch.previousY = enemy.y;
    movementPatch.x = enemy.x + vx * dt;
    movementPatch.y = enemy.y + vy * dt;
    movementPatch.vx = vx;
    movementPatch.vy = vy;
    movementPatch.previousRotation = enemy.rotation;
    movementPatch.rotation = Math.atan2(vy, vx);
    movementPatch.stateTimer = Math.max(0, enemy.stateTimer - dt);
    movementPatch.telegraphTimer = enemy.telegraphTimer;
    movementPatch.targetX = targetX;
    movementPatch.targetY = targetY;
    movementPatch.directionX = direction.x;
    movementPatch.directionY = direction.y;
    movementPatch.executingTelegraph = enemy.executingTelegraph;
    movementPatch.contactDamaging = enemy.contactDamaging;
    movementPatch.armored = enemy.armored;
    movementPatch.weakPoint = enemy.weakPoint;
    world.write(enemy.id, movementPatch);
  }

  function updateHunter(world, enemy, player, dt) {
    const prediction = predictHunterTarget(enemy, player);
    steer(world, enemy, prediction.x, prediction.y, dt, 3.8);
  }

  function updateInterceptor(world, enemy, player, objective, dt) {
    if (enemy.state === 'approach') {
      if (canBeginHighDamage(world, enemy.id)) beginInterceptor(world, enemy, player, objective);
      else steer(world, enemy, player.x, player.y, dt, 2.4);
      return;
    }
    if (enemy.state === 'cut-telegraph') {
      const timer = Math.max(0, enemy.stateTimer - dt);
      syncWarnings(world, enemy, timer, enemy.duration);
      world.write(enemy.id, { stateTimer: timer, telegraphTimer: timer, vx: 0, vy: 0 });
      if (timer <= EPSILON) {
        removeOwned(world, enemy.id, ['warning']);
        world.write(enemy.id, {
          state: 'cut-dash', stateTimer: 0.78, telegraphTimer: 0,
          vx: enemy.directionX * enemy.speed, vy: enemy.directionY * enemy.speed,
          executingTelegraph: false, contactDamaging: true,
        });
      }
      return;
    }
    if (enemy.state === 'cut-dash') {
      movementPatch.previousX = enemy.x;
      movementPatch.previousY = enemy.y;
      movementPatch.x = enemy.x + enemy.vx * dt;
      movementPatch.y = enemy.y + enemy.vy * dt;
      movementPatch.vx = enemy.vx;
      movementPatch.vy = enemy.vy;
      movementPatch.previousRotation = enemy.rotation;
      movementPatch.rotation = Math.atan2(enemy.vy, enemy.vx);
      movementPatch.stateTimer = Math.max(0, enemy.stateTimer - dt);
      movementPatch.telegraphTimer = 0;
      movementPatch.targetX = enemy.targetX;
      movementPatch.targetY = enemy.targetY;
      movementPatch.directionX = enemy.directionX;
      movementPatch.directionY = enemy.directionY;
      movementPatch.executingTelegraph = false;
      movementPatch.contactDamaging = true;
      movementPatch.armored = false;
      movementPatch.weakPoint = false;
      world.write(enemy.id, movementPatch);
      if (enemy.stateTimer - dt <= EPSILON) world.write(enemy.id, { state: 'approach', stateTimer: 0.5, contactDamaging: false });
    }
  }

  function updateStriker(world, enemy, player, dt) {
    if (enemy.state === 'track') {
      if (enemy.stateTimer <= dt && canBeginHighDamage(world, enemy.id)) beginStriker(world, enemy, player);
      else steer(world, enemy, player.x, player.y, dt, 3.2);
      return;
    }
    if (enemy.state === 'strike-telegraph') {
      const timer = Math.max(0, enemy.stateTimer - dt);
      syncWarnings(world, enemy, timer, enemy.duration);
      world.write(enemy.id, { stateTimer: timer, telegraphTimer: timer, vx: 0, vy: 0 });
      if (timer <= EPSILON) {
        removeOwned(world, enemy.id, ['warning']);
        world.write(enemy.id, {
          state: 'strike-dash', stateTimer: 0.5, telegraphTimer: 0,
          vx: enemy.directionX * 10.5, vy: enemy.directionY * 10.5,
          executingTelegraph: false, contactDamaging: true,
        });
      }
      return;
    }
    if (enemy.state === 'strike-dash') {
      steer(world, enemy, enemy.x + enemy.vx, enemy.y + enemy.vy, dt, 0.1, Math.hypot(enemy.vx, enemy.vy));
      if (enemy.stateTimer <= dt) world.write(enemy.id, { state: 'track', stateTimer: 0.85, contactDamaging: false, vx: 0, vy: 0 });
    }
  }

  function updateLancer(world, enemy, player, dt) {
    if (enemy.state === 'lock') {
      if (enemy.stateTimer <= dt && canBeginHighDamage(world, enemy.id)) beginLancer(world, enemy, player);
      else steer(world, enemy, player.x, player.y, dt, 2.2);
      return;
    }
    if (enemy.state === 'beam-telegraph') {
      const timer = Math.max(0, enemy.stateTimer - dt);
      syncWarnings(world, enemy, timer, enemy.duration);
      world.write(enemy.id, { stateTimer: timer, telegraphTimer: timer, vx: 0, vy: 0 });
      if (timer <= EPSILON) activateLancer(world, enemy, player);
      return;
    }
    if (enemy.state === 'beam-active') {
      const timer = Math.max(0, enemy.stateTimer - dt);
      world.write(enemy.id, { stateTimer: timer });
      if (timer <= EPSILON) {
        removeOwned(world, enemy.id, ['enemyHazard']);
        world.write(enemy.id, { state: 'lock', stateTimer: 1.2 });
      }
    }
  }

  function updateSwarm(world, enemy, player, dt) {
    const timer = Math.max(0, enemy.stateTimer - dt);
    const sign = enemy.variantIndex % 2 ? 1 : -1;
    if (enemy.state === 'formation-merge') {
      const targetX = player.x + sign * 0.65;
      const targetY = player.y + (enemy.variantIndex - 1) * 0.5;
      steer(world, enemy, targetX, targetY, dt, 4.5, enemy.speed);
      if (timer <= EPSILON) world.write(enemy.id, { state: 'formation-split', stateTimer: 0.78 });
    } else {
      const direction = normalize(player.x - enemy.x, player.y - enemy.y);
      const targetX = player.x - direction.y * sign * 3.2;
      const targetY = player.y + direction.x * sign * 2.2;
      steer(world, enemy, targetX, targetY, dt, 4.8, enemy.speed);
      if (timer <= EPSILON) world.write(enemy.id, { state: 'formation-merge', stateTimer: 0.9 });
    }
  }

  function updateMine(world, enemy, player, dt) {
    if (enemy.state === 'deploy') {
      if ((enemy.stateTimer <= dt || Math.hypot(player.x - enemy.x, player.y - enemy.y) < 3.6)
        && canBeginHighDamage(world, enemy.id)) beginMine(world, enemy);
      else steer(world, enemy, player.x, player.y, dt, 3.5, enemy.speed);
      return;
    }
    if (enemy.state === 'arming' || enemy.state === 'chain-telegraph') {
      const timer = Math.max(0, enemy.stateTimer - dt);
      syncWarnings(world, enemy, timer, enemy.duration);
      world.write(enemy.id, { stateTimer: timer, telegraphTimer: timer, vx: 0, vy: 0 });
      if (timer <= EPSILON) detonateMine(world, enemy);
      return;
    }
    if (enemy.state === 'detonate') {
      const timer = Math.max(0, enemy.stateTimer - dt);
      world.write(enemy.id, { stateTimer: timer });
      if (timer <= EPSILON) destroyEnemy(world, enemy, 'mine-spent');
    }
  }

  function updateWarden(world, enemy, player, dt) {
    if (enemy.state === 'patrol') {
      if (enemy.stateTimer <= dt && canBeginHighDamage(world, enemy.id)) beginWarden(world, enemy, player);
      else steer(world, enemy, player.x * 0.4, clamp(player.y + 4, -5.4, 5.4), dt, 2.2);
      return;
    }
    if (enemy.state === 'wall-telegraph') {
      const timer = Math.max(0, enemy.stateTimer - dt);
      syncWarnings(world, enemy, timer, enemy.duration);
      world.write(enemy.id, { stateTimer: timer, telegraphTimer: timer, vx: 0, vy: 0 });
      if (timer <= EPSILON) activateWarden(world, enemy);
      return;
    }
    if (enemy.state === 'wall-active') {
      const timer = Math.max(0, enemy.stateTimer - dt);
      world.write(enemy.id, { stateTimer: timer });
      if (timer <= EPSILON) {
        removeOwned(world, enemy.id, ['enemyHazard']);
        world.write(enemy.id, { state: 'patrol', stateTimer: 1.5 });
      }
    }
  }

  function updateBulwark(world, enemy, player, dt) {
    if (applyBulwarkBreak(world, enemy, player)) return;
    if (enemy.state === 'counter-pending') {
      if (canBeginHighDamage(world, enemy.id)) beginBulwarkCounter(world, enemy, enemy.counterToken);
      else world.write(enemy.id, { stateTimer: Math.max(0, enemy.stateTimer - dt), vx: 0, vy: 0 });
      return;
    }
    if (enemy.state === 'chase') {
      steer(world, enemy, player.x, player.y, dt, 2.4, enemy.speed);
      return;
    }
    if (enemy.state === 'counter-telegraph') {
      const timer = Math.max(0, enemy.stateTimer - dt);
      syncWarnings(world, enemy, timer, enemy.duration);
      world.write(enemy.id, { stateTimer: timer, telegraphTimer: timer, vx: 0, vy: 0 });
      if (timer <= EPSILON) activateBulwarkCounter(world, enemy);
      return;
    }
    if (enemy.state === 'counter-active') {
      const timer = Math.max(0, enemy.stateTimer - dt);
      world.write(enemy.id, { stateTimer: timer });
      if (timer <= EPSILON) {
        removeOwned(world, enemy.id, ['enemyHazard']);
        world.write(enemy.id, { state: 'chase', stateTimer: 1.1, armored: true, weakPoint: false });
      }
    }
  }

  const stepDestroyed = [];
  function destroyEnemy(world, enemy, reason = 'destroyed') {
    removeOwned(world, enemy.id);
    if (!world.despawn(enemy.id)) return false;
    destroyed += 1;
    stepDestroyed.push(Object.freeze({ id: enemy.id, sourceId: enemy.sourceId, role: enemy.role, reason }));
    return true;
  }

  function updateAuxiliaries(world, dt, reliefActive = false) {
    const hazards = world.query('enemyHazard');
    for (let index = hazards.length - 1; index >= 0; index -= 1) {
      const hazard = world.readInto(hazards.at(index), auxiliaryRead);
      if (!hazard) continue;
      const age = hazard.age + dt;
      if (hazard.lifetime > 0 && age >= hazard.lifetime - EPSILON) {
        world.despawn(hazard.id);
        continue;
      }
      auxiliaryPatch.previousX = hazard.x;
      auxiliaryPatch.previousY = hazard.y;
      auxiliaryPatch.x = hazard.x + hazard.vx * dt;
      auxiliaryPatch.y = hazard.y + hazard.vy * dt;
      auxiliaryPatch.age = age;
      auxiliaryPatch.lifetime = hazard.lifetime;
      auxiliaryPatch.progress = hazard.lifetime > 0 ? clamp(age / hazard.lifetime, 0, 1) : 0;
      auxiliaryPatch.opacity = hazard.opacity;
      auxiliaryPatch.collidable = reliefActive && hazard.role !== 'safe-sector' && hazard.role !== 'warden-gap' ? false : hazard.collidable;
      world.write(hazard.id, auxiliaryPatch);
    }
  }

  function update(world, playerValue, objective, dt, events = null) {
    if (!world?.query || !world?.readInto || !world?.write || !world?.spawn || !world?.despawn) {
      throw new TypeError('EntityWorld is required');
    }
    if (!Number.isFinite(dt) || dt <= 0) throw new TypeError('enemy dt must be positive and finite');
    const player = Number.isSafeInteger(playerValue)
      ? world.readInto(playerValue, playerRead)
      : playerValue?.id ? world.readInto(playerValue.id, playerRead) ?? playerValue : playerValue;
    if (!player) return frozen({ destroyedRecords: [], active: world.query('enemy').length });
    stepDestroyed.length = 0;
    const reliefActive = finite(player.hp ?? player.hull, 1) / Math.max(1, finite(player.maxHp ?? player.maxHull, 1)) <= 0.4;
    updateAuxiliaries(world, dt, reliefActive);
    if (reliefActive) {
      const projectiles = world.query('enemyProjectile');
      for (let index = 0; index < projectiles.length; index += 1) world.write(projectiles.at(index), { collidable: false });
    }
    const query = world.query('enemy');
    const initialCount = query.length;
    for (let index = initialCount - 1; index >= 0; index -= 1) {
      const enemy = world.readInto(query.at(index), enemyRead);
      if (!enemy) continue;
      if (enemy.hp <= 0 && !isPendingExecution(enemy)) {
        destroyEnemy(world, enemy, 'damage');
        continue;
      }
      if (enemy.role === 'hunter') updateHunter(world, enemy, player, dt);
      else if (enemy.role === 'interceptor') updateInterceptor(world, enemy, player, objective, dt);
      else if (enemy.role === 'striker') updateStriker(world, enemy, player, dt);
      else if (enemy.role === 'lancer') updateLancer(world, enemy, player, dt);
      else if (enemy.role === 'swarm') updateSwarm(world, enemy, player, dt);
      else if (enemy.role === 'mine') updateMine(world, enemy, player, dt);
      else if (enemy.role === 'warden') updateWarden(world, enemy, player, dt);
      else if (enemy.role === 'bulwark') updateBulwark(world, enemy, player, dt);
      const fresh = world.readInto(enemy.id, enemyRead);
      if (!fresh) continue;
      if (fresh.hp <= 0 && isPendingExecution(fresh)) executionProtected += 1;
      if (reliefActive && fresh.contactDamaging) world.write(fresh.id, { contactDamaging: false });
      if (Math.abs(fresh.x) > worldLimit || Math.abs(fresh.y) > worldLimit) {
        world.write(fresh.id, { x: clamp(fresh.x, -worldLimit, worldLimit), y: clamp(fresh.y, -worldLimit, worldLimit), vx: -fresh.vx * 0.4, vy: -fresh.vy * 0.4 });
      }
    }
    if (reliefActive) {
      for (const kind of ['enemyHazard', 'enemyProjectile']) {
        const reliefQuery = world.query(kind);
        for (let index = 0; index < reliefQuery.length; index += 1) {
          const reliefEntity = world.readInto(reliefQuery.at(index), auxiliaryRead);
          if (reliefEntity?.collidable) world.write(reliefEntity.id, { collidable: false, contactDamaging: false });
        }
      }
    }
    for (const record of stepDestroyed) emit(events, 'enemy:destroyed', record);
    updates += 1;
    return frozen({ destroyedRecords: [...stepDestroyed], active: world.query('enemy').length });
  }

  function spawnWave(world, roles, options = {}) {
    if (!Array.isArray(roles)) throw new TypeError('wave roles must be an array');
    const arena = options.arena ?? DEFAULT_ARENA;
    const ids = [];
    const group = ++sequence;
    for (let index = 0; index < roles.length; index += 1) {
      const role = roles[index];
      if (!ENEMY_ROLE_IDS.includes(role)) continue;
      const side = (group + index) % 4;
      const amount = clamp(finite(random(), 0.5), 0.08, 0.92);
      let x = (amount * 2 - 1) * (arena.halfWidth - 0.7);
      let y = (amount * 2 - 1) * (arena.halfHeight - 0.7);
      if (side === 0) x = -arena.halfWidth + 0.4;
      else if (side === 1) x = arena.halfWidth - 0.4;
      else if (side === 2) y = -arena.halfHeight + 0.4;
      else y = arena.halfHeight - 0.4;
      const id = spawnRole(world, role, { x, y, parentId: group, variantIndex: index, events: options.events });
      if (id != null) ids.push(id);
    }
    return Object.freeze(ids);
  }

  function cleanup(world, { includeProjectiles = true } = {}) {
    let removed = 0;
    for (const kind of ['enemy', 'warning', 'enemyHazard', ...(includeProjectiles ? ['enemyProjectile'] : [])]) {
      const query = world.query(kind);
      for (let index = query.length - 1; index >= 0; index -= 1) if (world.despawn(query.at(index))) removed += 1;
    }
    cleanupCount += 1;
    return removed;
  }

  function reset() {
    sequence = 0;
    warningSequence = 0;
    stepDestroyed.length = 0;
    return true;
  }

  function getStats(world = null) {
    const roles = {};
    let activeWarnings = 0;
    let activeHazards = 0;
    if (world?.query) {
      const enemies = world.query('enemy');
      for (let index = 0; index < enemies.length; index += 1) {
        const enemy = world.readInto(enemies.at(index), enemyRead);
        if (enemy?.role) roles[enemy.role] = (roles[enemy.role] ?? 0) + 1;
      }
      activeWarnings = world.query('warning').length;
      activeHazards = world.query('enemyHazard').length;
    }
    return frozen({
      updates, spawned, destroyed, rejectedSpawns, warningsSpawned, hazardsSpawned,
      projectilesSpawned, chainTriggers, executionProtected, cleanupCount,
      activeWarnings, activeHazards, warningCap: currentWarningCap(), roles,
    });
  }

  return Object.freeze({ spawnRole, spawnWave, update, cleanup, reset, getStats });
}

const defaultEnemySystem = createEnemySystem();

export function updateEnemies(world, player, objective, dt, events) {
  return defaultEnemySystem.update(world, player, objective, dt, events);
}
