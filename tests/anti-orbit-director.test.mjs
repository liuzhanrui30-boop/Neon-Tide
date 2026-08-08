import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeRoute,
  createAntiOrbitDirector,
  createRouteHistory,
} from '../src/systems/anti-orbit-director.js';
import { ANTI_ORBIT_COUNTER_TEMPLATES, getEncounterTemplate } from '../src/content/encounters.js';
import {
  commitObjectiveShift,
  createObjective,
  createObjectiveShiftPlan,
} from '../src/systems/objective-system.js';
import { createEncounterDirector } from '../src/systems/encounter-director.js';
import { createObjectiveWorldBridge } from '../src/systems/objective-world-bridge.js';
import { createEntityWorld } from '../src/game/entity-world.js';
import { createCollisionSystem } from '../src/systems/collision-system.js';

const STEP = 1 / 60;
const TAU = Math.PI * 2;
const PLAYER_COLLISION_RADIUS = 0.4;

function circleHistory({ seconds = 4.5, radius = 8, direction = 1, progress = 0 } = {}) {
  const history = createRouteHistory();
  const steps = Math.ceil(seconds / STEP);
  for (let index = 0; index <= steps; index += 1) {
    const time = index * STEP;
    const angle = direction * time * 1.35;
    history.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, time, progress });
  }
  return history;
}

function variedHistory({ seconds = 4.5, progressDelta = 1 } = {}) {
  const history = createRouteHistory();
  const steps = Math.ceil(seconds / STEP);
  for (let index = 0; index <= steps; index += 1) {
    const time = index * STEP;
    const phase = time * 1.45;
    const radius = 3.1 + 2.4 * (0.5 + 0.5 * Math.sin(time * 2.7));
    const angle = Math.sin(phase) * 1.6 + Math.sin(time * 4.2) * 0.35;
    history.push({
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      time,
      progress: progressDelta * (index / steps),
    });
  }
  return history;
}

function sink() {
  const events = [];
  return { events, emit(type, payload) { events.push({ type, payload }); return true; } };
}

function stepDirector(director, objective, route, seconds, events = null) {
  const steps = Math.ceil(seconds / STEP);
  for (let index = 0; index < steps; index += 1) {
    const time = index * STEP;
    const player = route(time, index);
    director.update({ player, objective }, STEP, events);
  }
}

function simulateOrbitRobot(seed, { responsive }) {
  const objective = createObjective(getEncounterTemplate('anchor-break'), seed);
  const director = createAntiOrbitDirector({ seed });
  const events = sink();
  const samples = [];
  let responseAt = null;
  let counterKind = null;
  let readablePreview = false;
  let shiftedTarget = null;
  let shiftedTargetBefore = null;
  let shifted = false;
  let hull = 5;
  let routeTax = 0;
  let hurtCooldown = 0;
  let observedEvents = 0;
  for (let index = 0; index < Math.ceil(12 / STEP); index += 1) {
    const time = index * STEP;
    const responseAmount = responsive && responseAt !== null ? Math.min(1, (time - responseAt) / 0.6) : 0;
    const radius = 1 - responseAmount * 0.48;
    const angle = time * 1.3;
    const player = {
      x: Math.cos(angle) * 9.2 * radius,
      y: Math.sin(angle) * 5.5 * radius,
      normalizedAngle: angle,
      normalizedRadius: radius,
      hp: hull,
      maxHp: 5,
    };
    director.update({ player, objective }, STEP, events);
    samples.push({ time, radius, angle });
    const newEvents = events.events.slice(observedEvents);
    observedEvents = events.events.length;
    const previewEvent = newEvents.find(({ type }) => type === 'anti-orbit:preview');
    if (previewEvent && responseAt === null) {
      const preview = previewEvent.payload.counter;
      readablePreview = preview.previewSeconds >= 0.65
        && preview.geometry.length >= 3
        && preview.geometry.every(({ collidable }) => !collidable);
      responseAt = time;
      counterKind = preview.kind;
      if (preview.kind === 'objective-shift') {
        shiftedTarget = objective.anchors.find(({ sourceId }) => sourceId === preview.targetSourceId);
        shiftedTargetBefore = shiftedTarget && { x: shiftedTarget.x, y: shiftedTarget.y };
      }
    }
    if (shiftedTarget && shiftedTargetBefore) {
      shifted ||= shiftedTarget.x !== shiftedTargetBefore.x || shiftedTarget.y !== shiftedTargetBefore.y;
    }
    const counter = director.getSnapshot().activeCounter;
    hurtCooldown = Math.max(0, hurtCooldown - STEP);
    if (counter?.phase === 'active' && hurtCooldown <= 0) {
      const collision = counter.geometry.some((node) => node.collidable
        && Math.hypot(player.x - node.x, player.y - node.y) <= 0.4 + node.radius);
      if (collision) {
        hull = Math.max(0, hull - 0.35);
        routeTax += 0.35;
        hurtCooldown = 0.5;
      }
    }
  }
  const departed = responsive && readablePreview && responseAt !== null
    && samples.some(({ time, radius }) => time >= responseAt && time <= responseAt + 1.2 && radius <= 0.72);
  return { counterKind, departed, hull, readablePreview, responseAt, routeTax, shifted };
}

