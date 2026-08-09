import test from 'node:test';
import assert from 'node:assert/strict';
import { createObjective, updateObjective } from '../src/systems/objective-system.js';
import { ENCOUNTER_TEMPLATES, OBJECTIVE_BOUNDARY_ORBIT } from '../src/content/encounters.js';

function sink() {
  const emitted = [];
  return { emitted, emit(type, payload) { emitted.push({ type, payload }); return true; } };
}

function update(objective, player, dt = 1, inputEvents = []) {
  const output = sink();
  updateObjective(objective, null, player, dt, { input: inputEvents, emit: output.emit.bind(output) });
  return output.emitted;
}

test('all eight objective types require their authored gameplay action', () => {
  const byType = Object.fromEntries(ENCOUNTER_TEMPLATES.map((template) => [template.type, template]));
  assert.deepEqual(Object.keys(byType).sort(), [
    'anchors', 'core-harvest', 'dual-crisis', 'elite-hunt', 'escort', 'moving-zone', 'purge', 'storm-corridor',
  ]);

  const purge = createObjective(byType.purge, 11);
  update(purge, { x: 0, y: 0 }, 20);
  assert.equal(purge.progress, 0);
  update(purge, { x: 0, y: 0 }, 0, Array.from({ length: purge.target }, (_, index) => ({ type: 'enemy:destroyed', payload: { id: index } })));
  assert.equal(purge.status, 'completed');

  const anchors = createObjective(byType.anchors, 12);
  update(anchors, { x: 9, y: 0 }, 20);
  assert.equal(anchors.progress, 0);
  for (const anchor of anchors.anchors) update(anchors, anchor, anchor.requiredSeconds);
  assert.equal(anchors.status, 'completed');

  const moving = createObjective(byType['moving-zone'], 13);
  update(moving, { x: 20, y: 20 }, moving.target + 3);
  assert.equal(moving.progress, 0);
  while (moving.status === 'active') update(moving, moving.safeZone, 0.25);
  assert.equal(moving.status, 'completed');

  const escort = createObjective(byType.escort, 14);
  const start = { x: escort.escort.x + escort.escort.supportRadius + 3, y: escort.escort.y };
  update(escort, start, 20);
  assert.equal(escort.progress, 0);
  while (escort.status === 'active') update(escort, escort.escort, 0.25);
  assert.equal(escort.status, 'completed');

  const elite = createObjective(byType['elite-hunt'], 15);
  update(elite, { x: 0, y: 0 }, 30);
  assert.equal(elite.progress, 0);
  update(elite, { x: 0, y: 0 }, 0, elite.eliteTargets.map(({ sourceId }) => ({ type: 'enemy:destroyed', payload: { sourceId } })));
  assert.equal(elite.status, 'completed');

  const storm = createObjective(byType['storm-corridor'], 16);
  while (storm.status === 'active') update(storm, storm.safeZone, 0.1);
  assert.equal(storm.status, 'completed');

  const harvest = createObjective(byType['core-harvest'], 17);
  update(harvest, { x: 9, y: 0 }, 30);
  assert.equal(harvest.progress, 0);
  for (const core of harvest.cores) update(harvest, core, 0.01);
  assert.equal(harvest.status, 'completed');

  const crisis = createObjective(byType['dual-crisis'], 18);
  update(crisis, { x: 9, y: 0 }, 20);
  assert.equal(crisis.progress, 0);
  for (const node of crisis.crises) update(crisis, node, node.requiredSeconds);
  assert.equal(crisis.status, 'completed');
});

test('Tide objective stats accelerate real proximity progress and repair an escorted target incrementally', () => {
  const anchorsTemplate = ENCOUNTER_TEMPLATES.find(({ type }) => type === 'anchors');
  const baselineAnchors = createObjective(anchorsTemplate, 4040);
  const upgradedAnchors = createObjective(anchorsTemplate, 4040);
  const baselineAnchor = baselineAnchors.anchors[0];
  const upgradedAnchor = upgradedAnchors.anchors[0];
  update(baselineAnchors, { ...baselineAnchor, buildStats: { objectiveProximityMultiplier: 1 } }, 0.5);
  update(upgradedAnchors, { ...upgradedAnchor, buildStats: { objectiveProximityMultiplier: 1.6 } }, 0.5);
  assert.ok(upgradedAnchor.charge > baselineAnchor.charge);
  assert.ok(Math.abs(upgradedAnchor.charge / baselineAnchor.charge - 1.6) < 1e-9);

  const escortTemplate = ENCOUNTER_TEMPLATES.find(({ type }) => type === 'escort');
  const escort = createObjective(escortTemplate, 5050);
  escort.escort.hp -= 1;
  const beforeHp = escort.escort.hp;
  const beforeRoute = escort.escort.routeDistance;
  update(escort, {
    x: escort.escort.x,
    y: escort.escort.y,
    buildStats: { escortRepairPerSecond: 0.24, objectiveProximityMultiplier: 1.6 },
  }, 0.5);
  assert.ok(Math.abs(escort.escort.hp - (beforeHp + 0.12)) < 1e-9);
  assert.ok(escort.escort.routeDistance - beforeRoute > escort.escort.speed * 0.5);
});

