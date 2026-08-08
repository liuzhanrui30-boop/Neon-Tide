import { ANTI_ORBIT_COUNTER_TEMPLATES } from '../content/encounters.js';
import { commitObjectiveShift, createObjectiveShiftPlan } from './objective-system.js';

const TAU = Math.PI * 2;
const EPSILON = 1e-9;
const DEFAULT_CAPACITY = 270;
const ANALYSIS_INTERVAL = 0.1;
const MIN_ROTATION_SECONDS = 3.5;
const MAX_RADIUS_VARIANCE = 0.15;
const STALLED_PROGRESS_DELTA = 0.01;
const ANGLE_NOISE = 0.001;
const MAX_NEUTRAL_SECONDS = 0.12;
const COUNTER_KINDS = Object.freeze(['intercept', 'reverse-wall', 'objective-shift', 'center-pulse']);
const COLORS = Object.freeze({
  preview: 0xffd166,
  danger: 0xff506f,
  safe: 0x78fff1,
  shift: 0xa56bff,
});

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const rounded = (value) => Math.round(value * 1e6) / 1e6;

function normalizeAngle(value) {
  let angle = value;
  while (angle > Math.PI) angle -= TAU;
  while (angle < -Math.PI) angle += TAU;
  return angle;
}

function cloneFrozen(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(cloneFrozen));
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneFrozen(entry)])));
}

function hashSeed(seed) {
  let value = Math.trunc(finite(seed, 0)) >>> 0;
  value ^= value >>> 16;
  value = Math.imul(value, 0x7feb352d);
  value ^= value >>> 15;
  value = Math.imul(value, 0x846ca68b);
  return (value ^ (value >>> 16)) >>> 0;
}

function emit(events, type, payload) {
  events?.emit?.(type, cloneFrozen(payload));
}

export function createRouteHistory(capacity = DEFAULT_CAPACITY) {
  if (!Number.isInteger(capacity) || capacity < 8 || capacity > 60 * 60) {
    throw new RangeError('route history capacity must be an integer from 8 to 3600');
  }
  const x = new Float64Array(capacity);
  const y = new Float64Array(capacity);
  const time = new Float64Array(capacity);
  const angle = new Float64Array(capacity);
  const radius = new Float64Array(capacity);
  const progress = new Float64Array(capacity);
  let start = 0;
  let length = 0;

  function pushValues(sampleX, sampleY, sampleTime, sampleAngle, sampleRadius, sampleProgress) {
    const index = length < capacity ? (start + length) % capacity : start;
    x[index] = sampleX;
    y[index] = sampleY;
    time[index] = sampleTime;
    angle[index] = sampleAngle;
    radius[index] = sampleRadius;
    progress[index] = sampleProgress;
    if (length < capacity) length += 1;
    else start = (start + 1) % capacity;
    return length;
  }

  function push(sample = {}) {
    const sampleX = finite(sample.x ?? sample.position?.x);
    const sampleY = finite(sample.y ?? sample.position?.y);
    const sampleAngle = Number.isFinite(Number(sample.angle))
      ? Number(sample.angle)
      : Number.isFinite(Number(sample.normalizedAngle))
        ? Number(sample.normalizedAngle)
        : Math.atan2(sampleY, sampleX);
    const sampleRadius = Number.isFinite(Number(sample.radius))
      ? Math.max(0, Number(sample.radius))
      : Number.isFinite(Number(sample.normalizedRadius))
        ? Math.max(0, Number(sample.normalizedRadius))
        : Math.hypot(sampleX, sampleY);
    return pushValues(
      sampleX,
      sampleY,
      finite(sample.time, length > 0 ? time[(start + length - 1) % capacity] : 0),
      sampleAngle,
      sampleRadius,
      finite(sample.progress),
    );
  }

  function logicalIndex(index) {
    return (start + index) % capacity;
  }

  function sampleAt(index) {
    if (!Number.isInteger(index) || index < 0 || index >= length) return null;
    const slot = logicalIndex(index);
    return {
      x: x[slot], y: y[slot], time: time[slot], angle: angle[slot], radius: radius[slot], progress: progress[slot],
    };
  }

  function clear() {
    start = 0;
    length = 0;
    return true;
  }

  return {
    capacity, x, y, time, angle, radius, progress,
    push,
    _pushValues: pushValues,
    clear,
    getOldest: () => sampleAt(0),
    getNewest: () => sampleAt(length - 1),
    get length() { return length; },
    _slot: logicalIndex,
  };
}

