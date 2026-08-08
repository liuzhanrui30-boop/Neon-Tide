export const OBJECTIVE_TYPES = Object.freeze([
  'purge',
  'anchors',
  'moving-zone',
  'escort',
  'elite-hunt',
  'storm-corridor',
  'core-harvest',
  'dual-crisis',
]);

const ARENA = Object.freeze({ halfWidth: 10.5, halfHeight: 7.2 });
export const OBJECTIVE_BOUNDARY_ORBIT = Object.freeze({ radiusX: 9.2, radiusY: 5.5 });

function template(definition) {
  return Object.freeze({
    ...definition,
    arena: ARENA,
    spawnHooks: Object.freeze(definition.spawnHooks.map((hook) => Object.freeze({ ...hook }))),
    cleanup: Object.freeze([...definition.cleanup]),
  });
}

export const ENCOUNTER_TEMPLATES = Object.freeze([
  template({
    id: 'purge-tide', type: 'purge', label: '清剿潮群', timeout: 75, killTarget: 18, threat: 30,
    spawnHooks: [{ kind: 'wave', count: 18, role: 'purge' }], cleanup: ['enemy', 'enemyProjectile'],
  }),
  template({
    id: 'anchor-break', type: 'anchors', label: '破坏潮汐锚点', timeout: 82, anchorCount: 3,
    anchorRadius: 1.55, anchorSeconds: 1.4, threat: 34,
    spawnHooks: [{ kind: 'objective', count: 3, role: 'anchor' }], cleanup: ['objective', 'enemy', 'enemyProjectile'],
  }),
  template({
    id: 'moving-sanctum', type: 'moving-zone', label: '跟随移动安全区', timeout: 78, holdSeconds: 12,
    zoneRadius: 2.15, pathSpeed: 2.2, threat: 36,
    spawnHooks: [{ kind: 'objective', count: 1, role: 'safe-zone' }], cleanup: ['objective', 'enemy', 'enemyProjectile'],
  }),
  template({
    id: 'escort-skiff', type: 'escort', label: '护送能量舰', timeout: 85, escortDistance: 24,
    escortSpeed: 2.4, supportRadius: 2.8, escortHp: 12, threat: 38,
    spawnHooks: [{ kind: 'objective', count: 1, role: 'escort' }], cleanup: ['objective', 'enemy', 'enemyProjectile'],
  }),
  template({
    id: 'elite-pursuit', type: 'elite-hunt', label: '追猎高价值目标', timeout: 80, eliteTarget: 2, threat: 40,
    spawnHooks: [{ kind: 'enemy', count: 2, role: 'elite-target' }], cleanup: ['enemy', 'enemyProjectile'],
  }),
  template({
    id: 'storm-run', type: 'storm-corridor', label: '穿越风暴走廊', timeout: 52, survivalSeconds: 18,
    corridorSegments: 6, corridorWidth: 2.7, threat: 42,
    spawnHooks: [{ kind: 'hazard', count: 6, role: 'storm-segment' }], cleanup: ['hazard', 'enemy', 'enemyProjectile'],
  }),
  template({
    id: 'core-harvest', type: 'core-harvest', label: '收割远距核心', timeout: 78, coreCount: 5,
    collectRadius: 1.15, activationDelay: 2, threat: 37,
    spawnHooks: [{ kind: 'pickup', count: 5, role: 'harvest-core' }], cleanup: ['pickup', 'enemy', 'enemyProjectile'],
  }),
  template({
    id: 'dual-crisis', type: 'dual-crisis', label: '处理双重危机', timeout: 84, crisisSeconds: 3.2,
    escalationSeconds: 28, crisisRadius: 1.7, threat: 44,
    spawnHooks: [{ kind: 'objective', count: 2, role: 'crisis' }], cleanup: ['objective', 'enemy', 'enemyProjectile'],
  }),
]);

const BY_ID = new Map(ENCOUNTER_TEMPLATES.map((entry) => [entry.id, entry]));
const BY_TYPE = new Map(ENCOUNTER_TEMPLATES.map((entry) => [entry.type, entry]));

export function getEncounterTemplate(value) {
  if (typeof value === 'string') return BY_ID.get(value) ?? BY_TYPE.get(value) ?? null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.objectiveTemplate) return getEncounterTemplate(value.objectiveTemplate);
  if (value.objective && typeof value.objective === 'object') return value.objective;
  if (value.type && OBJECTIVE_TYPES.includes(value.type)) return value;
  return BY_ID.get(value.id) ?? null;
}

function qualityName(quality) {
  if (typeof quality === 'string') return quality;
  if (quality?.tier === 'mobile' || quality?.coarsePointer) return 'mobile';
  if (quality?.tier === 'low') return 'low';
  return 'desktop';
}

export function getThreatBudget(templateValue, { mode = 'standard', quality = 'desktop' } = {}) {
  const encounter = getEncounterTemplate(templateValue);
  if (!encounter) throw new TypeError('unknown encounter template');
  if (!['standard', 'abyss'].includes(mode)) throw new TypeError('mode must be standard or abyss');
  const selectedQuality = qualityName(quality);
  const coarseQuality = ['mobile', 'coarse', 'touch'].includes(selectedQuality);
  const qualityFactor = coarseQuality ? 0.72 : selectedQuality === 'low' ? 0.84 : 1;
  const modeFactor = mode === 'abyss' ? 1.22 : 1;
  const authoredThreat = Number(encounter.threatBudget ?? encounter.threat);
  const baseThreat = Number.isFinite(authoredThreat) && authoredThreat > 0 ? authoredThreat : 30;
  const activeCap = coarseQuality ? (mode === 'abyss' ? 42 : 36) : (mode === 'abyss' ? 56 : 48);
  const projectileCap = coarseQuality ? 72 : 96;
  return Object.freeze({
    total: Math.max(1, Math.round(baseThreat * qualityFactor * modeFactor)),
    activeEnemyCap: activeCap,
    projectileCap,
  });
}

const STANDARD_CAMPAIGN_SEQUENCE = Object.freeze([
  'anchor-break',
  'moving-sanctum',
  'core-harvest',
  'escort-skiff',
  'elite-pursuit',
]);

export function getCampaignEncounter(roomIndex = 0, { mode = 'standard', seed = 0 } = {}) {
  const index = Number.isInteger(roomIndex) ? Math.max(0, roomIndex) : 0;
  const offset = mode === 'abyss' ? Math.abs(Math.trunc(Number(seed) || 0)) % STANDARD_CAMPAIGN_SEQUENCE.length : 0;
  return getEncounterTemplate(STANDARD_CAMPAIGN_SEQUENCE[(index + offset) % STANDARD_CAMPAIGN_SEQUENCE.length]);
}
