export const UPGRADE_TAGS = Object.freeze([
  'overload', 'rift', 'tide', 'weapon', 'phase', 'lance', 'survival', 'objective',
]);
export const STARTER_WEAPON_IDS = Object.freeze(['pulse-cannon', 'arc-drones', 'prism-missiles']);

const TAG_SET = new Set(UPGRADE_TAGS);
const STARTER_SET = new Set(STARTER_WEAPON_IDS);
const CATEGORIES = new Set(['weapon', 'phase', 'lance', 'utility']);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

const fx = (base, perStack, min, max) => ({ base, perStack, min, max });
const all = [...STARTER_WEAPON_IDS];
const copy = (zhName, zhBehavior, enName, enBehavior) => ({
  zhCN: { name: zhName, behavior: zhBehavior },
  en: { name: enName, behavior: enBehavior },
});
const upgrade = (id, category, tags, maxStacks, effects, localized, options = {}) => ({
  id,
  category,
  tags,
  maxStacks,
  effects,
  copy: localized,
  compatibleStarterWeapons: options.compatibleStarterWeapons ?? all,
  bossCore: options.bossCore ?? false,
  activeInput: null,
});

const definitions = [
  // Eight weapon-form upgrades.
  upgrade('overload-relay', 'weapon', ['overload', 'weapon'], 3,
    { chainTargets: fx(2, 1, 0, 6), propagationRadius: fx(6, 0.6, 0, 8) },
    copy('过载继电', '命中会向更多邻近敌人传播电弧。', 'Overload Relay', 'Hits propagate arcs to more nearby enemies.')),
  upgrade('drone-volley', 'weapon', ['overload', 'tide', 'weapon'], 2,
    { droneCount: fx(2, 1, 2, 4), droneArcTargets: fx(2, 1, 2, 6) },
    copy('无人机齐射', '增加护航无人机，并让每次齐射跨越更多目标。', 'Drone Volley', 'Adds escort drones and lets each volley arc across more targets.'), { bossCore: true }),
  upgrade('pulse-echo', 'weapon', ['overload', 'weapon'], 2,
    { pulseProjectiles: fx(1, 1, 1, 3), weaponDamageMultiplier: fx(1, 0.08, 0.5, 2.2) },
    copy('脉冲回声', '双炮命中后复制侧向脉冲，不需要额外瞄准。', 'Pulse Echo', 'Cannon hits copy side pulses without adding aim input.')),
  upgrade('prism-fan', 'weapon', ['rift', 'weapon'], 2,
    { missileSplit: fx(3, 1, 3, 5), missileImpactRadius: fx(0.75, 0.15, 0.5, 1.2) },
    copy('棱镜扇裂', '导弹命中后分裂成更宽的自动追踪扇面。', 'Prism Fan', 'Missiles split into a wider auto-tracking fan on impact.')),
  upgrade('rift-bore', 'weapon', ['rift', 'weapon'], 3,
    { projectilePierce: fx(0, 1, 0, 4), projectileSpeedMultiplier: fx(1, 0.08, 0.5, 1.5) },
    copy('裂隙钻芯', '主武器穿过额外目标，并保持自动锁敌。', 'Rift Bore', 'Primary shots traverse extra targets while remaining automatic.')),
  upgrade('weakpoint-prism', 'weapon', ['rift', 'weapon'], 3,
    { weakPointMultiplier: fx(1.5, 0.2, 1, 2.5), weakPointPriority: fx(1, 0.2, 1, 1.8) },
    copy('弱点棱镜', '自动武器更偏好弱点，弱点命中造成更高伤害。', 'Weakpoint Prism', 'Automatic weapons favor weak points and deal more weak-point damage.'), { bossCore: true }),
  upgrade('chain-reactor', 'weapon', ['overload', 'weapon'], 3,
    { chainDamageMultiplier: fx(0.78, 0.08, 0.5, 1), weaponDamageMultiplier: fx(1, 0.06, 0.5, 2.2) },
    copy('连锁反应堆', '传播电弧保留更多伤害，击破后继续寻找目标。', 'Chain Reactor', 'Propagated arcs retain more damage and continue after kills.')),
  upgrade('prism-core', 'weapon', ['rift', 'weapon'], 2,
    { weaponDamageMultiplier: fx(1, 0.14, 0.5, 2.2), objectiveDamageMultiplier: fx(1, 0.12, 1, 1.8) },
    copy('棱镜核心', '自动火力折射增幅，并对任务核心造成额外伤害。', 'Prism Core', 'Refracts automatic fire for more damage, especially against objectives.')),

  // Six dash / phase upgrades.
  upgrade('echo-shield', 'phase', ['phase', 'survival'], 2,
    { phaseDurationBonus: fx(0, 0.04, 0, 0.16) },
    copy('相位外壳', '冲刺后的无碰撞相位持续更久。', 'Phase Shell', 'The collision-free phase after a dash lasts longer.')),
  upgrade('perfect-resonance', 'phase', ['overload', 'phase'], 3,
    { perfectPhaseWindowBonus: fx(0, 0.015, 0, 0.06), perfectFireBuffMultiplier: fx(0.75, -0.04, 0.6, 0.75) },
    copy('完美共振', '扩大完美相位窗口，并强化自动武器涌流。', 'Perfect Resonance', 'Widens perfect phase timing and strengthens the automatic fire surge.')),
  upgrade('phase-overclock', 'phase', ['overload', 'phase', 'weapon'], 2,
    { fireIntervalMultiplier: fx(1, -0.1, 0.55, 1) },
    copy('相位超频', '每次相位后自动武器更快恢复射击节奏。', 'Phase Overclock', 'Automatic weapons recover their firing rhythm faster after phasing.'), { bossCore: true }),
  upgrade('rift-slip', 'phase', ['rift', 'phase'], 3,
    { dashRecoveryMultiplier: fx(1, -0.08, 0.65, 1), dashSpeedMultiplier: fx(1, 0.05, 1, 1.2) },
    copy('裂隙滑移', '冲刺穿越更远，且两格充能恢复更快。', 'Rift Slip', 'Dashes travel farther and both charges recover faster.')),
  upgrade('tide-wake', 'phase', ['tide', 'phase', 'objective'], 2,
    { objectiveProximityMultiplier: fx(1, 0.15, 1, 1.6), pickupRadiusMultiplier: fx(1, 0.2, 1, 3) },
    copy('潮痕尾流', '冲刺路线吸引拾取物，并增强任务区域内的推进。', 'Tide Wake', 'Dash routes attract pickups and strengthen progress near objectives.')),
  upgrade('ion-drive', 'phase', ['phase', 'survival'], 3,
    { moveSpeedMultiplier: fx(1, 0.08, 1, 1.24), steeringMultiplier: fx(1, 0.06, 1, 1.2) },
    copy('离子驱动', '提高移动上限与转向响应，不增加新操作。', 'Ion Drive', 'Raises movement speed and steering response without a new input.')),

  // Five Tide Lance upgrades.
  upgrade('lance-rift', 'lance', ['rift', 'lance'], 3,
    { lanceLength: fx(7.2, 1.2, 7.2, 12), lancePierce: fx(0, 1, 0, 4) },
    copy('光矛裂隙', '潮汐光矛延伸更远并贯穿更多目标。', 'Lance Rift', 'Tide Lance reaches farther and traverses more targets.')),
  upgrade('lance-aperture', 'lance', ['tide', 'lance'], 3,
    { lanceHalfWidth: fx(0.275, 0.1, 0.275, 0.7), lanceTargetCap: fx(8, 1, 8, 12) },
    copy('潮矛孔径', '自动选线变宽，可覆盖更多分散目标。', 'Lance Aperture', 'The automatic line widens to cover more dispersed targets.')),
  upgrade('lance-weakpoint', 'lance', ['rift', 'lance'], 3,
    { lanceWeakPointMultiplier: fx(1, 0.25, 1, 2), weakPointPriority: fx(1, 0.15, 1, 1.8) },
    copy('弱点潮刻', '光矛选线更重视弱点，并放大弱点伤害。', 'Weakpoint Tidecut', 'Lance lines favor weak points and amplify weak-point damage.'), { bossCore: true }),
  upgrade('lance-overload', 'lance', ['overload', 'lance'], 2,
    { lancePropagation: fx(0, 1, 0, 2), chainDamageMultiplier: fx(0.78, 0.08, 0.5, 1) },
    copy('光矛过载', '光矛命中会从路径目标向邻近敌人放电。', 'Lance Overload', 'Lance hits discharge from path targets into nearby enemies.')),
  upgrade('overclock', 'lance', ['tide', 'lance'], 3,
    { lanceEnergyGainMultiplier: fx(1, 0.18, 1, 1.6), lanceDamageMultiplier: fx(1, 0.12, 1, 1.6) },
    copy('潮核超频', '光核提供更多光矛能量，并提高释放伤害。', 'Tide Core Overclock', 'Cores grant more Lance energy and raise release damage.')),

  // Five survival, pickup and objective upgrades.
  upgrade('magnet-field', 'utility', ['tide', 'survival'], 3,
    { pickupRadiusMultiplier: fx(1, 0.45, 1, 3), pickupAttractionSpeed: fx(0, 2, 0, 6) },
    copy('磁潮力场', '远处光核会被持续吸向玩家。', 'Magnet Tide Field', 'Distant light cores are continuously pulled toward the player.')),
  upgrade('escort-repair', 'utility', ['tide', 'survival', 'objective'], 3,
    { escortRepairPerSecond: fx(0, 0.08, 0, 0.24), droneObjectiveDamageMultiplier: fx(1, 0.1, 1, 1.4) },
    copy('护航维修群', '无人机修复护送目标，并优先压制其附近威胁。', 'Escort Repair Swarm', 'Drones repair escorts and prioritize threats near them.'), { bossCore: true }),
  upgrade('objective-halo', 'utility', ['tide', 'objective'], 3,
    { objectiveProximityMultiplier: fx(1, 0.2, 1, 1.6), objectiveDamageMultiplier: fx(1, 0.12, 1, 1.8) },
    copy('任务光环', '靠近任务目标时加快占领、护送与核心破坏。', 'Objective Halo', 'Proximity accelerates capture, escort and objective-core damage.')),
  upgrade('repair-swarm', 'utility', ['tide', 'survival'], 1,
    { hullBonus: fx(0, 1, 0, 2), immediateRepair: fx(0, 1, 0, 1) },
    copy('维修蜂群', '立即修复一格船体，并永久增加本局船体上限。', 'Repair Swarm', 'Repairs one hull immediately and raises this run’s hull capacity.'), { bossCore: true }),
  upgrade('tide-reserve', 'utility', ['tide', 'survival', 'objective'], 3,
    { roomRepair: fx(0, 0.25, 0, 0.75), pickupValueMultiplier: fx(1, 0.15, 1, 1.45) },
    copy('潮汐储备', '完成任务后修复船体，并提高拾取物收益。', 'Tide Reserve', 'Repairs hull after objectives and increases pickup value.')),
];

