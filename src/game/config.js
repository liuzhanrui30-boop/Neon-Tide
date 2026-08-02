const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
};

const STAGE_BOUNDARIES = [0, 18, 38, 53];
const BOSS_WINDOW = 18;

export const GAME = freeze({
  version: '2.0.0',
  bossStart: STAGE_BOUNDARIES.at(-1),
  bossWindow: BOSS_WINDOW,
  duration: STAGE_BOUNDARIES.at(-1) + BOSS_WINDOW,
  stageBoundaries: STAGE_BOUNDARIES,
  maxEnemies: 24,
  maxParticles: 220,
  maxTrailNodes: 36,
  comboCap: 8,
  overdriveEnergy: 100,
  overdriveDuration: 5,
});

export const STAGES = freeze([
  { index: 0, id: 'drift', name: 'Neon Drift', start: 0, end: 18, spawnRate: 1.0, palette: '#36e0ff' },
  { index: 1, id: 'surge', name: 'Signal Surge', start: 18, end: 38, spawnRate: 1.35, palette: '#a56bff' },
  { index: 2, id: 'crosscurrent', name: 'Crosscurrent', start: 38, end: 53, spawnRate: 1.7, palette: '#ff4fba' },
  { index: 3, id: 'event-horizon', name: 'Event Horizon', start: 53, end: Infinity, spawnRate: 2.1, palette: '#ff9f43' },
]);

export const ENEMY_TYPES = freeze({
  chaser: { id: 'chaser', radius: 0.75, hp: 1, score: 100, energy: 8 },
  striker: { id: 'striker', radius: 0.9, hp: 1, score: 150, energy: 10 },
  mine: { id: 'mine', radius: 0.65, hp: 1, score: 125, energy: 9 },
  elite: { id: 'elite', radius: 1.15, hp: 3, score: 350, energy: 20 },
  boss: { id: 'boss', radius: 3.5, hp: 30, score: 2500, energy: 35 },
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
