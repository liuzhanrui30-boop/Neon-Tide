import test from 'node:test';
import assert from 'node:assert/strict';
import { createEntityWorld, ENTITY_KINDS } from '../src/game/entity-world.js';

test('stale entity IDs cannot mutate reused slots', () => {
  const world = createEntityWorld({ capacities: { enemy: 2 } });
  const first = world.spawn('enemy', { hp: 1 });
  const staleView = world.get(first);
  world.despawn(first);
  const second = world.spawn('enemy', { hp: 2 });

  assert.notEqual(first, second);
  assert.equal(world.get(first), null);
  staleView.hp = 99;
  assert.equal(staleView.active, false);
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

test('query exposes mutable component views without exposing pool structure', () => {
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
  assert.deepEqual([...query].map((entity) => entity.id), [first, second]);

  const entity = world.get(first);
  entity.x = 7;
  entity.velocity.y = -4;
  entity.role = 'striker';
  assert.equal(world.get(first).x, 7);
  assert.equal(world.get(first).vy, -4);
  assert.equal(world.get(first).role, 'striker');
  assert.equal(world.get(first).previousX, -1);
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

  for (const kind of ENTITY_KINDS) assert.ok(world.spawn(kind, { kindTag: kind }));
  assert.equal(world.getStats().count, ENTITY_KINDS.length);
  assert.equal(world.dispose(), true);
  assert.equal(world.dispose(), false);
  assert.equal(world.reset(), false);
  assert.equal(world.spawn('enemy', {}), null);
  assert.equal(world.getStats().disposed, true);
  assert.equal(world.getStats().count, 0);
});