test('constant-radius same-direction motion raises orbit pressure but varied routes do not', () => {
  const circle = circleHistory({ seconds: 4.5, radius: 8, direction: 1 });
  const varied = variedHistory();
  const circular = analyzeRoute(circle, { delta: 0 });
  assert.ok(circular.orbitPressure >= 1);
  assert.equal(circular.direction, 1);
  assert.ok(circular.radiusVariance < 0.15);
  assert.equal(circular.quadrantCoverage, 4);
  assert.equal(circular.stalled, true);
  assert.equal(analyzeRoute(varied, { delta: 1 }).orbitPressure, 0);
});

test('classifier requires 3.5 seconds consistent rotation, under 15 percent radius variance, and stalled progress', () => {
  assert.equal(analyzeRoute(circleHistory({ seconds: 3.45 }), { delta: 0 }).orbitPressure, 0);

  const radial = createRouteHistory();
  for (let index = 0; index <= 270; index += 1) {
    const time = index * STEP;
    const radius = index % 2 ? 8 : 10.6;
    const angle = time * 1.3;
    radial.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius, time, progress: 0 });
  }
  assert.ok(analyzeRoute(radial, { delta: 0 }).radiusVariance >= 0.15);
  assert.equal(analyzeRoute(radial, { delta: 0 }).orbitPressure, 0);
  assert.equal(analyzeRoute(circleHistory(), { delta: 0.05 }).orbitPressure, 0);
});

test('brief meaningful reversals break uninterrupted direction consistency while bounded angle noise does not', () => {
  const reversing = createRouteHistory();
  let angle = 0;
  for (let index = 0; index <= Math.ceil(4.8 / STEP); index += 1) {
    const time = index * STEP;
    const reversingFrames = index % 30 >= 27;
    angle += (reversingFrames ? -1 : 1) * 1.35 * STEP;
    reversing.push({ angle, radius: 1, time, progress: 0 });
  }
  assert.equal(analyzeRoute(reversing, { delta: 0 }).orbitPressure, 0);

  const noisy = createRouteHistory();
  angle = 0;
  for (let index = 0; index <= Math.ceil(4.2 / STEP); index += 1) {
    const time = index * STEP;
    angle += index % 12 === 0 ? 0.0004 : 1.35 * STEP;
    noisy.push({ angle, radius: 1, time, progress: 0 });
  }
  assert.ok(analyzeRoute(noisy, { delta: 0 }).orbitPressure >= 1);
});

test('stalled progress alone never pressures a varied route', () => {
  const varied = variedHistory({ seconds: 8, progressDelta: 0 });
  const analysis = analyzeRoute(varied, { delta: 0 });
  assert.equal(analysis.stalled, true);
  assert.equal(analysis.orbitPressure, 0);
});

test('route history is fixed-capacity, overwrite-bounded, and supports normalized arena samples', () => {
  const history = createRouteHistory(12);
  const buffers = [history.x, history.y, history.time, history.angle, history.radius, history.progress];
  for (let index = 0; index < 2000; index += 1) {
    history.push({
      x: index,
      y: -index,
      time: index / 60,
      angle: index / 30,
      radius: 0.82,
      progress: index / 100,
    });
  }
  assert.equal(history.length, 12);
  assert.equal(history.capacity, 12);
  assert.deepEqual([history.x, history.y, history.time, history.angle, history.radius, history.progress], buffers);
  assert.deepEqual(history.getOldest(), { x: 1988, y: -1988, time: 1988 / 60, angle: 1988 / 30, radius: 0.82, progress: 19.88 });
  assert.deepEqual(history.getNewest(), { x: 1999, y: -1999, time: 1999 / 60, angle: 1999 / 30, radius: 0.82, progress: 19.99 });
});

