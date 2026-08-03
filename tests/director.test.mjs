import test from 'node:test';
import assert from 'node:assert/strict';

import { ENEMY_TYPES, GAME, FORMATION_TEMPLATES, STAGES } from '../src/game/config.js';
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
  assert.equal(getFormationBudget(0, 0, { activeCost: 0, maxEnemyCap: 36 }), 9);
  assert.equal(getFormationBudget(2, 80, { activeCost: 30, maxEnemyCap: 36 }), 6);
  assert.equal(getFormationBudget(2, 80, { activeCost: 36, maxEnemyCap: 36 }), 0);
  assert.equal(getFormationBudget(2, 80, { activeCost: 0, maxEnemyCap: 0 }), 0);
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
  assert.equal(chooseFormation({ stageIndex: 1, elapsed: 42, cooldownRemaining: 0, activeCost: 0, maxEnemyCap: 0, safeGap: 4, seed: 7 }), null);
});

test('formation slot role counts and actual threat cost match the declared template budget', () => {
  for (const [name, template] of Object.entries(FORMATION_TEMPLATES)) {
    const slots = getFormationSlots(name, { width: 12, height: 8 });
    assert.equal(slots.length, template.roles.length);
    const actualCost = slots.reduce((total, slot) => total + ENEMY_TYPES[slot.role].threatCost, 0);
    assert.equal(actualCost, template.enemyCost);
    assert.ok(actualCost <= getFormationBudget(3, 110, { activeCost: 0, maxEnemyCap: 36 }));
  }
});

test('pincer adds a protected midline lancer while mine-wall adds two swarm flank slots', () => {
  const pincer = getFormationSlots('pincer', { width: 12, height: 8 });
  const mineWall = getFormationSlots('mine-wall', { width: 12, height: 8 });

  assert.equal(pincer.length, 5);
  assert.equal(pincer.filter(({ role }) => role === 'lancer').length, 1);
  assert.equal(pincer.find(({ role }) => role === 'lancer').x, 0);
  assert.equal(FORMATION_TEMPLATES.pincer.enemyCost, 9);

  const swarmFlanks = mineWall.filter(({ role }) => role === 'swarm');
  assert.equal(mineWall.length, 7);
  assert.equal(swarmFlanks.length, 2);
  assert.ok(swarmFlanks.some(({ x }) => x < 0));
  assert.ok(swarmFlanks.some(({ x }) => x > 0));
  assert.equal(FORMATION_TEMPLATES['mine-wall'].enemyCost, 12);
});

test('formation stage gates preserve the intended enemy learning curve', () => {
  const stageOneChoices = new Set(Array.from({ length: 24 }, (_, seed) => chooseFormation({
    stageIndex: 0,
    elapsed: 18,
    activeCost: 0,
    maxEnemyCap: 36,
    safeGap: 4,
    seed,
  })?.name).filter(Boolean));
  assert.deepEqual([...stageOneChoices], ['spiral']);

  const stageTwoChoices = new Set(Array.from({ length: 24 }, (_, seed) => chooseFormation({
    stageIndex: 1,
    elapsed: 48,
    activeCost: 0,
    maxEnemyCap: 36,
    safeGap: 4,
    seed,
  })?.name).filter(Boolean));
  assert.ok(stageTwoChoices.has('pincer'));
  assert.ok(stageTwoChoices.has('crossfire'));
  assert.equal(stageTwoChoices.has('mine-wall'), false);
  assert.equal(stageTwoChoices.has('elite-escort'), false);

  assert.equal(FORMATION_TEMPLATES.pincer.minStage, 1);
  assert.equal(FORMATION_TEMPLATES.crossfire.minStage, 1);
  assert.equal(FORMATION_TEMPLATES['mine-wall'].minStage, 2);
  assert.equal(FORMATION_TEMPLATES['elite-escort'].minStage, 2);
});

test('elite and bulwark armor require exactly three ordinary dash hits', () => {
  assert.equal(ENEMY_TYPES.elite.hp, 3);
  assert.equal(ENEMY_TYPES.bulwark.hp, 3);
});

test('formation slots are finite and preserve an opening around the play center', () => {
  for (const name of Object.keys(FORMATION_TEMPLATES)) {
    const slots = getFormationSlots(name, { width: 12, height: 8 });
    assert.ok(slots.length > 0);
    assert.ok(slots.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y)));
    assert.ok(slots.every(({ x, y }) => Math.hypot(x, y) >= FORMATION_TEMPLATES[name].minSafeGap));
  }
});

test('formations refuse an unsafe compact viewport rather than closing the safe gap', () => {
  for (const name of Object.keys(FORMATION_TEMPLATES)) {
    assert.deepEqual(getFormationSlots(name, { width: 4, height: 4 }), []);
  }
});
