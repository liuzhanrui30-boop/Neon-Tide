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
