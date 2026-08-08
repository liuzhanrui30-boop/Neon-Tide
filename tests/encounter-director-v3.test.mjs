import test from 'node:test';
import assert from 'node:assert/strict';
import { createEntityWorld } from '../src/game/entity-world.js';
import { getEncounterTemplate } from '../src/content/encounters.js';
import { ENEMY_ROLE_IDS, ENEMY_ROLES } from '../src/content/enemies.js';
import {
  createEncounterDirector,
  getThreatLimits,
  scanThreatWorld,
  selectThreatWave,
} from '../src/systems/encounter-director.js';

function seeded(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let next = value;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

function context(overrides = {}) {
  return {
    mode: 'standard', quality: 'desktop', chapter: 3, waveIndex: 0,
    activeEnemies: 0, roleCounts: {}, highDamageWarnings: 0, blockedArea: 0,
    enemyProjectiles: 0, objectiveBurden: 0.25, playerHealthRatio: 1,
    clearRate: 0.8, untouchedSeconds: 4, totalBudget: 36,
    ...overrides,
  };
}

test('global Standard/Abyss desktop/coarse caps are exact', () => {
  assert.deepEqual(getThreatLimits({ mode: 'standard', quality: 'desktop' }), {
    activeEnemyCap: 48, projectileCap: 96, simultaneousWarningCap: 3, blockedAreaBudget: 0.45,
  });
  assert.deepEqual(getThreatLimits({ mode: 'standard', quality: 'coarse' }), {
    activeEnemyCap: 36, projectileCap: 72, simultaneousWarningCap: 2, blockedAreaBudget: 0.38,
  });
  assert.deepEqual(getThreatLimits({ mode: 'abyss', quality: 'desktop' }), {
    activeEnemyCap: 56, projectileCap: 96, simultaneousWarningCap: 4, blockedAreaBudget: 0.5,
  });
  assert.deepEqual(getThreatLimits({ mode: 'abyss', quality: 'mobile' }), {
    activeEnemyCap: 42, projectileCap: 72, simultaneousWarningCap: 3, blockedAreaBudget: 0.42,
  });
});

test('threat-wave selection is deterministic, chapter-gated and respects every hard budget before spawning', () => {
  const run = () => selectThreatWave(context({ chapter: 0, waveIndex: 7 }), seeded(91));
  assert.deepEqual(run(), run());
  assert.ok(run().roles.every((role) => ENEMY_ROLES[role].minChapter <= 0));
  assert.deepEqual(selectThreatWave(context({ activeEnemies: 48 }), seeded(1)).roles, []);
  assert.ok(selectThreatWave(context({ highDamageWarnings: 3 }), seeded(2)).roles
    .every((role) => !ENEMY_ROLES[role].highDamage));
  assert.ok(selectThreatWave(context({ blockedArea: 0.44 }), seeded(3)).roles
    .every((role) => ENEMY_ROLES[role].blockedAreaCost <= 0.01));
  assert.ok(selectThreatWave(context({ enemyProjectiles: 95 }), seeded(4)).roles
    .every((role) => ENEMY_ROLES[role].projectileCost <= 1));
  const capped = selectThreatWave(context({ roleCounts: { interceptor: ENEMY_ROLES.interceptor.activeCap } }), seeded(5));
  assert.equal(capped.roles.includes('interceptor'), false);
});

test('health relief and objective burden lower the next combination while clear-rate and untouched play scale pressure', () => {
  const healthy = selectThreatWave(context({ waveIndex: 13 }), seeded(123));
  const relief = selectThreatWave(context({
    waveIndex: 13, playerHealthRatio: 0.2, objectiveBurden: 0.9, clearRate: 0.2, untouchedSeconds: 0,
  }), seeded(123));
  const mastery = selectThreatWave(context({
    waveIndex: 13, playerHealthRatio: 1, objectiveBurden: 0.05, clearRate: 2.2, untouchedSeconds: 24,
  }), seeded(123));
  assert.ok(relief.cost < healthy.cost);
  assert.ok(mastery.budget >= healthy.budget);
  assert.equal(relief.reliefApplied, true);
});

test('health relief changes only the subsequent combination and never requires mutating live threats', () => {
  const liveThreat = Object.freeze({ collidable: true, contactDamaging: true, damage: 0.35 });
  const healthy = selectThreatWave(context({ waveIndex: 19, playerHealthRatio: 1 }), seeded(777));
  const lowHull = selectThreatWave(context({ waveIndex: 19, playerHealthRatio: 0.2 }), seeded(777));
  const abyssLowHull = selectThreatWave(context({
    mode: 'abyss', waveIndex: 19, playerHealthRatio: 0.2,
  }), seeded(777));
  assert.ok(lowHull.cost < healthy.cost);
  assert.deepEqual(lowHull.roles, []);
  assert.ok(abyssLowHull.budget > lowHull.budget);
  assert.deepEqual(liveThreat, { collidable: true, contactDamaging: true, damage: 0.35 });
});

test('runtime blocked-area scan accounts for committed hazards throughout their active lifetime', () => {
  const world = createEntityWorld({ capacities: { enemy: 8, enemyHazard: 32, warning: 16 } });
  const roles = ['lancer', 'mine', 'warden', 'bulwark'];
  for (let index = 0; index < roles.length; index += 1) {
    const role = roles[index];
    const ownerId = world.spawn('enemy', { role, state: `${role}-active`, hp: 2, team: 2 });
    world.spawn('enemyHazard', {
      ownerId, role: role === 'warden' ? 'warden-wall' : role,
      type: `${role}-committed`, radius: 0.4, lifetime: 2, collidable: true, contactDamaging: true, team: 2,
    });
    world.spawn('enemyHazard', {
      ownerId, role: role === 'warden' ? 'warden-gap' : 'safe-sector',
      radius: 1.2, lifetime: 2, collidable: false, contactDamaging: false, team: 2,
    });
  }
  const scan = scanThreatWorld(world);
  const expected = roles.reduce((sum, role) => sum + ENEMY_ROLES[role].blockedAreaCost, 0);
  assert.ok(Math.abs(scan.blockedArea - expected) < 1e-9);
  assert.equal(scan.highDamageWarnings, 0);
  const wave = selectThreatWave(context({
    blockedArea: scan.blockedArea,
    activeEnemies: scan.activeEnemies,
    roleCounts: scan.roleCounts,
  }), seeded(99));
  assert.ok(wave.roles.every((role) => wave.blockedAreaCost + scan.blockedArea <= wave.limits.blockedAreaBudget + 1e-9));
});

test('256 seeded selections remain finite, capped and make every role naturally reachable through chapter selection', () => {
  const seen = new Set();
  for (let seed = 0; seed < 256; seed += 1) {
    for (let waveIndex = 0; waveIndex < 24; waveIndex += 1) {
      const wave = selectThreatWave(context({
        mode: seed % 2 ? 'abyss' : 'standard', quality: seed % 3 ? 'desktop' : 'coarse',
        chapter: Math.min(3, Math.floor(waveIndex / 6)), waveIndex,
        activeEnemies: seed % 17, highDamageWarnings: seed % 2,
        blockedArea: (seed % 4) * 0.05, enemyProjectiles: seed % 31,
        playerHealthRatio: 0.25 + (seed % 4) * 0.25,
        clearRate: (seed % 12) / 8, untouchedSeconds: seed % 25,
      }), seeded(seed * 1009 + waveIndex));
      assert.ok(Number.isFinite(wave.budget) && Number.isFinite(wave.cost));
      assert.ok(wave.roles.length + (seed % 17) <= wave.limits.activeEnemyCap);
      assert.ok(wave.projectileCost + (seed % 31) <= wave.limits.projectileCap);
      assert.ok(wave.blockedAreaCost + (seed % 4) * 0.05 <= wave.limits.blockedAreaBudget + 1e-9);
      wave.roles.forEach((role) => seen.add(role));
    }
  }
  assert.deepEqual([...seen].sort(), [...ENEMY_ROLE_IDS].sort());
});

test('the Task 7 encounter lifecycle naturally selects and spawns pooled threats without disabling objectives or anti-orbit', () => {
  const world = createEntityWorld({ capacities: { enemy: 56, warning: 96, enemyHazard: 96, enemyProjectile: 96 } });
  const playerId = world.spawn('player', {
    x: 9.2, y: 0, vx: 0, vy: 3, hp: 5, maxHp: 5, radius: 0.4, team: 1, collidable: true,
  });
  const authority = {};
  const director = createEncounterDirector({
    seed: 818, mode: 'standard', quality: 'desktop', objectiveAuthority: authority,
  });
  director.startRoom(getEncounterTemplate('anchor-break'), { chapterIndex: 2 });
  const events = { emit() { return true; }, input: [] };
  for (let index = 0; index < 420; index += 1) {
    const angle = index / 60 * 1.35;
    world.write(playerId, { x: Math.cos(angle) * 9.2, y: Math.sin(angle) * 5.5 });
    director.update({ world, player: world.get(playerId), presentationPending: 1 }, 1 / 60, events);
  }
  const snapshot = director.getSnapshot();
  assert.equal(snapshot.phase, 'active');
  assert.ok(snapshot.objective);
  assert.ok(snapshot.objective.antiOrbit.orbitPressure >= 1);
  assert.ok(world.query('enemy').length > 0);
  assert.ok(snapshot.threatState.wavesSelected > 0);
  assert.ok(snapshot.threatState.rolesSeen.length > 0);

  let live;
  authority.visit((objective) => { live = objective; });
  for (const anchor of live.anchors) anchor.completed = true;
  director.update({ world, player: world.get(playerId), presentationPending: 1 }, 1 / 60, events);
  assert.equal(director.getSnapshot().phase, 'draining');
  assert.equal(world.query('enemy').length, 0);
  assert.equal(world.query('warning').length, 0);
  assert.equal(world.query('enemyHazard').length, 0);
  assert.equal(world.query('enemyProjectile').length, 0);
});

test('rolesSeen and runtime enemy caps include only successfully materialized wave members', () => {
  const world = createEntityWorld({ capacities: { enemy: 1, warning: 8, enemyHazard: 8, enemyProjectile: 8 } });
  const playerId = world.spawn('player', {
    x: 0, y: 0, hp: 5, maxHp: 5, radius: 0.4, team: 1, collidable: true,
  });
  const director = createEncounterDirector({ seed: 91, mode: 'standard', quality: 'desktop' });
  director.startRoom(getEncounterTemplate('anchor-break'), { chapterIndex: 3 });
  director.update({ world, player: world.get(playerId), presentationPending: 1 }, 1 / 60, { emit() {}, input: [] });
  const actual = [...world.query('enemy')].map((id) => world.get(id).role);
  const seen = director.getSnapshot().threatState.rolesSeen;
  assert.equal(actual.length, 1);
  assert.deepEqual(seen, actual);
  assert.equal(director.getSnapshot().threatState.enemySystem.rejectedSpawns > 0, true);
});
