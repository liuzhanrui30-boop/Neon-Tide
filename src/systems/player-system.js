import { createEntityReadTarget } from '../game/entity-world.js';

export const FIXED_PLAYER_STEP = 1 / 60;
export const PERFECT_PHASE_WINDOW = 0.12;
export const PERFECT_PHASE_REFUND = 0.35;
export const AUTO_PULSE_INTERVAL = 0.55;
export const AUTO_PULSE_BUFF_MULTIPLIER = 0.75;

const MOVE_ACCELERATION = 17.5;
const TURN_ACCELERATION = 31;
const MOVE_DAMPING = 4.4;
const COAST_DAMPING = 6.2;
const MAX_SPEED = 6.15;
const DASH_SPEED = 16.2;
const DASH_DURATION = 0.19;
const PHASE_DURATION = 0.22;
const DASH_RECOVERY = 1.45;
const AUTO_FIRE_BUFF_DURATION = 0.8;
const CAMERA_RESPONSE = 5.5;
const CAMERA_MAX_LEAD = 0.72;
const CAMERA_VELOCITY_SCALE = 0.11;
const CAMERA_DEADZONE = 0.02;
const AUTO_TARGET_RANGE = 30;

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const approachZero = (value) => Math.max(0, value);

function vector(value, fallbackX = 0, fallbackY = 0) {
  return {
    x: Number.isFinite(value?.x) ? value.x : fallbackX,
    y: Number.isFinite(value?.y) ? value.y : fallbackY,
  };
}

function normalize(x, y) {
  const length = Math.hypot(x, y);
  if (length <= 1e-9) return { x: 0, y: 0, length: 0 };
  return { x: x / length, y: y / length, length };
}

function clampMagnitude(target, maximum) {
  const length = Math.hypot(target.x, target.y);
  if (length <= maximum || length === 0) return target;
  target.x = (target.x / length) * maximum;
  target.y = (target.y / length) * maximum;
  return target;
}

function emit(events, type, payload) {
  return events?.emit?.(type, Object.freeze({ ...payload })) ?? false;
}


