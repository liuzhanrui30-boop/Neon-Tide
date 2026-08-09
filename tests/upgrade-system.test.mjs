import test from 'node:test';
import assert from 'node:assert/strict';
import { createGameSession } from '../src/game/session.js';
import {
  applyUpgradeChoice,
  attachPendingOffer,
  createUpgradeBuild,
  deriveBuildStats,
  offerBossCoreUpgrades,
  offerUpgrades,
  serializeUpgradeBuild,
} from '../src/systems/upgrade-system.js';
import { selectTideLanceLine, createWeaponSystem } from '../src/systems/weapon-system.js';
import { createPlayerState, updatePlayerState } from '../src/systems/player-system.js';
import { createEntityWorld } from '../src/game/entity-world.js';
import { createRunSave } from '../src/persistence/run-save.js';
import { gainWeaponEnergy } from '../src/game/skill.js';

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function offerSeed(runSeed, roomsCompleted, sequence) {
  return Math.trunc(runSeed * 1103515245 + roomsCompleted * 2654435761 + sequence * 2246822519);
}

function findRunSeedForNormalUpgrade(id) {
  for (let runSeed = 0; runSeed < 10_000; runSeed += 1) {
    if (offerUpgrades(createUpgradeBuild(), offerSeed(runSeed, 1, 0)).some((card) => card.id === id)) return runSeed;
  }
  throw new Error(`no deterministic normal offer found for ${id}`);
}

test('three-card offers are deterministic, unique, compatible and use a separate boss-core subset', () => {
  const build = createUpgradeBuild({ starterWeapon: 'arc-drones' });
  const first = offerUpgrades(build, 0xdecafbad);
  const second = offerUpgrades(structuredClone(build), 0xdecafbad);
  assert.deepEqual(second, first);
  assert.equal(first.length, 3);
  assert.equal(new Set(first.map(({ id }) => id)).size, 3);
  assert.ok(first.every((card) => card.compatibleStarterWeapons.includes('arc-drones')));
  const boss = offerBossCoreUpgrades(build, 0xdecafbad);
  assert.equal(boss.length, 3);
  assert.ok(boss.every(({ bossCore }) => bossCore));
  assert.ok(first.every(({ bossCore }) => !bossCore));
});

test('starter compatibility is authoritative for builds, offers, choices and restored pending cards', () => {
  const pulse = createUpgradeBuild({ starterWeapon: 'pulse-cannon' });
  assert.throws(() => createUpgradeBuild({
    starterWeapon: 'pulse-cannon',
    upgradeStacks: { 'drone-volley': 1 },
  }), /incompatible/);
  for (let seed = 0; seed < 64; seed += 1) {
    assert.ok(offerUpgrades(pulse, seed).every(({ compatibleStarterWeapons }) => (
      compatibleStarterWeapons.includes('pulse-cannon')
    )));
  }
  assert.throws(() => applyUpgradeChoice(pulse, 'drone-volley'), /incompatible/);
  const valid = attachPendingOffer(pulse, 1234, 'normal');
  const forged = serializeUpgradeBuild(valid);
  forged.pendingOffer.cards[0] = 'drone-volley';
  assert.throws(() => createUpgradeBuild(forged), /pending upgrade offer/);
});

test('all newly wired effect families scale incrementally by stack', () => {
  let build = createUpgradeBuild({ starterWeapon: 'arc-drones' });
  build = applyUpgradeChoice(build, 'drone-volley');
  build = applyUpgradeChoice(build, 'perfect-resonance');
  build = applyUpgradeChoice(build, 'lance-overload');
  build = applyUpgradeChoice(build, 'tide-reserve');
  build = applyUpgradeChoice(build, 'overclock');
  const one = deriveBuildStats(build);
  for (const id of ['drone-volley', 'perfect-resonance', 'lance-overload', 'tide-reserve', 'overclock']) {
    build = applyUpgradeChoice(build, id);
  }
  const two = deriveBuildStats(build);
  assert.ok(two.droneArcTargets > one.droneArcTargets);
  assert.ok(two.perfectFireBuffMultiplier < one.perfectFireBuffMultiplier);
  assert.ok(two.lancePropagation > one.lancePropagation);
  assert.ok(two.roomRepair > one.roomRepair);
  assert.ok(two.lanceEnergyGainMultiplier > one.lanceEnergyGainMultiplier);
  assert.ok(gainWeaponEnergy(0, one.lanceEnergyGainMultiplier) > 5);
  assert.ok(gainWeaponEnergy(0, two.lanceEnergyGainMultiplier) > gainWeaponEnergy(0, one.lanceEnergyGainMultiplier));
});

