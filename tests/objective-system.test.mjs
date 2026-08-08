import test from 'node:test';
import assert from 'node:assert/strict';
import { createObjective, updateObjective } from '../src/systems/objective-system.js';
import { ENCOUNTER_TEMPLATES } from '../src/content/encounters.js';

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
  let visited = 0;
  while (routed.status === 'active') {
    const activeBefore = routed.corridor.activeSegment;
    update(routed, routed.safeZone, 0.1);
    if (routed.corridor.activeSegment !== activeBefore) visited += 1;
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
  update(harvest, { x: 99, y: 99 }, 0, [{ type: 'pickupCollected', payload: { count: 3 } }]);
  assert.equal(harvest.progress, 3);
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
