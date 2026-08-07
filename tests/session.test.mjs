import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventQueue } from '../src/game/events.js';
import { createGameSession, GAME_SESSION_MODES } from '../src/game/session.js';

const EXPECTED_MODES = ['menu', 'briefing', 'playing', 'upgrade', 'paused', 'chapterComplete', 'victory', 'defeat'];

test('session locks the public mode vocabulary and valid campaign transitions', () => {
  assert.deepEqual([...GAME_SESSION_MODES], EXPECTED_MODES);
  const events = createEventQueue();
  const transitions = [];
  const session = createGameSession({
    development: true,
    events,
    maxHull: 4,
    onTransition: (transition) => transitions.push([transition.previous.mode, transition.current.mode]),
  });
  assert.equal(session.snapshot().mode, 'menu');
  assert.equal(session.startRun('standard', 1234), true);
  assert.equal(session.snapshot().mode, 'briefing');
  assert.equal(session.startRoom({ id: 'abyss-01', chapterIndex: 0 }), true);
  assert.equal(session.pause(), true);
  assert.equal(session.resume(), true);
  assert.equal(session.completeRoom({ nextMode: 'upgrade', score: 20 }), true);
  assert.equal(session.startRoom({ id: 'abyss-02', chapterIndex: 0 }), true);
  assert.equal(session.completeRoom({ nextMode: 'chapterComplete', chapterIndex: 0 }), true);
  assert.equal(session.startRoom({ id: 'data-01', chapterIndex: 1 }), true);
  assert.equal(session.completeRoom({ outcome: 'victory' }), true);
  assert.deepEqual(transitions, [
    ['menu', 'briefing'],
    ['briefing', 'playing'],
    ['playing', 'paused'],
    ['paused', 'playing'],
    ['playing', 'upgrade'],
    ['upgrade', 'playing'],
    ['playing', 'chapterComplete'],
    ['chapterComplete', 'playing'],
    ['playing', 'victory'],
  ]);
  const snapshot = session.snapshot();
  assert.equal(snapshot.runMode, 'standard');
  assert.equal(snapshot.seed, 1234);
  assert.equal(snapshot.chapterIndex, 1);
  assert.equal(snapshot.stats.roomsCompleted, 3);
  assert.equal(events.getStats().emitted > 0, true);
});

test('invalid transitions throw in development and return false in production', () => {
  const development = createGameSession({ development: true });
  assert.throws(() => development.pause(), /Invalid GameSession transition menu -> paused/);
  development.startRun('standard', 1);
  assert.throws(() => development.resume(), /Invalid GameSession transition briefing -> playing/);

  const production = createGameSession({ development: false });
  assert.equal(production.pause(), false);
  assert.equal(production.resume(), false);
  assert.equal(production.snapshot().mode, 'menu');
});

test('damageHull owns defeat and reset produces a fresh immutable snapshot', () => {
  const session = createGameSession({ development: true, maxHull: 3 });
  session.startRun('abyss', 99);
  session.startRoom({ id: 'abyss-01', chapterIndex: 0 });
  assert.equal(session.damageHull(2), true);
  assert.equal(session.snapshot().hull, 1);
  assert.equal(session.damageHull(1), true);
  const defeated = session.snapshot();
  assert.equal(defeated.mode, 'defeat');
  assert.equal(defeated.hull, 0);
  assert.equal(defeated.stats.damageTaken, 3);
  assert.equal(session.reset(), true);
  const reset = session.snapshot();
  assert.equal(reset.mode, 'menu');
  assert.equal(reset.hull, 3);
  assert.equal(reset.runMode, null);
  assert.notEqual(reset, defeated);
});

test('session validates run modes, seeds, rooms and damage', () => {
  const session = createGameSession({ development: true });
  assert.throws(() => session.startRun('casual', 1), /standard or abyss/);
  assert.throws(() => session.startRun('standard', Number.NaN), /finite seed/);
  session.startRun('standard', 1);
  assert.throws(() => session.startRoom(null), /room object/);
  session.startRoom({ id: 'room' });
  assert.throws(() => session.damageHull(-1), /non-negative finite/);
});