test('director selects deterministically, owns one counter, and waits seven seconds after completion', () => {
  const make = () => createAntiOrbitDirector({ seed: 91 });
  const first = make();
  const second = make();
  const objectiveA = createObjective(getEncounterTemplate('anchor-break'), 111);
  const objectiveB = createObjective(getEncounterTemplate('anchor-break'), 111);
  const events = sink();
  const route = (time) => {
    const angle = time * 1.4;
    return {
      x: Math.cos(angle) * 9.2, y: Math.sin(angle) * 5.5,
      normalizedAngle: angle, normalizedRadius: 1,
    };
  };
  stepDirector(first, objectiveA, route, 3.65, events);
  stepDirector(second, objectiveB, route, 3.65);
  const started = first.getSnapshot();
  assert.ok(started.activeCounter);
  assert.deepEqual(started.activeCounter.kind, second.getSnapshot().activeCounter.kind);
  const counterId = started.activeCounter.id;
  stepDirector(first, objectiveA, route, 1.2, events);
  assert.equal(first.getSnapshot().activeCounter.id, counterId, 'a second counter must not replace the active one');

  while (first.getSnapshot().activeCounter) stepDirector(first, objectiveA, route, STEP, events);
  const completed = first.getSnapshot();
  assert.ok(completed.cooldownRemaining >= 7 - STEP - 1e-9);
  const startedCount = completed.countersStarted;
  stepDirector(first, objectiveA, route, 6.9, events);
  assert.equal(first.getSnapshot().countersStarted, startedCount);
  stepDirector(first, objectiveA, route, 0.25, events);
  assert.ok(first.getSnapshot().countersStarted > startedCount);
});

test('four counter templates encode readable previews, explicit gaps, telegraphed movement, and center safety', () => {
  assert.deepEqual(Object.keys(ANTI_ORBIT_COUNTER_TEMPLATES).sort(), [
    'center-pulse', 'intercept', 'objective-shift', 'reverse-wall',
  ]);
  assert.ok(ANTI_ORBIT_COUNTER_TEMPLATES.intercept.previewSeconds >= 0.65);
  assert.ok(ANTI_ORBIT_COUNTER_TEMPLATES.intercept.projectedAngleDegrees[0] >= 35);
  assert.ok(ANTI_ORBIT_COUNTER_TEMPLATES.intercept.projectedAngleDegrees[1] <= 55);
  assert.ok(ANTI_ORBIT_COUNTER_TEMPLATES['reverse-wall'].safeGapWidth > 0);
  assert.ok(ANTI_ORBIT_COUNTER_TEMPLATES['objective-shift'].telegraphSeconds > 0);
  assert.ok(ANTI_ORBIT_COUNTER_TEMPLATES['center-pulse'].centerSafeRadius > 0);
  assert.ok(ANTI_ORBIT_COUNTER_TEMPLATES['center-pulse'].edgeDangerSeconds > 0);
});

test('objective shift renders a path before moving authoritative objective geometry', () => {
  const director = createAntiOrbitDirector({ seed: 2, preferredKind: 'objective-shift' });
  const objective = createObjective(getEncounterTemplate('anchor-break'), 212);
  const route = (time) => {
    const angle = time * 1.4;
    return {
      x: Math.cos(angle) * 9.2, y: Math.sin(angle) * 5.5,
      normalizedAngle: angle, normalizedRadius: 1,
    };
  };
  stepDirector(director, objective, route, 3.65);
  const preview = director.getSnapshot().activeCounter;
  assert.equal(preview.kind, 'objective-shift');
  assert.equal(preview.phase, 'preview');
  assert.ok(preview.path.length >= 3);
  const target = objective.anchors.find((entry) => entry.sourceId === preview.targetSourceId);
  assert.deepEqual({ x: target.x, y: target.y }, preview.path[0]);
  const remainingPreview = preview.previewSeconds - preview.elapsed;
  stepDirector(director, objective, route, Math.max(0, remainingPreview - STEP * 2));
  assert.deepEqual({ x: target.x, y: target.y }, preview.path[0]);
  stepDirector(director, objective, route, STEP * 4);
  assert.deepEqual({ x: target.x, y: target.y }, preview.path.at(-1));
});

