import { COMBAT, FORMATION_TEMPLATES, GAME, STAGES } from './config.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function getStageIndex(elapsed) {
  const seconds = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
  let index = 0;
  for (let i = 1; i < STAGES.length; i += 1) {
    if (seconds >= STAGES[i].start) index = i;
    else break;
  }
  return index;
}

export function getStageProgress(elapsed) {
  const seconds = clamp(Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0, 0, GAME.duration);
  const index = getStageIndex(seconds);
  const stage = STAGES[index];
  const end = Number.isFinite(stage.end) ? stage.end : GAME.duration;
  return end <= stage.start ? 1 : clamp((seconds - stage.start) / (end - stage.start), 0, 1);
}

export function getActiveEnemyCap({ coarsePointer = false, viewportWidth = Infinity } = {}) {
  return coarsePointer || (Number.isFinite(viewportWidth) && viewportWidth < 700)
    ? COMBAT.coarsePointerEnemyCap
    : COMBAT.desktopEnemyCap;
}

export function getSpawnInterval(stageIndex = 0, elapsed = 0) {
  const index = clamp(Math.trunc(Number(stageIndex) || 0), 0, COMBAT.spawnIntervals.length - 1);
  const stageStart = STAGES[Math.min(index, STAGES.length - 1)].start;
  const base = COMBAT.spawnIntervals[index];
  const pressure = Math.max(0, (Number(elapsed) || 0) - stageStart) * 0.004;
  return Number(Math.max(COMBAT.spawnIntervalFloor, base - Math.min(0.16, pressure)).toFixed(3));
}

export function getFormationBudget(stageIndex = 0, elapsed = 0, context = {}) {
  const requestedCap = Number(context.maxEnemyCap);
  const cap = Number.isFinite(requestedCap)
    ? Math.max(0, requestedCap)
    : getActiveEnemyCap(context);
  const activeCost = Math.max(0, Number(context.activeCost) || 0);
  const available = Math.max(0, cap - activeCost);
  const index = clamp(Math.trunc(Number(stageIndex) || 0), 0, STAGES.length - 1);
  const progress = getStageProgress(elapsed);
  const target = 6 + index * 2 + Math.floor(progress * 2);
  return Math.min(available, target);
}

function seededIndex(seed, length) {
  if (length <= 1) return 0;
  const numeric = Number(seed);
  const value = Number.isFinite(numeric) ? numeric : String(seed ?? '').split('').reduce((hash, char) => ((hash * 31) + char.charCodeAt(0)) >>> 0, 7);
  return Math.abs(Math.trunc(value)) % length;
}

export function chooseFormation({
  stageIndex = 0,
  elapsed = 0,
  lastFormation = null,
  cooldownRemaining = 0,
  activeCost = 0,
  maxEnemyCap,
  safeGap = Infinity,
  seed = 0,
} = {}) {
  if ((Number(cooldownRemaining) || 0) > 0) return null;
  const budget = getFormationBudget(stageIndex, elapsed, { activeCost, maxEnemyCap });
  const candidates = Object.values(FORMATION_TEMPLATES).filter((template) => (
    template.enemyCost <= budget
      && template.name !== lastFormation
      && (!Number.isFinite(safeGap) || safeGap >= template.minSafeGap)
  ));
  if (!candidates.length) return null;
  const selected = candidates[seededIndex(seed, candidates.length)];
  return Object.freeze({ ...selected, roles: [...selected.roles] });
}

export function getFormationSlots(name, viewport = {}) {
  const template = FORMATION_TEMPLATES[name];
  if (!template) return [];
  const width = Math.max(4, Number(viewport.width) || 12);
  const height = Math.max(4, Number(viewport.height) || 8);
  const x = width * 0.34;
  const y = height * 0.34;
  const slots = {
    pincer: [{ x: -x, y: y }, { x: -x, y: -y }, { x: x, y: y }, { x: x, y: -y }],
    crossfire: [{ x: -x, y: 0 }, { x: x, y: 0 }, { x: 0, y: y }, { x: 0, y: -y }],
    'mine-wall': [{ x: -x, y: y }, { x: -x * 0.38, y: y }, { x: x * 0.38, y: y }, { x: x, y: y }, { x: 0, y: -y * 1.25 }],
    spiral: [{ x: -x, y: y }, { x: x * 0.6, y: y * 0.7 }, { x: x * 0.65, y: -y * 0.2 }, { x: -x * 0.55, y: -y }, { x: x, y: -y }],
    'elite-escort': [{ x: 0, y: y * 1.3 }, { x: -x, y: -y }, { x: x, y: -y }],
  }[name] ?? [];
  if (slots.length !== template.roles.length) return [];
  if (slots.some((slot) => Math.hypot(slot.x, slot.y) < template.minSafeGap)) return [];
  return slots.map((slot, index) => Object.freeze({ ...slot, role: template.roles[index] }));
}

export { FORMATION_TEMPLATES };
