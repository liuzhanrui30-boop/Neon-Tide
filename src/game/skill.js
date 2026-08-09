const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
};

const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

export const LASER_RULES = freeze({
  maxEnergy: 100,
  pickupEnergy: 5,
  focusedPickupEnergy: 7,
  chargeDuration: 0.28,
  activeDuration: 0.32,
  length: 7.2,
  width: 0.55,
  maxTargets: 5,
});

export const gainWeaponEnergy = (current, focusedOrMultiplier = false) => {
  const gain = typeof focusedOrMultiplier === 'number'
    ? LASER_RULES.pickupEnergy * Math.max(1, Math.min(1.6, finite(focusedOrMultiplier, 1)))
    : focusedOrMultiplier ? LASER_RULES.focusedPickupEnergy : LASER_RULES.pickupEnergy;
  return Math.min(LASER_RULES.maxEnergy, Math.max(0, finite(current)) + gain);
};

export const canFireLaser = (energy) => finite(energy) >= LASER_RULES.maxEnergy;

export const getLaserPhase = (elapsed = 0) => {
  const seconds = Math.max(0, finite(elapsed));
  if (seconds < LASER_RULES.chargeDuration) return 'charge';
  if (seconds < 0.6) return 'active';
  return 'done';
};

export const laserHitsCircle = (beam = {}, circle = {}) => {
  const originX = finite(beam.originX);
  const originY = finite(beam.originY);
  const directionX = finite(beam.directionX);
  const directionY = finite(beam.directionY);
  const x = finite(circle.x, NaN);
  const y = finite(circle.y, NaN);
  const radius = finite(circle.radius, NaN);
  const magnitude = Math.hypot(directionX, directionY);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(radius) || radius < 0 || magnitude === 0) return false;
  const unitX = directionX / magnitude;
  const unitY = directionY / magnitude;
  const offsetX = x - originX;
  const offsetY = y - originY;
  const along = (offsetX * unitX) + (offsetY * unitY);
  const length = Math.max(0, finite(beam.length, LASER_RULES.length));
  if (along < 0 || along > length) return false;
  const perpendicular = Math.abs((offsetX * unitY) - (offsetY * unitX));
  const width = Math.max(0, finite(beam.width, LASER_RULES.width));
  return perpendicular <= (width / 2) + radius;
};

export const selectLaserTargets = (candidates = [], maxTargets = LASER_RULES.maxTargets) => Object.freeze(
  (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => Number.isFinite(candidate?.along) && candidate.along >= 0)
    .slice()
    .sort((left, right) => left.along - right.along)
    .slice(0, Math.max(1, Math.min(16, Math.trunc(finite(maxTargets, LASER_RULES.maxTargets))))),
);
