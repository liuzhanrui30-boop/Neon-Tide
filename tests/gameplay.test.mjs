import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeFrameDeltas,
  computeRank,
  computeReward,
  computeSpawnBudget,
  getStage,
  getStageIndex,
  pickUpgradeOptions,
} from '../src/game/gameplay.js';
import { GAME, STAGES, UPGRADES } from '../src/game/config.js';

test('a long wall frame advances authoritative time while simulation remains capped', () => {
  const frame = computeFrameDeltas(2, 1);
  const slowedFrame = computeFrameDeltas(2, 0.5);

  assert.equal(frame.wallDt, 2);
  assert.equal(frame.simDt, 0.05);
  assert.equal(slowedFrame.wallDt, 2);
  assert.equal(slowedFrame.simDt, 0.025);
});

test('session timing is derived from boss entry and the boss window', () => {
  assert.equal(GAME.bossStart, STAGES[3].start);
  assert.equal(GAME.duration, GAME.bossStart + GAME.bossWindow);
});

test('stage boundaries begin each phase exactly at 0, 18, 38, and 53 seconds', () => {
  assert.equal(getStageIndex(0), 0);
  assert.equal(getStageIndex(18), 1);
  assert.equal(getStageIndex(38), 2);
  assert.equal(getStageIndex(53), 3);
  assert.equal(getStage(53), STAGES[3]);
});

test('spawn budget provides relief when player health is low', () => {
  const healthy = computeSpawnBudget(42, 100, 4_000);
  const hurt = computeSpawnBudget(42, 20, 4_000);

  assert.ok(hurt < healthy);
  assert.ok(healthy <= 24);
  assert.ok(hurt >= 1);
});

test('rewards cap combo scaling while retaining the supplied multiplier', () => {
  const atCap = computeReward('break', 12, 1.5);
  const beyondCap = computeReward('break', 99, 1.5);
  const unmultiplied = computeReward('break', 12, 1);

  assert.deepEqual(beyondCap, atCap);
  assert.equal(atCap.score, unmultiplied.score * 1.5);
  assert.equal(atCap.energy, unmultiplied.energy * 1.5);
});

test('upgrade options are deterministic, unowned, and unique', () => {
  const randomValues = [0, 0.99, 0.1];
  let call = 0;
  const random = () => randomValues[call++];
  const owned = [UPGRADES[0].id];

  const options = pickUpgradeOptions(owned, random, 3);

  assert.deepEqual(options.map((upgrade) => upgrade.id), [UPGRADES[1].id, UPGRADES.at(-1).id, UPGRADES[2].id]);
  assert.equal(new Set(options.map((upgrade) => upgrade.id)).size, options.length);
  assert.ok(options.every((upgrade) => !owned.includes(upgrade.id)));
});

test('rank thresholds produce S, A, B, and C', () => {
  assert.equal(computeRank({ score: 9_000 }), 'S');
  assert.equal(computeRank({ score: 6_000 }), 'A');
  assert.equal(computeRank({ score: 3_500 }), 'B');
  assert.equal(computeRank({ score: 3_499 }), 'C');
});
