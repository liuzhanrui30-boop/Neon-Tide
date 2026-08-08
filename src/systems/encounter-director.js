import { getEncounterTemplate, getThreatBudget } from '../content/encounters.js';
import { createObjective, getObjectiveSnapshot, updateObjective } from './objective-system.js';

function clone(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
}

function emit(events, type, payload) {
  events?.emit?.(type, Object.freeze(clone(payload)));
}

function roomSeed(seed, roomIndex, templateId) {
  let value = (Math.trunc(Number(seed) || 0) ^ Math.imul(roomIndex + 1, 0x9e3779b1)) >>> 0;
  for (const character of String(templateId)) value = Math.imul(value ^ character.charCodeAt(0), 16777619) >>> 0;
  return value;
}

export function createEncounterDirector({ mode = 'standard', quality = 'desktop', seed = 0, roomIndex: initialRoomIndex = 0 } = {}) {
  if (!['standard', 'abyss'].includes(mode)) throw new TypeError('encounter mode must be standard or abyss');
  if (!Number.isFinite(Number(seed))) throw new TypeError('encounter seed must be finite');
  if (!Number.isInteger(initialRoomIndex) || initialRoomIndex < 0) throw new TypeError('encounter roomIndex must be a non-negative integer');
  const qualityName = typeof quality === 'string' ? quality : quality?.tier ?? 'desktop';
  let roomIndex = initialRoomIndex;
  let phase = 'idle';
  let objective = null;
  let templateId = null;
  let threatBudget = null;
  let combatFrozen = false;
  let upgradeOffered = false;
  let completionAcknowledged = false;

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
      threatBudget: threatBudget ? Object.freeze(clone(threatBudget)) : null,
      templateId,
    });
  }

  function startRoom(templateValue) {
    const template = getEncounterTemplate(templateValue);
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
    return getSnapshot();
  }

  function update(context = {}, dt = 0, events = null) {
    if (phase === 'idle' || completionAcknowledged) return getSnapshot();
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
    return getSnapshot();
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
    return getSnapshot();
  }

  return Object.freeze({ startRoom, update, completeRoom, reset, getSnapshot });
}
