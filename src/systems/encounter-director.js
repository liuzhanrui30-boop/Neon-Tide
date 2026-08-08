import { getEncounterTemplate, getThreatBudget } from '../content/encounters.js';
import { createObjective, getObjectiveSnapshot, updateObjective } from './objective-system.js';

function clone(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
}

function cloneFrozen(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(cloneFrozen));
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, cloneFrozen(entry)]),
  ));
}

function emit(events, type, payload) {
  events?.emit?.(type, Object.freeze(clone(payload)));
}

function roomSeed(seed, roomIndex, templateId) {
  let value = (Math.trunc(Number(seed) || 0) ^ Math.imul(roomIndex + 1, 0x9e3779b1)) >>> 0;
  for (const character of String(templateId)) value = Math.imul(value ^ character.charCodeAt(0), 16777619) >>> 0;
  return value;
}

function scaledTemplate(template, scale) {
  if (scale >= 0.999) return template;
  return {
    ...template,
    timeout: Math.max(6, template.timeout * scale),
    killTarget: Math.max(3, Math.ceil((template.killTarget ?? 1) * scale)),
    anchorSeconds: Math.max(0.2, (template.anchorSeconds ?? 1) * scale),
    holdSeconds: Math.max(1, (template.holdSeconds ?? 1) * scale),
    escortDistance: Math.max(3, (template.escortDistance ?? 1) * scale),
    eliteTarget: Math.max(1, Math.ceil((template.eliteTarget ?? 1) * scale)),
    survivalSeconds: Math.max(2, (template.survivalSeconds ?? 1) * scale),
    coreCount: Math.max(2, Math.ceil((template.coreCount ?? 2) * scale)),
    crisisSeconds: Math.max(0.4, (template.crisisSeconds ?? 1) * scale),
  };
}

export function createEncounterDirector({
  mode = 'standard', quality = 'desktop', seed = 0, roomIndex: initialRoomIndex = 0, durationScale = 1,
  objectiveAuthority = null,
} = {}) {
  if (!['standard', 'abyss'].includes(mode)) throw new TypeError('encounter mode must be standard or abyss');
  if (!Number.isFinite(Number(seed))) throw new TypeError('encounter seed must be finite');
  if (!Number.isInteger(initialRoomIndex) || initialRoomIndex < 0) throw new TypeError('encounter roomIndex must be a non-negative integer');
  if (!Number.isFinite(durationScale) || durationScale <= 0 || durationScale > 1) throw new TypeError('durationScale must be in (0, 1]');
  if (objectiveAuthority !== null && (!objectiveAuthority || typeof objectiveAuthority !== 'object' || Array.isArray(objectiveAuthority))) {
    throw new TypeError('objectiveAuthority must be an internal channel object');
  }
  const qualityName = typeof quality === 'string' ? quality : quality?.tier ?? 'desktop';
  let roomIndex = initialRoomIndex;
  let phase = 'idle';
  let objective = null;
  let templateId = null;
  let threatBudget = null;
  let combatFrozen = false;
  let upgradeOffered = false;
  let completionAcknowledged = false;
  let updateRevision = 0;
  if (objectiveAuthority) {
    Object.defineProperty(objectiveAuthority, 'visit', {
      configurable: true,
      value(visitor) {
        if (typeof visitor !== 'function') throw new TypeError('objective authority visitor must be a function');
        if (!objective) return false;
        visitor(objective);
        return true;
      },
    });
  }

  function getSnapshot() {
    return Object.freeze({
      mode,
      quality: qualityName,
      seed: Number(seed),
      roomIndex,
      phase,
      combatFrozen,
      upgradeOffered,
      objective: getObjectiveSnapshot(objective),
      threatBudget: threatBudget ? cloneFrozen(threatBudget) : null,
      templateId,
    });
  }

  function startRoom(templateValue) {
    const authored = getEncounterTemplate(templateValue);
    const template = authored ? scaledTemplate(authored, durationScale) : null;
    if (!template) throw new TypeError('startRoom requires a known encounter template');
    const currentIndex = roomIndex;
    objective = createObjective(template, roomSeed(seed, currentIndex, template.id));
    threatBudget = getThreatBudget(template, { mode, quality });
    templateId = template.id;
    roomIndex += 1;
    phase = 'active';
    combatFrozen = false;
    upgradeOffered = false;
    completionAcknowledged = false;
    updateRevision += 1;
    return getSnapshot();
  }

  function update(context = {}, dt = 0, events = null) {
    if (phase === 'idle' || completionAcknowledged) return Object.freeze({ phase, combatFrozen, updateRevision, changed: false });
    const previousPhase = phase;
    const previousStatus = objective?.status;
    const previousProgressBucket = Math.floor((objective?.progressRatio ?? 0) * 20);
    let enteredDraining = false;
    if (phase === 'active') {
      updateObjective(objective, context.world ?? null, context.player ?? null, dt, events);
      if (objective.status === 'completed') {
        phase = 'draining';
        enteredDraining = true;
        combatFrozen = true;
        emit(events, 'encounter:combat-frozen', { templateId, objective: getObjectiveSnapshot(objective) });
      } else if (objective.status === 'failed') {
        phase = 'failed';
        combatFrozen = true;
        emit(events, 'encounter:failed', { templateId, objective: getObjectiveSnapshot(objective) });
      }
    }
    if (!enteredDraining && phase === 'draining' && Math.max(0, Number(context.presentationPending) || 0) === 0) {
      phase = 'complete';
      upgradeOffered = true;
      emit(events, 'encounter:upgrade-offered', { templateId, objective: getObjectiveSnapshot(objective) });
    }
    updateRevision += 1;
    return Object.freeze({
      phase,
      combatFrozen,
      updateRevision,
      changed: phase !== previousPhase || objective?.status !== previousStatus
        || Math.floor((objective?.progressRatio ?? 0) * 20) !== previousProgressBucket,
      objectiveStatus: objective?.status ?? null,
      progress: objective?.progress ?? 0,
      progressRatio: objective?.progressRatio ?? 0,
    });
  }

  function completeRoom() {
    if (phase !== 'complete' || completionAcknowledged) return false;
    completionAcknowledged = true;
    return true;
  }

  function reset() {
    roomIndex = initialRoomIndex;
    phase = 'idle';
    objective = null;
    templateId = null;
    threatBudget = null;
    combatFrozen = false;
    upgradeOffered = false;
    completionAcknowledged = false;
    updateRevision += 1;
    return getSnapshot();
  }

  return Object.freeze({
    startRoom, update, completeRoom, reset, getSnapshot,
  });
}
