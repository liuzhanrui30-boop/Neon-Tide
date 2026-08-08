import test from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeRoute,
  createAntiOrbitDirector,
  createRouteHistory,
} from '../src/systems/anti-orbit-director.js';
import { ANTI_ORBIT_COUNTER_TEMPLATES, getEncounterTemplate } from '../src/content/encounters.js';
import { createObjective } from '../src/systems/objective-system.js';
import { createEncounterDirector } from '../src/systems/encounter-director.js';
import { createObjectiveWorldBridge } from '../src/systems/objective-world-bridge.js';
import { createEntityWorld } from '../src/game/entity-world.js';
import { createCollisionSystem } from '../src/systems/collision-system.js';

const STEP = 1 / 60;
const TAU = Math.PI * 2;

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

test('100 seeded robot encounters pressure fixed edge orbit in at least 90 seeds with at most one varied-route false counter', (t) => {
  let pressured = 0;
  let falseCounters = 0;
  for (let seed = 0; seed < 100; seed += 1) {
    const fixed = createAntiOrbitDirector({ seed });
    const fixedObjective = createObjective(getEncounterTemplate('anchor-break'), seed);
    stepDirector(fixed, fixedObjective, (time) => {
      const angle = time * 1.3;
      return {
        x: Math.cos(angle) * 9.2,
        y: Math.sin(angle) * 5.5,
        normalizedAngle: angle,
        normalizedRadius: 1,
      };
    }, 12);
    const fixedSnapshot = fixed.getSnapshot();
    if (fixedSnapshot.countersStarted > 0 && fixedSnapshot.routeChangesRequired > 0) pressured += 1;

    const varied = createAntiOrbitDirector({ seed });
    const variedObjective = createObjective(getEncounterTemplate('anchor-break'), seed);
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
    }, 12);
    falseCounters += varied.getSnapshot().countersStarted;
  }
  assert.ok(pressured >= 90, `fixed orbit pressured in ${pressured}/100 seeds`);
  assert.ok(falseCounters <= 1, `varied route received ${falseCounters}/100 false counters`);
  t.diagnostic(`fixed orbit pressured ${pressured}/100; varied false counters ${falseCounters}/100`);
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