export function selectAutomaticTarget(candidates, origin = { x: 0, y: 0 }) {
  if (!Array.isArray(candidates)) throw new TypeError('automatic target candidates must be an array');
  const originX = Number.isFinite(origin?.x) ? origin.x : 0;
  const originY = Number.isFinite(origin?.y) ? origin.y : 0;
  const ranked = candidates.flatMap((candidate, index) => {
    if (!candidate || candidate.visible === false || candidate.dead) return [];
    const x = Number(candidate.x);
    const y = Number(candidate.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
    const distance = Math.hypot(x - originX, y - originY);
    if (!Number.isFinite(distance) || distance > AUTO_TARGET_RANGE) return [];
    const threat = clamp(Number(candidate.threat) || 0, 0, 20);
    const priority = clamp(
      (candidate.weakPoint ? 100 : 0)
        + (candidate.type === 'boss' ? 60 : 0)
        + (candidate.executing ? 30 : 0)
        + threat,
      0,
      200,
    );
    const stableId = Number.isFinite(candidate.id) ? candidate.id : index;
    return [{ candidate, x, y, distance, priority, stableId }];
  });
  if (ranked.length === 0) return null;
  const hasPriority = ranked.some((entry) => entry.priority > 0);
  ranked.sort((left, right) => {
    if (hasPriority && right.priority !== left.priority) return right.priority - left.priority;
    if (left.distance !== right.distance) return left.distance - right.distance;
    return left.stableId - right.stableId;
  });
  const selected = ranked[0];
  const direction = normalize(selected.x - originX, selected.y - originY);
  return Object.freeze({
    mode: 'target',
    target: selected.candidate,
    score: selected.priority,
    distance: selected.distance,
    direction: Object.freeze({ x: direction.x, y: direction.y }),
  });
}

export function createPlayerState(overrides = {}) {
  const facing = vector(overrides.facing, 0, 1);
  const facingDirection = normalize(facing.x, facing.y);
  const dashCharges = Array.isArray(overrides.dashCharges) && overrides.dashCharges.length === 2
    ? overrides.dashCharges.map((charge) => clamp(Number(charge) || 0, 0, 1))
    : [1, 1];
  return {
    position: vector(overrides.position),
    velocity: vector(overrides.velocity),
    facing: facingDirection.length ? { x: facingDirection.x, y: facingDirection.y } : { x: 0, y: 1 },
    dashCharges,
    dashTimer: approachZero(Number(overrides.dashTimer) || 0),
    phaseTimer: approachZero(Number(overrides.phaseTimer) || 0),
    perfectPhaseWindow: clamp(Number(overrides.perfectPhaseWindow) || 0, 0, PERFECT_PHASE_WINDOW),
    autoFireRateBuffTimer: approachZero(Number(overrides.autoFireRateBuffTimer) || 0),
    autoFireTimer: Number.isFinite(overrides.autoFireTimer) && overrides.autoFireTimer > 0
      ? overrides.autoFireTimer
      : AUTO_PULSE_INTERVAL,
    autoShotsFired: Math.max(0, Math.trunc(Number(overrides.autoShotsFired) || 0)),
    maxSpeed: Number.isFinite(overrides.maxSpeed) && overrides.maxSpeed > 0 ? overrides.maxSpeed : MAX_SPEED,
    cameraLead: vector(overrides.cameraLead),
    bounds: overrides.bounds ? { ...overrides.bounds } : null,
  };
}

function startDash(player, input, events) {
  if (!input.dashPressed || player.dashTimer > 0) return false;
  const chargeIndex = player.dashCharges.findIndex((charge) => charge >= 1 - 1e-9);
  if (chargeIndex < 0) return false;
  const requested = normalize(input.moveX, input.moveY);
  const dashDirection = requested.length ? requested : normalize(player.facing.x, player.facing.y);
  player.dashCharges[chargeIndex] = 0;
  player.dashTimer = DASH_DURATION;
  player.phaseTimer = PHASE_DURATION;
  player.perfectPhaseWindow = PERFECT_PHASE_WINDOW;
  player.facing.x = dashDirection.x;
  player.facing.y = dashDirection.y;
  player.velocity.x = dashDirection.x * DASH_SPEED;
  player.velocity.y = dashDirection.y * DASH_SPEED;
  emit(events, 'player:dash', { chargeIndex, directionX: dashDirection.x, directionY: dashDirection.y });
  return true;
}

function updateMovement(player, input, dt) {
  const requested = normalize(input.moveX, input.moveY);
  const magnitude = Math.min(1, requested.length);
  const hasDirection = magnitude > 0.01;

  if (hasDirection) {
    const facingBlend = 1 - Math.exp(-TURN_ACCELERATION * 0.5 * dt);
    player.facing.x += (requested.x - player.facing.x) * facingBlend;
    player.facing.y += (requested.y - player.facing.y) * facingBlend;
    const normalizedFacing = normalize(player.facing.x, player.facing.y);
    player.facing.x = normalizedFacing.x;
    player.facing.y = normalizedFacing.y;
  }

  if (player.dashTimer > 0) return;
  if (!hasDirection) {
    const damping = Math.exp(-COAST_DAMPING * dt);
    player.velocity.x *= damping;
    player.velocity.y *= damping;
    return;
  }

  const speed = Math.hypot(player.velocity.x, player.velocity.y);
  if (speed > 0.05) {
    let steeringX = requested.x * speed - player.velocity.x;
    let steeringY = requested.y * speed - player.velocity.y;
    const steeringLength = Math.hypot(steeringX, steeringY);
    const maxSteering = TURN_ACCELERATION * dt;
    if (steeringLength > maxSteering) {
      steeringX = (steeringX / steeringLength) * maxSteering;
      steeringY = (steeringY / steeringLength) * maxSteering;
    }
    player.velocity.x += steeringX;
    player.velocity.y += steeringY;
  }
  player.velocity.x += requested.x * MOVE_ACCELERATION * magnitude * dt;
  player.velocity.y += requested.y * MOVE_ACCELERATION * magnitude * dt;
  const damping = Math.exp(-MOVE_DAMPING * 0.35 * dt);
  player.velocity.x *= damping;
  player.velocity.y *= damping;
  clampMagnitude(player.velocity, player.maxSpeed);
}

function updateBounds(player) {
  const bounds = player.bounds;
  if (!bounds) return;
  if (Number.isFinite(bounds.minX) && player.position.x < bounds.minX) {
    player.position.x = bounds.minX;
    player.velocity.x *= -0.25;
  } else if (Number.isFinite(bounds.maxX) && player.position.x > bounds.maxX) {
    player.position.x = bounds.maxX;
    player.velocity.x *= -0.25;
  }
  if (Number.isFinite(bounds.minY) && player.position.y < bounds.minY) {
    player.position.y = bounds.minY;
    player.velocity.y *= -0.25;
  } else if (Number.isFinite(bounds.maxY) && player.position.y > bounds.maxY) {
    player.position.y = bounds.maxY;
    player.velocity.y *= -0.25;
  }
}

function updateCameraLead(player, dt) {
  let targetX = player.velocity.x * CAMERA_VELOCITY_SCALE;
  let targetY = player.velocity.y * CAMERA_VELOCITY_SCALE;
  if (Math.hypot(targetX, targetY) <= CAMERA_DEADZONE) {
    targetX = 0;
    targetY = 0;
  }
  const target = clampMagnitude({ x: targetX, y: targetY }, CAMERA_MAX_LEAD);
  const blend = 1 - Math.exp(-CAMERA_RESPONSE * dt);
  player.cameraLead.x += (target.x - player.cameraLead.x) * blend;
  player.cameraLead.y += (target.y - player.cameraLead.y) * blend;
}

function updateAutomaticPulse(player, dt, events) {
  const buffed = player.autoFireRateBuffTimer > 0;
  const interval = AUTO_PULSE_INTERVAL * (buffed ? AUTO_PULSE_BUFF_MULTIPLIER : 1);
  player.autoFireTimer -= dt;
  let guard = 0;
  while (player.autoFireTimer <= 1e-9 && guard < 4) {
    player.autoShotsFired += 1;
    emit(events, 'player:autoPulse', {
      sequence: player.autoShotsFired,
      interval,
      buffed,
    });
    player.autoFireTimer += interval;
    guard += 1;
  }
}

export function updatePlayerState(player, input, dt, events = null) {
  if (!player || typeof player !== 'object') throw new TypeError('player state is required');
  if (!input || typeof input !== 'object') throw new TypeError('named action input is required');
  if (!Number.isFinite(dt) || dt <= 0) throw new TypeError('player dt must be positive and finite');

  player.dashTimer = approachZero(player.dashTimer - dt);
  player.phaseTimer = approachZero(player.phaseTimer - dt);
  player.perfectPhaseWindow = approachZero(player.perfectPhaseWindow - dt);
  updateAutomaticPulse(player, dt, events);
  player.autoFireRateBuffTimer = approachZero(player.autoFireRateBuffTimer - dt);
  for (let index = 0; index < 2; index += 1) {
    player.dashCharges[index] = clamp(player.dashCharges[index] + dt / DASH_RECOVERY, 0, 1);
  }

  startDash(player, input, events);
  updateMovement(player, input, dt);
  player.position.x += player.velocity.x * dt;
  player.position.y += player.velocity.y * dt;
  updateBounds(player);
  // Camera state is derived only after authoritative body movement. Presentation
  // shake can be added later without feeding back into position/collision.
  updateCameraLead(player, dt);
  return player;
}

export function resolvePlayerHit(player, session, events) {
  if (!player || typeof player !== 'object') throw new TypeError('player state is required');
  if (player.perfectPhaseWindow > 0) {
    player.perfectPhaseWindow = 0;
    player.phaseTimer = Math.max(player.phaseTimer, 0.08);
    const refundIndex = player.dashCharges[0] <= player.dashCharges[1] ? 0 : 1;
    const before = player.dashCharges[refundIndex];
    player.dashCharges[refundIndex] = clamp(before + PERFECT_PHASE_REFUND, 0, 1);
    player.autoFireRateBuffTimer = Math.max(player.autoFireRateBuffTimer, AUTO_FIRE_BUFF_DURATION);
    emit(events, 'perfectPhase', {
      refundIndex,
      refunded: player.dashCharges[refundIndex] - before,
      fireRateMultiplier: 0.75,
      duration: AUTO_FIRE_BUFF_DURATION,
    });
    return false;
  }
  const damaged = session?.damageHull?.(1) ?? false;
  if (damaged) emit(events, 'player:damaged', { amount: 1 });
  return Boolean(damaged);
}

const readTarget = createEntityReadTarget();

export function updatePlayer(world, session, input, dt, events) {
  if (!world?.query || !world?.readInto || !world?.write) throw new TypeError('EntityWorld is required');
  if (session?.snapshot && session.snapshot().mode !== 'playing') return null;
  const id = world.query('player').at(0);
  if (!Number.isSafeInteger(id) || !world.readInto(id, readTarget)) return null;
  const angle = Number.isFinite(readTarget.facing) ? readTarget.facing : Math.PI / 2;
  const state = createPlayerState({
    position: { x: readTarget.x, y: readTarget.y },
    velocity: { x: readTarget.vx, y: readTarget.vy },
    facing: { x: Math.cos(angle), y: Math.sin(angle) },
    dashCharges: [readTarget.dashCharge0, readTarget.dashCharge1],
    dashTimer: readTarget.dashTimer,
    phaseTimer: readTarget.phaseTimer,
    perfectPhaseWindow: readTarget.perfectPhaseWindow,
    autoFireRateBuffTimer: readTarget.fireTimer,
    autoFireTimer: readTarget.cooldown || AUTO_PULSE_INTERVAL,
    autoShotsFired: readTarget.value,
    maxSpeed: readTarget.maxSpeed || MAX_SPEED,
    cameraLead: { x: readTarget.cameraLeadX, y: readTarget.cameraLeadY },
  });
  updatePlayerState(state, input, dt, events);
  world.write(id, {
    previousX: readTarget.x,
    previousY: readTarget.y,
    x: state.position.x,
    y: state.position.y,
    vx: state.velocity.x,
    vy: state.velocity.y,
    facing: Math.atan2(state.facing.y, state.facing.x),
    dashCharges: state.dashCharges,
    dashTimer: state.dashTimer,
    phaseTimer: state.phaseTimer,
    perfectPhaseWindow: state.perfectPhaseWindow,
    fireTimer: state.autoFireRateBuffTimer,
    cooldown: state.autoFireTimer,
    value: state.autoShotsFired,
    cameraLeadX: state.cameraLead.x,
    cameraLeadY: state.cameraLead.y,
    maxSpeed: state.maxSpeed,
    invulnerable: state.phaseTimer > 0,
  });
  return id;
}
