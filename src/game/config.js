const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
};

const STAGE_BOUNDARIES = [0, 30, 64, 100];
const BOSS_WINDOW = 26;

export const COMBAT = freeze({
  desktopEnemyCap: 36,
  coarsePointerEnemyCap: 28,
  particleCap: 300,
  trailNodeCap: 48,
  spawnIntervals: [0.72, 0.55, 0.42],
  spawnIntervalFloor: 0.3,
  formationCooldown: { min: 5, max: 9 },
  formationTelegraph: { min: 0.45, max: 0.85 },
});

export const GAME = freeze({
  version: '2.1.0',
  bossStart: STAGE_BOUNDARIES.at(-1),
  bossWindow: BOSS_WINDOW,
  duration: STAGE_BOUNDARIES.at(-1) + BOSS_WINDOW,
  stageBoundaries: STAGE_BOUNDARIES,
  maxEnemies: COMBAT.desktopEnemyCap,
  desktopEnemyCap: COMBAT.desktopEnemyCap,
  coarsePointerEnemyCap: COMBAT.coarsePointerEnemyCap,
  maxParticles: COMBAT.particleCap,
  maxTrailNodes: COMBAT.trailNodeCap,
  spawnIntervalFloor: COMBAT.spawnIntervalFloor,
  comboCap: 8,
  overdriveEnergy: 100,
  overdriveDuration: 5,
});

export const STAGES = freeze([
  { index: 0, id: 'drift', name: 'Neon Drift', start: 0, end: 30, spawnRate: 1.0, palette: '#36e0ff' },
  { index: 1, id: 'surge', name: 'Signal Surge', start: 30, end: 64, spawnRate: 1.35, palette: '#a56bff' },
  { index: 2, id: 'crosscurrent', name: 'Crosscurrent', start: 64, end: 100, spawnRate: 1.7, palette: '#ff4fba' },
  { index: 3, id: 'event-horizon', name: 'Event Horizon', start: 100, end: Infinity, spawnRate: 2.1, palette: '#ff9f43' },
]);

export const ENEMY_TYPES = freeze({
  hunter: { id: 'hunter', role: 'Hunter', radius: 0.75, hp: 1, damage: 1, speed: 2.2, threatCost: 1, telegraph: 0.5, score: 100, energy: 8 },
  chaser: { id: 'chaser', role: 'Hunter', radius: 0.75, hp: 1, damage: 1, speed: 2.2, threatCost: 1, telegraph: 0.5, score: 100, energy: 8 },
  striker: { id: 'striker', role: 'Striker', radius: 0.9, hp: 1, damage: 1, speed: 2.8, threatCost: 2, telegraph: 0.55, score: 150, energy: 10 },
  lancer: { id: 'lancer', role: 'Lancer', radius: 0.85, hp: 2, damage: 2, speed: 1.6, threatCost: 3, telegraph: 0.7, score: 220, energy: 12 },
  swarm: { id: 'swarm', role: 'Swarm', radius: 0.42, hp: 1, damage: 1, speed: 3.2, threatCost: 1, telegraph: 0.45, score: 80, energy: 6 },
  mine: { id: 'mine', role: 'Mine', radius: 0.65, hp: 1, damage: 2, speed: 0, threatCost: 2, telegraph: 1.1, score: 125, energy: 9 },
  bulwark: { id: 'bulwark', role: 'Bulwark', radius: 1.15, hp: 3, damage: 2, speed: 1.5, threatCost: 4, telegraph: 0.68, score: 400, energy: 22 },
  elite: { id: 'elite', role: 'Bulwark', radius: 1.15, hp: 3, damage: 2, speed: 1.5, threatCost: 4, telegraph: 0.68, score: 350, energy: 20 },
  boss: { id: 'boss', role: 'Boss', radius: 3.5, hp: 30, damage: 3, speed: 1.2, threatCost: 8, telegraph: 0.68, score: 2500, energy: 35 },
});

export const FORMATION_TEMPLATES = freeze({
  pincer: { name: 'pincer', enemyCost: 9, minSafeGap: 2.4, cooldown: 5, palette: '#ff4fba', roles: ['hunter', 'striker', 'lancer', 'striker', 'hunter'] },
  crossfire: { name: 'crossfire', enemyCost: 10, minSafeGap: 2.6, cooldown: 6, palette: '#a56bff', roles: ['striker', 'lancer', 'lancer', 'striker'] },
  'mine-wall': { name: 'mine-wall', enemyCost: 12, minSafeGap: 2.8, cooldown: 7, palette: '#ff9f43', roles: ['mine', 'mine', 'mine', 'mine', 'mine', 'swarm', 'swarm'] },
  spiral: { name: 'spiral', enemyCost: 5, minSafeGap: 2.5, cooldown: 6, palette: '#36e0ff', roles: ['swarm', 'hunter', 'swarm', 'hunter', 'swarm'] },
  'elite-escort': { name: 'elite-escort', enemyCost: 8, minSafeGap: 3.2, cooldown: 9, palette: '#ff4fba', roles: ['elite', 'striker', 'striker'] },
});

export const UPGRADES = freeze([
  { id: 'ion-drive', name: 'Ion Drive', description: 'Increase movement speed.', effect: 0.15 },
  { id: 'prism-core', name: 'Prism Core', description: 'Increase score multiplier.', effect: 0.2 },
  { id: 'echo-shield', name: 'Echo Shield', description: 'Extend dash invulnerability.', effect: 0.08 },
  { id: 'magnet-field', name: 'Magnet Field', description: 'Collect pickups from farther away.', effect: 0.25 },
  { id: 'overclock', name: 'Overclock', description: 'Charge overdrive more quickly.', effect: 0.2 },
  { id: 'repair-swarm', name: 'Repair Swarm', description: 'Restore 1 hull now and raise maximum hull to 4.', effect: 1 },
]);

export const REWARDS = freeze({
  pickup: { score: 100, energy: 12 },
  nearMiss: { score: 150, energy: 8 },
  break: { score: 250, energy: 20 },
  bossHit: { score: 400, energy: 25 },
});

export const RANK_THRESHOLDS = freeze({ S: 9000, A: 6000, B: 3500 });
