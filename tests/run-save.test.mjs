import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunSave } from '../src/persistence/run-save.js';
import {
  attachPendingOffer,
  createUpgradeBuild,
  serializeUpgradeBuild,
} from '../src/systems/upgrade-system.js';

class MemoryStorage {
  #values = new Map();

  getItem(key) { return this.#values.get(key) ?? null; }
  setItem(key, value) { this.#values.set(key, String(value)); }
  removeItem(key) { this.#values.delete(key); }
}

function checkpoint(overrides = {}) {
  return {
    version: 1,
    mode: 'standard',
    seed: 42,
    chapterIndex: 3,
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
    key: 'neon-tide:v3:checkpoint', saves: 1, loads: 1, clears: 0,
    corruptions: 0, failures: 0, lastError: null, available: true,
  });
});

test('checkpoint rejects Abyss saves and corrupt payloads safely', () => {
  const storage = new MemoryStorage();
  const save = createRunSave(storage);
  assert.equal(save.save({ version: 1, mode: 'abyss' }), false);
  storage.setItem('neon-tide:v3:checkpoint', '{broken');
  assert.equal(save.load(), null);
  assert.equal(save.getStatus().corruptions, 1);
  assert.equal(storage.getItem('neon-tide:v3:checkpoint'), null);
});

test('checkpoint rejects mismatched schemas and storage failures without throwing', () => {
  const storage = new MemoryStorage();
  const save = createRunSave(storage);
  storage.setItem('neon-tide:v3:checkpoint', JSON.stringify(checkpoint({ version: 2 })));
  assert.equal(save.load(), null);
  assert.equal(save.getStatus().corruptions, 1);
  assert.equal(save.save(checkpoint({ maxHull: 4 })), false, 'v1 rejects unversioned top-level extensions');
  for (const payload of [
    checkpoint({ build: { ownedUpgrades: ['unknown-upgrade'] } }),
    checkpoint({ build: { ownedUpgrades: ['ion-drive', 'ion-drive'] } }),
    checkpoint({ build: { ownedUpgrades: ['repair-swarm'], maxHull: 999 } }),
    checkpoint({ stats: { roomsStarted: 1, roomsCompleted: 2, damageTaken: 0, score: 0 } }),
    checkpoint({ stats: { roomsStarted: 1, roomsCompleted: 1, damageTaken: Number.NaN, score: 0 } }),
    checkpoint({ build: serializeUpgradeBuild(createUpgradeBuild({
      upgradeStacks: { 'ion-drive': 2 }, offerSequence: 0,
    })), stats: { roomsStarted: 0, roomsCompleted: 0, damageTaken: 0, score: 0 }, chapterIndex: 0 }),
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
    })), stats: { ...exact.stats, roomsStarted: 1, roomsCompleted: 1 }, chapterIndex: 1 },
    { ...exact, build: forgedTwoStacks, stats: { roomsStarted: 0, roomsCompleted: 0, damageTaken: 0, score: 0 }, chapterIndex: 0 },
    { ...exact, build: { ...exact.build, offerSequence: 3 } },
    { ...exact, seed: 1, build: serializeUpgradeBuild(attachPendingOffer(createUpgradeBuild(), 123)),
      stats: { roomsStarted: 1, roomsCompleted: 1, damageTaken: 0, score: 0 }, chapterIndex: 1 },
    { ...exact, seed: 1, build: pending, stats: { roomsStarted: 0, roomsCompleted: 0, damageTaken: 0, score: 0 }, chapterIndex: 0 },
    { ...exact, stats: { ...exact.stats, roomsCompleted: exact.stats.roomsStarted - 1 } },
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
