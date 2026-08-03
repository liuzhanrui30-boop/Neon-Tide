import { REALMS } from './realms.js';

const freeze = (value) => Object.freeze(value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finite = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const ACTIVE_DURATION = 3.2;

export const ENVIRONMENT_RULES = freeze({
  activeDuration: ACTIVE_DURATION,
  currentForce: 0.7,
  dataLanePenalty: 0.35,
  gravityAcceleration: 1.25,
});

const getRealm = (realmId) => REALMS.find((realm) => realm.id === realmId) ?? REALMS[0];

export const getEnvironmentDelay = (realmId, seed = 0) => {
  const [minimum, maximum] = getRealm(realmId).environment.interval;
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) return Infinity;
  const amount = clamp(finite(seed), 0, 1);
  return minimum + ((maximum - minimum) * amount);
};

export const getEnvironmentFrame = (realmId, eventElapsed = 0) => {
  const realm = getRealm(realmId);
  const { environment } = realm;
  if (environment.type === 'none') return freeze({ realmId: realm.id, type: 'none', phase: 'disabled', elapsed: 0, telegraph: 0, activeDuration: 0 });
  const elapsed = Math.max(0, finite(eventElapsed));
  const phase = elapsed < environment.telegraph
    ? 'telegraph'
    : elapsed < environment.telegraph + ACTIVE_DURATION ? 'active' : 'cooldown';
  return freeze({
    realmId: realm.id,
    type: environment.type,
    phase,
    elapsed,
    telegraph: environment.telegraph,
    activeDuration: ACTIVE_DURATION,
    direction: freeze({ x: 1, y: 0 }),
    laneCenter: 0,
    laneHalfWidth: 1,
    center: freeze({ x: 0, y: 0 }),
  });
};

export const getCurrentForce = (frame = {}, point = {}) => {
  if (frame.type !== 'current' || frame.phase !== 'active') return freeze({ x: 0, y: 0 });
  const x = finite(frame.direction?.x, 1);
  const y = finite(frame.direction?.y, 0);
  const magnitude = Math.hypot(x, y) || 1;
  return freeze({ x: (x / magnitude) * ENVIRONMENT_RULES.currentForce, y: (y / magnitude) * ENVIRONMENT_RULES.currentForce });
};

export const getDataLanePenalty = (frame = {}, point = {}) => {
  if (frame.type !== 'data-lane' || frame.phase !== 'active') return 0;
  const laneCenter = finite(frame.laneCenter);
  const laneHalfWidth = Math.max(0, finite(frame.laneHalfWidth, 1));
  return Math.abs(finite(point.y) - laneCenter) <= laneHalfWidth ? ENVIRONMENT_RULES.dataLanePenalty : 0;
};

export const getGravityForce = (frame = {}, point = {}) => {
  if (frame.type !== 'gravity-well' || frame.phase !== 'active') return freeze({ x: 0, y: 0 });
  const offsetX = finite(frame.center?.x) - finite(point.x);
  const offsetY = finite(frame.center?.y) - finite(point.y);
  const distance = Math.hypot(offsetX, offsetY);
  if (distance === 0) return freeze({ x: 0, y: 0 });
  const acceleration = Math.min(ENVIRONMENT_RULES.gravityAcceleration, 1 / Math.max(distance, 0.001));
  return freeze({ x: (offsetX / distance) * acceleration, y: (offsetY / distance) * acceleration });
};