test('moving-zone objective shift materializes the exact authoritative activation point as a visible safe preview marker', () => {
  const world = createEntityWorld({ capacities: { objective: 24 } });
  const bridge = createObjectiveWorldBridge({ world });
  const director = createAntiOrbitDirector({ seed: 222, preferredKind: 'objective-shift' });
  const objective = createObjective(getEncounterTemplate('moving-sanctum'), 222);
  const route = (time) => {
    const angle = time * 1.4;
    return {
      x: Math.cos(angle) * 9.2, y: Math.sin(angle) * 5.5,
      normalizedAngle: angle, normalizedRadius: 1,
    };
  };
  stepDirector(director, objective, route, 3.65);
  const preview = director.getSnapshot().activeCounter;
  bridge.sync(objective);
  const marker = [...world.query('objective')].map((id) => world.get(id))
    .find(({ role }) => role === 'counter-shift-destination');
  assert.ok(marker && !marker.collidable);
  assert.ok(Math.hypot(marker.x - preview.destination.x, marker.y - preview.destination.y) <= 1e-6);
  stepDirector(director, objective, route, preview.previewSeconds - preview.elapsed + STEP);
  assert.deepEqual({ x: objective.safeZone.x, y: objective.safeZone.y }, preview.destination);
  assert.ok(Math.hypot(objective.safeZone.x - marker.x, objective.safeZone.y - marker.y) <= 1e-6);
});

