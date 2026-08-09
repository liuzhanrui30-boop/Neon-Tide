import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventQueue } from '../src/game/events.js';
import {
  createCompatibilityRunRoute,
  createNextStandardRunRoute,
  roomRequestForRunRoute,
} from '../src/game/run-route.js';
import { createGameSession, GAME_SESSION_MODES } from '../src/game/session.js';
import { createRunSave } from '../src/persistence/run-save.js';
import {
  applyUpgradeChoice,
  attachPendingOffer,
  createUpgradeBuild,
  getUpgradeById,
  offerBossCoreUpgrades,
  serializeUpgradeBuild,
} from '../src/systems/upgrade-system.js';

class MemoryStorage {
  #values = new Map();

  getItem(key) { return this.#values.get(key) ?? null; }
  setItem(key, value) { this.#values.set(key, String(value)); }
  removeItem(key) { this.#values.delete(key); }
}

const EXPECTED_MODES = ['menu', 'briefing', 'playing', 'upgrade', 'paused', 'chapterComplete', 'victory', 'defeat'];

function offerSeed(runSeed, roomsCompleted, sequence) {
  return Math.trunc(runSeed * 1103515245 + roomsCompleted * 2654435761 + sequence * 2246822519);
}

function findRunSeedForBossUpgrade(id, roomsCompleted = 1, sequence = 0) {
  for (let runSeed = 0; runSeed < 10_000; runSeed += 1) {
    const cards = offerBossCoreUpgrades(createUpgradeBuild(), offerSeed(runSeed, roomsCompleted, sequence));
    if (cards.some((card) => card.id === id)) return runSeed;
  }
  throw new Error(`no deterministic boss offer found for ${id}`);
}

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
  assert.equal(session.selectUpgrade(session.snapshot().build.pendingOffer.cards[0]), true);
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
  assert.equal(snapshot.chapterIndex, 2);
  assert.equal(snapshot.stats.roomsCompleted, 3);
  assert.equal(events.getStats().emitted > 0, true);
});

test('starting an encounter room creates objective and threat ownership in the session snapshot', () => {
  const session = createGameSession({ development: true });
  session.startRun('standard', 4455);
  session.startRoom({ id: 'anchor-break', chapterIndex: 0 });
  const room = session.snapshot().room;
  assert.equal(room.templateId, 'anchor-break');
  assert.equal(room.objective.type, 'anchors');
  assert.ok(room.threatBudget.total > 0);
  assert.equal(room.objective.seed, session.getEncounterSnapshot().objective.seed);
});

test('natural campaign room requests select authored objectives in Standard and Abyss', () => {
  for (const mode of ['standard', 'abyss']) {
    const session = createGameSession({ development: true, deterministicTestMode: true });
    session.startRun(mode, 71);
    session.startRoom({ campaign: true, chapterIndex: 0 });
    assert.equal(session.snapshot().room.objectiveManaged, true);
    assert.equal(session.snapshot().room.objective.type, mode === 'standard' ? 'anchors' : session.getEncounterSnapshot().objective.type);
  }
});

test('objective completion freezes for presentation drain before upgrade and next room', () => {
  const events = createEventQueue();
  const session = createGameSession({ development: true, events });
  session.startRun('standard', 9001);
  session.startRoom({ id: 'purge-tide' });
  const target = session.snapshot().room.objective.target;
  session.updateRoom({ player: { x: 0, y: 0 }, presentationPending: 0 }, 1 / 60, {
    input: Array.from({ length: target }, (_, id) => ({ type: 'enemy:destroyed', payload: { id } })),
    emit: events.emit,
  });
  assert.equal(session.snapshot().mode, 'playing');
  assert.equal(session.snapshot().room.encounterPhase, 'draining');
  assert.equal(session.snapshot().room.combatFrozen, true);
  events.drain(() => {});
  session.updateRoom({ player: { x: 0, y: 0 }, presentationPending: 0 }, 1 / 60, events);
  assert.equal(session.snapshot().mode, 'upgrade');
  assert.equal(session.snapshot().stats.roomsCompleted, 1);
  assert.equal(session.selectUpgrade(session.snapshot().build.pendingOffer.cards[0]), true);
  assert.equal(session.startRoom({ id: 'moving-sanctum' }), true);
  assert.equal(session.snapshot().room.objective.type, 'moving-zone');
});

test('objective failure enters defeat without incrementing roomsCompleted', () => {
  const session = createGameSession({ development: true });
  session.startRun('standard', 12);
  session.startRoom({ objectiveTemplate: { id: 'fast-fail', type: 'anchors', label: 'fail', timeout: 0.1, anchorCount: 2, spawnHooks: [], cleanup: [] } });
  session.updateRoom({ player: { x: 99, y: 99 }, presentationPending: 0 }, 0.2);
  const snapshot = session.snapshot();
  assert.equal(snapshot.mode, 'defeat');
  assert.equal(snapshot.stats.roomsStarted, 1);
  assert.equal(snapshot.stats.roomsCompleted, 0);
});

test('checkpoint restore reproduces the next authored room index and geometry', () => {
  const storage = new MemoryStorage();
  const runSave = createRunSave(storage);
  const original = createGameSession({ development: true, runSave, now: () => 222 });
  original.startRun('standard', 909);
  original.startRoom({ campaign: true, chapterIndex: 0 });
  original.completeRoom({ nextMode: 'chapterComplete', chapterIndex: 1 });
  original.startRoom({ campaign: true, chapterIndex: 1 });
  const expected = original.snapshot().room.objective;

  const restored = createGameSession({ development: true, runSave, now: () => 333 });
  assert.equal(restored.restoreCheckpoint(), true);
  restored.startRoom({ campaign: true, chapterIndex: 1 });
  assert.equal(restored.getEncounterSnapshot().roomIndex, original.getEncounterSnapshot().roomIndex);
  assert.deepEqual(restored.snapshot().room.objective.path, expected.path);
  assert.equal(restored.snapshot().room.objective.seed, expected.seed);
});

test('selected checkpoint resumes the same next authored template, chapter, realm projection, and threat', () => {
  const storage = new MemoryStorage();
  const runSave = createRunSave(storage);
  const original = createGameSession({ development: true, runSave, now: () => 444 });
  original.startRun('standard', 9090);
  original.startRoom({ campaign: true });
  original.completeRoom({ nextMode: 'upgrade' });
  original.selectUpgrade(original.snapshot().build.pendingOffer.cards[0]);
  const selectedCheckpoint = runSave.load();
  assert.equal(selectedCheckpoint.chapterIndex, 1);
  original.startRoom({ campaign: true });
  const uninterrupted = original.snapshot();

  const restored = createGameSession({ development: true, runSave, now: () => 555 });
  assert.equal(restored.restoreCheckpoint(), true);
  assert.equal(restored.snapshot().chapterIndex, selectedCheckpoint.chapterIndex);
  restored.startRoom({ campaign: true });
  const resumed = restored.snapshot();
  assert.deepEqual({
    templateId: resumed.room.templateId,
    chapterIndex: resumed.chapterIndex,
    realmIndex: resumed.chapterIndex,
    threatBudget: resumed.room.threatBudget,
  }, {
    templateId: uninterrupted.room.templateId,
    chapterIndex: uninterrupted.chapterIndex,
    realmIndex: uninterrupted.chapterIndex,
    threatBudget: uninterrupted.room.threatBudget,
  });
  assert.equal(resumed.room.templateId, 'moving-sanctum');
});

test('pending compatibility checkpoint resumes the exact route after selecting an upgrade', () => {
  const storage = new MemoryStorage();
  const runSave = createRunSave(storage);
  const original = createGameSession({ development: true, runSave, now: () => 777, initialRouteKind: 'compatibility' });
  original.startRun('standard', 8181);
  original.startRoom({ id: 'legacy-reef-stage', compatibility: true, chapterIndex: 1 });
  original.completeRoom({ nextMode: 'upgrade' });
  const pendingCheckpoint = runSave.load();
  assert.deepEqual(pendingCheckpoint.route, createCompatibilityRunRoute({
    roomIndex: 1, chapterIndex: 1, templateId: 'legacy-reef-stage',
  }));

  const choice = original.snapshot().build.pendingOffer.cards[0];
  original.selectUpgrade(choice);
  original.startRoom(roomRequestForRunRoute(original.snapshot().route));
  const uninterrupted = original.snapshot();

  const restored = createGameSession({ development: true });
  assert.equal(restored.restoreCheckpoint(pendingCheckpoint), true);
  assert.deepEqual(restored.snapshot().route, pendingCheckpoint.route);
  assert.equal(restored.continuePendingOffer(), true);
  assert.equal(restored.selectUpgrade(choice), true);
  restored.startRoom(roomRequestForRunRoute(restored.snapshot().route));
  const resumed = restored.snapshot();

  assert.deepEqual(resumed.route, uninterrupted.route);
  assert.deepEqual({
    templateId: resumed.room.templateId,
    chapterIndex: resumed.chapterIndex,
    realmIndex: resumed.route.realmIndex,
    threatBudget: resumed.room.threatBudget,
  }, {
    templateId: uninterrupted.room.templateId,
    chapterIndex: uninterrupted.chapterIndex,
    realmIndex: uninterrupted.route.realmIndex,
    threatBudget: uninterrupted.room.threatBudget,
  });
});

test('fixed-step objective updates publish bounded session changes rather than every tick', () => {
  let objectiveChanges = 0;
  const authority = {};
  const session = createGameSession({
    development: true,
    objectiveAuthority: authority,
    onChange: ({ detail }) => { if (detail?.objectiveUpdated) objectiveChanges += 1; },
  });
  session.startRun('standard', 55);
  session.startRoom({ id: 'moving-sanctum' });
  for (let index = 0; index < 60; index += 1) {
    let player;
    authority.visit((objective) => { player = { x: objective.safeZone.x, y: objective.safeZone.y }; });
    session.updateRoom({ player, presentationPending: 0 }, 1 / 60);
  }
  assert.ok(objectiveChanges <= 10, `published ${objectiveChanges} objective changes in one second`);
});

test('session public snapshots cannot mutate objective authority and expose no live getter', () => {
  const authority = {};
  const session = createGameSession({ development: true, objectiveAuthority: authority });
  session.startRun('standard', 616);
  session.startRoom({ id: 'anchor-break' });
  const publicSnapshot = session.snapshot();
  const encounterSnapshot = session.getEncounterSnapshot();
  const original = publicSnapshot.room.objective.anchors[0].x;
  assert.equal(Object.isFrozen(publicSnapshot.room.objective.anchors[0]), true);
  assert.throws(() => { publicSnapshot.room.objective.anchors[0].x = 888; }, TypeError);
  assert.throws(() => { encounterSnapshot.objective.anchors.push({ x: 0, y: 0 }); }, TypeError);
  let authoritativeX;
  authority.visit((objective) => { authoritativeX = objective.anchors[0].x; });
  assert.equal(authoritativeX, original);
  assert.equal('getLiveEncounterObjective' in session, false);
});

test('thousands of internal fixed steps do not publish or clone a full objective each tick', () => {
  let objectiveChanges = 0;
  const authority = {};
  const session = createGameSession({
    development: true,
    objectiveAuthority: authority,
    onChange: ({ detail }) => { if (detail?.objectiveUpdated) objectiveChanges += 1; },
  });
  session.startRun('standard', 717);
  session.startRoom({ id: 'moving-sanctum' });
  let snapshotCount = 0;
  for (let index = 0; index < 3_000; index += 1) {
    let player;
    authority.visit((objective) => {
      player = { x: objective.safeZone.x, y: objective.safeZone.y };
      snapshotCount = objective._snapshotCount;
    });
    session.updateRoom({ player, presentationPending: 1 }, 0.001);
  }
  authority.visit((objective) => { snapshotCount = objective._snapshotCount; });
  assert.ok(snapshotCount < 30, `created ${snapshotCount} full objective snapshots`);
  assert.ok(objectiveChanges < 30, `published ${objectiveChanges} full session changes`);
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

  const seed = findRunSeedForBossUpgrade('repair-swarm');
  session.startRun('standard', seed);
  session.startRoom({ campaign: true });
  assert.equal(runSave.getStatus().saves, 0, 'a room start is not a checkpoint');
  assert.equal(session.completeRoom({ nextMode: 'upgrade', rewardKind: 'boss', score: 50 }), true);
  assert.ok(session.snapshot().build.pendingOffer.cards.includes('repair-swarm'));
  assert.equal(session.selectUpgrade('repair-swarm'), true);
  assert.equal(session.snapshot().mode, 'upgrade');
  assert.deepEqual(runSave.load(), {
    version: 2, mode: 'standard', seed, chapterIndex: 1,
    route: createNextStandardRunRoute(1, seed),
    build: serializeUpgradeBuild(createUpgradeBuild({ ownedUpgrades: ['repair-swarm'], offerSequence: 1 })), hull: 4,
    stats: { roomsStarted: 1, roomsCompleted: 1, damageTaken: 0, score: 50 }, savedAt: 1234,
  });
  const savesAfterTransition = runSave.getStatus().saves;
  session.startRoom({ campaign: true });
  assert.equal(runSave.getStatus().saves, savesAfterTransition, 'next room must not rewrite the chapter entry');

  session.damageHull(4);
  assert.deepEqual(
    { mode: session.snapshot().mode, runMode: session.snapshot().runMode, chapterIndex: session.snapshot().chapterIndex, hull: session.snapshot().hull, maxHull: session.snapshot().maxHull, room: session.snapshot().room },
    { mode: 'briefing', runMode: 'standard', chapterIndex: 1, hull: 4, maxHull: 4, room: null },
  );
});


test('chapter checkpoint is persisted before transition observers can start the next room', () => {
  const storage = new MemoryStorage();
  const runSave = createRunSave(storage);
  let session;
  session = createGameSession({
    development: true,
    runSave,
    now: () => 22,
    onChange: ({ current }) => {
      if (current.mode === 'chapterComplete') session.startRoom({ id: 'reentrant-next-room', chapterIndex: 1 });
    },
  });
  session.startRun('standard', 12);
  session.startRoom({ id: 'chapter-0', chapterIndex: 0 });

  assert.equal(session.completeRoom({ nextMode: 'chapterComplete', chapterIndex: 1 }), true);
  assert.equal(session.snapshot().mode, 'playing');
  assert.deepEqual(runSave.load(), {
    version: 2, mode: 'standard', seed: 12, chapterIndex: 1,
    route: createNextStandardRunRoute(1, 12),
    build: serializeUpgradeBuild(createUpgradeBuild()), hull: 3,
    stats: { roomsStarted: 1, roomsCompleted: 1, damageTaken: 0, score: 0 }, savedAt: 22,
  });
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
    version: 2, mode: 'standard', seed: 5, chapterIndex: 2,
    route: createNextStandardRunRoute(2, 5),
    build: serializeUpgradeBuild(createUpgradeBuild({ ownedUpgrades: ['ion-drive'], offerSequence: 1 })), hull: 3,
    stats: { roomsStarted: 2, roomsCompleted: 2, damageTaken: 0, score: 25 }, savedAt: 1,
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

test('huge compatibility chapters fail before mutating the session', () => {
  const session = createGameSession({ development: true, initialRouteKind: 'compatibility' });
  session.startRun('standard', 3);
  assert.throws(
    () => session.startRoom({ id: 'huge-route', compatibility: true, chapterIndex: 999999 }),
    /outside the campaign/,
  );
  assert.equal(session.snapshot().mode, 'briefing');
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

test('malicious checkpoint build and stat payloads cannot mutate the session', () => {
  const storage = new MemoryStorage();
  const runSave = createRunSave(storage);
  const session = createGameSession({ development: true, runSave });
  const before = session.snapshot();

  for (const checkpoint of [
    { version: 1, mode: 'standard', seed: 1, chapterIndex: 1, build: { ownedUpgrades: ['unknown'] }, hull: 3, stats: { roomsStarted: 1, roomsCompleted: 1, damageTaken: 0, score: 0 }, savedAt: 1 },
    { version: 1, mode: 'standard', seed: 1, chapterIndex: 1, build: { ownedUpgrades: ['repair-swarm', 'repair-swarm'] }, hull: 4, stats: { roomsStarted: 1, roomsCompleted: 1, damageTaken: 0, score: 0 }, savedAt: 1 },
    { version: 1, mode: 'standard', seed: 1, chapterIndex: 1, build: { ownedUpgrades: ['repair-swarm'], maxHull: 999 }, hull: 4, stats: { roomsStarted: 1, roomsCompleted: 1, damageTaken: 0, score: 0 }, savedAt: 1 },
    { version: 1, mode: 'standard', seed: 1, chapterIndex: 1, build: { ownedUpgrades: [] }, hull: 4, stats: { roomsStarted: 1, roomsCompleted: 1, damageTaken: 0, score: 0 }, savedAt: 1 },
    { version: 1, mode: 'standard', seed: 1, chapterIndex: 1, build: { ownedUpgrades: [] }, hull: 3, stats: { roomsStarted: 1, roomsCompleted: 2, damageTaken: 0, score: 0 }, savedAt: 1 },
  ]) {
    storage.setItem('neon-tide:v3:checkpoint', JSON.stringify(checkpoint));
    assert.equal(session.restoreCheckpoint(), false);
    assert.deepEqual(session.snapshot(), before);
  }
  assert.equal(runSave.getStatus().corruptions, 5);

  session.startRun('standard', 2);
  session.startRoom({ id: 'room' });
  const activeBefore = session.snapshot();
  assert.throws(() => session.setBuild({ ownedUpgrades: ['unknown'] }), /unique known upgrade IDs/);
  assert.deepEqual(session.snapshot(), activeBefore);
  assert.throws(() => session.setStats({ roomsStarted: 1, roomsCompleted: 2, damageTaken: 0, score: 0 }), /bounded finite campaign values/);
  assert.deepEqual(session.snapshot(), activeBefore);
});

test('pending upgrade authority rejects forged, stale, maxed and incompatible checkpoint cards', () => {
  const storage = new MemoryStorage();
  const runSave = createRunSave(storage);
  const session = createGameSession({ development: true, runSave });
  const base = {
    version: 2,
    mode: 'standard',
    seed: 11,
    chapterIndex: 1,
    route: createNextStandardRunRoute(1, 11),
    hull: 3,
    stats: { roomsStarted: 1, roomsCompleted: 1, damageTaken: 0, score: 0 },
    savedAt: 1,
  };
  const validBuild = attachPendingOffer(createUpgradeBuild({ starterWeapon: 'pulse-cannon' }), 4567);
  const valid = serializeUpgradeBuild(validBuild);
  const forgedBuilds = [
    { ...valid, pendingOffer: { ...valid.pendingOffer, cards: ['drone-volley', ...valid.pendingOffer.cards.slice(1)] } },
    { ...valid, pendingOffer: { ...valid.pendingOffer, cards: [...valid.pendingOffer.cards].reverse() } },
    { ...valid, pendingOffer: { ...valid.pendingOffer, seed: valid.pendingOffer.seed + 1 } },
    {
      ...valid,
      upgradeStacks: { ...valid.upgradeStacks, [valid.pendingOffer.cards[0]]: getUpgradeById(valid.pendingOffer.cards[0]).maxStacks },
    },
  ];
  for (const build of forgedBuilds) {
    storage.setItem('neon-tide:v3:checkpoint', JSON.stringify({ ...base, build }));
    assert.equal(session.restoreCheckpoint(), false);
  }
});

test('an unresolved pending offer cannot transition back to playing or be skipped', () => {
  const session = createGameSession({ development: true, deterministicTestMode: true, initialRouteKind: 'compatibility' });
  session.startRun('standard', 77);
  session.startRoom({ id: 'offer-room', compatibility: true });
  session.completeRoom({ nextMode: 'upgrade' });
  assert.equal(session.snapshot().mode, 'upgrade');
  assert.throws(() => session.startRoom({ id: 'skip', compatibility: true }), /Invalid GameSession transition upgrade -> playing/);
  const choice = session.snapshot().build.pendingOffer.cards[0];
  assert.equal(session.selectUpgrade(choice), true);
  assert.equal(session.startRoom({ id: 'next', compatibility: true }), true);
});

test('new runs and resets expose the full immutable canonical progression build schema', () => {
  const session = createGameSession({ development: true });
  const expectedKeys = ['offerSequence', 'ownedUpgrades', 'pendingOffer', 'starterWeapon', 'upgradeStacks'];
  assert.deepEqual(Object.keys(session.snapshot().build).sort(), expectedKeys);
  session.setStarterWeapon('prism-missiles');
  assert.equal(session.snapshot().build.starterWeapon, 'prism-missiles');
  session.startRun('standard', 1);
  assert.deepEqual(Object.keys(session.snapshot().build).sort(), expectedKeys);
  assert.equal(session.snapshot().build.starterWeapon, 'prism-missiles');
  session.reset();
  assert.deepEqual(Object.keys(session.snapshot().build).sort(), expectedKeys);
});

test('setBuild cannot replace progression, clear pending offers, or grant unoffered cards', () => {
  const session = createGameSession({ development: true, initialRouteKind: 'compatibility' });
  session.setStarterWeapon('arc-drones');
  session.startRun('standard', 12);
  session.startRoom({ id: 'starter-lock', compatibility: true });
  assert.throws(() => session.setBuild(createUpgradeBuild({ starterWeapon: 'pulse-cannon' })), /Invalid GameSession transition/);
  session.completeRoom({ nextMode: 'upgrade' });
  const pending = session.snapshot();
  assert.throws(() => session.setBuild(createUpgradeBuild({ starterWeapon: 'arc-drones' })), /Invalid GameSession transition/);
  assert.throws(() => session.setBuild(createUpgradeBuild({
    starterWeapon: 'arc-drones', upgradeStacks: { 'drone-volley': 1 },
  })), /Invalid GameSession transition/);
  assert.deepEqual(session.snapshot(), pending);
  assert.throws(() => session.startRoom({ id: 'skip', compatibility: true }), /upgrade -> playing/);
});

test('public build snapshots and cached stats are deeply immutable detached views', () => {
  const session = createGameSession({ development: true });
  const snapshot = session.snapshot();
  assert.equal(Object.isFrozen(snapshot.build), true);
  assert.equal(Object.isFrozen(snapshot.build.ownedUpgrades), true);
  assert.equal(Object.isFrozen(snapshot.build.upgradeStacks), true);
  assert.equal(Object.isFrozen(session.getBuildStats()), true);
  assert.throws(() => { snapshot.build.starterWeapon = 'arc-drones'; }, TypeError);
  assert.throws(() => { session.getBuildStats().weaponDamageMultiplier = 999; }, TypeError);
  assert.equal(session.snapshot().build.starterWeapon, 'pulse-cannon');
  assert.equal(session.getBuildStats().weaponDamageMultiplier, 1);
});

test('room repair applies its derived per-stack amount exactly once on successful completion', () => {
  const storage = new MemoryStorage();
  const runSave = createRunSave(storage);
  const build = serializeUpgradeBuild(createUpgradeBuild({
    upgradeStacks: { 'tide-reserve': 2 }, offerSequence: 2,
  }));
  assert.equal(runSave.save({
    version: 2, mode: 'standard', seed: 91, chapterIndex: 2,
    route: createCompatibilityRunRoute({
      roomIndex: 2, chapterIndex: 2, templateId: 'v2.2-compatibility-chapter-2',
    }),
    build, hull: 3,
    stats: { roomsStarted: 2, roomsCompleted: 2, damageTaken: 0, score: 0 }, savedAt: 1,
  }), true);
  const session = createGameSession({ development: true, runSave });
  assert.equal(session.restoreCheckpoint(), true);
  session.startRoom({ id: 'repair-room', compatibility: true });
  session.damageHull(1);
  assert.equal(session.getHull(), 2);
  session.completeRoom({ nextMode: 'chapterComplete' });
  assert.equal(session.getHull(), 2.5);
});
