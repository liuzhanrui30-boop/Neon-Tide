import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEntityReadTarget,
  createEntityWorld,
  ENTITY_KINDS,
} from '../src/game/entity-world.js';

test('held snapshots and read targets cannot observe or mutate a replacement generation', () => {
  const world = createEntityWorld({ capacities: { enemy: 2 } });
  const first = world.spawn('enemy', { hp: 1 });
  const firstSnapshot = world.get(first);
  const readTarget = createEntityReadTarget();
  assert.equal(world.readInto(first, readTarget), readTarget);
  world.despawn(first);
  const second = world.spawn('enemy', { hp: 2 });

  assert.notEqual(first, second);
  assert.equal(world.get(first), null);
  assert.equal(Object.isFrozen(firstSnapshot), true);
  assert.equal(firstSnapshot.id, first);
  assert.equal(firstSnapshot.hp, 1);
  assert.throws(() => { firstSnapshot.hp = 99; }, TypeError);
  assert.equal(world.write(first, { hp: 99 }), false);
  assert.equal(readTarget.id, first);
  assert.equal(readTarget.hp, 1);
  assert.equal(world.readInto(first, readTarget), null);
  assert.equal(readTarget.id, first);
  assert.equal(readTarget.hp, 1);
  readTarget.hp = 77;
  assert.equal(world.get(second).hp, 2);
});

test('typed pools reject overflow without changing capacity', () => {
  const world = createEntityWorld({ capacities: { enemy: 2 } });
  const first = world.spawn('enemy', { x: 1, y: 2, hp: 3 });
  const second = world.spawn('enemy', { x: 4, y: 5, hp: 6 });
  const capacityBefore = world.getStats().pools.enemy.capacity;

  assert.ok(Number.isSafeInteger(first));
  assert.ok(Number.isSafeInteger(second));
  assert.equal(world.spawn('enemy', { hp: 99 }), null);
  assert.equal(world.getStats().pools.enemy.capacity, capacityBefore);
  assert.equal(world.getStats().pools.enemy.count, 2);
  assert.equal(world.getStats().rejectedSpawns, 1);
});

test('queries expose immutable IDs while writes and allocation-free reads stay generation checked', () => {
  const world = createEntityWorld({ capacities: { enemy: 3 } });
  const first = world.spawn('enemy', {
    x: 1,
    previousX: -1,
    velocity: { x: 2, y: 3 },
    role: 'lancer',
  });
  const second = world.spawn('enemy', { x: 4, role: 'swarm' });
  const query = world.query('enemy');

  assert.equal(Object.isFrozen(query), true);
  assert.equal(query.length, 2);
  assert.equal(typeof query.push, 'undefined');
  assert.deepEqual([...query], [first, second]);

  assert.equal(world.write(first, { x: 7, velocity: { y: -4 }, role: 'striker' }), true);
  assert.equal(world.get(first).x, 7);
  assert.equal(world.get(first).vy, -4);
  assert.equal(world.get(first).role, 'striker');
  assert.equal(world.get(first).previousX, -1);
});

test('query iteration snapshots generations and stays deterministic during despawn and reuse', () => {
  const world = createEntityWorld({ capacities: { enemy: 3 } });
  const first = world.spawn('enemy', { hp: 1 });
  const removed = world.spawn('enemy', { hp: 2 });
  const last = world.spawn('enemy', { hp: 3 });
  const visited = [];
  let replacement = null;

  world.query('enemy').forEach((id) => {
    visited.push(id);
    if (id === first) {
      assert.equal(world.despawn(removed), true);
      replacement = world.spawn('enemy', { hp: 4 });
    }
  });

  assert.deepEqual(visited, [first, last]);
  assert.notEqual(replacement, removed);

  world.reset();
  const iteratorFirst = world.spawn('enemy', { hp: 1 });
  const iteratorRemoved = world.spawn('enemy', { hp: 2 });
  const iteratorLast = world.spawn('enemy', { hp: 3 });
  const iterator = world.query('enemy')[Symbol.iterator]();
  assert.equal(iterator.next().value, iteratorFirst);
  world.despawn(iteratorRemoved);
  const iteratorReplacement = world.spawn('enemy', { hp: 4 });
  assert.deepEqual([...iterator], [iteratorLast]);
  assert.notEqual(iteratorReplacement, iteratorRemoved);
});