test('10,000 seeded objective shifts preview exact activation geometry in the opposite quadrant and preserve route semantics', () => {
  const cases = [
    ['anchor-break', (objective) => objective.anchors.filter(({ completed }) => !completed), (objective) => objective.anchors.find(({ completed }) => !completed), (entry) => entry.radius],
    ['moving-sanctum', (objective) => objective.path, (objective) => objective.safeZone, (entry, objective) => objective.safeZone.radius],
    ['escort-skiff', (objective) => objective.escort.route, (objective) => objective.escort, (entry, objective) => objective.escort.supportRadius],
    ['core-harvest', (objective) => objective.cores.filter(({ collected }) => !collected), (objective) => objective.cores.find(({ collected }) => !collected), (entry) => entry.radius],
    ['dual-crisis', (objective) => objective.crises.filter(({ completed }) => !completed), (objective) => objective.crises.find(({ completed }) => !completed), (entry) => entry.radius],
  ];
  const safetyMargin = 0.35;
  for (let seed = 0; seed < 10_000; seed += 1) {
    for (const [templateId, geometryFor, targetFor, clearanceFor] of cases) {
      const objective = createObjective(getEncounterTemplate(templateId), seed);
      const beforeGeometry = geometryFor(objective);
      const before = beforeGeometry.map(({ x, y, sourceId }) => ({ x, y, sourceId }));
      const targetBefore = { x: targetFor(objective).x, y: targetFor(objective).y };
      const routeDistances = beforeGeometry.map(({ distance }) => distance);
      const routeProgress = objective.type === 'moving-zone' ? objective.routeDistance
        : objective.type === 'escort' ? objective.escort.routeDistance : null;
      const plan = createObjectiveShiftPlan(objective, { pathNodes: 7, variant: seed });
      assert.ok(plan, `${templateId} seed ${seed} must produce a shift`);
      assert.ok(Number.isFinite(plan.transform?.translateX) && Number.isFinite(plan.transform?.translateY));
      assert.deepEqual(plan.destinationQuadrant, {
        x: -plan.sourceQuadrant.x,
        y: -plan.sourceQuadrant.y,
      });
      assert.ok(Math.abs(plan.destination.x) >= plan.axisEpsilon - 1e-6);
      assert.ok(Math.abs(plan.destination.y) >= plan.axisEpsilon - 1e-6);
      assert.equal(Math.sign(plan.destination.x), plan.destinationQuadrant.x);
      assert.equal(Math.sign(plan.destination.y), plan.destinationQuadrant.y);
      if (Math.abs(targetBefore.x) >= plan.axisEpsilon) assert.equal(Math.sign(plan.destination.x), -Math.sign(targetBefore.x));
      if (Math.abs(targetBefore.y) >= plan.axisEpsilon) assert.equal(Math.sign(plan.destination.y), -Math.sign(targetBefore.y));
      const transformPoint = ({ x, y }) => ({
        x: Math.round((x * plan.transform.scaleX + plan.transform.translateX) * 1e6) / 1e6,
        y: Math.round((y * plan.transform.scaleY + plan.transform.translateY) * 1e6) / 1e6,
      });
      const translatesWholeRoute = templateId === 'moving-sanctum' || templateId === 'escort-skiff';
      const expected = before.map(({ x, y, sourceId }) => ({
        ...(translatesWholeRoute || sourceId === plan.targetSourceId ? transformPoint({ x, y }) : { x, y }),
      }));
      if (translatesWholeRoute) {
        assert.deepEqual(plan.path, expected, `${templateId} seed ${seed} preview must be the future route`);
      } else {
        const targetIndex = before.findIndex(({ sourceId }) => sourceId === plan.targetSourceId);
        assert.deepEqual(plan.path.at(-1), expected[targetIndex], `${templateId} seed ${seed} preview must end at the future target`);
      }
      const destinationMarker = plan.previewGeometry.find(({ role }) => role === 'counter-shift-destination');
      assert.ok(destinationMarker, `${templateId} seed ${seed} must visibly preview the activation point`);
      assert.ok(Math.hypot(destinationMarker.x - plan.destination.x, destinationMarker.y - plan.destination.y) <= 1e-6);
      assert.equal(commitObjectiveShift(objective, plan), true);
      const committed = geometryFor(objective).map(({ x, y }) => ({ x, y }));
      assert.deepEqual(committed, expected, `${templateId} seed ${seed} preview and activation must agree`);
      assert.deepEqual({ x: targetFor(objective).x, y: targetFor(objective).y }, plan.destination,
        `${templateId} seed ${seed} authoritative target must activate on the visible destination marker`);
      assert.deepEqual(beforeGeometry.map(({ distance }) => distance), routeDistances,
        `${templateId} seed ${seed} route distances must retain progress semantics`);
      if (objective.type === 'moving-zone') assert.equal(objective.routeDistance, routeProgress);
      if (objective.type === 'escort') assert.equal(objective.escort.routeDistance, routeProgress);
      geometryFor(objective).forEach((entry) => {
        const clearance = clearanceFor(entry, objective) + safetyMargin;
        assert.ok(Math.abs(entry.x) <= objective.arena.halfWidth - clearance + 1e-6,
          `${templateId} seed ${seed} x=${entry.x} exceeds safe arena extent`);
        assert.ok(Math.abs(entry.y) <= objective.arena.halfHeight - clearance + 1e-6,
          `${templateId} seed ${seed} y=${entry.y} exceeds safe arena extent`);
      });
    }
  }
});

