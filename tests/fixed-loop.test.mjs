import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixedLoop } from '../src/game/fixed-loop.js';

test('fixed loop discards pause time and retains post-resume time', () => {
  const steps = [];
  const loop = createFixedLoop({ stepSeconds: 1 / 60, maxCatchUpSteps: 6, onStep: (dt) => steps.push(dt), onRender: () => {} });
  loop.reset(0);
  loop.tick(16.7);
  loop.pause(20);
  loop.resume(5020);
  loop.tick(5120);
  assert.ok(steps.length >= 6);
  assert.ok(steps.length <= 7);
  assert.ok(steps.every((dt) => dt === 1 / 60));
});

test('fixed loop caps catch-up work and reports discarded time', () => {
  const renders = [];
  let stepCount = 0;
  const loop = createFixedLoop({
    stepSeconds: 1 / 60,
    maxCatchUpSteps: 3,
    onStep: () => { stepCount += 1; },
    onRender: (alpha) => renders.push(alpha),
  });
  loop.reset(100);
  loop.tick(1100);
  const stats = loop.getStats();
  assert.equal(stepCount, 3);
  assert.equal(stats.steps, 3);
  assert.equal(stats.droppedSteps, 57);
  assert.ok(stats.droppedSeconds > 0.94 && stats.droppedSeconds < 0.96);
  assert.ok(renders.at(-1) >= 0 && renders.at(-1) < 1);
});

test('fixed loop ignores backwards timestamps and does not step while paused', () => {
  let stepCount = 0;
  const loop = createFixedLoop({
    stepSeconds: 0.01,
    maxCatchUpSteps: 4,
    onStep: () => { stepCount += 1; },
    onRender: () => {},
  });
  loop.reset(100);
  loop.tick(90);
  loop.pause(95);
  loop.tick(5000);
  assert.equal(stepCount, 0);
  assert.equal(loop.getStats().paused, true);
  loop.resume(5000);
  loop.tick(5010);
  assert.equal(stepCount, 1);
});