function countBits(value) {
  let bits = value;
  let count = 0;
  while (bits) {
    count += bits & 1;
    bits >>>= 1;
  }
  return count;
}

export function analyzeRoute(history, objectiveProgress = {}) {
  if (!history || !Number.isInteger(history.length) || typeof history._slot !== 'function') {
    throw new TypeError('analyzeRoute requires a route history');
  }
  if (history.length < 2) {
    return Object.freeze({ orbitPressure: 0, direction: 0, radiusVariance: 1, quadrantCoverage: 0, stalled: true });
  }

  let minimumRadius = Infinity;
  let maximumRadius = 0;
  let radiusTotal = 0;
  let direction = 0;
  let consistentSeconds = 0;
  let neutralSeconds = 0;
  let angularTravel = 0;
  let quadrantMask = 0;
  const oldestSlot = history._slot(0);
  const newestSlot = history._slot(history.length - 1);
  const duration = Math.max(0, history.time[newestSlot] - history.time[oldestSlot]);

  for (let index = 0; index < history.length; index += 1) {
    const slot = history._slot(index);
    const sampleRadius = Math.max(0, history.radius[slot]);
    minimumRadius = Math.min(minimumRadius, sampleRadius);
    maximumRadius = Math.max(maximumRadius, sampleRadius);
    radiusTotal += sampleRadius;
    const wrapped = ((history.angle[slot] % TAU) + TAU) % TAU;
    quadrantMask |= 1 << Math.min(3, Math.floor(wrapped / (Math.PI / 2)));
    if (index === 0) continue;
    const previousSlot = history._slot(index - 1);
    const dt = Math.max(0, history.time[slot] - history.time[previousSlot]);
    const delta = normalizeAngle(history.angle[slot] - history.angle[previousSlot]);
    if (dt <= 0) continue;
    if (Math.abs(delta) <= ANGLE_NOISE) {
      if (direction !== 0) {
        neutralSeconds += dt;
        if (neutralSeconds > MAX_NEUTRAL_SECONDS + EPSILON) {
          direction = 0;
          consistentSeconds = 0;
          neutralSeconds = 0;
        }
      }
      continue;
    }
    angularTravel += Math.abs(delta);
    const nextDirection = delta > 0 ? 1 : -1;
    if (nextDirection !== direction) {
      direction = nextDirection;
      consistentSeconds = dt;
    } else {
      consistentSeconds += neutralSeconds + dt;
    }
    neutralSeconds = 0;
  }

  if (neutralSeconds <= MAX_NEUTRAL_SECONDS + EPSILON) consistentSeconds += neutralSeconds;
  const meanRadius = radiusTotal / history.length;
  const radiusVariance = meanRadius > EPSILON ? (maximumRadius - minimumRadius) / meanRadius : 1;
  const delta = Number.isFinite(Number(objectiveProgress?.delta))
    ? Math.abs(Number(objectiveProgress.delta))
    : Math.abs(history.progress[newestSlot] - history.progress[oldestSlot]);
  const stalled = delta <= STALLED_PROGRESS_DELTA + EPSILON;
  const quadrantCoverage = countBits(quadrantMask);
  const qualifies = duration >= MIN_ROTATION_SECONDS - EPSILON
    && consistentSeconds >= MIN_ROTATION_SECONDS - EPSILON
    && angularTravel >= Math.PI * 0.75
    && radiusVariance < MAX_RADIUS_VARIANCE
    && stalled;
  const orbitPressure = qualifies ? (radiusVariance < 0.06 && quadrantCoverage >= 3 ? 2 : 1) : 0;
  return Object.freeze({ orbitPressure, direction, radiusVariance, quadrantCoverage, stalled });
}