test('timeouts fail unfinished objectives and terminal cleanup emits exactly once', () => {
  const template = { ...ENCOUNTER_TEMPLATES.find(({ type }) => type === 'anchors'), timeout: 2 };
  const objective = createObjective(template, 42);
  const events = sink();
  updateObjective(objective, null, { x: 99, y: 99 }, 2.1, events);
  updateObjective(objective, null, { x: 99, y: 99 }, 1, events);
  assert.equal(objective.status, 'failed');
  assert.equal(objective.failureReason, 'timeout');
  assert.equal(events.emitted.filter(({ type }) => type === 'objective:cleanup').length, 1);
  assert.equal(events.emitted.filter(({ type }) => type === 'objective:failed').length, 1);
});

test('storm survival advances only inside the current safe segment and requires route changes', () => {
  const template = ENCOUNTER_TEMPLATES.find(({ type }) => type === 'storm-corridor');
  const objective = createObjective(template, 501);
  update(objective, { x: 99, y: 99 }, 4);
  assert.equal(objective.progress, 0);
  assert.equal(objective.status, 'failed');
  assert.equal(objective.failureReason, 'storm-exposure');

  const routed = createObjective(template, 501);
  const player = { x: routed.safeZone.x, y: routed.safeZone.y };
  let visited = 0;
  while (routed.status === 'active') {
    const activeBefore = routed.corridor.activeSegment;
    update(routed, player, 0.1);
    if (routed.corridor.activeSegment !== activeBefore) {
      visited += 1;
      player.x = routed.safeZone.x;
      player.y = routed.safeZone.y;
    }
  }
  assert.equal(routed.status, 'completed');
  assert.ok(visited >= 2);
});

test('elite hunt matches stable target source IDs from bootstrap-shaped destruction events', () => {
  const template = ENCOUNTER_TEMPLATES.find(({ type }) => type === 'elite-hunt');
  const objective = createObjective(template, 808);
  assert.equal(objective.eliteTargets.length, objective.target);
  for (const target of objective.eliteTargets) {
    update(objective, { x: 0, y: 0 }, 0, [{ type: 'enemy:destroyed', payload: { targetSourceId: target.sourceId } }]);
  }
  assert.equal(objective.status, 'completed');
});

test('id-less repeated events remain legitimate, sequences dedupe boundedly, and harvest honors counts', () => {
  const purgeTemplate = { ...ENCOUNTER_TEMPLATES.find(({ type }) => type === 'purge'), killTarget: 3 };
  const purge = createObjective(purgeTemplate, 9);
  update(purge, null, 0, [{ type: 'enemy:destroyed', payload: {} }]);
  update(purge, null, 0, [{ type: 'enemy:destroyed', payload: {} }]);
  assert.equal(purge.progress, 2);
  update(purge, null, 0, [{ type: 'enemy:destroyed', sequence: 44, payload: {} }]);
  update(purge, null, 0, [{ type: 'enemy:destroyed', sequence: 44, payload: {} }]);
  assert.equal(purge.progress, 3);
  assert.ok(purge._seenEventOrder.length <= 128);

  const harvest = createObjective(ENCOUNTER_TEMPLATES.find(({ type }) => type === 'core-harvest'), 10);
  update(harvest, { x: 99, y: 99 }, harvest.activationDelay);
  update(harvest, { x: 99, y: 99 }, 0, [{ type: 'pickupCollected', payload: { count: 3 } }]);
  assert.equal(harvest.progress, 3);
});