test('100 seeded robot encounters produce measurable route departure or damage in at least 90 seeds with at most one productive-route false counter', (t) => {
  let pressured = 0;
  let falseCounters = 0;
  let shiftedSeeds = 0;
  let shiftedAndDeparted = 0;
  let stubbornTaxed = 0;
  for (let seed = 0; seed < 100; seed += 1) {
    const stubborn = simulateOrbitRobot(seed, { responsive: false });
    const responsive = simulateOrbitRobot(seed, { responsive: true });
    if (stubborn.routeTax > 0 || stubborn.hull <= 0) stubbornTaxed += 1;
    const responsiveOutcome = responsive.counterKind === 'objective-shift'
      ? responsive.shifted && responsive.departed
      : responsive.departed;
    const measurable = stubborn.routeTax > 0 || stubborn.hull <= 0 || responsiveOutcome;
    if (measurable) pressured += 1;
    if (responsive.counterKind === 'objective-shift') {
      shiftedSeeds += 1;
      if (responsive.shifted && responsive.departed) shiftedAndDeparted += 1;
    }

    const varied = createAntiOrbitDirector({ seed });
    const variedObjective = createObjective(getEncounterTemplate('anchor-break'), seed);
    const variedEvents = sink();
    stepDirector(varied, variedObjective, (time, index) => {
      const radius = 0.35 + 0.55 * (0.5 + 0.5 * Math.sin(time * 2.8));
      const angle = Math.sin(time * 1.7) * 2.1;
      variedObjective.progress = Math.min(variedObjective.target - 0.1, index / 180);
      return {
        x: Math.cos(angle) * 9.2 * radius,
        y: Math.sin(angle) * 5.5 * radius,
        normalizedAngle: angle,
        normalizedRadius: radius,
      };
    }, 12, variedEvents);
    falseCounters += variedEvents.events.filter(({ type }) => type === 'anti-orbit:preview').length;
  }
  assert.ok(pressured >= 90, `fixed orbit pressured in ${pressured}/100 seeds`);
  assert.ok(falseCounters <= 1, `varied route received ${falseCounters}/100 false counters`);
  assert.ok(shiftedSeeds > 0, 'the seeded matrix must exercise the non-damaging objective shift');
  assert.equal(shiftedAndDeparted, shiftedSeeds, 'objective shifts only count after authoritative motion and route departure');
  t.diagnostic(`measurable counter outcome ${pressured}/100; stubborn route tax ${stubbornTaxed}/100; objective shifts ${shiftedAndDeparted}/${shiftedSeeds}; varied false counters ${falseCounters}/100`);
});

test('center pulse keeps the full advertised safe circle clear of collision geometry for every active tick and hull mode', () => {
  for (const quality of ['high', 'low']) {
    for (const hp of [5, 1]) {
      const director = createAntiOrbitDirector({ seed: 404, preferredKind: 'center-pulse' });
      const objective = createObjective(getEncounterTemplate('anchor-break'), 404);
      const route = (time) => {
        const angle = time * 1.35;
        return {
          x: Math.cos(angle) * 9.2,
          y: Math.sin(angle) * 5.5,
          normalizedAngle: angle,
          normalizedRadius: 1,
          hp,
          maxHp: 5,
          quality,
        };
      };
      stepDirector(director, objective, route, 3.65);
      for (let tick = 0; tick < Math.ceil(3.2 / STEP); tick += 1) {
        stepDirector(director, objective, route, STEP);
        const counter = director.getSnapshot().activeCounter;
        if (!counter || counter.phase !== 'active') continue;
        const marker = counter.geometry.find(({ role }) => role === 'counter-center-safe');
        assert.ok(marker && !marker.collidable);
        for (const hazard of counter.geometry.filter(({ collidable }) => collidable)) {
          const clearance = Math.hypot(hazard.x - marker.x, hazard.y - marker.y) - hazard.radius;
          assert.ok(clearance >= marker.radius + PLAYER_COLLISION_RADIUS + counter.safeMargin - 1e-6,
            `${quality} quality hp=${hp} tick=${tick} hazard clearance ${clearance} overlaps advertised ${marker.radius}`);
        }
      }
    }
  }
});

test('center pulse safe marker prevents real collision damage for player bodies tangent to every safe-boundary direction', () => {
  for (const quality of ['high', 'low']) {
    for (const hp of [5, 1]) {
      const world = createEntityWorld({ capacities: { objective: 24 } });
      const bridge = createObjectiveWorldBridge({ world });
      const collision = createCollisionSystem();
      const director = createAntiOrbitDirector({ seed: 505, preferredKind: 'center-pulse' });
      const objective = createObjective(getEncounterTemplate('anchor-break'), 505);
      const route = (time) => {
        const angle = time * 1.35;
        return {
          x: Math.cos(angle) * 9.2,
          y: Math.sin(angle) * 5.5,
          normalizedAngle: angle,
          normalizedRadius: 1,
          hp,
          maxHp: 5,
          quality,
        };
      };
      stepDirector(director, objective, route, 3.65);
      const playerId = world.spawn('player', {
        x: 0, y: 0, radius: PLAYER_COLLISION_RADIUS, hp: 5, maxHp: 5,
        team: 1, collidable: true, invulnerable: false,
      });
      let hullDamage = 0;
      for (let tick = 0; tick < Math.ceil(3.2 / STEP); tick += 1) {
        stepDirector(director, objective, route, STEP);
        const counter = director.getSnapshot().activeCounter;
        if (!counter || counter.phase !== 'active') continue;
        bridge.sync(objective);
        const centerRadius = counter.centerSafeRadius;
        const points = [{ x: 0, y: 0 }];
        for (let index = 0; index < 16; index += 1) {
          const angle = index / 16 * TAU;
          for (const amount of [0.5, 1]) {
            points.push({ x: Math.cos(angle) * centerRadius * amount, y: Math.sin(angle) * centerRadius * amount });
          }
        }
        for (const point of points) {
          world.write(playerId, point);
          const summary = collision.resolve(world, {
            damageHull(amount) { hullDamage += amount; return true; },
          }, STEP);
          assert.equal(summary.playerDamage, 0,
            `${quality} quality hp=${hp} tick=${tick} safe point ${JSON.stringify(point)} took damage`);
        }
      }
      assert.equal(hullDamage, 0);
    }
  }
});