function arenaAxes(objective) {
  const arena = objective?.arena ?? { halfWidth: 10.5, halfHeight: 7.2 };
  return {
    x: Math.max(2, finite(arena.halfWidth, 10.5) - 1.3),
    y: Math.max(2, finite(arena.halfHeight, 7.2) - 1.7),
  };
}

function routePoint(angle, normalizedRadius, axes) {
  return { x: rounded(Math.cos(angle) * axes.x * normalizedRadius), y: rounded(Math.sin(angle) * axes.y * normalizedRadius) };
}

function hazardNode(x, y, radius = 0.5, extra = {}) {
  return {
    x: rounded(x), y: rounded(y), radius, scale: radius,
    scaleX: 1, scaleY: 1, rotation: 0,
    state: 'telegraph', collidable: false, color: COLORS.preview,
    ...extra,
  };
}

function assignCounterNodeIds(objective, counter) {
  for (let index = 0; index < counter.geometry.length; index += 1) {
    const node = counter.geometry[index];
    let value = (Number(objective.seed) ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0;
    for (const character of `${counter.id}:${node.sequence ?? index}`) {
      value = Math.imul(value ^ character.charCodeAt(0), 16777619) >>> 0;
    }
    node.sourceId = 0x60000000 + (value % 0x0fffffff);
  }
  return counter;
}

function createIntercept({ id, tier, direction, player, objective, sampleAngle, sampleRadius, variant }) {
  const template = ANTI_ORBIT_COUNTER_TEMPLATES.intercept;
  const axes = arenaAxes(objective);
  const [minimum, maximum] = template.projectedAngleDegrees;
  const degrees = minimum + (variant % (maximum - minimum + 1));
  const projectedAngle = sampleAngle + direction * degrees * (Math.PI / 180);
  const projectedPoint = routePoint(projectedAngle, Math.max(0.25, sampleRadius), axes);
  const tx = -Math.sin(projectedAngle);
  const ty = Math.cos(projectedAngle);
  const geometry = Array.from({ length: template.routeNodes }, (_, index) => {
    const amount = (index / (template.routeNodes - 1)) * 2 - 1;
    return hazardNode(
      projectedPoint.x + tx * template.tangentHalfLength * amount,
      projectedPoint.y + ty * template.tangentHalfLength * amount,
      0.48,
      { role: 'counter-intercept', sequence: index },
    );
  });
  return {
    id, kind: 'intercept', tier, direction, phase: 'preview', elapsed: 0,
    previewSeconds: template.previewSeconds, activeSeconds: template.activeSeconds,
    recoverySeconds: template.recoverySeconds, requiresRouteChange: true,
    projectedAngle, projectedPoint, tangent: { x: tx, y: ty }, geometry,
    playerStart: { x: finite(player?.x), y: finite(player?.y) },
  };
}

function createReverseWall({ id, tier, direction, objective, sampleAngle, playerRadius, lowHull }) {
  const template = ANTI_ORBIT_COUNTER_TEMPLATES['reverse-wall'];
  const gapRadius = clamp(playerRadius * 0.58, 2.6, 5.4);
  const safeGap = { radius: rounded(gapRadius), width: template.safeGapWidth * (lowHull ? 1.4 : 1) };
  const axes = arenaAxes(objective);
  const maximumRadius = Math.min(axes.x, axes.y) + 3.4;
  const geometry = [];
  for (let index = 0; index < template.wallNodes; index += 1) {
    const distance = 1.2 + (index / (template.wallNodes - 1)) * (maximumRadius - 1.2);
    if (Math.abs(distance - safeGap.radius) < safeGap.width * 0.5) continue;
    geometry.push(hazardNode(0, 0, 0.52, {
      role: 'counter-reverse-wall', sequence: index, distance,
    }));
  }
  geometry.push(hazardNode(0, 0, safeGap.width * 0.42, {
    role: 'counter-reverse-gap', sequence: template.wallNodes + 1,
    distance: safeGap.radius, safe: true, color: COLORS.safe,
  }));
  return {
    id, kind: 'reverse-wall', tier, direction, phase: 'preview', elapsed: 0,
    previewSeconds: template.previewSeconds, activeSeconds: template.activeSeconds,
    recoverySeconds: template.recoverySeconds, requiresRouteChange: true,
    baseWallAngle: sampleAngle + direction * 0.7,
    wallAngle: sampleAngle + direction * 0.7, safeGap, geometry,
  };
}

function createObjectiveShift({ id, tier, direction, objective, variant }) {
  const template = ANTI_ORBIT_COUNTER_TEMPLATES['objective-shift'];
  const plan = createObjectiveShiftPlan(objective, { pathNodes: template.pathNodes, variant });
  if (!plan) return null;
  const geometry = plan.previewGeometry.map((entry, index) => hazardNode(entry.x, entry.y, entry.radius, {
    role: entry.role, sequence: index, color: COLORS.shift,
  }));
  return {
    id, kind: 'objective-shift', tier, direction, phase: 'preview', elapsed: 0,
    previewSeconds: template.telegraphSeconds, activeSeconds: template.activeSeconds,
    recoverySeconds: template.recoverySeconds, requiresRouteChange: true,
    targetSourceId: plan.targetSourceId, targetType: plan.targetType,
    path: plan.path, destination: plan.destination, transform: plan.transform,
    geometry, committed: false, plan,
  };
}

function createCenterPulse({ id, tier, direction, objective, lowHull }) {
  const template = ANTI_ORBIT_COUNTER_TEMPLATES['center-pulse'];
  return {
    id, kind: 'center-pulse', tier, direction, phase: 'preview', elapsed: 0,
    previewSeconds: template.previewSeconds, activeSeconds: template.activeSeconds,
    recoverySeconds: template.recoverySeconds, requiresRouteChange: true,
    centerSafeRadius: template.centerSafeRadius * (lowHull ? 1.25 : 1), safeMargin: template.safeMargin,
    playerCollisionRadius: template.playerCollisionRadius,
    window: 'edge-warning', ringRadius: 1,
    ringNodeCount: template.ringNodes,
    geometry: [
      ...Array.from({ length: template.ringNodes }, (_, index) => hazardNode(0, 0, 0.48, {
      role: 'counter-center-pulse', sequence: index,
      })),
      hazardNode(0, 0, template.centerSafeRadius * (lowHull ? 1.25 : 1), {
        role: 'counter-center-safe', sequence: template.ringNodes, safe: true,
        color: COLORS.safe, state: 'center-preview',
      }),
    ],
  };
}

function updateReverseWall(counter, objective) {
  const template = ANTI_ORBIT_COUNTER_TEMPLATES['reverse-wall'];
  const activeElapsed = Math.max(0, counter.elapsed - counter.previewSeconds);
  counter.wallAngle = counter.baseWallAngle - counter.direction * template.angularSpeed * activeElapsed;
  for (let index = 0; index < counter.geometry.length; index += 1) {
    const node = counter.geometry[index];
    node.x = rounded(Math.cos(counter.wallAngle) * node.distance);
    node.y = rounded(Math.sin(counter.wallAngle) * node.distance);
  }
}

function updateCenterPulse(counter, objective) {
  const template = ANTI_ORBIT_COUNTER_TEMPLATES['center-pulse'];
  const axes = arenaAxes(objective);
  const activeElapsed = clamp(counter.elapsed - counter.previewSeconds, 0, counter.activeSeconds);
  const amount = activeElapsed / counter.activeSeconds;
  const hazardRadius = counter.geometry[0]?.radius ?? 0.48;
  const minimumSafeRingRadius = (counter.centerSafeRadius + counter.playerCollisionRadius + counter.safeMargin + hazardRadius)
    / Math.min(axes.x, axes.y);
  counter.ringRadius = Math.max(1 - amount * 0.68, minimumSafeRingRadius);
  counter.window = activeElapsed <= template.edgeDangerSeconds
    ? 'edge-danger'
    : activeElapsed <= template.edgeDangerSeconds * 2
      ? 'center-safe'
      : 'edge-danger';
  for (let index = 0; index < counter.ringNodeCount; index += 1) {
    const angle = (index / counter.ringNodeCount) * TAU + counter.direction * activeElapsed * 0.12;
    const node = counter.geometry[index];
    node.x = rounded(Math.cos(angle) * axes.x * counter.ringRadius);
    node.y = rounded(Math.sin(angle) * axes.y * counter.ringRadius);
    node.color = COLORS.danger;
  }
  const safeMarker = counter.geometry[counter.ringNodeCount];
  safeMarker.x = 0;
  safeMarker.y = 0;
  safeMarker.state = counter.window === 'center-safe' ? 'center-safe' : 'center-preview';
  safeMarker.color = COLORS.safe;
}

function setCounterGeometryState(counter) {
  const active = counter.phase === 'active';
  for (let index = 0; index < counter.geometry.length; index += 1) {
    const node = counter.geometry[index];
    node.state = active ? (counter.window ?? 'active') : counter.phase === 'recovery' ? 'recovery' : 'telegraph';
    node.collidable = active && !node.safe && counter.kind !== 'objective-shift';
    if (node.safe) node.color = COLORS.safe;
    else if (counter.kind !== 'objective-shift') node.color = active ? COLORS.danger : COLORS.preview;
    if (counter.kind === 'center-pulse' && active && !node.safe) node.color = COLORS.danger;
  }
}

export function createAntiOrbitDirector({
  seed = 0,
  historyCapacity = DEFAULT_CAPACITY,
  cooldownSeconds = 7,
  preferredKind = null,
} = {}) {
  if (!Number.isFinite(Number(seed))) throw new TypeError('anti-orbit seed must be finite');
  if (!Number.isFinite(cooldownSeconds) || cooldownSeconds < 7) throw new RangeError('anti-orbit cooldown must be at least seven seconds');
  if (preferredKind !== null && !COUNTER_KINDS.includes(preferredKind)) throw new TypeError('unknown preferred counter kind');
  const history = createRouteHistory(historyCapacity);
  let currentSeed = Number(seed);
  let elapsed = 0;
  let analysisElapsed = 0;
  let activeCounter = null;
  let cooldownRemaining = 0;
  let countersStarted = 0;
  let countersCompleted = 0;
  let routeChangesRequired = 0;
  let lastAnalysis = Object.freeze({ orbitPressure: 0, direction: 0, radiusVariance: 1, quadrantCoverage: 0, stalled: true });
  let objectiveId = null;

  function attachObjectiveState(objective) {
    if (!objective) return null;
    if (!objective.antiOrbit || typeof objective.antiOrbit !== 'object') {
      objective.antiOrbit = {
        orbitPressure: 0,
        direction: 0,
        radiusVariance: 1,
        quadrantCoverage: 0,
        stalled: true,
        cooldownRemaining: 0,
        countersStarted: 0,
        activeCounter: null,
      };
    }
    return objective.antiOrbit;
  }

  function chooseKind(objective, tier) {
    if (preferredKind) {
      if (preferredKind !== 'objective-shift' || createObjectiveShiftPlan(objective)) return preferredKind;
    }
    const offset = hashSeed(currentSeed + Math.imul(tier + 1, 0x9e3779b1) + countersStarted) % COUNTER_KINDS.length;
    for (let index = 0; index < COUNTER_KINDS.length; index += 1) {
      const kind = COUNTER_KINDS[(offset + index) % COUNTER_KINDS.length];
      if (kind !== 'objective-shift' || createObjectiveShiftPlan(objective)) return kind;
    }
    return 'intercept';
  }

  function beginCounter(objective, player, analysis, events) {
    const newest = history.getNewest();
    if (!newest || activeCounter || cooldownRemaining > EPSILON) return false;
    const tier = Math.max(1, Math.min(4, analysis.orbitPressure + Math.floor(countersStarted / 2)));
    const kind = chooseKind(objective, tier);
    const id = `${objective?.id ?? 'room'}:anti-orbit:${countersStarted + 1}`;
    const variant = hashSeed(currentSeed + countersStarted * 37 + tier * 101);
    const axes = arenaAxes(objective);
    const physicalRadius = Math.hypot(finite(player?.x), finite(player?.y));
    const maximumHull = Math.max(EPSILON, finite(player?.maxHp ?? player?.maxHull, 1));
    const currentHull = clamp(finite(player?.hp ?? player?.hull, maximumHull), 0, maximumHull);
    const parameters = {
      id, tier, direction: analysis.direction || 1, player, objective,
      sampleAngle: newest.angle, sampleRadius: newest.radius,
      playerRadius: physicalRadius || Math.min(axes.x, axes.y), variant,
      lowHull: currentHull / maximumHull <= 0.4,
    };
    activeCounter = kind === 'intercept' ? createIntercept(parameters)
      : kind === 'reverse-wall' ? createReverseWall(parameters)
        : kind === 'objective-shift' ? createObjectiveShift(parameters)
          : createCenterPulse(parameters);
    if (!activeCounter) return false;
    assignCounterNodeIds(objective, activeCounter);
    countersStarted += 1;
    routeChangesRequired += 1;
    const state = attachObjectiveState(objective);
    if (state) activeCounter && (state.activeCounter = activeCounter);
    if (activeCounter.kind === 'reverse-wall') updateReverseWall(activeCounter, objective);
    if (activeCounter.kind === 'center-pulse') updateCenterPulse(activeCounter, objective);
    setCounterGeometryState(activeCounter);
    emit(events, 'anti-orbit:preview', { counter: snapshotCounter(activeCounter), analysis });
    return true;
  }

  function snapshotCounter(counter) {
    if (!counter) return null;
    const snapshot = {};
    for (const [key, value] of Object.entries(counter)) {
      if (key === 'plan') continue;
      snapshot[key] = value;
    }
    return cloneFrozen(snapshot);
  }

  function advanceCounter(objective, dt, events) {
    if (!activeCounter) return false;
    const counter = activeCounter;
    const previousPhase = counter.phase;
    counter.elapsed += dt;
    const activeAt = counter.previewSeconds;
    const recoveryAt = activeAt + counter.activeSeconds;
    const completeAt = recoveryAt + counter.recoverySeconds;
    if (counter.elapsed >= completeAt - EPSILON) {
      countersCompleted += 1;
      cooldownRemaining = cooldownSeconds;
      const completed = snapshotCounter(counter);
      activeCounter = null;
      const state = attachObjectiveState(objective);
      if (state) state.activeCounter = null;
      emit(events, 'anti-orbit:completed', { counter: completed, cooldownSeconds });
      return true;
    }
    counter.phase = counter.elapsed >= recoveryAt - EPSILON ? 'recovery'
      : counter.elapsed >= activeAt - EPSILON ? 'active' : 'preview';
    if (counter.kind === 'reverse-wall') updateReverseWall(counter, objective);
    else if (counter.kind === 'center-pulse') updateCenterPulse(counter, objective);
    if (counter.kind === 'objective-shift' && counter.phase === 'active' && !counter.committed) {
      counter.committed = commitObjectiveShift(objective, counter.plan);
      emit(events, 'anti-orbit:objective-shifted', {
        counterId: counter.id,
        targetSourceId: counter.targetSourceId,
        destination: counter.destination,
      });
    }
    setCounterGeometryState(counter);
    if (previousPhase !== counter.phase) emit(events, `anti-orbit:${counter.phase}`, { counter: snapshotCounter(counter) });
    return true;
  }

  function update(context = {}, dt = 0, events = null) {
    const seconds = Number(dt);
    if (!Number.isFinite(seconds) || seconds < 0) throw new TypeError('anti-orbit dt must be non-negative and finite');
    const objective = context.objective ?? null;
    const player = context.player ?? null;
    if (!objective || objective.status !== 'active' || !player) return getCompactSnapshot();
    if (objectiveId !== objective.id) {
      reset({ seed: currentSeed, objectiveId: objective.id });
    }
    elapsed += seconds;
    const axes = arenaAxes(objective);
    const x = finite(player.x ?? player.position?.x);
    const y = finite(player.y ?? player.position?.y);
    const normalizedAngle = Number.isFinite(Number(player.normalizedAngle))
      ? Number(player.normalizedAngle)
      : Math.atan2(y / axes.y, x / axes.x);
    const normalizedRadius = Number.isFinite(Number(player.normalizedRadius))
      ? Math.max(0, Number(player.normalizedRadius))
      : Math.hypot(x / axes.x, y / axes.y);
    history._pushValues(x, y, elapsed, normalizedAngle, normalizedRadius, finite(objective.progress));

    const completedNow = advanceCounter(objective, seconds, events);
    if (!activeCounter && !completedNow && cooldownRemaining > 0) cooldownRemaining = Math.max(0, cooldownRemaining - seconds);
    analysisElapsed += seconds;
    if (analysisElapsed >= ANALYSIS_INTERVAL - EPSILON) {
      analysisElapsed %= ANALYSIS_INTERVAL;
      const oldest = history.getOldest();
      const progressDelta = oldest ? objective.progress - oldest.progress : 0;
      lastAnalysis = analyzeRoute(history, { delta: progressDelta });
      if (!activeCounter && cooldownRemaining <= EPSILON && lastAnalysis.orbitPressure > 0) {
        beginCounter(objective, player, lastAnalysis, events);
      }
    }
    const state = attachObjectiveState(objective);
    state.orbitPressure = lastAnalysis.orbitPressure;
    state.direction = lastAnalysis.direction;
    state.radiusVariance = lastAnalysis.radiusVariance;
    state.quadrantCoverage = lastAnalysis.quadrantCoverage;
    state.stalled = lastAnalysis.stalled;
    state.cooldownRemaining = cooldownRemaining;
    state.countersStarted = countersStarted;
    state.activeCounter = activeCounter;
    return getCompactSnapshot();
  }

  function getCompactSnapshot() {
    return Object.freeze({
      orbitPressure: lastAnalysis.orbitPressure,
      direction: lastAnalysis.direction,
      active: Boolean(activeCounter),
      kind: activeCounter?.kind ?? null,
      cooldownRemaining,
      countersStarted,
      countersCompleted,
      routeChangesRequired,
    });
  }

  function getSnapshot() {
    return Object.freeze({
      analysis: lastAnalysis,
      activeCounter: snapshotCounter(activeCounter),
      cooldownRemaining,
      countersStarted,
      countersCompleted,
      routeChangesRequired,
      historyLength: history.length,
    });
  }

  function reset(options = {}) {
    if (Number.isFinite(Number(options.seed))) currentSeed = Number(options.seed);
    objectiveId = options.objectiveId ?? null;
    elapsed = 0;
    analysisElapsed = 0;
    activeCounter = null;
    cooldownRemaining = 0;
    countersStarted = 0;
    countersCompleted = 0;
    routeChangesRequired = 0;
    history.clear();
    lastAnalysis = Object.freeze({ orbitPressure: 0, direction: 0, radiusVariance: 1, quadrantCoverage: 0, stalled: true });
    return true;
  }

  return Object.freeze({ update, reset, getSnapshot, getCompactSnapshot });
}
