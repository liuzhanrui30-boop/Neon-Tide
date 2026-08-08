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
  update(elite, { x: 0, y: 0 }, 0, Array.from({ length: elite.target }, (_, index) => ({ type: 'enemy:destroyed', payload: { id: index, elite: true } })));
  assert.equal(elite.status, 'completed');

  const storm = createObjective(byType['storm-corridor'], 16);
  update(storm, { x: 0, y: 0 }, storm.target);
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

