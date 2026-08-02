import { ENEMY_TYPES, GAME, RANK_THRESHOLDS, REWARDS, STAGES, UPGRADES } from './config.js';

export { GAME, STAGES, ENEMY_TYPES, UPGRADES };

export function computeFrameDeltas(rawWallDt, slowMotionScale = 1) {
  const wallDt = Number.isFinite(rawWallDt) ? Math.max(0, rawWallDt) : 0;
  const simulationScale = Math.min(1, Math.max(0, Number(slowMotionScale) || 0));
  return Object.freeze({
    wallDt,
    simDt: Math.min(wallDt, 0.05) * simulationScale,
  });
}

export function getStageIndex(elapsed) {
  const seconds = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  let index = 0;
  for (let i = 1; i < STAGES.length; i += 1) {
    if (seconds >= STAGES[i].start) index = i;
    else break;
  }
  return index;
}

export function getStage(elapsed) {
  return STAGES[getStageIndex(elapsed)];
}

export function computeSpawnBudget(elapsed, health, score) {
  const stage = getStage(elapsed);
  const progress = Math.min(1, Math.max(0, Number(elapsed) || 0) / GAME.duration);
  const normalizedHealth = Math.min(1, Math.max(0, Number(health) || 0) / 100);
  const scorePressure = Math.min(0.35, Math.max(0, Number(score) || 0) / 30000);
  // Give a damaged player breathing room while steadily increasing pressure.
  const raw = stage.spawnRate * (1 + progress * 0.8 + scorePressure) * (0.55 + normalizedHealth * 0.45);
  return Math.max(1, Math.min(GAME.maxEnemies, Math.round(raw)));
}

export function computeReward(kind, combo = 0, multiplier = 1) {
  const base = REWARDS[kind] ?? REWARDS.pickup;
  const comboFactor = 1 + (Math.min(GAME.comboCap, Math.max(0, Number(combo) || 0)) * 0.1);
  const factor = Math.max(0, Number(multiplier) || 0) * comboFactor;
  return Object.freeze({
    score: Math.round(base.score * factor),
    energy: Math.round(base.energy * factor),
    combo: 1,
  });
}

export function computeRank(stats = {}) {
  const score = typeof stats === 'number' ? stats : Math.max(0, Number(stats.score) || 0);
  if (score >= RANK_THRESHOLDS.S) return 'S';
  if (score >= RANK_THRESHOLDS.A) return 'A';
  if (score >= RANK_THRESHOLDS.B) return 'B';
  return 'C';
}

export function pickUpgradeOptions(ownedIds = [], random = Math.random, count = 3) {
  const owned = new Set(ownedIds instanceof Set ? ownedIds : ownedIds ?? []);
  const pool = UPGRADES.filter((upgrade) => !owned.has(upgrade.id));
  const requested = Math.max(0, Math.min(Number(count) || 0, pool.length));
  const options = [];
  for (let i = 0; i < requested; i += 1) {
    const value = Number(random());
    const normalized = Number.isFinite(value) ? Math.min(0.999999999, Math.max(0, value)) : 0;
    const index = Math.floor(normalized * pool.length);
    options.push(pool.splice(index, 1)[0]);
  }
  return Object.freeze(options);
}
