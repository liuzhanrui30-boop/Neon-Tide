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

export const gainWeaponEnergy = (current, focused) => Math.min(
  LASER_RULES.maxEnergy,
  Math.max(0, finite(current)) + (focused ? LASER_RULES.focusedPickupEnergy : LASER_RULES.pickupEnergy),
);

export const canFireLaser = (energy) => finite(energy) >= LASER_RULES.maxEnergy;

export const getLaserPhase = (elapsed = 0) => {
  const seconds = Math.max(0, finite(elapsed));
  if (seconds < LASER_RULES.chargeDuration) return 'charge';
  if (seconds < LASER_RULES.chargeDuration + LASER_RULES.activeDuration) return 'active';
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
  if (along < 0 || along > LASER_RULES.length) return false;
  const perpendicular = Math.abs((offsetX * unitY) - (offsetY * unitX));
  return perpendicular <= (LASER_RULES.width / 2) + radius;
};

export const selectLaserTargets = (candidates = []) => Object.freeze(
  (Array.isArray(candidates) ? candidates : [])
    .filter((candidate) => Number.isFinite(candidate?.along) && candidate.along >= 0)
    .slice()
    .sort((left, right) => left.along - right.along)
    .slice(0, LASER_RULES.maxTargets),
);