export function validateUpgrades(pool) {
  if (!Array.isArray(pool) || pool.length !== 24) throw new TypeError('upgrade pool must contain exactly 24 entries');
  const ids = new Set();
  const distribution = { weapon: 0, phase: 0, lance: 0, utility: 0 };
  for (const entry of pool) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id || ids.has(entry.id)) {
      throw new TypeError('upgrade IDs must be unique non-empty strings');
    }
    ids.add(entry.id);
    if (!CATEGORIES.has(entry.category)) throw new TypeError(`unknown upgrade category: ${entry.category}`);
    distribution[entry.category] += 1;
    if (!Array.isArray(entry.tags) || entry.tags.length === 0 || entry.tags.some((tag) => !TAG_SET.has(tag))) {
      throw new TypeError(`unknown or missing upgrade tag: ${entry.id}`);
    }
    if (!Number.isInteger(entry.maxStacks) || entry.maxStacks < 1 || entry.maxStacks > 3) {
      throw new TypeError(`upgrade stacking must be finite and bounded: ${entry.id}`);
    }
    if (entry.activeInput != null) throw new TypeError(`upgrade adds an active input: ${entry.id}`);
    if (!Array.isArray(entry.compatibleStarterWeapons) || entry.compatibleStarterWeapons.length === 0
      || entry.compatibleStarterWeapons.some((id) => !STARTER_SET.has(id))) {
      throw new TypeError(`upgrade starter compatibility is invalid: ${entry.id}`);
    }
    for (const locale of ['zhCN', 'en']) {
      const localized = entry.copy?.[locale];
      if (!localized || typeof localized.name !== 'string' || !localized.name.trim()
        || typeof localized.behavior !== 'string' || !localized.behavior.trim()) {
        throw new TypeError(`upgrade localized behavior copy is missing: ${entry.id}/${locale}`);
      }
    }
    if (!entry.effects || typeof entry.effects !== 'object' || Array.isArray(entry.effects)
      || Object.keys(entry.effects).length === 0) throw new TypeError(`upgrade effects are missing: ${entry.id}`);
    for (const effect of Object.values(entry.effects)) {
      if (!effect || !['base', 'perStack', 'min', 'max'].every((key) => Number.isFinite(effect[key]))
        || effect.min > effect.max) throw new TypeError(`upgrade formula is nonfinite or unbounded: ${entry.id}`);
      const maximumStackValue = effect.base + effect.perStack * entry.maxStacks;
      if (!Number.isFinite(maximumStackValue)) throw new TypeError(`upgrade formula overflows: ${entry.id}`);
    }
  }
  if (distribution.weapon !== 8 || distribution.phase !== 6 || distribution.lance !== 5 || distribution.utility !== 5) {
    throw new TypeError('upgrade category distribution must be 8/6/5/5');
  }
  return true;
}

validateUpgrades(definitions);
export const UPGRADES = deepFreeze(definitions);
export const BOSS_CORE_UPGRADE_IDS = Object.freeze(UPGRADES.filter(({ bossCore }) => bossCore).map(({ id }) => id));