test('ten deterministic choices form all three build families without NaN, cap bypass, or extra input', () => {
  let build = createUpgradeBuild({ starterWeapon: 'pulse-cannon' });
  const seenTags = new Set();
  for (let choice = 0; choice < 10; choice += 1) {
    const offer = choice === 4 ? offerBossCoreUpgrades(build, 4100 + choice) : offerUpgrades(build, 4100 + choice);
    assert.equal(offer.length, 3);
    const preferred = offer.find(({ tags }) => ['overload', 'rift', 'tide'].some((tag) => tags.includes(tag) && !seenTags.has(tag)))
      ?? offer[choice % offer.length];
    build = applyUpgradeChoice(build, preferred.id);
    preferred.tags.forEach((tag) => seenTags.add(tag));
    const stats = deriveBuildStats(build);
    for (const value of Object.values(stats)) {
      if (typeof value === 'number') assert.ok(Number.isFinite(value), `${preferred.id} produced ${value}`);
    }
    assert.ok(stats.weaponDamageMultiplier <= 2.2);
    assert.ok(stats.projectilePierce <= 4);
    assert.ok(stats.droneCount <= 4);
    assert.ok(stats.lanceLength <= 12);
    assert.ok(stats.pickupRadiusMultiplier <= 3);
  }
  assert.ok(['overload', 'rift', 'tide'].every((tag) => seenTags.has(tag)), [...seenTags].join(','));
  assert.equal('activeInput' in deriveBuildStats(build), false);
  assert.deepEqual(createUpgradeBuild(serializeUpgradeBuild(build)), build);
});

test('family stats alter real projectile traversal, drone arcs, Lance weak-point lines and phase movement', () => {
  let build = createUpgradeBuild({ starterWeapon: 'arc-drones' });
  for (const id of ['overload-relay', 'drone-volley', 'lance-rift', 'lance-weakpoint', 'echo-shield']) {
    build = applyUpgradeChoice(build, id);
  }
  const stats = deriveBuildStats(build);
  assert.ok(stats.chainTargets > 2);
  assert.ok(stats.droneCount > 2);
  assert.ok(stats.droneArcTargets > 2);
  assert.ok(stats.lanceWeakPointMultiplier > 1);
  assert.ok(stats.lanceLength > 7.2);

  const world = createEntityWorld({ capacities: { player: 1, enemy: 3, friendlyProjectile: 32 } });
  const playerId = world.spawn('player', { x: 0, y: 0, team: 1 });
  world.spawn('enemy', { x: 5, y: 0, hp: 20, team: 2, collidable: true, weakPoint: true });
  const weapons = createWeaponSystem();
  weapons.update(world, playerId, 1, null, stats);
  const projectiles = [...world.query('friendlyProjectile')].map((id) => world.get(id));
  assert.equal(projectiles.filter(({ type }) => type === 'arc-drone').length, stats.droneCount);
  assert.ok(projectiles.some(({ type, chainCount }) => type === 'arc-chain' && chainCount === stats.chainTargets));

  const line = selectTideLanceLine({ x: 0, y: 0, facing: { x: 0, y: 1 } }, [
    { id: 1, x: 8.3, y: 0, radius: 0.3, hp: 1, weakPoint: true },
  ], [], { length: stats.lanceLength, halfWidth: stats.lanceHalfWidth, weakPointMultiplier: stats.lanceWeakPointMultiplier });
  assert.deepEqual(line.targetIds, [1]);

  const baseline = createPlayerState();
  const phased = createPlayerState();
  updatePlayerState(baseline, { moveX: 1, moveY: 0, dashPressed: true }, 1 / 60);
  updatePlayerState(phased, { moveX: 1, moveY: 0, dashPressed: true }, 1 / 60, null, stats);
  assert.ok(phased.phaseTimer > baseline.phaseTimer);
});

