import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventQueue } from '../src/game/events.js';

test('event queue drains semantic events in FIFO order', () => {
  const queue = createEventQueue(3);
  assert.equal(queue.emit('session:start', { seed: 7 }), true);
  assert.equal(queue.emit('room:start', { id: 'abyss-1' }), true);
  const received = [];
  assert.equal(queue.drain((event) => received.push(event)), 2);
  assert.deepEqual(received, [
    { type: 'session:start', payload: { seed: 7 } },
    { type: 'room:start', payload: { id: 'abyss-1' } },
  ]);
  assert.deepEqual(queue.getStats(), {
    capacity: 3,
    queued: 0,
    emitted: 2,
    drained: 2,
    dropped: 0,
    clears: 0,
  });
});

test('event queue is bounded and preserves accepted events', () => {
  const queue = createEventQueue(2);
  assert.equal(queue.emit('one'), true);
  assert.equal(queue.emit('two'), true);
  assert.equal(queue.emit('three'), false);
  const types = [];
  queue.drain(({ type }) => types.push(type));
  assert.deepEqual(types, ['one', 'two']);
  assert.equal(queue.getStats().dropped, 1);
});

test('events emitted during drain wait for the next drain and clear is observable', () => {
  const queue = createEventQueue(4);
  queue.emit('first');
  const first = [];
  queue.drain((event) => {
    first.push(event.type);
    queue.emit('later');
  });
  assert.deepEqual(first, ['first']);
  assert.equal(queue.getStats().queued, 1);
  assert.equal(queue.clear(), 1);
  assert.equal(queue.getStats().clears, 1);
  assert.throws(() => queue.emit('', null), /non-empty string/);
});
