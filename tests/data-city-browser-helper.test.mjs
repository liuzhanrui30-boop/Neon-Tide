import assert from 'node:assert/strict';
import test from 'node:test';
import { getLaneSettlingContract } from './browser/v3-data-city.mjs';

test('browser lane settlement derives exact targets from authored public geometry', () => {
  const contract = getLaneSettlingContract({
    type: 'data-lane', laneCenter: -0.4, laneHalfWidth: 1.2,
  });

  assert.equal(contract.laneCenter, -0.4);
  assert.equal(contract.laneHalfWidth, 1.2);
  assert.equal(contract.settleTolerance, 0.16);
  assert.ok(Math.abs(contract.outsideTarget - contract.laneCenter) > contract.laneHalfWidth);
  assert.equal(contract.consecutiveFrames, 8);
  assert.ok(contract.minimumActiveRemaining > 1.5);
  assert.ok(contract.confirmationBudget > 0);
});

test('browser lane settlement rejects absent or invalid authored geometry', () => {
  assert.throws(() => getLaneSettlingContract(null), /authored data-lane geometry/);
  assert.throws(() => getLaneSettlingContract({ type: 'data-lane', laneCenter: 0, laneHalfWidth: 0 }), /authored data-lane geometry/);
});