test('semantic destroyed target IDs dedupe across distinct transport sequences and repeated identities', () => {
  const purgeTemplate = { ...ENCOUNTER_TEMPLATES.find(({ type }) => type === 'purge'), killTarget: 5 };
  const purge = createObjective(purgeTemplate, 99);
  update(purge, null, 0, [
    { type: 'enemy:destroyed', sequence: 1, payload: { targetSourceId: 7001 } },
    { type: 'enemy:destroyed', sequence: 2, payload: { targetSourceId: 7001 } },
  ]);
  assert.equal(purge.progress, 1);
  const aggregatePayload = { count: 2 };
  update(purge, null, 0, [{ type: 'enemy:destroyed', payload: aggregatePayload }]);
  update(purge, null, 0, [{ type: 'enemy:destroyed', payload: aggregatePayload }]);
  assert.equal(purge.progress, 3, 'the same id-less payload object must count only once');

  const elite = createObjective(ENCOUNTER_TEMPLATES.find(({ type }) => type === 'elite-hunt'), 101);
  const [first] = elite.eliteTargets;
  update(elite, null, 0, [
    { type: 'enemy:destroyed', sequence: 10, payload: { targetSourceId: first.sourceId } },
    { type: 'enemy:destroyed', sequence: 11, payload: { targetSourceId: first.sourceId } },
  ]);
  assert.equal(elite.progress, 1);
  const eliteAggregate = { type: 'elite:destroyed', payload: { count: 1 } };
  update(elite, null, 0, [eliteAggregate]);
  update(elite, null, 0, [eliteAggregate]);
  assert.equal(elite.progress, 2);
  assert.ok(elite._destroyedTargetOrder.length <= 256);

  const targetIdElite = createObjective(ENCOUNTER_TEMPLATES.find(({ type }) => type === 'elite-hunt'), 102);
  update(targetIdElite, null, 0, [
    { type: 'enemyDestroyed', payload: { targetId: targetIdElite.eliteTargets[0].id } },
  ]);
  assert.equal(targetIdElite.progress, 1);
});

test('fixed-step updates return compact metadata without cloning full objective snapshots', () => {
  const objective = createObjective(ENCOUNTER_TEMPLATES.find(({ type }) => type === 'moving-zone'), 404);
  const player = { x: objective.safeZone.x, y: objective.safeZone.y };
  for (let index = 0; index < 5_000; index += 1) {
    player.x = objective.safeZone.x;
    player.y = objective.safeZone.y;
    const result = updateObjective(objective, null, player, 0.001);
    assert.equal('path' in result, false);
  }
  assert.equal(objective._snapshotCount, 0);
  assert.ok(objective.progress > 4.9);
});

test('route objective placement preserves a fair authored margin from the arena-boundary orbit', () => {
  const templateByType = Object.fromEntries(ENCOUNTER_TEMPLATES.map((template) => [template.type, template]));
  for (let seed = 0; seed < 64; seed += 1) {
    for (const type of ['anchors', 'moving-zone', 'core-harvest', 'escort']) {
      const objective = createObjective(templateByType[type], seed);
      const targets = type === 'anchors'
        ? objective.anchors.map((entry) => ({ ...entry, clearanceRadius: entry.radius }))
        : type === 'moving-zone'
          ? objective.path.map((entry) => ({ ...entry, clearanceRadius: objective.safeZone.radius }))
          : type === 'core-harvest'
            ? objective.cores.map((entry) => ({ ...entry, clearanceRadius: entry.radius }))
            : objective.escort.route.map((entry) => ({ ...entry, clearanceRadius: objective.escort.supportRadius }));
      let minimumGap = Number.POSITIVE_INFINITY;
      for (let index = 0; index < 360; index += 1) {
        const angle = (index / 360) * Math.PI * 2;
        const x = Math.cos(angle) * OBJECTIVE_BOUNDARY_ORBIT.radiusX;
        const y = Math.sin(angle) * OBJECTIVE_BOUNDARY_ORBIT.radiusY;
        for (const target of targets) {
          minimumGap = Math.min(minimumGap,
            Math.hypot(x - target.x, y - target.y) - target.clearanceRadius);
        }
      }
      assert.ok(minimumGap >= 0.45, `${type} seed ${seed} boundary gap ${minimumGap}`);
      if (type === 'escort') assert.ok(objective.escort.routeLength >= objective.target);
    }
  }
});

test('core harvest transition grace prevents unavoidable room-entry collection', () => {
  const template = ENCOUNTER_TEMPLATES.find(({ type }) => type === 'core-harvest');
  const objective = createObjective(template, 300);
  const [core] = objective.cores;
  update(objective, core, objective.activationDelay - 0.1);
  assert.equal(objective.progress, 0);
  update(objective, core, 0.11);
  assert.equal(objective.progress, 1);
});

test('fixed seeds reproduce route geometry while different seeds vary it', () => {
  for (const type of ['anchors', 'moving-zone', 'escort', 'dual-crisis']) {
    const template = ENCOUNTER_TEMPLATES.find((entry) => entry.type === type);
    const first = createObjective(template, 0x51a7);
    const restored = createObjective(template, 0x51a7);
    const different = createObjective(template, 0x51a8);
    const geometry = (objective) => ({
      anchors: objective.anchors,
      path: objective.path,
      route: objective.escort?.route,
      crises: objective.crises,
    });
    assert.deepEqual(geometry(first), geometry(restored), `${type} must restore identically`);
    assert.notDeepEqual(geometry(first), geometry(different), `${type} should use the seed`);
  }
});
