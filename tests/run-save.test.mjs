import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunSave } from '../src/persistence/run-save.js';
import {
  createCompatibilityRunRoute,
  createNextStandardRunRoute,
} from '../src/game/run-route.js';
import {
  attachPendingOffer,
  createUpgradeBuild,
  deriveUpgradeOfferSeed,
  serializeUpgradeBuild,
} from '../src/systems/upgrade-system.js';

class MemoryStorage {
  #values = new Map();

  getItem(key) { return this.#values.get(key) ?? null; }
  setItem(key, value) { this.#values.set(key, String(value)); }
  removeItem(key) { this.#values.delete(key); }
}

class RejectingRewriteStorage extends MemoryStorage {
  rejectWrites = false;

  setItem(key, value) {
    if (this.rejectWrites) throw new Error('replacement rejected');
    super.setItem(key, value);
  }
}

function checkpoint(overrides = {}) {
  return {
    version: 2,
    mode: 'standard',
    seed: 42,
    chapterIndex: 3,
    route: createCompatibilityRunRoute({
      roomIndex: 7, chapterIndex: 3, templateId: 'v2.2-boss-compatibility',
    }),
    build: serializeUpgradeBuild(createUpgradeBuild({
      ownedUpgrades: ['ion-drive'],
      offerSequence: 1,
    })),
    hull: 3,
    stats: { roomsStarted: 7, roomsCompleted: 7, damageTaken: 2, score: 900 },
    savedAt: 1_725_000_000_000,
    ...overrides,
  };
}

test('checkpoint round-trips a cloned, versioned Standard chapter entry', () => {
  const storage = new MemoryStorage();
  const save = createRunSave(storage);
  const source = checkpoint();
  assert.equal(save.save(source), true);
  source.build.ownedUpgrades.push('mutated');

  assert.deepEqual(save.load(), checkpoint());
  assert.deepEqual(save.getStatus(), {
    key: 'neon-tide:v3:checkpoint', saves: 1, loads: 1, migrations: 0, clears: 0,
    corruptions: 0, failures: 0, lastError: null, available: true,
  });
});

test('checkpoint rejects Abyss saves and corrupt payloads safely', () => {
  const storage = new MemoryStorage();
  const save = createRunSave(storage);
  assert.equal(save.save({ version: 2, mode: 'abyss' }), false);
  storage.setItem('neon-tide:v3:checkpoint', '{broken');
  assert.equal(save.load(), null);
  assert.equal(save.getStatus().corruptions, 1);
  assert.equal(storage.getItem('neon-tide:v3:checkpoint'), null);
});

test('checkpoint rejects mismatched schemas and storage failures without throwing', () => {
  const storage = new MemoryStorage();
  const save = createRunSave(storage);
  storage.setItem('neon-tide:v3:checkpoint', JSON.stringify(checkpoint({ version: 99 })));
  assert.equal(save.load(), null);
  assert.equal(save.getStatus().corruptions, 1);
  assert.equal(save.save(checkpoint({ maxHull: 4 })), false, 'v2 rejects unversioned top-level extensions');
  for (const payload of [
    checkpoint({ build: { ownedUpgrades: ['unknown-upgrade'] } }),
    checkpoint({ build: { ownedUpgrades: ['ion-drive', 'ion-drive'] } }),
    checkpoint({ build: { ownedUpgrades: ['repair-swarm'], maxHull: 999 } }),
    checkpoint({ stats: { roomsStarted: 1, roomsCompleted: 2, damageTaken: 0, score: 0 } }),
    checkpoint({ stats: { roomsStarted: 1, roomsCompleted: 1, damageTaken: Number.NaN, score: 0 } }),
    checkpoint({ build: serializeUpgradeBuild(createUpgradeBuild({
      upgradeStacks: { 'ion-drive': 2 }, offerSequence: 0,
    })), stats: { roomsStarted: 0, roomsCompleted: 0, damageTaken: 0, score: 0 }, chapterIndex: 0,
    route: createNextStandardRunRoute(0, 42) }),
  ]) assert.equal(save.save(payload), false);


  const unavailable = createRunSave(null);
  assert.equal(unavailable.save(checkpoint()), false);
  assert.equal(unavailable.load(), null);
  assert.equal(unavailable.clear(), false);
  assert.equal(unavailable.getStatus().failures, 3);
});

test('malicious full-build and progression matrices are rejected and cleared', () => {
  const exact = checkpoint();
  const forgedTwoStacks = serializeUpgradeBuild(createUpgradeBuild({
    upgradeStacks: { 'ion-drive': 2 }, offerSequence: 0,
  }));
  const pending = serializeUpgradeBuild(attachPendingOffer(
    createUpgradeBuild(),
    Math.trunc(1 * 1103515245 + 1 * 2654435761),
  ));
  const payloads = [
    { ...exact, build: { ...exact.build, ownedUpgrades: [] } },
    { ...exact, build: { ...exact.build, upgradeStacks: { 'ion-drive': 0 } } },
    { ...exact, build: { ...exact.build, pendingOffer: undefined } },
    { ...exact, build: { ...exact.build, injected: true } },
    { ...exact, build: serializeUpgradeBuild(createUpgradeBuild({
      starterWeapon: 'pulse-cannon', offerSequence: 1,
    })), stats: { ...exact.stats, roomsStarted: 1, roomsCompleted: 1 }, chapterIndex: 1,
    route: createNextStandardRunRoute(1, 42) },
    { ...exact, build: forgedTwoStacks, stats: { roomsStarted: 0, roomsCompleted: 0, damageTaken: 0, score: 0 }, chapterIndex: 0,
      route: createNextStandardRunRoute(0, 42) },
    { ...exact, build: { ...exact.build, offerSequence: 3 } },
    { ...exact, seed: 1, build: serializeUpgradeBuild(attachPendingOffer(createUpgradeBuild(), 123)),
      stats: { roomsStarted: 1, roomsCompleted: 1, damageTaken: 0, score: 0 }, chapterIndex: 1,
      route: createNextStandardRunRoute(1, 1) },
    { ...exact, seed: 1, build: pending, stats: { roomsStarted: 0, roomsCompleted: 0, damageTaken: 0, score: 0 }, chapterIndex: 0,
      route: createNextStandardRunRoute(0, 1) },
    { ...exact, stats: { ...exact.stats, roomsCompleted: exact.stats.roomsStarted - 1 } },
    { ...exact, stats: { ...exact.stats, roomsStarted: 999999999999, roomsCompleted: 999999999999 },
      route: { ...exact.route, roomIndex: 999999999999 } },
    { ...exact, chapterIndex: 999999 },
    { ...exact, route: { ...exact.route, kind: 'authored' } },
    { ...exact, route: { ...exact.route, chapterIndex: 2 } },
    { ...exact, route: { ...exact.route, templateId: 'moving-sanctum' } },
    {
      ...exact,
      chapterIndex: 3,
      route: createCompatibilityRunRoute({
        roomIndex: 0, chapterIndex: 3, templateId: 'impossible-empty-boss',
      }),
      build: serializeUpgradeBuild(createUpgradeBuild()),
      hull: 3,
      stats: { roomsStarted: 0, roomsCompleted: 0, damageTaken: 0, score: 0 },
    },
    {
      ...exact,
      chapterIndex: 1,
      route: createNextStandardRunRoute(1, 42),
      build: serializeUpgradeBuild(createUpgradeBuild()),
      hull: 999,
      stats: { roomsStarted: 1, roomsCompleted: 1, damageTaken: 0, score: 0 },
    },
  ];
  for (const payload of payloads) {
    const storage = new MemoryStorage();
    storage.setItem('neon-tide:v3:checkpoint', JSON.stringify(payload));
    const save = createRunSave(storage);
    assert.equal(save.load(), null);
    assert.equal(storage.getItem('neon-tide:v3:checkpoint'), null);
    assert.equal(save.getStatus().corruptions, 1);
  }
});

test('valid legacy v1 Repair Swarm checkpoints migrate once and rewrite atomically to exact v2', () => {
  const storage = new MemoryStorage();
  const legacy = {
    version: 1,
    mode: 'standard',
    seed: 77,
    chapterIndex: 2,
    build: { ownedUpgrades: ['repair-swarm'] },
    hull: 4,
    stats: { roomsStarted: 3, roomsCompleted: 2, damageTaken: 1, score: 500 },
    savedAt: 99,
  };
  storage.setItem('neon-tide:v3:checkpoint', JSON.stringify(legacy));
  const save = createRunSave(storage);
  const migrated = save.load();
  assert.deepEqual(migrated, {
    version: 2,
    mode: 'standard',
    seed: 77,
    chapterIndex: 2,
    route: createCompatibilityRunRoute({
      roomIndex: 2, chapterIndex: 2, templateId: 'v2.2-compatibility-chapter-2',
    }),
    build: serializeUpgradeBuild(createUpgradeBuild({ ownedUpgrades: ['repair-swarm'], offerSequence: 1 })),
    hull: 4,
    stats: { roomsStarted: 2, roomsCompleted: 2, damageTaken: 1, score: 500 },
    savedAt: 99,
  });
  assert.deepEqual(JSON.parse(storage.getItem('neon-tide:v3:checkpoint')), migrated);
  assert.deepEqual(save.load(), migrated);
  assert.equal(save.getStatus().migrations, 1);
  assert.equal(save.getStatus().loads, 2);
});

test('failed legacy replacement leaves the original v1 checkpoint intact for an idempotent retry', () => {
  const storage = new RejectingRewriteStorage();
  const legacy = {
    version: 1, mode: 'standard', seed: 7, chapterIndex: 1,
    build: { ownedUpgrades: ['repair-swarm'] }, hull: 4,
    stats: { roomsStarted: 1, roomsCompleted: 1, damageTaken: 0, score: 10 }, savedAt: 8,
  };
  const raw = JSON.stringify(legacy);
  storage.setItem('neon-tide:v3:checkpoint', raw);
  storage.rejectWrites = true;
  const save = createRunSave(storage);
  assert.equal(save.load(), null);
  assert.equal(storage.getItem('neon-tide:v3:checkpoint'), raw);
  assert.deepEqual({
    failures: save.getStatus().failures,
    corruptions: save.getStatus().corruptions,
    migrations: save.getStatus().migrations,
  }, { failures: 1, corruptions: 0, migrations: 0 });

  storage.rejectWrites = false;
  const migrated = save.load();
  assert.equal(migrated.version, 2);
  assert.equal(migrated.build.upgradeStacks['repair-swarm'], 1);
  assert.equal(save.getStatus().migrations, 1);
});

test('immediate-predecessor canonical v1 selected and pending builds migrate without loss', () => {
  const selected = {
    version: 1, mode: 'standard', seed: 42, chapterIndex: 1,
    build: serializeUpgradeBuild(createUpgradeBuild({
      ownedUpgrades: ['ion-drive'], offerSequence: 1,
    })),
    hull: 3,
    stats: { roomsStarted: 1, roomsCompleted: 1, damageTaken: 0, score: 20 },
    savedAt: 10,
  };
  const pendingBuild = attachPendingOffer(
    createUpgradeBuild(),
    deriveUpgradeOfferSeed(42, 1, 0),
  );
  const pending = {
    ...selected,
    build: serializeUpgradeBuild(pendingBuild),
    savedAt: 11,
  };
  const repairSelected = {
    ...selected,
    build: serializeUpgradeBuild(createUpgradeBuild({
      ownedUpgrades: ['repair-swarm'], offerSequence: 1,
    })),
    hull: 4,
    savedAt: 12,
  };

  for (const [legacy, expectedBuild] of [
    [selected, selected.build],
    [pending, pending.build],
    [repairSelected, repairSelected.build],
  ]) {
    const storage = new MemoryStorage();
    storage.setItem('neon-tide:v3:checkpoint', JSON.stringify(legacy));
    const save = createRunSave(storage);
    const migrated = save.load();
    assert.equal(migrated.version, 2);
    assert.deepEqual(migrated.route, createNextStandardRunRoute(1, 42));
    assert.deepEqual(migrated.build, expectedBuild);
    assert.deepEqual(JSON.parse(storage.getItem('neon-tide:v3:checkpoint')), migrated);
    assert.deepEqual(save.load(), migrated);
    assert.equal(save.getStatus().migrations, 1);
  }
});

test('one-field legacy chapters zero through two map to their exact compatibility stage nodes', () => {
  for (const chapterIndex of [0, 1, 2]) {
    const roomsCompleted = Math.max(1, chapterIndex);
    const storage = new MemoryStorage();
    storage.setItem('neon-tide:v3:checkpoint', JSON.stringify({
      version: 1, mode: 'standard', seed: 5, chapterIndex,
      build: { ownedUpgrades: [] }, hull: 3,
      stats: { roomsStarted: roomsCompleted, roomsCompleted, damageTaken: 0, score: 0 }, savedAt: 1,
    }));
    const migrated = createRunSave(storage).load();
    assert.deepEqual(migrated.route, createCompatibilityRunRoute({
      roomIndex: roomsCompleted,
      chapterIndex,
      templateId: `v2.2-compatibility-chapter-${chapterIndex}`,
    }));
  }
});

test('canonical compatibility pending migration preserves its stage node and chapter-three legacy uses the boss node', () => {
  const seed = 19;
  const selectedBuild = createUpgradeBuild({ ownedUpgrades: ['ion-drive'], offerSequence: 1 });
  const pendingBuild = attachPendingOffer(selectedBuild, deriveUpgradeOfferSeed(seed, 4, 1));
  const compatibilityPending = {
    version: 1, mode: 'standard', seed, chapterIndex: 2,
    build: serializeUpgradeBuild(pendingBuild), hull: 3,
    stats: { roomsStarted: 4, roomsCompleted: 4, damageTaken: 0, score: 40 }, savedAt: 12,
  };
  const bossLegacy = {
    version: 1, mode: 'standard', seed, chapterIndex: 3,
    build: { ownedUpgrades: ['repair-swarm'] }, hull: 4,
    stats: { roomsStarted: 3, roomsCompleted: 3, damageTaken: 1, score: 80 }, savedAt: 13,
  };
  const canonicalBoss = {
    version: 1, mode: 'standard', seed, chapterIndex: 3,
    build: serializeUpgradeBuild(selectedBuild), hull: 3,
    stats: { roomsStarted: 5, roomsCompleted: 5, damageTaken: 0, score: 120 }, savedAt: 14,
  };

  for (const [legacy, expectedRoute] of [
    [compatibilityPending, createCompatibilityRunRoute({
      roomIndex: 4, chapterIndex: 2, templateId: 'v2.2-compatibility-chapter-2',
    })],
    [bossLegacy, createCompatibilityRunRoute({
      roomIndex: 3, chapterIndex: 3, templateId: 'v2.2-boss-compatibility',
    })],
    [canonicalBoss, createCompatibilityRunRoute({
      roomIndex: 5, chapterIndex: 3, templateId: 'v2.2-boss-compatibility',
    })],
  ]) {
    const storage = new MemoryStorage();
    storage.setItem('neon-tide:v3:checkpoint', JSON.stringify(legacy));
    const migrated = createRunSave(storage).load();
    assert.deepEqual(migrated.route, expectedRoute);
  }
});

test('unknown and malformed legacy v1 checkpoints are cleared instead of migrated', () => {
  for (const build of [
    { ownedUpgrades: ['unknown-upgrade'] },
    { ownedUpgrades: ['repair-swarm', 'repair-swarm'] },
    { ownedUpgrades: 'repair-swarm' },
  ]) {
    const storage = new MemoryStorage();
    storage.setItem('neon-tide:v3:checkpoint', JSON.stringify({
      version: 1, mode: 'standard', seed: 1, chapterIndex: 1, build, hull: 4,
      stats: { roomsStarted: 1, roomsCompleted: 1, damageTaken: 0, score: 0 }, savedAt: 1,
    }));
    const save = createRunSave(storage);
    assert.equal(save.load(), null);
    assert.equal(storage.getItem('neon-tide:v3:checkpoint'), null);
    assert.equal(save.getStatus().corruptions, 1);
    assert.equal(save.getStatus().migrations, 0);
  }

  for (const legacy of [
    {
      version: 1, mode: 'standard', seed: 1, chapterIndex: 999999,
      build: { ownedUpgrades: [] }, hull: 3,
      stats: { roomsStarted: 1, roomsCompleted: 1, damageTaken: 0, score: 0 }, savedAt: 1,
    },
    {
      version: 1, mode: 'standard', seed: 1, chapterIndex: 1,
      build: { ownedUpgrades: ['repair-swarm'] }, hull: 4,
      stats: { roomsStarted: 0, roomsCompleted: 0, damageTaken: 0, score: 0 }, savedAt: 1,
    },
    {
      version: 1, mode: 'standard', seed: 1, chapterIndex: 3,
      build: serializeUpgradeBuild(createUpgradeBuild()), hull: 3,
      stats: { roomsStarted: 0, roomsCompleted: 0, damageTaken: 0, score: 0 }, savedAt: 1,
    },
    {
      version: 1, mode: 'standard', seed: 1, chapterIndex: 1,
      build: serializeUpgradeBuild(createUpgradeBuild()), hull: 999,
      stats: { roomsStarted: 1, roomsCompleted: 1, damageTaken: 0, score: 0 }, savedAt: 1,
    },
  ]) {
    const storage = new MemoryStorage();
    storage.setItem('neon-tide:v3:checkpoint', JSON.stringify(legacy));
    const save = createRunSave(storage);
    assert.equal(save.load(), null);
    assert.equal(storage.getItem('neon-tide:v3:checkpoint'), null);
  }
});
