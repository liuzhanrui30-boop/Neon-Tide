import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOSS_CORE_UPGRADE_IDS,
  STARTER_WEAPON_IDS,
  UPGRADE_TAGS,
  UPGRADES,
  UPGRADE_EFFECT_CONSUMERS,
  validateUpgrades,
} from '../src/content/upgrades.js';
import {
  DEFAULT_BUILD_STATS,
  applyUpgradeChoice,
  createUpgradeBuild,
  deriveBuildStats,
} from '../src/systems/upgrade-system.js';

const EXPECTED_TAGS = ['overload', 'rift', 'tide', 'weapon', 'phase', 'lance', 'survival', 'objective'];

test('the immutable localized pool contains exactly 24 bounded no-input upgrades in the planned distribution', () => {
  assert.equal(UPGRADES.length, 24);
  assert.deepEqual([...UPGRADE_TAGS], EXPECTED_TAGS);
  assert.deepEqual([...STARTER_WEAPON_IDS], ['pulse-cannon', 'arc-drones', 'prism-missiles']);
  assert.equal(validateUpgrades(UPGRADES), true);
  assert.equal(Object.isFrozen(UPGRADES), true);
  assert.equal(new Set(UPGRADES.map(({ id }) => id)).size, 24);
  assert.deepEqual(
    Object.fromEntries(['weapon', 'phase', 'lance', 'utility'].map((category) => [
      category,
      UPGRADES.filter((upgrade) => upgrade.category === category).length,
    ])),
    { weapon: 8, phase: 6, lance: 5, utility: 5 },
  );
  for (const upgrade of UPGRADES) {
    assert.equal(Object.isFrozen(upgrade), true);
    assert.equal(Object.isFrozen(upgrade.copy), true);
    assert.equal(Object.isFrozen(upgrade.effects), true);
    assert.ok(upgrade.copy.zhCN.name && upgrade.copy.zhCN.behavior);
    assert.ok(upgrade.copy.en.name && upgrade.copy.en.behavior);
    assert.ok(upgrade.maxStacks >= 1 && upgrade.maxStacks <= 3);
    assert.equal(upgrade.activeInput, null);
    assert.ok(upgrade.compatibleStarterWeapons.length > 0);
    assert.ok(upgrade.compatibleStarterWeapons.every((id) => STARTER_WEAPON_IDS.includes(id)));
    assert.ok(upgrade.tags.every((tag) => EXPECTED_TAGS.includes(tag)));
    for (const effect of Object.values(upgrade.effects)) {
      assert.ok(Number.isFinite(effect.perStack));
      assert.ok(Number.isFinite(effect.min));
      assert.ok(Number.isFinite(effect.max));
      assert.ok(effect.min <= effect.max);
      assert.ok(Number.isFinite(effect.base));
      assert.ok(Number.isFinite(Math.max(effect.min, Math.min(effect.max, effect.base + effect.perStack * upgrade.maxStacks))));
    }
  }
  assert.ok(BOSS_CORE_UPGRADE_IDS.length >= 3);
  assert.ok(BOSS_CORE_UPGRADE_IDS.every((id) => UPGRADES.some((upgrade) => upgrade.id === id && upgrade.bossCore)));
  const effectKeys = [...new Set(UPGRADES.flatMap(({ effects }) => Object.keys(effects)))].sort();
  assert.deepEqual(Object.keys(UPGRADE_EFFECT_CONSUMERS).sort(), effectKeys);
  assert.ok(Object.values(UPGRADE_EFFECT_CONSUMERS).every((consumer) => typeof consumer === 'string' && consumer.length > 0));
  assert.ok(UPGRADES.some(({ compatibleStarterWeapons }) => compatibleStarterWeapons.length === 1));
  assert.ok(STARTER_WEAPON_IDS.every((starter) => UPGRADES.some(({ compatibleStarterWeapons }) => (
    !compatibleStarterWeapons.includes(starter)
  ))));
});

test('upgrade validation rejects IDs, copy, tags, stacking bounds, formulas, compatibility and active inputs', () => {
  const source = structuredClone(UPGRADES);
  const invalid = [
    source.map((entry, index) => index === 1 ? { ...entry, id: source[0].id } : entry),
    source.map((entry, index) => index === 0 ? { ...entry, copy: { ...entry.copy, zhCN: { ...entry.copy.zhCN, behavior: '' } } } : entry),
    source.map((entry, index) => index === 0 ? { ...entry, tags: [...entry.tags, 'manual-aim'] } : entry),
    source.map((entry, index) => index === 0 ? { ...entry, maxStacks: Number.POSITIVE_INFINITY } : entry),
    source.map((entry, index) => index === 0 ? { ...entry, effects: { damage: { base: 1, perStack: Infinity, min: 0, max: 2 } } } : entry),
    source.map((entry, index) => index === 0 ? { ...entry, compatibleStarterWeapons: ['unknown-gun'] } : entry),
    source.map((entry, index) => index === 0 ? { ...entry, activeInput: 'secondarySkill' } : entry),
    source.slice(0, 23),
  ];
  for (const pool of invalid) assert.throws(() => validateUpgrades(pool), TypeError);
});

test('every declared effect changes its canonical derived stat incrementally and remains bounded', () => {
  assert.deepEqual(
    Object.keys(UPGRADE_EFFECT_CONSUMERS).sort(),
    Object.keys(DEFAULT_BUILD_STATS).filter((key) => key !== 'starterWeapon').sort(),
  );
  for (const upgrade of UPGRADES) {
    const starterWeapon = upgrade.compatibleStarterWeapons[0];
    let build = createUpgradeBuild({ starterWeapon });
    const baseline = deriveBuildStats(build);
    build = applyUpgradeChoice(build, upgrade.id);
    const first = deriveBuildStats(build);
    for (const [key, formula] of Object.entries(upgrade.effects)) {
      const expected = Math.max(formula.min, Math.min(formula.max, formula.base + formula.perStack));
      assert.equal(first[key], expected, `${upgrade.id}/${key} first stack`);
      assert.notEqual(first[key], baseline[key], `${upgrade.id}/${key} is inert`);
    }
    while ((build.upgradeStacks[upgrade.id] ?? 0) < upgrade.maxStacks) {
      const previous = deriveBuildStats(build);
      build = applyUpgradeChoice(build, upgrade.id);
      const current = deriveBuildStats(build);
      for (const [key, formula] of Object.entries(upgrade.effects)) {
        assert.ok(current[key] >= formula.min && current[key] <= formula.max, `${upgrade.id}/${key} bounds`);
        assert.notEqual(current[key], previous[key], `${upgrade.id}/${key} stack is inert`);
      }
    }
  }
});
