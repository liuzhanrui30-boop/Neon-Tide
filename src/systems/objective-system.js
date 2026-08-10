import { OBJECTIVE_TYPES } from '../content/encounters.js';
import {
  DUAL_CRISIS_ESCALATION_MULTIPLIER,
  normalizeDualCrisisEscalationMultiplier,
} from '../game/campaign-pacing.js';

const EPSILON = 1e-9;
const TAU = Math.PI * 2;

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

function hashSeed(seed) {
  if (Number.isFinite(Number(seed))) return Math.trunc(Number(seed)) >>> 0;
  return String(seed ?? '').split('').reduce((hash, character) => Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0, 2166136261);
}

function createRandom(seed) {
  let state = hashSeed(seed) || 0x6d2b79f5;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function stableSourceId(seed, kind, index = 0) {
  let value = hashSeed(seed) ^ Math.imul(index + 1, 0x9e3779b1);
  for (const character of kind) value = Math.imul(value ^ character.charCodeAt(0), 16777619) >>> 0;
  return 0x20000000 + (value % 0x1fffffff);
}

function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positive(value, fallback) {
  const number = finite(value, fallback);
  return number > 0 ? number : fallback;
}

function point(x, y, extra = {}) {
  return { x: Math.round(x * 1e6) / 1e6, y: Math.round(y * 1e6) / 1e6, ...extra };
}

function shiftableTarget(objective) {
  if (objective?.type === 'anchors') return objective.anchors.find(({ completed }) => !completed) ?? null;
  if (objective?.type === 'core-harvest') return objective.cores.find(({ collected }) => !collected) ?? null;
  if (objective?.type === 'moving-zone') return objective.safeZone ?? null;
  if (objective?.type === 'escort') return objective.escort ?? null;
  if (objective?.type === 'dual-crisis') return objective.crises.find(({ completed }) => !completed) ?? null;
  return null;
}

const OBJECTIVE_SHIFT_MARGIN = 0.35;
const OBJECTIVE_SHIFT_AXIS_EPSILON = 0.25;
const OBJECTIVE_SHIFT_CENTER_PLACEMENT = 0.75;

function objectiveShiftGeometry(objective, target) {
  if (objective.type === 'moving-zone') {
    return { points: objective.path, clearance: positive(objective.safeZone?.radius, 1), translatesRoute: true };
  }
  if (objective.type === 'escort') {
    return { points: objective.escort.route, clearance: positive(objective.escort.supportRadius, 1), translatesRoute: true };
  }
  return { points: [target], clearance: positive(target.radius, 1), translatesRoute: false };
}

function transformBounds(points, arena, clearance, scaleX, scaleY) {
  const minimumX = -finite(arena.halfWidth, 10.5) + clearance + OBJECTIVE_SHIFT_MARGIN;
  const maximumX = finite(arena.halfWidth, 10.5) - clearance - OBJECTIVE_SHIFT_MARGIN;
  const minimumY = -finite(arena.halfHeight, 7.2) + clearance + OBJECTIVE_SHIFT_MARGIN;
  const maximumY = finite(arena.halfHeight, 7.2) - clearance - OBJECTIVE_SHIFT_MARGIN;
  return points.reduce((bounds, entry) => ({
    minimumTranslateX: Math.max(bounds.minimumTranslateX, minimumX - entry.x * scaleX),
    maximumTranslateX: Math.min(bounds.maximumTranslateX, maximumX - entry.x * scaleX),
    minimumTranslateY: Math.max(bounds.minimumTranslateY, minimumY - entry.y * scaleY),
    maximumTranslateY: Math.min(bounds.maximumTranslateY, maximumY - entry.y * scaleY),
  }), {
    minimumTranslateX: -Infinity, maximumTranslateX: Infinity,
    minimumTranslateY: -Infinity, maximumTranslateY: Infinity,
  });
}

function meaningfulAxisSign(coordinate, fallbackSign) {
  if (coordinate >= OBJECTIVE_SHIFT_AXIS_EPSILON) return 1;
  if (coordinate <= -OBJECTIVE_SHIFT_AXIS_EPSILON) return -1;
  return fallbackSign;
}

function chooseOppositeAxisTransform(coordinate, minimumTranslation, maximumTranslation, fallbackSign) {
  const sourceSign = meaningfulAxisSign(coordinate, fallbackSign);
  const destinationSign = -sourceSign;
  const baseDestination = -coordinate;
  const minimumDestination = baseDestination + minimumTranslation;
  const maximumDestination = baseDestination + maximumTranslation;
  const preferredMagnitude = Math.abs(coordinate) >= OBJECTIVE_SHIFT_AXIS_EPSILON
    ? Math.abs(coordinate)
    : OBJECTIVE_SHIFT_CENTER_PLACEMENT;
  const destination = destinationSign > 0
    ? Math.max(Math.max(OBJECTIVE_SHIFT_AXIS_EPSILON, minimumDestination), Math.min(maximumDestination, preferredMagnitude))
    : Math.min(Math.min(-OBJECTIVE_SHIFT_AXIS_EPSILON, maximumDestination), Math.max(minimumDestination, -preferredMagnitude));
  if (destination < minimumDestination - EPSILON || destination > maximumDestination + EPSILON
    || Math.sign(destination) !== destinationSign) return null;
  return { sourceSign, destinationSign, destination, translation: destination - baseDestination };
}

function transformShiftPoint(entry, transform) {
  return point(
    entry.x * transform.scaleX + transform.translateX,
    entry.y * transform.scaleY + transform.translateY,
  );
}

export function createObjectiveShiftPlan(objective, { pathNodes = 7, variant = 0 } = {}) {
  const target = shiftableTarget(objective);
  if (!target || !Number.isSafeInteger(target.sourceId)) return null;
  const arena = objective.arena ?? { halfWidth: 10.5, halfHeight: 7.2 };
  const sign = (Math.trunc(finite(variant, 0)) & 1) === 0 ? 1 : -1;
  const geometry = objectiveShiftGeometry(objective, target);
  const scaleX = -1;
  const scaleY = -1;
  const bounds = transformBounds(geometry.points, arena, geometry.clearance, scaleX, scaleY);
  const xTransform = chooseOppositeAxisTransform(
    target.x, bounds.minimumTranslateX, bounds.maximumTranslateX, sign,
  );
  const yTransform = chooseOppositeAxisTransform(
    target.y, bounds.minimumTranslateY, bounds.maximumTranslateY, -sign,
  );
  if (!xTransform || !yTransform) return null;
  const transform = {
    scaleX,
    scaleY,
    translateX: point(xTransform.translation, 0).x,
    translateY: point(0, yTransform.translation).y,
  };
  const destination = transformShiftPoint(target, transform);
  const count = Math.max(3, Math.min(12, Math.trunc(positive(pathNodes, 7))));
  const path = geometry.translatesRoute
    ? geometry.points.map((entry) => transformShiftPoint(entry, transform))
    : Array.from({ length: count }, (_, index) => {
      const amount = index / (count - 1);
      const curve = Math.sin(amount * Math.PI) * 0.65 * sign;
      return point(
        target.x + (destination.x - target.x) * amount + curve * (destination.y - target.y) * 0.12,
        target.y + (destination.y - target.y) * amount - curve * (destination.x - target.x) * 0.12,
      );
    });
  if (!geometry.translatesRoute) {
    path[0] = point(target.x, target.y);
    path[path.length - 1] = destination;
  }
  const destinationRadius = objective.type === 'moving-zone' ? positive(target.radius, 1)
    : objective.type === 'escort' ? 0.8 : Math.max(0.55, positive(target.radius, 0.55));
  const previewGeometry = [
    ...path.map((entry) => ({ ...entry, radius: 0.32, role: 'counter-shift-path' })),
    { ...destination, radius: destinationRadius, role: 'counter-shift-destination' },
  ];
  return {
    targetSourceId: target.sourceId,
    targetType: objective.type,
    transform,
    destination,
    sourceQuadrant: { x: xTransform.sourceSign, y: yTransform.sourceSign },
    destinationQuadrant: { x: xTransform.destinationSign, y: yTransform.destinationSign },
    axisEpsilon: OBJECTIVE_SHIFT_AXIS_EPSILON,
    safetyMargin: OBJECTIVE_SHIFT_MARGIN,
    translatesRoute: geometry.translatesRoute,
    path,
    previewGeometry,
  };
}

export function commitObjectiveShift(objective, plan) {
  if (!objective || !plan || !Number.isSafeInteger(plan.targetSourceId) || !Array.isArray(plan.path) || plan.path.length < 2) {
    return false;
  }
  const target = shiftableTarget(objective);
  if (!target || target.sourceId !== plan.targetSourceId) return false;
  const destination = plan.destination ?? plan.path.at(-1);
  const transform = plan.transform ?? {
    scaleX: 1,
    scaleY: 1,
    translateX: finite(plan.translation?.x, destination.x - target.x),
    translateY: finite(plan.translation?.y, destination.y - target.y),
  };
  if (objective.type === 'moving-zone') {
    for (const entry of objective.path) {
      const transformed = transformShiftPoint(entry, transform);
      entry.x = transformed.x;
      entry.y = transformed.y;
    }
  } else if (objective.type === 'escort') {
    for (const entry of objective.escort.route) {
      const transformed = transformShiftPoint(entry, transform);
      entry.x = transformed.x;
      entry.y = transformed.y;
    }
  }
  target.x = destination.x;
  target.y = destination.y;
  return true;
}

function radialPoints(random, count, radiusMin, radiusMax, offset = random() * TAU) {
  return Array.from({ length: count }, (_, index) => {
    const jitter = (random() - 0.5) * (TAU / Math.max(3, count)) * 0.35;
    const angle = offset + (index / count) * TAU + jitter;
    const radius = radiusMin + random() * (radiusMax - radiusMin);
    return point(Math.cos(angle) * radius, Math.sin(angle) * radius);
  });
}

function ellipticalRadialPoints(random, count, radiusMin, radiusMax, yScale = 0.45, offset = random() * TAU) {
  return Array.from({ length: count }, (_, index) => {
    const jitter = (random() - 0.5) * (TAU / Math.max(3, count)) * 0.35;
    const angle = offset + (index / count) * TAU + jitter;
    const radius = radiusMin + random() * (radiusMax - radiusMin);
    return point(Math.cos(angle) * radius, Math.sin(angle) * radius * yScale);
  });
}

function routeFromPoints(points) {
  let total = 0;
  return points.map((entry, index) => {
    if (index > 0) total += Math.hypot(entry.x - points[index - 1].x, entry.y - points[index - 1].y);
    return { ...entry, distance: Math.round(total * 1e6) / 1e6 };
  });
}

function interpolateRoute(route, distance, loop = false) {
  if (!route?.length) return point(0, 0);
  const total = route.at(-1).distance || 0;
  let target = loop && total > 0 ? ((distance % total) + total) % total : Math.max(0, Math.min(total, distance));
  for (let index = 1; index < route.length; index += 1) {
    const previous = route[index - 1];
    const next = route[index];
    if (target > next.distance + EPSILON) continue;
    const length = Math.max(EPSILON, next.distance - previous.distance);
    const amount = Math.max(0, Math.min(1, (target - previous.distance) / length));
    return point(previous.x + (next.x - previous.x) * amount, previous.y + (next.y - previous.y) * amount);
  }
  return point(route.at(-1).x, route.at(-1).y);
}

function distanceTo(player, target) {
  const x = finite(player?.x ?? player?.position?.x, Infinity);
  const y = finite(player?.y ?? player?.position?.y, Infinity);
  return Math.hypot(x - target.x, y - target.y);
}

export function getDataLaneEffect(lane = {}, player = {}) {
  const active = lane?.type === 'data-lane'
    && lane?.phase === 'active'
    && Math.abs(finite(player?.y ?? player?.position?.y) - finite(lane.laneCenter))
      <= Math.max(0, finite(lane.laneHalfWidth, 1));
  return Object.freeze({
    active,
    steeringMultiplier: active ? Math.max(0.5, Math.min(1, finite(lane.steeringMultiplier, 0.78))) : 1,
    dashRecoveryMultiplier: active
      ? Math.max(0.5, Math.min(1, finite(lane.dashRecoveryMultiplier, 0.65)))
      : 1,
    directDamage: 0,
  });
}

function eventInput(events) {
  if (Array.isArray(events)) return events;
  if (Array.isArray(events?.input)) return events.input;
  if (Array.isArray(events?.events)) return events.events;
  return [];
}

function emit(events, type, payload) {
  events?.emit?.(type, Object.freeze(clone(payload)));
}

function newEvents(objective, events, predicate) {
  const result = [];
  for (const event of eventInput(events)) {
    const payload = event?.payload ?? event ?? {};
    if (!predicate(event, payload)) continue;
    const sequence = Number(event?.sequence);
    if (Number.isSafeInteger(sequence) && sequence > 0) {
      if (objective._seenEventSequences.has(sequence)) continue;
      objective._seenEventSequences.add(sequence);
      objective._seenEventOrder.push(sequence);
      if (objective._seenEventOrder.length > 128) {
        objective._seenEventSequences.delete(objective._seenEventOrder.shift());
      }
    }
    const hasSemanticId = ['targetSourceId', 'sourceId', 'targetId', 'id']
      .some((key) => payload[key] !== undefined && payload[key] !== null);
    const identity = payload && typeof payload === 'object' ? payload : event;
    if (!hasSemanticId && identity && typeof identity === 'object') {
      if (objective._seenIdlessEventObjects.has(identity)) continue;
      objective._seenIdlessEventObjects.add(identity);
    }
    result.push(payload);
  }
  return result;
}

function destroyedTargetKey(payload) {
  for (const key of ['targetSourceId', 'sourceId', 'targetId', 'id']) {
    const value = payload?.[key];
    if (value !== undefined && value !== null) return `${typeof value}:${String(value)}`;
  }
  return null;
}

function markDestroyedTarget(objective, key) {
  if (key === null || objective._destroyedTargetIds.has(key)) return false;
  objective._destroyedTargetIds.add(key);
  objective._destroyedTargetOrder.push(key);
  if (objective._destroyedTargetOrder.length > 256) {
    objective._destroyedTargetIds.delete(objective._destroyedTargetOrder.shift());
  }
  return true;
}

function aggregateCount(payload, fallback = 1, maximum = Number.MAX_SAFE_INTEGER) {
  const value = payload?.count === undefined ? fallback : Math.trunc(finite(payload.count, 0));
  return Math.max(0, Math.min(maximum, value));
}

function findEliteTarget(objective, payload) {
  const candidates = [payload?.targetSourceId, payload?.sourceId, payload?.targetId, payload?.id]
    .filter((value) => value !== undefined && value !== null);
  return objective.eliteTargets.find((target) => (
    candidates.some((value) => target.sourceId === value || target.id === value)
  ));
}

function setupObjective(template, seed) {
  const random = createRandom(seed);
  const arena = clone(template.arena ?? { halfWidth: 10.5, halfHeight: 7.2 });
  const base = {
    id: template.id,
    templateId: template.id,
    type: template.type,
    label: template.label ?? template.id,
    seed: hashSeed(seed),
    status: 'active',
    completed: false,
    failed: false,
    failureReason: null,
    elapsed: 0,
    timeout: positive(template.timeout, 60),
    timeoutRemaining: positive(template.timeout, 60),
    progress: 0,
    target: 1,
    progressRatio: 0,
    pacing: template.campaignPacing ? clone(template.campaignPacing) : null,
    arena,
    safeZone: null,
    spawnHooks: clone(template.spawnHooks ?? []),
    cleanup: clone(template.cleanup ?? []),
    _spawned: false,
    _cleaned: false,
    _seenEventSequences: new Set(),
    _seenEventOrder: [],
    _seenIdlessEventObjects: new WeakSet(),
    _destroyedTargetIds: new Set(),
    _destroyedTargetOrder: [],
    _lastProgressEventKey: null,
    _snapshotCount: 0,
  };

  if (template.type === 'purge') {
    base.target = Math.max(1, Math.trunc(positive(template.killTarget, 18)));
  } else if (template.type === 'anchors') {
    const count = Math.max(2, Math.min(4, Math.trunc(positive(template.anchorCount, 3))));
    base.anchors = ellipticalRadialPoints(random, count, 3.5, 5.8).map((entry, index) => ({
      ...entry, id: `anchor-${index + 1}`, radius: positive(template.anchorRadius, 1.55),
      sourceId: stableSourceId(base.seed, 'anchor', index),
      charge: 0, requiredSeconds: positive(template.anchorSeconds, 1.4), completed: false,
    }));
    base.target = count;
  } else if (template.type === 'moving-zone') {
    const nodes = ellipticalRadialPoints(random, 5, 2.1, 5.4);
    nodes.push({ ...nodes[0] });
    base.path = routeFromPoints(nodes);
    base.pathSpeed = positive(template.pathSpeed, 2.2);
    base.routeDistance = random() * Math.max(0, base.path.at(-1).distance);
    base.safeZone = {
      ...interpolateRoute(base.path, base.routeDistance, true), radius: positive(template.zoneRadius, 2.15),
      kind: 'moving-zone', sourceId: stableSourceId(base.seed, 'moving-zone'),
    };
    base.target = positive(template.holdSeconds, 12);
  } else if (template.type === 'escort') {
    const angle = random() * TAU;
    const length = positive(template.escortDistance, 24);
    // Long campaign escorts trace multiple readable arena loops. The path owns
    // enough real distance for the authored work target instead of clamping a
    // 65-second contract to the old seven-second route.
    const routeNodeCount = Math.max(13, Math.ceil(length / 1.2) + 2);
    const route = routeFromPoints(Array.from({ length: routeNodeCount }, (_, index) => {
      const routeAngle = angle + index * (TAU / 8);
      return point(Math.cos(routeAngle) * 4, Math.sin(routeAngle) * 1.6);
    }));
    const start = interpolateRoute(route, 0);
    base.escort = {
      ...start, route, routeDistance: 0, routeLength: route.at(-1).distance,
      sourceId: stableSourceId(base.seed, 'escort'),
      speed: positive(template.escortSpeed, 2.4), supportRadius: positive(template.supportRadius, 2.8),
      hp: positive(template.escortHp, 12), maxHp: positive(template.escortHp, 12), completed: false,
    };
    base.target = positive(template.escortDistance, base.escort.routeLength);
  } else if (template.type === 'elite-hunt') {
    base.target = Math.max(1, Math.trunc(positive(template.eliteTarget, 2)));
    const targetHp = positive(template.eliteTargetHp, 6);
    base.eliteTargets = radialPoints(random, base.target, 3.2, 5.2).map((entry, index) => ({
      ...entry,
      id: `elite-${index + 1}`,
      sourceId: stableSourceId(base.seed, 'elite', index),
      hp: targetHp,
    }));
    base.eliteIds = base.eliteTargets.map(({ id }) => id);
  } else if (template.type === 'storm-corridor') {
    const count = Math.max(2, Math.trunc(positive(template.corridorSegments, 6)));
    const width = positive(template.corridorWidth, 2.7);
    const horizontal = random() >= 0.5;
    const direction = random() >= 0.5 ? 1 : -1;
    base.corridor = {
      horizontal, direction, width, activeSegment: direction > 0 ? 0 : count - 1,
      segments: Array.from({ length: count }, (_, index) => ({
        id: `storm-${index + 1}`,
        x: horizontal ? -arena.halfWidth + ((index + 0.5) / count) * arena.halfWidth * 2 : (random() - 0.5) * 4,
        y: horizontal ? (random() - 0.5) * 4 : -arena.halfHeight + ((index + 0.5) / count) * arena.halfHeight * 2,
        width,
      })),
    };
    base.target = positive(template.survivalSeconds, 18);
    const first = base.corridor.segments[direction > 0 ? 0 : count - 1];
    base.safeZone = { ...first, radius: width, kind: 'storm-corridor', sourceId: stableSourceId(base.seed, 'storm-active') };
    const nextIndex = direction > 0 ? Math.min(count - 1, 1) : Math.max(0, count - 2);
    base.nextSafeZone = { ...base.corridor.segments[nextIndex], radius: width, kind: 'storm-telegraph' };
    base.stormExposure = 0;
    base.stormGraceSeconds = positive(template.stormGraceSeconds, 2.5);
  } else if (template.type === 'core-harvest') {
    const count = Math.max(2, Math.trunc(positive(template.coreCount, 5)));
    base.activationDelay = positive(template.activationDelay, 0.75);
    base.coreActivationIntervalSeconds = Math.max(0, finite(template.coreActivationIntervalSeconds));
    base.cores = ellipticalRadialPoints(random, count, 2.6, 6).map((entry, index) => ({
      ...entry, id: `core-${index + 1}`, radius: positive(template.collectRadius, 1.15), collected: false,
      sourceId: stableSourceId(base.seed, 'core', index),
      activationAt: base.activationDelay + index * base.coreActivationIntervalSeconds,
    }));
    base.target = count;
  } else if (template.type === 'dual-crisis') {
    const rotation = random() * TAU;
    const variants = random() >= 0.5 ? ['containment', 'rescue'] : ['rescue', 'containment'];
    base.crises = [0, 1].map((index) => {
      const angle = rotation + index * Math.PI;
      return point(Math.cos(angle) * (4.4 + random()), Math.sin(angle) * (3.2 + random()), {
        id: `crisis-${index + 1}`, variant: variants[index], radius: positive(template.crisisRadius, 1.7),
        sourceId: stableSourceId(base.seed, 'crisis', index),
        charge: 0, requiredSeconds: positive(template.crisisSeconds, 3.2), completed: false, escalated: false,
      });
    });
    base.escalationSeconds = positive(template.escalationSeconds, 28);
    base.crisisEscalationMultiplier = normalizeDualCrisisEscalationMultiplier(
      template.crisisEscalationMultiplier ?? DUAL_CRISIS_ESCALATION_MULTIPLIER,
    );
    base.target = 2;
    base.choiceOrder = [];
  }
  return base;
}

export function createObjective(template, seed = 0) {
  if (!template || typeof template !== 'object' || Array.isArray(template)) throw new TypeError('objective template must be an object');
  if (!OBJECTIVE_TYPES.includes(template.type)) throw new TypeError(`unknown objective type: ${String(template.type)}`);
  return setupObjective(template, seed);
}

function updateProgress(objective) {
  objective.progress = Math.max(0, Math.min(objective.target, objective.progress));
  objective.progressRatio = objective.target > 0 ? Math.max(0, Math.min(1, objective.progress / objective.target)) : 0;
}

function finish(objective, events, status, reason = null) {
  if (objective.status !== 'active') return false;
  objective.status = status;
  objective.completed = status === 'completed';
  objective.failed = status === 'failed';
  objective.failureReason = reason;
  if (objective.completed) {
    objective.progress = objective.target;
    objective.progressRatio = 1;
  }
  if (events?.emit) {
    emit(events, status === 'completed' ? 'objective:completed' : 'objective:failed', getObjectiveSnapshot(objective));
  }
  if (!objective._cleaned) {
    objective._cleaned = true;
    emit(events, 'objective:cleanup', { id: objective.id, kinds: objective.cleanup, status });
  }
  return true;
}

// This hook is deliberately reachable only through an injected deterministic
// campaign-test authority. Production gameplay completes objectives through
// updateObjective and never receives the authority object.
export function completeObjectiveForDeterministicTest(objective, events = null) {
  if (!objective || typeof objective !== 'object' || Array.isArray(objective)) {
    throw new TypeError('deterministic objective completion requires objective authority');
  }
  return finish(objective, events, 'completed');
}

function updatePurge(objective, events) {
  const kills = newEvents(objective, events, (event) => ['enemy:destroyed', 'enemyDestroyed', 'kill'].includes(event?.type));
  for (const payload of kills) {
    const key = destroyedTargetKey(payload);
    if (key !== null) objective.progress += markDestroyedTarget(objective, key) ? 1 : 0;
    else objective.progress += aggregateCount(payload, 1, Math.max(0, objective.target - objective.progress));
  }
}

function updateAnchors(objective, player, dt) {
  const multiplier = Math.max(1, Math.min(1.6, Number(player?.buildStats?.objectiveProximityMultiplier) || 1));
  for (const anchor of objective.anchors) {
    if (anchor.completed || distanceTo(player, anchor) > anchor.radius) continue;
    anchor.charge = Math.min(anchor.requiredSeconds, anchor.charge + dt * multiplier);
    if (anchor.charge >= anchor.requiredSeconds - EPSILON) anchor.completed = true;
  }
  objective.progress = objective.anchors.filter(({ completed }) => completed).length;
}

function updateMovingZone(objective, player, dt) {
  objective.routeDistance += objective.pathSpeed * dt;
  Object.assign(objective.safeZone, interpolateRoute(objective.path, objective.routeDistance, true));
  if (distanceTo(player, objective.safeZone) <= objective.safeZone.radius) {
    objective.progress += dt * Math.max(1, Math.min(1.6, Number(player?.buildStats?.objectiveProximityMultiplier) || 1));
  }
}

function updateEscort(objective, player, dt, events) {
  const damage = newEvents(objective, events, (event) => ['escort:damaged', 'objective:damaged'].includes(event?.type));
  for (const payload of damage) objective.escort.hp = Math.max(0, objective.escort.hp - positive(payload.amount, 1));
  if (objective.escort.hp <= 0) return 'escort-destroyed';
  if (distanceTo(player, objective.escort) > objective.escort.supportRadius) return null;
  const stats = player?.buildStats ?? {};
  const repair = Math.max(0, Math.min(0.24, Number(stats.escortRepairPerSecond) || 0));
  objective.escort.hp = Math.min(objective.escort.maxHp, objective.escort.hp + repair * dt);
  const proximity = Math.max(1, Math.min(1.6, Number(stats.objectiveProximityMultiplier) || 1));
  objective.escort.routeDistance = Math.min(objective.escort.routeLength, objective.escort.routeDistance + objective.escort.speed * dt * proximity);
  Object.assign(objective.escort, interpolateRoute(objective.escort.route, objective.escort.routeDistance));
  objective.progress = objective.escort.routeDistance;
  objective.escort.completed = objective.progress >= objective.target - EPSILON;
  return null;
}

function updateElite(objective, events) {
  const kills = newEvents(objective, events, (event, payload) => (
    ['elite:destroyed', 'eliteDestroyed'].includes(event?.type)
    || (['enemy:destroyed', 'enemyDestroyed', 'kill'].includes(event?.type)
      && Boolean(findEliteTarget(objective, payload)))
  ));
  for (const payload of kills) {
    const key = destroyedTargetKey(payload);
    if (key !== null) {
      const target = findEliteTarget(objective, payload);
      if (target) objective.progress += markDestroyedTarget(objective, `number:${target.sourceId}`) ? 1 : 0;
      continue;
    }
    let remaining = aggregateCount(payload, 1, Math.max(0, objective.target - objective.progress));
    for (const target of objective.eliteTargets) {
      if (remaining <= 0) break;
      if (markDestroyedTarget(objective, `number:${target.sourceId}`)) {
        objective.progress += 1;
        remaining -= 1;
      }
    }
  }
}

function updateStorm(objective, player, dt) {
  if (player?.dead || finite(player?.hull, 1) <= 0 || finite(player?.hp, 1) <= 0) return 'player-destroyed';
  const count = objective.corridor.segments.length;
  let remaining = dt;
  // Segment the update so a large frame cannot skip every corridor gate while
  // the pilot remains parked in the first safe zone.
  while (remaining > EPSILON) {
    const step = Math.min(remaining, 0.1);
    if (distanceTo(player, objective.safeZone) <= objective.safeZone.radius) {
      objective.progress += step;
      objective.stormExposure = Math.max(0, objective.stormExposure - step * 2);
    } else {
      objective.progress = Math.max(0, objective.progress - step * 0.5);
      objective.stormExposure += step;
      if (objective.stormExposure >= objective.stormGraceSeconds - EPSILON) return 'storm-exposure';
    }
    const normalized = Math.min(0.999999, objective.progress / objective.target);
    const logical = Math.floor(normalized * count);
    const index = objective.corridor.direction > 0 ? logical : count - 1 - logical;
    objective.corridor.activeSegment = index;
    Object.assign(objective.safeZone, objective.corridor.segments[index]);
    const next = Math.max(0, Math.min(count - 1, index + objective.corridor.direction));
    Object.assign(objective.nextSafeZone, objective.corridor.segments[next]);
    remaining -= step;
  }
  return null;
}

function updateHarvest(objective, player, events) {
  const active = (core) => objective.elapsed >= finite(core.activationAt, objective.activationDelay) - EPSILON;
  if (objective.elapsed < objective.activationDelay - EPSILON) return;
  const collected = newEvents(objective, events, (event) => ['core:collected', 'pickupCollected'].includes(event?.type));
  for (const payload of collected) {
    const ids = Array.isArray(payload.ids) ? payload.ids : payload.id != null ? [payload.id] : [];
    for (const id of ids) {
      const core = objective.cores.find((entry) => entry.id === id || entry.sourceId === id);
      if (core && active(core)) core.collected = true;
    }
    let remaining = Math.max(0, Math.trunc(finite(payload.count, ids.length || 1)) - ids.length);
    while (remaining > 0) {
      const core = objective.cores.find((entry) => !entry.collected && active(entry));
      if (!core) break;
      core.collected = true;
      remaining -= 1;
    }
  }
  for (const core of objective.cores) {
    const pickupMultiplier = Math.max(1, Math.min(3, Number(player?.buildStats?.pickupRadiusMultiplier) || 1));
    if (!core.collected && active(core)
      && distanceTo(player, core) <= core.radius * pickupMultiplier) core.collected = true;
  }
  objective.progress = objective.cores.filter(({ collected: done }) => done).length;
}

function escalateDualCrises(objective) {
  for (const crisis of objective.crises) {
    if (crisis.completed || crisis.escalated) continue;
    crisis.escalated = true;
    crisis.requiredSeconds *= objective.crisisEscalationMultiplier;
  }
}

function chargeDualCrisis(objective, player, dt, multiplier) {
  if (dt <= EPSILON) return;
  for (const crisis of objective.crises) {
    if (crisis.completed || distanceTo(player, crisis) > crisis.radius) continue;
    crisis.charge = Math.min(crisis.requiredSeconds, crisis.charge + dt * multiplier);
    if (crisis.charge >= crisis.requiredSeconds - EPSILON) {
      crisis.completed = true;
      objective.choiceOrder.push(crisis.id);
    }
  }
}

function updateDualCrisis(objective, player, dt) {
  const multiplier = Math.max(1, Math.min(1.6, Number(player?.buildStats?.objectiveProximityMultiplier) || 1));
  const startElapsed = Math.max(0, objective.elapsed - dt);
  if (startElapsed < objective.escalationSeconds
    && objective.elapsed >= objective.escalationSeconds) {
    const beforeEscalation = Math.max(0, objective.escalationSeconds - startElapsed);
    chargeDualCrisis(objective, player, beforeEscalation, multiplier);
    escalateDualCrises(objective);
    chargeDualCrisis(objective, player, dt - beforeEscalation, multiplier);
  } else {
    if (startElapsed >= objective.escalationSeconds) escalateDualCrises(objective);
    chargeDualCrisis(objective, player, dt, multiplier);
  }
  objective.progress = objective.crises.filter(({ completed }) => completed).length;
}

export function updateObjective(objective, world, player, dt, events = null) {
  if (!objective || typeof objective !== 'object') throw new TypeError('objective must be an objective object');
  const seconds = Number(dt);
  if (!Number.isFinite(seconds) || seconds < 0) throw new TypeError('objective dt must be non-negative and finite');
  if (objective.status !== 'active') return Object.freeze({
    status: objective.status, progress: objective.progress, progressRatio: objective.progressRatio, changed: false,
  });
  const previousStatus = objective.status;
  const previousProgressBucket = Math.floor(objective.progressRatio * 20);
  if (!objective._spawned) {
    objective._spawned = true;
    for (const hook of objective.spawnHooks) emit(events, 'objective:spawn', {
      objectiveId: objective.id, objectiveType: objective.type, ...hook, seed: objective.seed,
      targets: objective.type === 'elite-hunt' ? objective.eliteTargets : undefined,
    });
  }

  objective.elapsed += seconds;
  objective.timeoutRemaining = Math.max(0, objective.timeout - objective.elapsed);
  let failureReason = null;
  if (objective.type === 'purge') updatePurge(objective, events);
  else if (objective.type === 'anchors') updateAnchors(objective, player, seconds);
  else if (objective.type === 'moving-zone') updateMovingZone(objective, player, seconds);
  else if (objective.type === 'escort') failureReason = updateEscort(objective, player, seconds, events);
  else if (objective.type === 'elite-hunt') updateElite(objective, events);
  else if (objective.type === 'storm-corridor') failureReason = updateStorm(objective, player, seconds);
  else if (objective.type === 'core-harvest') updateHarvest(objective, player, events);
  else if (objective.type === 'dual-crisis') updateDualCrisis(objective, player, seconds);

  updateProgress(objective);
  if (failureReason) finish(objective, events, 'failed', failureReason);
  else if (objective.progress >= objective.target - EPSILON) finish(objective, events, 'completed');
  else if (objective.elapsed >= objective.timeout - EPSILON) finish(objective, events, 'failed', 'timeout');
  else {
    const progressEventKey = `${Math.floor(objective.progressRatio * 20)}:${Math.floor(objective.timeoutRemaining)}`;
    if (progressEventKey !== objective._lastProgressEventKey) {
      objective._lastProgressEventKey = progressEventKey;
      emit(events, 'objective:progress', {
        id: objective.id, type: objective.type, status: objective.status,
        progress: objective.progress, target: objective.target, progressRatio: objective.progressRatio,
      });
    }
  }
  return Object.freeze({
    status: objective.status,
    progress: objective.progress,
    progressRatio: objective.progressRatio,
    changed: objective.status !== previousStatus
      || Math.floor(objective.progressRatio * 20) !== previousProgressBucket,
  });
}

export function getObjectiveSnapshot(objective) {
  if (!objective) return null;
  if (Object.isExtensible(objective)) {
    objective._snapshotCount = Math.max(0, Math.trunc(objective._snapshotCount ?? 0)) + 1;
  }
  const snapshot = {};
  for (const [key, value] of Object.entries(objective)) {
    if (key.startsWith('_')) continue;
    snapshot[key] = cloneFrozen(value);
  }
  return Object.freeze(snapshot);
}

// Boss objectives are projections owned and mutated by BossSystem. Keeping the
// discriminator here lets HUD, tests, and future objective bridges consume the
// same snapshot contract without giving ObjectiveSystem a second Boss writer.
export function isBossObjective(objective) {
  return Boolean(objective && objective.type === 'boss' && typeof objective.bossId === 'string');
}