test('session reports authoritative hull effects and reset effects through onChange', () => {
  const changes = [];
  const session = createGameSession({
    development: true,
    onChange: ({ previous, current, detail }) => changes.push({
      previousMode: previous.mode,
      mode: current.mode,
      previousHull: previous.hull,
      hull: current.hull,
      detail,
    }),
  });
  session.startRun('standard', 7);
  session.startRoom({ id: 'room' });
  changes.length = 0;

  assert.equal(session.damageHull(1), true);
  assert.deepEqual(changes, [{
    previousMode: 'playing',
    mode: 'playing',
    previousHull: 3,
    hull: 2,
    detail: { hullDamage: 1 },
  }]);

  changes.length = 0;
  assert.equal(session.upgradeHullCapacity(6, { repair: 3 }), true);
  assert.equal(session.snapshot().hull, 5);
  assert.equal(session.snapshot().maxHull, 6);
  assert.deepEqual(changes[0].detail, { hullCapacityUpgrade: { maxHull: 6, repair: 3 } });

  changes.length = 0;
  assert.equal(session.reset(), true);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].previousMode, 'playing');
  assert.equal(changes[0].mode, 'menu');
  assert.equal(changes[0].hull, 3);
  assert.deepEqual(changes[0].detail, { reset: true });
});

test('hull capacity upgrades are scoped to one run', () => {
  const session = createGameSession({ development: true, maxHull: 3 });
  session.startRun('standard', 7);
  session.startRoom({ id: 'room-1' });

  assert.equal(session.damageHull(1), true);
  assert.equal(session.upgradeHullCapacity(4, { repair: 1 }), true);
  assert.deepEqual(
    { hull: session.snapshot().hull, maxHull: session.snapshot().maxHull },
    { hull: 3, maxHull: 4 },
  );

  session.completeRoom({ outcome: 'defeat', reason: 'test' });
  assert.equal(session.startRun('standard', 8), true);
  assert.deepEqual(
    { hull: session.snapshot().hull, maxHull: session.snapshot().maxHull },
    { hull: 3, maxHull: 3 },
  );
});

test('compatibility hull reconciliation preserves defeat invariants', () => {
  const session = createGameSession({ development: true });
  session.startRun('standard', 7);
  session.startRoom({ id: 'room-1' });

  assert.equal(session.reconcileCompatibilityHull(0, { maxHull: 4 }), true);
  assert.deepEqual(
    { mode: session.snapshot().mode, hull: session.snapshot().hull, maxHull: session.snapshot().maxHull },
    { mode: 'defeat', hull: 0, maxHull: 4 },
  );
  assert.throws(
    () => session.reconcileCompatibilityHull(3, { maxHull: 4 }),
    /Invalid GameSession transition defeat -> playing/,
  );
  assert.equal(session.snapshot().hull, 0);

  const production = createGameSession({ development: false });
  production.startRun('standard', 8);
  production.startRoom({ id: 'room-2' });
  production.reconcileCompatibilityHull(0);
  assert.equal(production.reconcileCompatibilityHull(3), false);
  assert.deepEqual(
    { mode: production.snapshot().mode, hull: production.snapshot().hull },
    { mode: 'defeat', hull: 0 },
  );
});

test('authoritative hull APIs validate finite positive capacity', () => {
  assert.throws(() => createGameSession({ maxHull: Number.POSITIVE_INFINITY }), /positive and finite/);
  const session = createGameSession({ development: true });
  session.startRun('standard', 7);
  session.startRoom({ id: 'room-1' });

  for (const invalidMaxHull of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => session.upgradeHullCapacity(invalidMaxHull, { repair: 1 }),
      /maxHull must be positive and finite/,
    );
    assert.throws(
      () => session.reconcileCompatibilityHull(2, { maxHull: invalidMaxHull }),
      /maxHull must be positive and finite/,
    );
  }
});