test('encounter lifecycle naturally owns anti-orbit analysis, active counter, cooldown, and room cleanup', () => {
  const authority = {};
  const director = createEncounterDirector({ seed: 411, objectiveAuthority: authority });
  director.startRoom(getEncounterTemplate('anchor-break'));
  const events = sink();
  for (let index = 0; index < Math.ceil(3.8 / STEP); index += 1) {
    const angle = index * STEP * 1.35;
    director.update({
      player: { x: Math.cos(angle) * 9.2, y: Math.sin(angle) * 5.5 },
      presentationPending: 1,
    }, STEP, events);
  }
  const active = director.getSnapshot();
  assert.ok(active.objective.antiOrbit.activeCounter);
  assert.ok(active.objective.antiOrbit.orbitPressure >= 1);
  assert.ok(active.antiOrbit.activeCounter);
  assert.equal(events.events.some(({ type }) => type === 'anti-orbit:preview'), true);

  let live;
  authority.visit((objective) => { live = objective; });
  for (const anchor of live.anchors) {
    for (let index = 0; index < Math.ceil(anchor.requiredSeconds / STEP) + 1; index += 1) {
      director.update({ player: anchor, presentationPending: 0 }, STEP, events);
    }
  }
  assert.equal(director.getSnapshot().phase, 'complete');
  assert.equal(live.antiOrbit.activeCounter, null);
});

test('counter geometry is materialized by the objective bridge and active hazards pressure the real collision pipeline', () => {
  const world = createEntityWorld({ capacities: { objective: 24 } });
  const bridge = createObjectiveWorldBridge({ world });
  const director = createAntiOrbitDirector({ seed: 7, preferredKind: 'reverse-wall' });
  const objective = createObjective(getEncounterTemplate('anchor-break'), 707);
  const events = sink();
  const route = (time) => {
    const angle = time * 1.4;
    return {
      x: Math.cos(angle) * 9.2, y: Math.sin(angle) * 5.5,
      normalizedAngle: angle, normalizedRadius: 1,
    };
  };
  stepDirector(director, objective, route, 3.65, events);
  bridge.sync(objective);
  const previewNodes = [...world.query('objective')]
    .map((id) => world.get(id)).filter(({ role }) => role === 'counter-reverse-wall');
  assert.ok(previewNodes.length >= 6);
  assert.ok(previewNodes.every(({ state, collidable }) => state === 'telegraph' && !collidable));
  const gap = director.getSnapshot().activeCounter.safeGap;
  assert.ok(previewNodes.every((node) => Math.abs(Math.hypot(node.x, node.y) - gap.radius) >= gap.width * 0.45));

  stepDirector(director, objective, route, ANTI_ORBIT_COUNTER_TEMPLATES['reverse-wall'].previewSeconds);
  bridge.sync(objective);
  const hazard = [...world.query('objective')]
    .map((id) => world.get(id)).find(({ role, collidable }) => role === 'counter-reverse-wall' && collidable);
  assert.ok(hazard);
  const playerId = world.spawn('player', {
    x: hazard.x, y: hazard.y, radius: 0.4, hp: 5, maxHp: 5, team: 1, collidable: true,
  });
  assert.ok(playerId);
  let damage = 0;
  const collision = createCollisionSystem();
  const summary = collision.resolve(world, { damageHull(amount) { damage += amount; return true; } }, STEP, events);
  assert.ok(summary.playerDamage > 0);
  assert.ok(damage > 0);
});

