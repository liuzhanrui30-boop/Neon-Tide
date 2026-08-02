import test from 'node:test';
import assert from 'node:assert/strict';

import { GAME, FORMATION_TEMPLATES, STAGES } from '../src/game/config.js';
import {
  chooseFormation,
  getActiveEnemyCap,
  getFormationBudget,
  getFormationSlots,
  getSpawnInterval,
  getStageIndex,
  getStageProgress,
} from '../src/game/director.js';

test('director stage boundaries and total timing are stable', () => {
  assert.deepEqual(GAME.stageBoundaries, [0, 30, 64, 100]);
  assert.equal(GAME.bossStart, 100);
  assert.equal(GAME.bossWindow, 26);
  assert.equal(GAME.duration, 126);
  assert.deepEqual([0, 30, 64, 100].map(getStageIndex), [0, 1, 2, 3]);
  assert.equal(getStageProgress(30), 0);
  assert.equal(getStageProgress(47), 0.5);
  assert.equal(getStageProgress(126), 1);
  assert.equal(STAGES.at(-1).start, GAME.bossStart);
});

test('enemy caps honor desktop and coarse-pointer budgets', () => {
  assert.equal(getActiveEnemyCap({ coarsePointer: false, viewportWidth: 1440 }), 36);
  assert.equal(getActiveEnemyCap({ coarsePointer: true, viewportWidth: 1440 }), 28);
  assert.equal(getActiveEnemyCap({ coarsePointer: false, viewportWidth: 640 }), 28);
  assert.equal(GAME.maxParticles, 300);
  assert.equal(GAME.maxTrailNodes, 48);
});

test('spawn intervals tighten by stage but never cross the floor', () => {
  const first = getSpawnInterval(0, 0);
  const second = getSpawnInterval(1, 30);
  const third = getSpawnInterval(2, 64);
  assert.deepEqual([first, second, third], [0.72, 0.55, 0.42]);
  assert.ok(getSpawnInterval(2, 10_000) >= GAME.spawnIntervalFloor);
  assert.equal(getSpawnInterval(2, 10_000), GAME.spawnIntervalFloor);
});

test('formation budget is constrained by active enemy cap', () => {
  assert.equal(getFormationBudget(0, 0, { activeCost: 0, maxEnemyCap: 36 }), 6);
  assert.equal(getFormationBudget(2, 80, { activeCost: 30, maxEnemyCap: 36 }), 6);
  assert.equal(getFormationBudget(2, 80, { activeCost: 36, maxEnemyCap: 36 }), 0);
});

test('formation chooser is deterministic and rejects cooldown, unsafe gaps, and over-budget plans', () => {
  const first = chooseFormation({
    stageIndex: 1,
    elapsed: 42,
    lastFormation: null,
    cooldownRemaining: 0,
    activeCost: 0,
    maxEnemyCap: 36,
    safeGap: 4,
    seed: 7,
  });
  assert.ok(first);
  assert.ok(FORMATION_TEMPLATES[first.name]);
  assert.notEqual(first.name, chooseFormation({
    stageIndex: 1,
    elapsed: 42,
    lastFormation: first.name,
    cooldownRemaining: 0,
    activeCost: 0,
    maxEnemyCap: 36,
    safeGap: 4,
    seed: 7,
  })?.name);
  assert.equal(chooseFormation({ stageIndex: 1, elapsed: 42, cooldownRemaining: 1, activeCost: 0, maxEnemyCap: 36, safeGap: 4, seed: 7 }), null);
  assert.equal(chooseFormation({ stageIndex: 1, elapsed: 42, cooldownRemaining: 0, activeCost: 0, maxEnemyCap: 36, safeGap: 0, seed: 7 }), null);
  assert.equal(chooseFormation({ stageIndex: 1, elapsed: 42, cooldownRemaining: 0, activeCost: 35, maxEnemyCap: 36, safeGap: 4, seed: 7 }), null);
});

test('formation slots are finite and preserve an opening around the play center', () => {
  for (const name of Object.keys(FORMATION_TEMPLATES)) {
    const slots = getFormationSlots(name, { width: 12, height: 8 });
    assert.ok(slots.length > 0);
    assert.ok(slots.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)));
    assert.ok(slots.every(({ x, y }) => Math.hypot(x, y) >= FORMATION_TEMPLATES[name].minSafeGap));
  }
});
