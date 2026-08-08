import test from 'node:test';
import assert from 'node:assert/strict';
import { createEntityWorld } from '../src/game/entity-world.js';
import { getEncounterTemplate } from '../src/content/encounters.js';
import { createObjective } from '../src/systems/objective-system.js';
import { createObjectiveWorldBridge } from '../src/systems/objective-world-bridge.js';

test('objective bridge materializes authoritative geometry and consumes cleanup without allocation growth', () => {
  const world = createEntityWorld();
  const bridge = createObjectiveWorldBridge({ world });
  const anchors = createObjective(getEncounterTemplate('anchor-break'), 42);
  bridge.consume({ type: 'objective:spawn', payload: { objectiveId: anchors.id } });
  bridge.sync(anchors);
  assert.equal(world.query('objective').length, anchors.anchors.length);
  const positions = [...world.query('objective')].map((id) => world.get(id)).map(({ x, y }) => ({ x, y }));
  assert.deepEqual(positions, anchors.anchors.map(({ x, y }) => ({ x, y })));
  const capacity = world.getStats().capacity;
  for (let index = 0; index < 120; index += 1) bridge.sync(anchors);
  assert.deepEqual(world.getStats().capacity, capacity);
  bridge.consume({ type: 'objective:cleanup', payload: { id: anchors.id } });
  assert.equal(world.query('objective').length, 0);
});

test('bridge renders current and telegraphed storm segments from the same safe positions', () => {
  const world = createEntityWorld();
  const bridge = createObjectiveWorldBridge({ world });
  const storm = createObjective(getEncounterTemplate('storm-run'), 77);
  bridge.sync(storm);
  assert.equal(world.query('objective').length, storm.corridor.segments.length);
  const active = [...world.query('objective')].map((id) => world.get(id)).find(({ state }) => state === 'active');
  assert.deepEqual({ x: active.x, y: active.y }, { x: storm.safeZone.x, y: storm.safeZone.y });
});

test('stable objective sync avoids allocating entity snapshots and skips unchanged writes', () => {
  const baseWorld = createEntityWorld();
  let getCalls = 0;
  let writes = 0;
  const world = {
    spawn: baseWorld.spawn,
    despawn: baseWorld.despawn,
    query: baseWorld.query,
    readInto: baseWorld.readInto,
    write(...args) { writes += 1; return baseWorld.write(...args); },
    get(...args) { getCalls += 1; return baseWorld.get(...args); },
  };
  const bridge = createObjectiveWorldBridge({ world });
  const anchors = createObjective(getEncounterTemplate('anchor-break'), 88);
  bridge.sync(anchors);
  const writesAfterSpawn = writes;
  for (let index = 0; index < 5_000; index += 1) bridge.sync(anchors);
  assert.equal(getCalls, 0, 'bridge must use allocation-safe reads rather than world.get snapshots');
  assert.equal(writes, writesAfterSpawn, 'unchanged objective geometry should not be rewritten every tick');
  assert.ok(bridge.getStats().skippedWrites >= 5_000 * anchors.anchors.length);
});