test('all four templates remain visible, fair, and playable through authoritative objective and pooled world state', () => {
  for (const [index, kind] of ['intercept', 'reverse-wall', 'objective-shift', 'center-pulse'].entries()) {
    const world = createEntityWorld({ capacities: { objective: 24 } });
    const bridge = createObjectiveWorldBridge({ world });
    const director = createAntiOrbitDirector({ seed: 900 + index, preferredKind: kind });
    const objective = createObjective(getEncounterTemplate('anchor-break'), 800 + index);
    const route = (time) => {
      const angle = time * 1.35;
      return {
        x: Math.cos(angle) * 9.2, y: Math.sin(angle) * 5.5,
        normalizedAngle: angle, normalizedRadius: 1,
      };
    };
    stepDirector(director, objective, route, 3.65);
    const preview = director.getSnapshot().activeCounter;
    assert.equal(preview.kind, kind);
    bridge.sync(objective);
    const previewEntities = [...world.query('objective')].map((id) => world.get(id))
      .filter(({ objectiveType }) => objectiveType === 'anti-orbit');
    assert.ok(previewEntities.length >= 3, `${kind} must render a preview`);
    assert.ok(previewEntities.every(({ collidable }) => collidable === false), `${kind} preview must be safe`);

    const shiftedTarget = kind === 'objective-shift'
      ? objective.anchors.find(({ sourceId }) => sourceId === preview.targetSourceId)
      : null;
    const beforeShift = shiftedTarget ? { x: shiftedTarget.x, y: shiftedTarget.y } : null;
    stepDirector(director, objective, route, Math.max(STEP, preview.previewSeconds - preview.elapsed + STEP));
    bridge.sync(objective);
    const active = director.getSnapshot().activeCounter;
    assert.equal(active.phase, 'active');
    const activeEntities = [...world.query('objective')].map((id) => world.get(id))
      .filter(({ objectiveType }) => objectiveType === 'anti-orbit');
    if (kind === 'objective-shift') {
      assert.notDeepEqual({ x: shiftedTarget.x, y: shiftedTarget.y }, beforeShift);
      assert.ok(activeEntities.every(({ collidable }) => collidable === false));
    } else {
      assert.ok(activeEntities.some(({ collidable }) => collidable === true), `${kind} must create playable pressure`);
    }
    if (kind === 'intercept') {
      assert.ok(active.previewSeconds >= 0.65);
      assert.ok(Math.abs(active.tangent.x * active.tangent.x + active.tangent.y * active.tangent.y - 1) < 1e-6);
    } else if (kind === 'reverse-wall') {
      assert.ok(activeEntities.some(({ role, collidable, color }) => (
        role === 'counter-reverse-gap' && !collidable && color === 0x78fff1
      )));
    } else if (kind === 'center-pulse') {
      const edgeDangerSeconds = ANTI_ORBIT_COUNTER_TEMPLATES['center-pulse'].edgeDangerSeconds;
      stepDirector(director, objective, route, edgeDangerSeconds + 0.1);
      bridge.sync(objective);
      const centerWindow = director.getSnapshot().activeCounter;
      assert.equal(centerWindow.window, 'center-safe');
      assert.ok([...world.query('objective')].map((id) => world.get(id))
        .some(({ role, state, collidable }) => role === 'counter-center-safe' && state === 'center-safe' && !collidable));
    }
  }
});

test('low hull expands authored safe routes instead of cancelling anti-orbit pressure', () => {
  const run = (hp) => {
    const director = createAntiOrbitDirector({ seed: 72, preferredKind: 'reverse-wall' });
    const objective = createObjective(getEncounterTemplate('anchor-break'), 72);
    stepDirector(director, objective, (time) => {
      const angle = time * 1.35;
      return {
        x: Math.cos(angle) * 9.2, y: Math.sin(angle) * 5.5,
        normalizedAngle: angle, normalizedRadius: 1, hp, maxHp: 5,
      };
    }, 3.65);
    return director.getSnapshot().activeCounter;
  };
  const healthy = run(5);
  const low = run(1);
  assert.equal(low.kind, 'reverse-wall');
  assert.ok(low.safeGap.width > healthy.safeGap.width);
  assert.equal(low.requiresRouteChange, true);
});
