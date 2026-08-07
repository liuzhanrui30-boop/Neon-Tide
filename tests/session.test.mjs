import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventQueue } from '../src/game/events.js';
import { createGameSession, GAME_SESSION_MODES } from '../src/game/session.js';
import { createRunSave } from '../src/persistence/run-save.js';

class MemoryStorage {
  #values = new Map();

  getItem(key) { return this.#values.get(key) ?? null; }
  setItem(key, value) { this.#values.set(key, String(value)); }
  removeItem(key) { this.#values.delete(key); }
}

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

test('Abyss death clears the run and begins a fresh chapter-zero attempt', () => {
  const session = createGameSession({ development: true, maxHull: 3, deterministicTestMode: true });
  session.startRun('abyss', 99);
  session.startRoom({ id: 'abyss-01', chapterIndex: 0 });
  assert.equal(session.damageHull(2), true);
  assert.equal(session.snapshot().hull, 1);
  assert.equal(session.damageHull(1), true);
  const defeated = session.snapshot();
  assert.equal(defeated.mode, 'briefing');
  assert.equal(defeated.runMode, 'abyss');
  assert.equal(defeated.seed, 99);
  assert.equal(defeated.chapterIndex, 0);
  assert.equal(defeated.hull, 3);
  assert.equal(defeated.stats.damageTaken, 0);
  assert.equal(session.reset(), true);
  const reset = session.snapshot();
  assert.equal(reset.mode, 'menu');
  assert.equal(reset.hull, 3);
  assert.equal(reset.runMode, null);
  assert.notEqual(reset, defeated);
});

test('Abyss changes the selected seed outside deterministic test mode', () => {
  const session = createGameSession({ development: true, seedFactory: () => 31 });
  session.startRun('abyss', 31);
  session.startRoom({ id: 'abyss-01', chapterIndex: 0 });
  session.damageHull(3);
  assert.deepEqual(
    { mode: session.snapshot().mode, chapterIndex: session.snapshot().chapterIndex, seed: session.snapshot().seed },
    { mode: 'briefing', chapterIndex: 0, seed: 32 },
  );
});


test('Standard saves only completed chapter entries and restores that snapshot on death', () => {
  const storage = new MemoryStorage();
  const runSave = createRunSave(storage);
  const session = createGameSession({ development: true, runSave, now: () => 1234, maxHull: 3 });

  session.startRun('standard', 77);
  session.startRoom({ id: 'chapter-0-room', chapterIndex: 0 });
  assert.equal(runSave.getStatus().saves, 0, 'a room start is not a checkpoint');
  session.upgradeHullCapacity(4, { repair: 1 });
  assert.equal(session.completeRoom({ nextMode: 'chapterComplete', chapterIndex: 2, score: 50 }), true);
  assert.equal(session.snapshot().mode, 'chapterComplete');
  assert.deepEqual(runSave.load(), {
    version: 1, mode: 'standard', seed: 77, chapterIndex: 2, build: {}, hull: 4, maxHull: 4,
    stats: { roomsStarted: 1, roomsCompleted: 1, damageTaken: 0, score: 50 }, savedAt: 1234,
  });
  const savesAfterTransition = runSave.getStatus().saves;
  session.startRoom({ id: 'chapter-2-room', chapterIndex: 2 });
  assert.equal(runSave.getStatus().saves, savesAfterTransition, 'next room must not rewrite the chapter entry');

  session.damageHull(4);
  assert.deepEqual(
    { mode: session.snapshot().mode, runMode: session.snapshot().runMode, chapterIndex: session.snapshot().chapterIndex, hull: session.snapshot().hull, maxHull: session.snapshot().maxHull, room: session.snapshot().room },
    { mode: 'briefing', runMode: 'standard', chapterIndex: 2, hull: 4, maxHull: 4, room: null },
  );
});

test('checkpoint restore and corrupt storage keep session snapshots valid', () => {
  const storage = new MemoryStorage();
  storage.setItem('neon-tide:v3:checkpoint', '{not json');
  const runSave = createRunSave(storage);
  const session = createGameSession({ development: true, runSave });
  const before = session.snapshot();
  assert.equal(session.restoreCheckpoint(), false);
  assert.deepEqual(session.snapshot(), before);
  assert.equal(session.getPersistenceStatus().corruptions, 1);

  assert.equal(runSave.save({
    version: 1, mode: 'standard', seed: 5, chapterIndex: 2, build: { beam: 1 }, hull: 3,
    stats: { roomsStarted: 2 }, savedAt: 1,
  }), true);
  assert.equal(session.restoreCheckpoint(), true);
  assert.deepEqual(
    { mode: session.snapshot().mode, seed: session.snapshot().seed, chapterIndex: session.snapshot().chapterIndex, hull: session.snapshot().hull },
    { mode: 'briefing', seed: 5, chapterIndex: 2, hull: 3 },
  );
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

test('terminal compatibility reconciliation exposes only an atomic defeat snapshot', () => {
  const events = createEventQueue();
  const changes = [];
  let session;
  session = createGameSession({
    development: true,
    events,
    onChange: ({ previous, current, detail }) => changes.push({
      previous,
      current,
      detail,
      observed: session.snapshot(),
    }),
  });
  session.startRun('standard', 9);
  session.startRoom({ id: 'room-atomic' });
  changes.length = 0;
  events.clear();
  const revisionBefore = session.snapshot().revision;

  assert.equal(session.reconcileCompatibilityHull(0, { maxHull: 4 }), true);

  assert.equal(changes.length, 1);
  assert.deepEqual(
    changes.map(({ current, observed }) => ({
      current: { mode: current.mode, hull: current.hull },
      observed: { mode: observed.mode, hull: observed.hull },
    })),
    [{ current: { mode: 'defeat', hull: 0 }, observed: { mode: 'defeat', hull: 0 } }],
  );
  assert.equal(changes[0].current.revision, revisionBefore + 1);

  const drained = [];
  events.drain((event) => drained.push(event));
  assert.deepEqual(drained.map(({ type }) => type), ['session:transition']);
  assert.deepEqual(
    drained.map(({ payload }) => ({ mode: payload.current.mode, hull: payload.current.hull })),
    [{ mode: 'defeat', hull: 0 }],
  );
  assert.equal(
    [...changes.map(({ current }) => current), ...drained.map(({ payload }) => payload.current)]
      .some(({ mode, hull }) => ['playing', 'paused', 'upgrade'].includes(mode) && hull === 0),
    false,
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
