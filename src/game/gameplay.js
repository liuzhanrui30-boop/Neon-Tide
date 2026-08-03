import { ENEMY_TYPES, GAME, RANK_THRESHOLDS, REWARDS, STAGES, UPGRADES } from './config.js';

export { GAME, STAGES, ENEMY_TYPES, UPGRADES };

/**
 * Runtime sanitizers shared by the render loop and tests. Browser input or a
 * long suspended frame must never turn a gameplay scalar into NaN/Infinity.
 */
export function finiteOr(value, fallback = 0) {
  if (Number.isFinite(value)) return value;
  return Number.isFinite(fallback) ? fallback : 0;
}

export function clampFinite(value, min, max, fallback = min) {
  const safeMin = Number.isFinite(min) ? min : 0;
  const safeMax = Number.isFinite(max) ? Math.max(safeMin, max) : safeMin;
  const safeFallback = Number.isFinite(fallback) ? Math.min(safeMax, Math.max(safeMin, fallback)) : safeMin;
  const numeric = finiteOr(value, safeFallback);
  return Math.min(safeMax, Math.max(safeMin, numeric));
}

export function capActiveCount(count, cap) {
  return Math.trunc(clampFinite(count, 0, Math.max(0, Math.trunc(finiteOr(cap, 0))), 0));
}

export function beamHitsCircle(beam = {}, circle = {}) {
  const originX = finiteOr(beam.originX, 0);
  const originY = finiteOr(beam.originY, 0);
  const directionX = finiteOr(beam.directionX, 0);
  const directionY = finiteOr(beam.directionY, 0);
  const directionLength = Math.hypot(directionX, directionY);
  if (directionLength <= 0) return false;
  const normalizedX = directionX / directionLength;
  const normalizedY = directionY / directionLength;
  const relativeX = finiteOr(circle.x, 0) - originX;
  const relativeY = finiteOr(circle.y, 0) - originY;
  const along = relativeX * normalizedX + relativeY * normalizedY;
  const length = Math.max(0, finiteOr(beam.length, 18));
  if (along < 0 || along > length) return false;
  const perpendicularDistance = Math.abs(relativeX * normalizedY - relativeY * normalizedX);
  const halfWidth = Math.max(0, finiteOr(beam.width, 0)) * 0.5;
  const radius = Math.max(0, finiteOr(circle.radius, 0));
  return perpendicularDistance < halfWidth + radius;
}

export function getMineDetonationFrame(timeRemaining, reducedMotion = false) {
  const duration = 0.78;
  const progress = Math.min(1, Math.max(0, 1 - finiteOr(timeRemaining, duration) / duration));
  const scaled = Math.min(2.999999, progress * 3);
  const stage = Math.min(2, Math.floor(scaled));
  const stageProgress = scaled - stage;
  const radii = [1.7, 3.25, 4.8];
  const fromRadius = stage === 0 ? 0.55 : radii[stage - 1];
  const easedProgress = 1 - ((1 - stageProgress) ** 3);
  const radius = reducedMotion
    ? radii[stage]
    : fromRadius + (radii[stage] - fromRadius) * easedProgress;
  return Object.freeze({ stage, stageProgress, radius });
}

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
