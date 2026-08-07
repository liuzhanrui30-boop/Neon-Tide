import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunSave } from '../src/persistence/run-save.js';

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
    chapterIndex: 2,
    build: { weapons: ['arc'] },
    hull: 3,
    stats: { roomsCompleted: 7 },
    savedAt: 1_725_000_000_000,
    ...overrides,
  };
}

test('checkpoint round-trips a cloned, versioned Standard chapter entry', () => {
  const storage = new MemoryStorage();
  const save = createRunSave(storage);
  const source = checkpoint();
  assert.equal(save.save(source), true);
  source.build.weapons.push('mutated');

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

  const unavailable = createRunSave(null);
  assert.equal(unavailable.save(checkpoint()), false);
  assert.equal(unavailable.load(), null);
  assert.equal(unavailable.clear(), false);
  assert.equal(unavailable.getStatus().failures, 3);
});
