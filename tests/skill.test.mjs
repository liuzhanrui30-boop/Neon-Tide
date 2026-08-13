import test from 'node:test';
import assert from 'node:assert/strict';
import { LASER_RULES, NORMAL_FIRE_RULES, canFireLaser, gainWeaponEnergy, getLaserPhase, laserHitsCircle, selectLaserTargets } from '../src/game/skill.js';

test('normal fire is a compact red tail burst while charge remains the ultimate', () => {
  assert.deepEqual(NORMAL_FIRE_RULES, {
    cooldown: 1,
    burstSize: 7,
    shotInterval: 0.065,
    speed: 13.2,
    life: 1.08,
    damage: 1,
    radius: 0.11,
    color: 0xff3b30,
  });
  assert.ok(NORMAL_FIRE_RULES.radius < LASER_RULES.width / 2);
  assert.equal(canFireLaser(99), false);
  assert.equal(canFireLaser(100), true);
});

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
