import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LASER_RULES,
  canFireLaser,
  createTideLanceRay,
  gainWeaponEnergy,
  getLaserPhase,
  getTideLanceAvailability,
  laserHitsCircle,
  selectTideLanceDamageAuthority,
  selectLaserTargets,
} from '../src/game/skill.js';

test('twenty normal pickups charge one laser and firing requires full energy', () => {
  let energy = 0;
  for (let index = 0; index < 19; index += 1) energy = gainWeaponEnergy(energy, false);
  assert.equal(energy, 95);
  assert.equal(canFireLaser(energy), false);
  energy = gainWeaponEnergy(energy, false);
  assert.equal(energy, 100);
  assert.equal(canFireLaser(energy), true);
  assert.equal(gainWeaponEnergy(98, true), 100);
});

test('laser timing, narrow collision and penetration cap are stable', () => {
  assert.deepEqual(LASER_RULES, { maxEnergy: 100, pickupEnergy: 5, focusedPickupEnergy: 7, chargeDuration: 0.28, activeDuration: 0.32, length: 7.2, width: 0.55, maxTargets: 5 });
  assert.equal(getLaserPhase(0.1), 'charge');
  assert.equal(getLaserPhase(0.3), 'active');
  assert.equal(getLaserPhase(0.61), 'done');
  assert.equal(laserHitsCircle({ originX: 0, originY: 0, directionX: 1, directionY: 0 }, { x: 4, y: 0.2, radius: 0.1 }), true);
  assert.equal(laserHitsCircle({ originX: 0, originY: 0, directionX: 1, directionY: 0 }, { x: 4, y: 0.5, radius: 0.1 }), false);
  assert.equal(selectLaserTargets(Array.from({ length: 8 }, (_, index) => ({ id: index, along: 7 - index }))).length, 5);
});

test('laser phase changes exactly at charge and completion boundaries', () => {
  assert.equal(getLaserPhase(0.28), 'active');
  assert.equal(getLaserPhase(0.60), 'done');
});

test('managed campaign Tide Lance availability ignores legacy stage-end timing while compatibility keeps it', () => {
  const shared = {
    mode: 'playing',
    laserState: 'ready',
    weaponEnergy: LASER_RULES.maxEnergy,
    dashTimer: 0,
    dashInvulnTimer: 0,
    elapsed: 31.25,
    stageEnd: 30,
    stepSeconds: 1 / 60,
  };
  assert.deepEqual(getTideLanceAvailability({ ...shared, objectiveManaged: true }), {
    canStart: true,
    reason: 'ready',
  });
  assert.deepEqual(getTideLanceAvailability({ ...shared, objectiveManaged: false }), {
    canStart: false,
    reason: 'stage-end',
  });
  assert.equal(selectTideLanceDamageAuthority({ ecsCombatAuthority: true }), 'ecs');
  assert.equal(selectTideLanceDamageAuthority({ ecsCombatAuthority: false }), 'legacy');
});

test('Tide Lance ray is a normalized center-to-length segment', () => {
  const ray = createTideLanceRay({ originX: 2, originY: -3, directionX: 3, directionY: 4, length: 7.2 });
  assert.deepEqual(ray, {
    originX: 2,
    originY: -3,
    directionX: 0.6,
    directionY: 0.8,
    length: 7.2,
    endX: 6.32,
    endY: 2.7600000000000007,
  });
});