test('GameSession owns pending offers and selection, and checkpoint-shaped round trips preserve equality', () => {
  const session = createGameSession({ development: true, deterministicTestMode: true, initialRouteKind: 'compatibility' });
  session.startRun('standard', 90210);
  session.startRoom({ id: 'compat-room', compatibility: true });
  session.completeRoom({ nextMode: 'upgrade', rewardKind: 'normal' });
  const offered = session.snapshot();
  assert.equal(offered.mode, 'upgrade');
  assert.equal(offered.build.pendingOffer.cards.length, 3);
  const checkpointBuild = structuredClone(offered.build);
  const restored = createUpgradeBuild(checkpointBuild);
  assert.deepEqual(restored.pendingOffer, offered.build.pendingOffer);
  assert.equal(session.selectUpgrade(offered.build.pendingOffer.cards[0]), true);
  const selected = session.snapshot();
  assert.equal(selected.build.pendingOffer, null);
  assert.equal(Object.values(selected.build.upgradeStacks).reduce((sum, value) => sum + value, 0), 1);
});

test('a Standard chapter checkpoint restores the exact pending offer and stacked build', () => {
  const runSave = createRunSave(new MemoryStorage());
  const original = createGameSession({ development: true, runSave, now: () => 55 });
  original.startRun('standard', findRunSeedForNormalUpgrade('pulse-echo'));
  original.startRoom({ campaign: true });
  original.completeRoom({ nextMode: 'upgrade' });
  assert.ok(original.snapshot().build.pendingOffer.cards.includes('pulse-echo'));
  original.selectUpgrade('pulse-echo');
  original.startRoom({ campaign: true });
  original.completeRoom({ nextMode: 'upgrade' });
  const expected = original.snapshot().build;

  const restored = createGameSession({ development: true, runSave });
  assert.equal(restored.restoreCheckpoint(), true);
  assert.deepEqual(restored.snapshot().build, expected);
  assert.deepEqual(restored.snapshot().build.pendingOffer, expected.pendingOffer);
});

test('derived build stats are cached by canonical build identity and invalidate only on build changes', () => {
  const session = createGameSession({ development: true, deterministicTestMode: true });
  const initial = session.getBuildStats();
  for (let index = 0; index < 5_000; index += 1) assert.equal(session.getBuildStats(), initial);
  session.setStarterWeapon('arc-drones');
  const starterChanged = session.getBuildStats();
  assert.notEqual(starterChanged, initial);
  assert.equal(starterChanged.starterWeapon, 'arc-drones');
  for (let index = 0; index < 5_000; index += 1) assert.equal(session.getBuildStats(), starterChanged);
  session.startRun('standard', 33);
  const reset = session.getBuildStats();
  assert.notEqual(reset, starterChanged);
  assert.equal(reset.starterWeapon, 'arc-drones');
});

test('cached stats invalidate on upgrade selection, checkpoint restore and reset without per-step churn', () => {
  const storage = new MemoryStorage();
  const runSave = createRunSave(storage);
  const session = createGameSession({
    development: true, deterministicTestMode: true, runSave, now: () => 10,
    initialRouteKind: 'compatibility',
  });
  session.startRun('standard', 404);
  session.startRoom({ id: 'cache-room', compatibility: true });
  session.completeRoom({ nextMode: 'upgrade' });
  const beforeSelection = session.getBuildStats();
  session.selectUpgrade(session.snapshot().build.pendingOffer.cards[0]);
  const afterSelection = session.getBuildStats();
  assert.notEqual(afterSelection, beforeSelection);
  assert.equal(runSave.load().build.pendingOffer, null);
  assert.deepEqual(runSave.load().build.upgradeStacks, session.snapshot().build.upgradeStacks);
  for (let index = 0; index < 5_000; index += 1) assert.equal(session.getBuildStats(), afterSelection);
  session.startRoom({ id: 'cache-room-2', compatibility: true });
  session.completeRoom({ nextMode: 'chapterComplete', chapterIndex: 1 });

  const restored = createGameSession({ development: true, runSave });
  const beforeRestore = restored.getBuildStats();
  assert.equal(restored.restoreCheckpoint(), true);
  const afterRestore = restored.getBuildStats();
  assert.notEqual(afterRestore, beforeRestore);
  assert.deepEqual(afterRestore, afterSelection);
  for (let index = 0; index < 5_000; index += 1) assert.equal(restored.getBuildStats(), afterRestore);
  restored.reset();
  assert.notEqual(restored.getBuildStats(), afterRestore);
  assert.equal(restored.getBuildStats().starterWeapon, 'pulse-cannon');
});
