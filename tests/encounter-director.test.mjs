import test from 'node:test';
import assert from 'node:assert/strict';
import { createEncounterDirector } from '../src/systems/encounter-director.js';
import { getEncounterTemplate } from '../src/content/encounters.js';

function eventSink() {
  const events = [];
  return { events, emit(type, payload) { events.push({ type, payload }); return true; } };
}

test('director owns deterministic start, freeze, drain, upgrade and reset lifecycle', () => {
  const director = createEncounterDirector({ mode: 'standard', quality: 'desktop', seed: 91 });
  const started = director.startRoom(getEncounterTemplate('purge-tide'));
  assert.equal(started.phase, 'active');
  assert.ok(started.threatBudget.total > 0);
  const target = started.objective.target;
  const sink = eventSink();
  director.update({ player: { x: 0, y: 0 }, presentationPending: 3 }, 1 / 60, {
    input: Array.from({ length: target }, (_, id) => ({ type: 'enemy:destroyed', payload: { id } })),
    emit: sink.emit.bind(sink),
  });
  const draining = director.getSnapshot();
  assert.equal(draining.phase, 'draining');
  assert.equal(draining.combatFrozen, true);
  assert.equal(draining.upgradeOffered, false);

  director.update({ player: { x: 0, y: 0 }, presentationPending: 0 }, 1 / 60, sink);
  const complete = director.getSnapshot();
  assert.equal(complete.phase, 'complete');
  assert.equal(complete.upgradeOffered, true);
  assert.equal(director.completeRoom(), true);
  assert.equal(director.completeRoom(), false);

  director.reset();
  assert.deepEqual(director.getSnapshot(), {
    mode: 'standard', quality: 'desktop', seed: 91, roomIndex: 0, phase: 'idle', combatFrozen: false,
    upgradeOffered: false, objective: null, threatBudget: null, templateId: null,
    antiOrbit: {
      analysis: { orbitPressure: 0, direction: 0, radiusVariance: 1, quadrantCoverage: 0, stalled: true },
      activeCounter: null, cooldownRemaining: 0, countersStarted: 0, countersCompleted: 0,
      routeChangesRequired: 0, historyLength: 0,
    },
  });
});

test('director placement is stable for checkpoint-equivalent room sequence', () => {
  const run = () => {
    const director = createEncounterDirector({ mode: 'standard', quality: 'desktop', seed: 123 });
    return ['anchor-break', 'moving-sanctum', 'escort-skiff'].map((id) => director.startRoom(getEncounterTemplate(id)).objective);
  };
  assert.deepEqual(run(), run());
});

test('director snapshots are recursively immutable detached views of objective authority', () => {
  const director = createEncounterDirector({ seed: 5150 });
  const started = director.startRoom(getEncounterTemplate('anchor-break'));
  const originalX = started.objective.anchors[0].x;
  assert.equal(Object.isFrozen(started.objective.anchors), true);
  assert.equal(Object.isFrozen(started.objective.anchors[0]), true);
  assert.throws(() => { started.objective.anchors[0].x = 999; }, TypeError);
  const fresh = director.getSnapshot();
  assert.equal(fresh.objective.anchors[0].x, originalX);
  assert.notEqual(fresh.objective, started.objective);
  assert.equal('getLiveObjective' in director, false);
});
