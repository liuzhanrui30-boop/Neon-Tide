import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeFrameDeltas,
  computeRank,
  computeReward,
  computeSpawnBudget,
  finiteOr,
  clampFinite,
  capActiveCount,
  getStage,
  getStageIndex,
  pickUpgradeOptions,
} from '../src/game/gameplay.js';
import { GAME, STAGES, UPGRADES } from '../src/game/config.js';
import * as gameplay from '../src/game/gameplay.js';

test('a long wall frame advances authoritative time while simulation remains capped', () => {
  const frame = computeFrameDeltas(2, 1);
  const slowedFrame = computeFrameDeltas(2, 0.5);

  assert.equal(frame.wallDt, 2);
  assert.equal(frame.simDt, 0.05);
  assert.equal(slowedFrame.wallDt, 2);
  assert.equal(slowedFrame.simDt, 0.025);
});

test('runtime sanitizers reject NaN and Infinity before they reach gameplay state', () => {
  assert.equal(finiteOr(Number.NaN, 7), 7);
  assert.equal(finiteOr(Number.POSITIVE_INFINITY, -2), -2);
  assert.equal(clampFinite(Number.NaN, 0, 5, 2), 2);
  assert.equal(clampFinite(Number.POSITIVE_INFINITY, 0, 5, 2), 2);
  assert.equal(clampFinite(-10, 0, 5), 0);
  assert.equal(clampFinite(10, 0, 5), 5);
  assert.equal(capActiveCount(99.9, 36), 36);
  assert.equal(capActiveCount(Number.POSITIVE_INFINITY, 36), 0);
  assert.equal(capActiveCount(-Infinity, 36), 0);
  assert.equal(capActiveCount(Number.NaN, 36), 0);
});

test('session timing is derived from boss entry and the boss window', () => {
  assert.equal(GAME.bossStart, STAGES[3].start);
  assert.equal(GAME.duration, GAME.bossStart + GAME.bossWindow);
});

test('stage boundaries begin each phase exactly at 0, 30, 64, and 100 seconds', () => {
  assert.equal(getStageIndex(0), 0);
  assert.equal(getStageIndex(30), 1);
  assert.equal(getStageIndex(64), 2);
  assert.equal(getStageIndex(100), 3);
  assert.equal(getStage(100), STAGES[3]);
});

test('spawn budget provides relief when player health is low', () => {
  const healthy = computeSpawnBudget(42, 100, 4_000);
  const hurt = computeSpawnBudget(42, 20, 4_000);

  assert.ok(hurt < healthy);
  assert.ok(healthy <= 36);
  assert.ok(hurt >= 1);
});

test('rewards cap combo scaling while retaining the supplied multiplier', () => {
  const atCap = computeReward('break', 12, 1.5);
  const beyondCap = computeReward('break', 99, 1.5);
  const unmultiplied = computeReward('break', 12, 1);

  assert.deepEqual(beyondCap, atCap);
  assert.equal(atCap.score, unmultiplied.score * 1.5);
  assert.equal(atCap.energy, 0);
  assert.equal(unmultiplied.energy, 0);
});

test('score rewards never carry weapon charge or an automatic overdrive contract', () => {
  assert.deepEqual(['pickup', 'nearMiss', 'break', 'bossHit'].map((kind) => computeReward(kind, 8, 1).energy), [0, 0, 0, 0]);
  assert.equal('overdriveEnergy' in GAME, false);
  assert.equal('overdriveDuration' in GAME, false);
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

test('beam collision uses the same full width rendered by the beam mesh', () => {
  assert.equal(typeof gameplay.beamHitsCircle, 'function');
  const beam = { originX: 0, originY: 0, directionX: 1, directionY: 0, width: 2, length: 18 };

  assert.equal(gameplay.beamHitsCircle(beam, { x: 5, y: 1.39, radius: 0.4 }), true);
  assert.equal(gameplay.beamHitsCircle(beam, { x: 5, y: 1.41, radius: 0.4 }), false);
  assert.equal(gameplay.beamHitsCircle(beam, { x: -0.1, y: 0, radius: 0.4 }), false);
  assert.equal(gameplay.beamHitsCircle(beam, { x: 18.1, y: 0, radius: 0.4 }), false);
});

test('mine detonation advances through three monotonic expansion stages with discrete reduced-motion radii', () => {
  assert.equal(typeof gameplay.getMineDetonationFrame, 'function');
  const animated = [0.77, 0.51, 0.25].map((timeRemaining) => gameplay.getMineDetonationFrame(timeRemaining, false));
  const reduced = [0.77, 0.51, 0.25].map((timeRemaining) => gameplay.getMineDetonationFrame(timeRemaining, true));

  assert.deepEqual(animated.map(({ stage }) => stage), [0, 1, 2]);
  assert.ok(animated[0].radius < animated[1].radius && animated[1].radius < animated[2].radius);
  assert.deepEqual(reduced.map(({ stage }) => stage), [0, 1, 2]);
  assert.deepEqual(reduced.map(({ radius }) => radius), [1.7, 3.25, 4.8]);
});
