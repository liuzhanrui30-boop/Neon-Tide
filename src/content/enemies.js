export const ENEMY_ROLE_IDS = Object.freeze([
  'hunter',
  'interceptor',
  'striker',
  'lancer',
  'swarm',
  'mine',
  'warden',
  'bulwark',
]);

export const ENEMY_COMMITTED_ATTACK_STATES = Object.freeze([
  'cut-dash',
  'strike-dash',
  'beam-active',
  'detonate',
  'wall-active',
  'counter-active',
]);

const COMMITTED_ATTACK_STATE_SET = new Set(ENEMY_COMMITTED_ATTACK_STATES);

export function isEnemyCommittedAttackState(state) {
  return typeof state === 'string' && COMMITTED_ATTACK_STATE_SET.has(state);
}

const ROLE_SET = new Set(ENEMY_ROLE_IDS);

function role(definition) {
  return Object.freeze({
    ...definition,
    speedRange: Object.freeze([...definition.speedRange]),
  });
}

export const ENEMY_ROLES = Object.freeze({
  hunter: role({
    id: 'hunter', speedRange: [3.2, 4.4], threatCost: 1, minChapter: 0, telegraphSeconds: 0.6,
    activeCap: 18, counterplay: 'Break direction before the prediction lane closes.',
    highDamage: false, blockedAreaCost: 0, projectileCost: 0,
    hp: 2, damage: 0.1, radius: 0.64, color: 0xff4fba,
  }),
  interceptor: role({
    id: 'interceptor', speedRange: [5.2, 7], threatCost: 3, minChapter: 0, telegraphSeconds: 0.7,
    activeCap: 4, counterplay: 'Reverse orbit or cut inward after the tangent preview appears.',
    highDamage: true, blockedAreaCost: 0.04, projectileCost: 0,
    hp: 2, damage: 0.3, radius: 0.7, color: 0xff506f,
  }),
  striker: role({
    id: 'striker', speedRange: [3.4, 4.8], threatCost: 3, minChapter: 1, telegraphSeconds: 0.65,
    activeCap: 5, counterplay: 'Read all three lanes, then leave the bright selected lane.',
    highDamage: true, blockedAreaCost: 0.06, projectileCost: 0,
    hp: 2, damage: 0.3, radius: 0.72, color: 0xff4fd8,
  }),
  lancer: role({
    id: 'lancer', speedRange: [3.2, 4], threatCost: 4, minChapter: 1, telegraphSeconds: 0.75,
    activeCap: 4, counterplay: 'Enter the cyan beam sector or phase through the slow bolt group.',
    highDamage: true, blockedAreaCost: 0.12, projectileCost: 3,
    hp: 5, damage: 0.35, radius: 0.78, color: 0xffd166,
  }),
  swarm: role({
    id: 'swarm', speedRange: [4, 5], threatCost: 1, minChapter: 0, telegraphSeconds: 0.55,
    activeCap: 18, counterplay: 'Cross the formation seam while the wings split, then clear one side.',
    highDamage: false, blockedAreaCost: 0, projectileCost: 0,
    hp: 1, damage: 0.1, radius: 0.4, color: 0x9af6ff,
  }),
  mine: role({
    id: 'mine', speedRange: [3.2, 3.6], threatCost: 2, minChapter: 0, telegraphSeconds: 0.9,
    activeCap: 8, counterplay: 'Plan around the orange countdown and leave chained circles in order.',
    highDamage: true, blockedAreaCost: 0.1, projectileCost: 0,
    hp: 1, damage: 0.35, radius: 0.58, color: 0xff9f43,
  }),
  warden: role({
    id: 'warden', speedRange: [3.2, 3.8], threatCost: 5, minChapter: 2, telegraphSeconds: 0.8,
    activeCap: 2, counterplay: 'Track the cyan wall gap and move with it instead of hugging an edge.',
    highDamage: true, blockedAreaCost: 0.24, projectileCost: 0,
    hp: 5, damage: 0.35, radius: 0.95, color: 0xa56bff,
  }),
  bulwark: role({
    id: 'bulwark', speedRange: [3.2, 3.6], threatCost: 6, minChapter: 2, telegraphSeconds: 0.68,
    activeCap: 2, counterplay: 'Crack armor with phase dash or Tide Lance, then exit the counter ring.',
    highDamage: true, blockedAreaCost: 0.14, projectileCost: 0,
    hp: 6, damage: 0.35, radius: 1.05, color: 0xe7ffff,
  }),
});

export function getEnemyRole(id) {
  return typeof id === 'string' ? ENEMY_ROLES[id] ?? null : null;
}

export function validateEnemyRoster(roster = ENEMY_ROLES) {
  if (!roster || typeof roster !== 'object' || Array.isArray(roster)) return false;
  const ids = Object.keys(roster);
  if (ids.length !== ENEMY_ROLE_IDS.length || ids.some((id) => !ROLE_SET.has(id))) return false;
  for (const id of ENEMY_ROLE_IDS) {
    const entry = roster[id];
    if (!entry || entry.id !== id || !Array.isArray(entry.speedRange) || entry.speedRange.length !== 2) return false;
    const [minimum, maximum] = entry.speedRange;
    const interceptor = id === 'interceptor';
    if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || minimum > maximum) return false;
    if (minimum < (interceptor ? 5.2 : 3.2) || maximum > (interceptor ? 7 : 5)) return false;
    if (!Number.isInteger(entry.threatCost) || entry.threatCost < 1) return false;
    if (!Number.isInteger(entry.minChapter) || entry.minChapter < 0) return false;
    if (!Number.isInteger(entry.activeCap) || entry.activeCap < 1) return false;
    if (typeof entry.counterplay !== 'string' || entry.counterplay.length < 16) return false;
    if (entry.highDamage && (!Number.isFinite(entry.telegraphSeconds) || entry.telegraphSeconds < 0.55)) return false;
  }
  return true;
}
