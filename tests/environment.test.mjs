import test from 'node:test';
import assert from 'node:assert/strict';
import { getCurrentForce, getDataLanePenalty, getEnvironmentDelay, getEnvironmentFrame, getGravityForce } from '../src/game/environment.js';

test('realm environments telegraph before active and never return non-finite forces', () => {
  const current = getEnvironmentFrame('abyss', 8);
  assert.ok(['telegraph', 'active', 'cooldown'].includes(current.phase));
  assert.ok(getEnvironmentDelay('abyss', 0.5) >= 7 && getEnvironmentDelay('abyss', 0.5) <= 10);
  assert.ok(Number.isFinite(getCurrentForce(current, { x: 0, y: 0 }).x));
  assert.ok(getDataLanePenalty(getEnvironmentFrame('data-city', 40), { x: 0, y: 0 }) >= 0);
  const gravity = getGravityForce(getEnvironmentFrame('star-forge', 76), { x: 2, y: -1 });
  assert.ok(Number.isFinite(gravity.x) && Number.isFinite(gravity.y));
  assert.equal(getEnvironmentFrame('void-cathedral', 110).phase, 'disabled');
});

test('environment timing clamps seeds and respects exact phase boundaries', () => {
  assert.equal(getEnvironmentDelay('abyss', -1), 7);
  assert.equal(getEnvironmentDelay('abyss', 2), 10);
  assert.equal(getEnvironmentFrame('abyss', 0.799).phase, 'telegraph');
  assert.equal(getEnvironmentFrame('abyss', 0.8).phase, 'active');
  assert.equal(getEnvironmentFrame('abyss', 4).phase, 'cooldown');
});

test('disabled and non-finite environment intervals never produce NaN', () => {
  for (const seed of [-1, 0, 0.5, 1, 2, Infinity, NaN]) {
    assert.equal(getEnvironmentDelay('void-cathedral', seed), Infinity);
  }
});

test('data-city exits its active environment phase at the exact decimal boundary', () => {
  assert.equal(getEnvironmentFrame('data-city', 4.1).phase, 'cooldown');
});