test('nested callbacks and overlapping or abandoned iterators remain independent', () => {
  const world = createEntityWorld({ capacities: { enemy: 3 } });
  const first = world.spawn('enemy', { hp: 1 });
  const second = world.spawn('enemy', { hp: 2 });
  const query = world.query('enemy');
  const outer = [];
  const nested = [];

  query.forEach((id) => {
    outer.push(id);
    if (id === first) {
      query.forEach((nestedId) => nested.push(nestedId));
      assert.equal(query.some((candidate) => candidate === second), true);
      assert.equal(query.find((candidate) => candidate === second), second);
    }
  });
  assert.deepEqual(outer, [first, second]);
  assert.deepEqual(nested, [first, second]);

  const abandoned = query[Symbol.iterator]();
  const overlapping = query[Symbol.iterator]();
  assert.equal(abandoned.next().value, first);
  assert.equal(overlapping.next().value, first);
  const afterAbandon = [];
  query.forEach((id) => afterAbandon.push(id));
  assert.deepEqual(afterAbandon, [first, second]);
  assert.deepEqual([...overlapping], [second]);
  assert.deepEqual([...query], [first, second]);
});

test('component schema rejects unknown data and read targets are reusable', () => {
  const world = createEntityWorld({ capacities: { enemy: 1 } });
  assert.throws(() => world.spawn('enemy', { arbitraryMetadata: true }), /unknown entity component/);
  assert.equal(world.getStats().count, 0);

  const first = world.spawn('enemy', { role: 'lancer', state: 'telegraph' });
  const target = createEntityReadTarget();
  assert.equal(world.readInto(first, target), target);
  assert.equal(target.role, 'lancer');
  assert.throws(() => world.write(first, { arbitraryMetadata: true }), /unknown entity component/);
  world.despawn(first);
  const second = world.spawn('enemy', { role: 'swarm', state: 'active' });
  assert.equal(target.id, first);
  assert.equal(target.role, 'lancer');
  assert.equal(world.readInto(second, target), target);
  assert.equal(target.id, second);
  assert.equal(target.role, 'swarm');
});

test('generation exhaustion retires slots atomically without breaking reset or dispose', () => {
  const world = createEntityWorld({ capacities: { enemy: 1 }, maxGeneration: 2 });
  const first = world.spawn('enemy', { hp: 1 });
  assert.equal(world.despawn(first), true);
  const lastGeneration = world.spawn('enemy', { hp: 2 });
  assert.equal(world.despawn(lastGeneration), true);
  assert.equal(world.spawn('enemy', { hp: 3 }), null);
  assert.deepEqual(world.getStats().pools.enemy, {
    capacity: 1,
    count: 0,
    available: 0,
    retired: 1,
  });
  assert.equal(world.reset(), true);
  assert.equal(world.dispose(), true);
  assert.equal(world.dispose(), false);
});

test('reset invalidates every live ID while retaining fixed pool storage', () => {
  const world = createEntityWorld({ capacities: { player: 1, enemy: 2 } });
  const player = world.spawn('player', { hp: 3 });
  const enemy = world.spawn('enemy', { hp: 2 });
  const before = world.getStats();

  assert.equal(world.reset(), true);
  assert.equal(world.reset(), true);
  assert.equal(world.get(player), null);
  assert.equal(world.get(enemy), null);
  assert.equal(world.query('player').length, 0);
  assert.equal(world.query('enemy').length, 0);
  assert.equal(world.getStats().capacity, before.capacity);

  const replacement = world.spawn('player', { hp: 4 });
  assert.notEqual(replacement, player);
  assert.equal(world.get(replacement).hp, 4);
});

test('all semantic kinds exist and disposal is idempotent', () => {
  const world = createEntityWorld({
    capacities: Object.fromEntries(ENTITY_KINDS.map((kind) => [kind, 1])),
  });

  for (const kind of ENTITY_KINDS) assert.ok(world.spawn(kind, { state: kind }));
  assert.equal(world.getStats().count, ENTITY_KINDS.length);
  assert.equal(world.dispose(), true);
  assert.equal(world.dispose(), false);
  assert.equal(world.reset(), false);
  assert.equal(world.spawn('enemy', {}), null);
  assert.equal(world.getStats().disposed, true);
  assert.equal(world.getStats().count, 0);
});
