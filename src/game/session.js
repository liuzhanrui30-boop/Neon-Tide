import {
  isRunBuildProgressionConsistent,
  maxHullForRunBuild,
  normalizePersistedRunBuild,
  normalizeRunBuild,
} from './run-build.js';
import {
  getCampaignChapterIndex,
  getCampaignEncounter,
  getEncounterTemplate,
} from '../content/encounters.js';
import {
  CAMPAIGN_ROUTE_ROOM_COUNT,
  COMPATIBILITY_BOSS_TEMPLATE_ID,
  MAX_CAMPAIGN_CHAPTER_INDEX,
  createAuthoredRunRoute,
  createCampaignRunRoute,
  createCompatibilityRunRoute,
  createNextStandardRunRoute,
  normalizeRunRoute,
} from './run-route.js';
import {
  createCampaign,
  getCampaignCheckpointContract,
  getCampaignNode,
  isCampaignChapterEntry,
} from './campaign.js';
import { createEncounterDirector } from '../systems/encounter-director.js';
import {
  applyUpgradeChoice,
  attachPendingOffer,
  createUpgradeBuild,
  deriveUpgradeOfferSeed,
  deriveBuildStats,
} from '../systems/upgrade-system.js';

export const GAME_SESSION_MODES = Object.freeze([
  'menu',
  'briefing',
  'playing',
  'upgrade',
  'paused',
  'chapterComplete',
  'victory',
  'defeat',
]);

const RUN_MODES = new Set(['standard', 'abyss']);
const MODE_SET = new Set(GAME_SESSION_MODES);
const MAX_SESSION_STAT = 1_000_000_000;
const ALLOWED_TRANSITIONS = Object.freeze({
  menu: new Set(['briefing']),
  briefing: new Set(['playing', 'upgrade', 'menu']),
  playing: new Set(['upgrade', 'paused', 'chapterComplete', 'victory', 'defeat', 'menu']),
  upgrade: new Set(['playing', 'defeat', 'menu']),
  paused: new Set(['playing', 'defeat', 'menu']),
  chapterComplete: new Set(['briefing', 'playing', 'victory', 'menu']),
  victory: new Set(['briefing', 'menu']),
  defeat: new Set(['briefing', 'menu']),
});

function cloneValue(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneValue);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)]));
}

function cloneFrozen(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(cloneFrozen));
  return Object.freeze(Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, cloneFrozen(entry)]),
  ));
}

function createStats() {
  return {
    roomsStarted: 0,
    roomsCompleted: 0,
    damageTaken: 0,
    score: 0,
  };
}

function isSessionStats(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Number.isInteger(value.roomsStarted) && value.roomsStarted >= 0
    && value.roomsStarted <= MAX_SESSION_STAT
    && Number.isInteger(value.roomsCompleted) && value.roomsCompleted >= 0
    && value.roomsCompleted <= MAX_SESSION_STAT
    && value.roomsCompleted <= value.roomsStarted
    && Number.isFinite(value.damageTaken) && value.damageTaken >= 0 && value.damageTaken <= MAX_SESSION_STAT
    && Number.isFinite(value.score) && value.score >= 0 && value.score <= MAX_SESSION_STAT;
}

export function createGameSession(options = {}) {
  const development = options.development ?? true;
  const events = options.events ?? null;
  const onTransition = options.onTransition ?? (() => {});
  const onChange = options.onChange ?? (() => {});
  const runSave = options.runSave ?? null;
  const now = options.now ?? Date.now;
  const deterministicTestMode = options.deterministicTestMode ?? options.deterministic ?? false;
  const seedFactory = options.seedFactory ?? (() => Math.floor(Date.now() + Math.random() * 0x7fffffff));
  const encounterQuality = options.encounterQuality ?? options.quality ?? 'desktop';
  const encounterDurationScale = options.encounterDurationScale ?? 1;
  // Historical/test callers keep the authored route unless they explicitly
  // opt into the 3.0 campaign. Production bootstrap always passes campaign.
  const initialRouteKind = options.initialRouteKind ?? 'authored';
  const deterministicCampaignTest = development && options.deterministicCampaignTest === true;
  const campaignTestAuthority = options.campaignTestAuthority ?? null;
  const objectiveAuthority = options.objectiveAuthority ?? null;
  const encounterDirectorFactory = options.encounterDirectorFactory
    ?? ((configuration) => createEncounterDirector(configuration));
  const baseMaxHull = options.maxHull ?? 3;
  if (!Number.isFinite(baseMaxHull) || baseMaxHull <= 0) throw new TypeError('maxHull must be positive and finite');
  if (events && typeof events.emit !== 'function') throw new TypeError('events must expose emit(type, payload)');
  if (typeof onTransition !== 'function') throw new TypeError('onTransition must be a function');
  if (typeof onChange !== 'function') throw new TypeError('onChange must be a function');
  if (runSave && (typeof runSave.save !== 'function' || typeof runSave.load !== 'function' || typeof runSave.clear !== 'function')) {
    throw new TypeError('runSave must expose save(checkpoint), load(), and clear()');
  }
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (typeof seedFactory !== 'function') throw new TypeError('seedFactory must be a function');
  if (typeof encounterDirectorFactory !== 'function') throw new TypeError('encounterDirectorFactory must be a function');
  if (!['campaign', 'authored', 'compatibility'].includes(initialRouteKind)) {
    throw new TypeError('initialRouteKind must be campaign, authored, or compatibility');
  }
  if (campaignTestAuthority !== null
    && (!campaignTestAuthority || typeof campaignTestAuthority !== 'object' || Array.isArray(campaignTestAuthority))) {
    throw new TypeError('campaignTestAuthority must be an internal channel object');
  }
  if (objectiveAuthority !== null && (!objectiveAuthority || typeof objectiveAuthority !== 'object' || Array.isArray(objectiveAuthority))) {
    throw new TypeError('objectiveAuthority must be an internal channel object');
  }

  let directorAuthority = null;
  let directorTestAuthority = null;
  function createDirector(configuration) {
    directorAuthority = {};
    directorTestAuthority = deterministicCampaignTest ? {} : null;
    return encounterDirectorFactory({
      ...configuration,
      objectiveAuthority: directorAuthority,
      deterministicTestAuthority: directorTestAuthority,
    });
  }
  let activeCampaign = createCampaign(0, 'standard');
  let encounterDirector = createDirector({
    mode: 'standard', quality: encounterQuality, seed: 0, durationScale: encounterDurationScale,
  });
  if (!encounterDirector || typeof encounterDirector.startRoom !== 'function' || typeof encounterDirector.update !== 'function'
    || typeof encounterDirector.completeRoom !== 'function' || typeof encounterDirector.reset !== 'function'
    || typeof encounterDirector.getSnapshot !== 'function' || typeof directorAuthority.visit !== 'function') {
    throw new TypeError('encounterDirectorFactory must return an encounter director');
  }
  if (objectiveAuthority) {
    Object.defineProperty(objectiveAuthority, 'visit', {
      configurable: true,
      value(visitor) {
        if (typeof visitor !== 'function') throw new TypeError('objective authority visitor must be a function');
        return directorAuthority.visit(visitor);
      },
    });
  }

  let state = {
    mode: 'menu',
    runMode: null,
    seed: null,
    chapterIndex: 0,
    route: null,
    room: null,
    build: createUpgradeBuild(),
    hull: baseMaxHull,
    maxHull: baseMaxHull,
    stats: createStats(),
    terminalReason: null,
    revision: 0,
  };
  let objectivePublishElapsed = 0;
  let lastObjectivePublishKey = null;
  let buildRevision = 0;
  let cachedBuildStats = deriveBuildStats(state.build);
  const campaignSettlementAuthority = Symbol('campaign-settlement-authority');
  let campaignCompletionGrant = null;

  function assignBuild(build) {
    state.build = createUpgradeBuild(build);
    cachedBuildStats = deriveBuildStats(state.build);
    buildRevision += 1;
    return state.build;
  }

  function snapshot() {
    return Object.freeze({
      mode: state.mode,
      runMode: state.runMode,
      seed: state.seed,
      chapterIndex: state.chapterIndex,
      route: cloneFrozen(state.route),
      room: cloneFrozen(state.room),
      build: cloneFrozen(state.build),
      hull: state.hull,
      maxHull: state.maxHull,
      stats: cloneFrozen(state.stats),
      terminalReason: state.terminalReason,
      revision: state.revision,
    });
  }

  function invalid(nextMode) {
    const message = `Invalid GameSession transition ${state.mode} -> ${nextMode}`;
    if (development) throw new Error(message);
    return false;
  }

  function publishTransition(previous, nextMode, detail = {}, beforeNotify = null) {
    state.mode = nextMode;
    state.revision += 1;
    const current = snapshot();
    // The checkpoint is part of committing a chapter boundary. Write it before
    // callbacks can synchronously start the following room.
    beforeNotify?.(current);
    const transitionRecord = Object.freeze({ previous, current, detail: cloneValue(detail) });
    events?.emit('session:transition', transitionRecord);
    onTransition(transitionRecord);
    onChange(transitionRecord);
    return true;
  }

  function transition(nextMode, detail = {}, beforeNotify = null) {
    if (!MODE_SET.has(nextMode)) return invalid(nextMode);
    if (nextMode === 'playing' && state.build.pendingOffer) return invalid(nextMode);
    if (nextMode === state.mode || !ALLOWED_TRANSITIONS[state.mode]?.has(nextMode)) return invalid(nextMode);
    return publishTransition(snapshot(), nextMode, detail, beforeNotify);
  }

  function checkpointFromState() {
    const savedAt = now();
    if (!Number.isFinite(savedAt) || savedAt < 0) throw new TypeError('checkpoint clock must return a non-negative finite timestamp');
    if (!state.route) throw new TypeError('checkpoint route provenance is unavailable');
    return {
      version: 2,
      mode: 'standard',
      seed: state.seed,
      chapterIndex: state.route.chapterIndex,
      route: cloneValue(state.route),
      build: cloneValue(state.build),
      hull: state.hull,
      stats: cloneValue(state.stats),
      savedAt,
    };
  }

  function saveProgressCheckpoint({ emit = true } = {}) {
    if (state.runMode !== 'standard' || !['upgrade', 'chapterComplete'].includes(state.mode) || !runSave) return false;
    if (state.route?.kind === 'campaign' && !isCampaignChapterEntry(activeCampaign, state.route.roomIndex)) return false;
    const checkpoint = checkpointFromState();
    const saved = runSave.save(checkpoint);
    if (saved && emit) events?.emit('session:checkpoint-saved', { checkpoint: cloneValue(checkpoint) });
    return saved ? checkpoint : null;
  }

  function maxHullFromBuild(build) {
    return maxHullForRunBuild(build, baseMaxHull);
  }

  function isExactCampaignCheckpoint(checkpoint) {
    if (checkpoint?.route?.kind !== 'campaign') return true;
    const expected = getCampaignCheckpointContract(checkpoint.route.roomIndex);
    const build = normalizePersistedRunBuild(checkpoint.build);
    if (!expected || !build
      || checkpoint.chapterIndex !== expected.chapterIndex
      || checkpoint.route.chapterIndex !== expected.chapterIndex
      || checkpoint.stats?.roomsStarted !== checkpoint.route.roomIndex
      || checkpoint.stats?.roomsCompleted !== checkpoint.route.roomIndex
      || build.offerSequence !== expected.offerSequence) return false;
    const selectedStacks = Object.values(build.upgradeStacks)
      .reduce((total, stack) => total + stack, 0);
    return build.pendingOffer
      ? build.pendingOffer.rewardKind === 'boss' && selectedStacks === expected.offerSequence - 1
      : selectedStacks === expected.offerSequence;
  }

  function isCheckpoint(checkpoint) {
    return checkpoint
      && checkpoint.version === 2
      && checkpoint.mode === 'standard'
      && Number.isFinite(checkpoint.seed)
      && Number.isInteger(checkpoint.chapterIndex) && checkpoint.chapterIndex >= 0
      && checkpoint.chapterIndex <= MAX_CAMPAIGN_CHAPTER_INDEX
      && normalizePersistedRunBuild(checkpoint.build)
      && Number.isFinite(checkpoint.hull) && checkpoint.hull > 0
      && isSessionStats(checkpoint.stats)
      && checkpoint.stats.roomsStarted === checkpoint.stats.roomsCompleted
      && checkpoint.stats.roomsCompleted >= 1
      && checkpoint.chapterIndex <= checkpoint.stats.roomsCompleted
      && isRunBuildProgressionConsistent(checkpoint.build, checkpoint.stats, checkpoint.seed)
      && isExactCampaignCheckpoint(checkpoint)
      && normalizeRunRoute(checkpoint.route, {
        seed: checkpoint.seed,
        stats: checkpoint.stats,
        chapterIndex: checkpoint.chapterIndex,
      })
      && Number.isFinite(checkpoint.savedAt) && checkpoint.savedAt >= 0;
  }

  function restoreCheckpoint(checkpoint = runSave?.load()) {
    if (!isCheckpoint(checkpoint) || !['menu', 'defeat'].includes(state.mode)) return false;
    const normalizedBuild = normalizePersistedRunBuild(checkpoint.build);
    if (normalizedBuild?.pendingOffer) {
      const previousSequence = normalizedBuild.offerSequence - 1;
      const expectedSeed = deriveUpgradeOfferSeed(checkpoint.seed, checkpoint.stats.roomsCompleted, previousSequence);
      if (previousSequence < 0 || normalizedBuild.pendingOffer.seed !== expectedSeed) {
        runSave?.clear({ corruption: true });
        return false;
      }
    }
    const restoredMaxHull = maxHullFromBuild(normalizedBuild);
    if (!normalizedBuild || !Number.isFinite(restoredMaxHull) || checkpoint.hull > restoredMaxHull) {
      runSave?.clear({ corruption: true });
      return false;
    }
    const previous = snapshot();
    state.runMode = 'standard';
    state.seed = checkpoint.seed;
    activeCampaign = createCampaign(checkpoint.seed, 'standard');
    state.chapterIndex = checkpoint.chapterIndex;
    state.route = normalizeRunRoute(checkpoint.route, {
      seed: checkpoint.seed,
      stats: checkpoint.stats,
      chapterIndex: checkpoint.chapterIndex,
    });
    state.room = null;
    assignBuild(normalizedBuild);
    state.maxHull = restoredMaxHull;
    state.hull = Math.min(state.maxHull, checkpoint.hull);
    state.stats = cloneValue(checkpoint.stats);
    state.terminalReason = null;
    campaignCompletionGrant = null;
    encounterDirector.reset(events);
    encounterDirector = createDirector({
      mode: 'standard', quality: encounterQuality, seed: checkpoint.seed, roomIndex: checkpoint.stats.roomsStarted,
      durationScale: encounterDurationScale,
      pressure: state.route?.kind === 'campaign' ? activeCampaign.pressure : null,
    });
    const restored = publishTransition(previous, 'briefing', {
      checkpointRestored: true,
      chapterIndex: state.chapterIndex,
    });
    if (restored) events?.emit('session:checkpoint-restored', { checkpoint: cloneValue(checkpoint) });
    return restored;
  }

  function restartAbyssAfterDefeat() {
    if (state.runMode !== 'abyss') return false;
    runSave?.clear();
    const selectedSeed = state.seed;
    const candidate = deterministicTestMode ? selectedSeed : seedFactory();
    const nextSeed = deterministicTestMode
      ? selectedSeed
      : Number.isFinite(candidate) && candidate !== selectedSeed
        ? candidate
        : selectedSeed + 1;
    return startRun('abyss', nextSeed);
  }

  function applyDefeatRule() {
    if (state.runMode === 'standard') {
      if (restoreCheckpoint()) return true;
      // Chapter zero intentionally has no persistent checkpoint. Its legal
      // entry state is the selected starter with no chapter-earned upgrades,
      // so Standard retries reconstruct that exact entry instead of inventing
      // a midpoint save or leaving the player stranded on Defeat.
      if (state.route?.kind === 'campaign' && state.chapterIndex === 0) {
        return startRun('standard', state.seed);
      }
      return false;
    }
    if (state.runMode === 'abyss') return restartAbyssAfterDefeat();
    return false;
  }

  function startRun(runMode, seed) {
    if (!RUN_MODES.has(runMode)) throw new TypeError('run mode must be standard or abyss');
    if (!Number.isFinite(seed)) throw new TypeError('run seed must be a finite seed');
    if (!['menu', 'victory', 'defeat'].includes(state.mode)) return invalid('briefing');
    state.runMode = runMode;
    state.seed = seed;
    state.chapterIndex = 0;
    activeCampaign = createCampaign(seed, runMode);
    state.route = initialRouteKind === 'campaign'
      ? createCampaignRunRoute(0, seed, runMode)
      : initialRouteKind === 'authored'
        ? createNextStandardRunRoute(0, seed)
        : createCompatibilityRunRoute({
          roomIndex: 0,
          chapterIndex: 0,
          templateId: 'v2.2-compatibility-chapter-0',
        });
    state.room = null;
    const starterWeapon = state.build?.starterWeapon ?? 'pulse-cannon';
    assignBuild({ starterWeapon });
    state.hull = baseMaxHull;
    state.maxHull = baseMaxHull;
    state.stats = createStats();
    state.terminalReason = null;
    campaignCompletionGrant = null;
    encounterDirector.reset(events);
    encounterDirector = createDirector({
      mode: runMode, quality: encounterQuality, seed, durationScale: encounterDurationScale,
      pressure: state.route.kind === 'campaign' ? activeCampaign.pressure : null,
    });
    // A new attempt must never inherit an older Standard checkpoint. Abyss
    // additionally guarantees that it cannot expose a stale Continue path.
    runSave?.clear();
    events?.clear?.();
    const changed = transition('briefing', { runMode, seed });
    if (changed) events?.emit('session:started', { runMode, seed });
    return changed;
  }

  function startRoom(room) {
    if (!room || typeof room !== 'object' || Array.isArray(room)) throw new TypeError('room must be a room object');
    if (!['briefing', 'upgrade', 'chapterComplete'].includes(state.mode)) return invalid('playing');
    if (state.build.pendingOffer) return invalid('playing');
    const routeRoomIndex = state.stats.roomsStarted;
    const compatibility = room.compatibility === true;
    // Requests without nodeId are the exact Task 7–10 authored compatibility contract.
    // New 3.0 routes always carry the deterministic node id.
    const campaignRequest = room.campaign === true && typeof room.nodeId === 'string';
    const legacyAuthored = room.legacyAuthored === true
      || (state.route?.kind === 'authored' && !compatibility && !campaignRequest);
    const requestKind = campaignRequest
      ? 'campaign'
      : compatibility
        ? 'compatibility'
        : legacyAuthored
          ? 'authored'
          : null;
    const authoredCompatibilityHandoff = requestKind === 'compatibility' && state.route?.kind === 'authored';
    if (requestKind !== state.route?.kind && !authoredCompatibilityHandoff) {
      throw new TypeError(`room request type does not match authoritative ${state.route?.kind ?? 'missing'} route`);
    }
    let campaignNode = null;
    let authoredTemplate = null;
    let encounterChapterIndex = state.chapterIndex;

    if (campaignRequest) {
      if (state.route?.kind !== 'campaign' || state.route.roomIndex !== routeRoomIndex) {
        throw new TypeError('campaign room request does not match the authoritative route');
      }
      campaignNode = getCampaignNode(activeCampaign, routeRoomIndex);
      if (!campaignNode || room.nodeId !== campaignNode.id || room.chapterIndex !== campaignNode.chapterIndex) {
        throw new TypeError('campaign room request does not match the deterministic node');
      }
      authoredTemplate = getEncounterTemplate(campaignNode.objectiveTemplate);
      encounterChapterIndex = campaignNode.chapterIndex;
    } else if (legacyAuthored) {
      const authoritativeRequest = room.legacyAuthored === true || room.campaign === true;
      authoredTemplate = getEncounterTemplate(authoritativeRequest
        ? room.objectiveTemplate ?? state.route?.templateId
        : room) ?? getEncounterTemplate(state.route?.templateId);
      encounterChapterIndex = state.route.chapterIndex;
    } else if (!compatibility) {
      authoredTemplate = getEncounterTemplate(room)
        ?? getCampaignEncounter(state.stats.roomsStarted, { mode: state.runMode, seed: state.seed });
      encounterChapterIndex = getCampaignChapterIndex(state.stats.roomsStarted);
    }

    const compatibilityTemplate = authoredTemplate ?? {
      ...getCampaignEncounter(state.stats.roomsStarted),
      id: String(room.id ?? `room-${state.stats.roomsStarted + 1}`),
      label: room.label ?? '清剿当前威胁',
      type: 'purge',
      killTarget: 1_000_000,
      timeout: 1_000_000,
    };
    if (compatibility) {
      encounterChapterIndex = Number.isInteger(room.chapterIndex) ? room.chapterIndex : state.chapterIndex;
    }
    if (!Number.isInteger(encounterChapterIndex)
      || encounterChapterIndex < 0
      || encounterChapterIndex > MAX_CAMPAIGN_CHAPTER_INDEX) {
      throw new TypeError('room chapter index is outside the campaign');
    }
    const timing = campaignNode ? {
      kind: campaignNode.kind,
      targetDurationSeconds: campaignNode.targetDurationSeconds,
    } : null;
    const boss = campaignNode?.kind === 'boss' ? {
      id: campaignNode.bossId,
      label: campaignNode.bossLabel,
      targetDurationSeconds: campaignNode.targetDurationSeconds,
      recoveryMultiplier: activeCampaign.pressure.bossRecovery,
      variantCount: activeCampaign.pressure.bossVariantCount,
      telegraphFloorSeconds: activeCampaign.pressure.telegraphFloorSeconds,
    } : null;
    const encounter = encounterDirector.startRoom(compatibilityTemplate, {
      chapterIndex: encounterChapterIndex,
      timing,
      boss,
      campaign: campaignNode ? {
        chapterId: campaignNode.chapterId,
        nodeId: campaignNode.id,
        roomIndex: campaignNode.roomIndex,
        routeIndex: campaignNode.routeIndex,
        kind: campaignNode.kind,
      } : null,
    });
    campaignCompletionGrant = null;
    state.route = campaignRequest
      ? createCampaignRunRoute(routeRoomIndex, state.seed, state.runMode)
      : compatibility
        ? createCompatibilityRunRoute({
          roomIndex: routeRoomIndex,
          chapterIndex: encounterChapterIndex,
          templateId: String(room.id ?? `v2.2-compatibility-chapter-${encounterChapterIndex}`),
        })
        : createAuthoredRunRoute(routeRoomIndex, state.seed);
    state.room = {
      ...cloneValue(room),
      ...(campaignNode ? cloneValue(campaignNode) : {}),
      templateId: authoredTemplate?.id ?? compatibilityTemplate.id,
      objectiveManaged: !compatibility,
      objective: cloneValue(encounter.objective),
      threatBudget: cloneValue(encounter.threatBudget),
      pressure: cloneValue(encounter.pressure),
      timing: cloneValue(encounter.timing),
      boss: cloneValue(encounter.boss),
      bossBehavior: cloneValue(encounter.bossBehavior),
      encounterPhase: encounter.phase,
      combatFrozen: encounter.combatFrozen,
    };
    objectivePublishElapsed = 0;
    lastObjectivePublishKey = null;
    state.chapterIndex = encounterChapterIndex;
    state.stats.roomsStarted += 1;
    const changed = transition('playing', { room: state.room });
    if (changed) events?.emit('room:started', { room: cloneValue(state.room), chapterIndex: state.chapterIndex });
    return changed;
  }

  function updateRoom(context = {}, dt = 0, objectiveEvents = null) {
    if (state.mode !== 'playing' || !state.room) return false;
    const update = encounterDirector.update(context, dt, objectiveEvents);
    let liveObjective = null;
    directorAuthority.visit((objective) => { liveObjective = objective; });
    objectivePublishElapsed += Math.max(0, Number(dt) || 0);
    const publishKey = `${update.phase}:${liveObjective?.status}:${Math.floor((liveObjective?.progressRatio ?? 0) * 20)}:${Math.floor(liveObjective?.timeoutRemaining ?? 0)}`;
    const shouldPublish = update.changed || publishKey !== lastObjectivePublishKey || objectivePublishElapsed >= 0.25;
    let current = null;
    if (shouldPublish) {
      const encounter = encounterDirector.getSnapshot();
      const previous = snapshot();
      state.room.objective = cloneValue(encounter.objective);
      state.room.threatBudget = cloneValue(encounter.threatBudget);
      state.room.pressure = cloneValue(encounter.pressure);
      state.room.timing = cloneValue(encounter.timing);
      state.room.boss = cloneValue(encounter.boss);
      state.room.bossBehavior = cloneValue(encounter.bossBehavior);
      state.room.encounterPhase = encounter.phase;
      state.room.combatFrozen = encounter.combatFrozen;
      state.revision += 1;
      current = snapshot();
      const changeRecord = Object.freeze({ previous, current, detail: Object.freeze({ objectiveUpdated: true }) });
      events?.emit('session:changed', changeRecord);
      onChange(changeRecord);
      objectivePublishElapsed = 0;
      lastObjectivePublishKey = publishKey;
    }
    if (update.phase === 'failed') {
      return completeRoom(
        { outcome: 'defeat', reason: liveObjective?.failureReason ?? 'objectiveFailed' },
        campaignSettlementAuthority,
      );
    }
    if (update.phase === 'complete' && encounterDirector.completeRoom()) {
      if (state.route?.kind === 'campaign') {
        campaignCompletionGrant = Object.freeze({
          roomIndex: state.route.roomIndex,
          roomsStarted: state.stats.roomsStarted,
        });
      }
      return state.route?.kind === 'campaign'
        ? completeRoom(
          { objective: cloneValue(liveObjective), score: 100 },
          campaignSettlementAuthority,
        )
        : completeRoom({ nextMode: 'upgrade', objective: cloneValue(liveObjective), score: 100 });
    }
    return current ?? update;
  }

  function pause() {
    if (state.mode !== 'playing') return invalid('paused');
    return transition('paused');
  }

  function resume() {
    if (state.mode !== 'paused') return invalid('playing');
    return transition('playing', { resumed: true });
  }

  function completeRoom(result = {}, authority = null) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TypeError('result must be an object');
    if (state.mode !== 'playing') {
      const requested = result.outcome === 'victory' ? 'victory' : result.outcome === 'defeat' ? 'defeat' : result.nextMode ?? 'chapterComplete';
      return invalid(requested);
    }
    const completedRoute = state.route;
    const campaignNode = completedRoute?.kind === 'campaign'
      ? getCampaignNode(activeCampaign, completedRoute.roomIndex)
      : null;
    if (campaignNode && (Object.hasOwn(result, 'nextMode')
      || Object.hasOwn(result, 'chapterIndex')
      || Object.hasOwn(result, 'rewardKind')
      || Object.hasOwn(result, 'bossCore')
      || result.outcome === 'victory')) {
      throw new TypeError('campaign completion is authoritative and cannot be overridden by callers');
    }
    if (campaignNode && authority !== campaignSettlementAuthority) {
      throw new TypeError('natural campaign completion authorization is required');
    }
    if (campaignNode && result.outcome !== 'defeat') {
      const grant = campaignCompletionGrant;
      campaignCompletionGrant = null;
      if (!grant
        || grant.roomIndex !== completedRoute.roomIndex
        || grant.roomsStarted !== state.stats.roomsStarted) {
        throw new TypeError('natural campaign completion authorization is invalid or already consumed');
      }
    }
    const inferredCampaignMode = campaignNode
      ? completedRoute.roomIndex === CAMPAIGN_ROUTE_ROOM_COUNT - 1
        ? 'victory'
        : campaignNode.rewardKind
          ? 'upgrade'
          : 'chapterComplete'
      : 'chapterComplete';
    const nextMode = result.outcome === 'victory'
      ? 'victory'
      : result.outcome === 'defeat'
        ? 'defeat'
        : result.nextMode ?? inferredCampaignMode;
    if (!['upgrade', 'chapterComplete', 'victory', 'defeat'].includes(nextMode)) {
      throw new TypeError('room completion nextMode must be upgrade, chapterComplete, victory, or defeat');
    }
    if (Object.hasOwn(result, 'chapterIndex')
      && (!Number.isInteger(result.chapterIndex)
        || result.chapterIndex < 0
        || result.chapterIndex > MAX_CAMPAIGN_CHAPTER_INDEX)) {
      throw new TypeError('room completion chapter index is outside the campaign');
    }
    if (nextMode !== 'defeat') state.stats.roomsCompleted += 1;
    if (nextMode !== 'defeat' && Number.isFinite(result.score)) state.stats.score += result.score;
    if (nextMode !== 'defeat' && cachedBuildStats.roomRepair > 0) {
      state.hull = Math.min(state.maxHull, state.hull + cachedBuildStats.roomRepair);
    }
    if (nextMode === 'victory' || nextMode === 'defeat') state.terminalReason = result.reason ?? nextMode;
    if (nextMode === 'defeat') state.hull = 0;
    if (nextMode === 'upgrade') {
      const offerSeed = deriveUpgradeOfferSeed(state.seed, state.stats.roomsCompleted, state.build.offerSequence);
      assignBuild(attachPendingOffer(
        state.build,
        offerSeed,
        result.rewardKind === 'boss' || result.bossCore || campaignNode?.rewardKind === 'boss' ? 'boss' : 'normal',
      ));
    }
    if (nextMode === 'upgrade' || nextMode === 'chapterComplete') {
      if (completedRoute?.kind === 'campaign') {
        if (state.stats.roomsStarted >= CAMPAIGN_ROUTE_ROOM_COUNT) {
          throw new Error('campaign route advanced beyond the final node');
        }
        state.route = createCampaignRunRoute(state.stats.roomsStarted, state.seed, state.runMode);
      } else if (completedRoute?.kind === 'compatibility') {
        const nextChapter = Number.isInteger(result.chapterIndex)
          ? result.chapterIndex
          : completedRoute.chapterIndex;
        const templateId = nextChapter === completedRoute.chapterIndex
          ? completedRoute.templateId
          : nextChapter === 3
            ? COMPATIBILITY_BOSS_TEMPLATE_ID
            : `v2.2-compatibility-chapter-${nextChapter}`;
        state.route = createCompatibilityRunRoute({
          roomIndex: state.stats.roomsStarted,
          chapterIndex: nextChapter,
          templateId,
        });
      } else {
        state.route = createNextStandardRunRoute(state.stats.roomsStarted, state.seed);
      }
      state.chapterIndex = state.route.chapterIndex;
    }
    let checkpoint = null;
    const changed = transition(
      nextMode,
      { result: cloneValue(result) },
      ['upgrade', 'chapterComplete'].includes(nextMode)
        ? () => { checkpoint = saveProgressCheckpoint({ emit: false }); }
        : null,
    );
    if (changed) events?.emit('room:completed', { result: cloneValue(result), nextMode });
    if (checkpoint) events?.emit('session:checkpoint-saved', { checkpoint: cloneValue(checkpoint) });
    if (changed && nextMode === 'victory') runSave?.clear();
    if (changed && nextMode === 'defeat') applyDefeatRule();
    return changed;
  }

  function damageHull(amount) {
    if (!Number.isFinite(amount) || amount < 0) throw new TypeError('damage amount must be non-negative finite');
    if (!['playing', 'paused', 'upgrade'].includes(state.mode)) return invalid(state.mode === 'defeat' ? 'defeat' : 'defeat');
    const previous = snapshot();
    const applied = Math.min(state.hull, amount);
    state.hull = Math.max(0, state.hull - amount);
    state.stats.damageTaken += applied;
    state.revision += 1;
    events?.emit('session:hull-damaged', { amount: applied, hull: state.hull, maxHull: state.maxHull });
    const changeRecord = Object.freeze({
      previous,
      current: snapshot(),
      detail: Object.freeze({ hullDamage: applied }),
    });
    events?.emit('session:changed', changeRecord);
    onChange(changeRecord);
    if (state.hull <= 0) {
      state.terminalReason = 'hullBreach';
      const defeated = transition('defeat', { reason: 'hullBreach' });
      if (defeated) applyDefeatRule();
      return defeated;
    }
    return true;
  }

  function upgradeHullCapacity(requestedMaxHull, { repair = 0 } = {}) {
    if (!Number.isFinite(requestedMaxHull) || requestedMaxHull <= 0) {
      throw new TypeError('maxHull must be positive and finite');
    }
    if (!Number.isFinite(repair) || repair < 0) throw new TypeError('repair must be non-negative and finite');
    if (!['playing', 'paused', 'upgrade'].includes(state.mode)) return invalid('playing');
    if (requestedMaxHull < state.maxHull) throw new TypeError('hull capacity upgrades cannot reduce maxHull');
    const previous = snapshot();
    state.maxHull = requestedMaxHull;
    state.hull = Math.min(state.maxHull, state.hull + repair);
    state.revision += 1;
    const changeRecord = Object.freeze({
      previous,
      current: snapshot(),
      detail: Object.freeze({ hullCapacityUpgrade: Object.freeze({ maxHull: requestedMaxHull, repair }) }),
    });
    events?.emit('session:changed', changeRecord);
    onChange(changeRecord);
    return true;
  }

  function setBuild(build) {
    const normalizedBuild = normalizeRunBuild(build);
    if (!normalizedBuild) throw new TypeError('build must contain unique known upgrade IDs');
    if (!['menu', 'briefing'].includes(state.mode)) return invalid(state.mode);
    if (state.stats.roomsStarted !== 0 || state.stats.roomsCompleted !== 0
      || state.build.pendingOffer || state.build.offerSequence !== 0 || state.build.ownedUpgrades.length !== 0) {
      throw new Error('build configuration is locked after campaign progression begins');
    }
    if (normalizedBuild.pendingOffer || normalizedBuild.offerSequence !== 0 || normalizedBuild.ownedUpgrades.length !== 0) {
      throw new TypeError('setBuild only configures a starter weapon before progression');
    }
    return setStarterWeapon(normalizedBuild.starterWeapon);
  }

  function selectUpgrade(id) {
    if (state.mode !== 'upgrade') return invalid('upgrade');
    if (typeof id !== 'string' || !state.build?.pendingOffer?.cards?.includes(id)) return false;
    const previous = snapshot();
    const beforeStats = cachedBuildStats;
    const nextBuild = applyUpgradeChoice(state.build, id);
    const nextStats = deriveBuildStats(nextBuild);
    const hullIncrease = Math.max(0, nextStats.hullBonus - beforeStats.hullBonus);
    assignBuild(nextBuild);
    state.maxHull = Math.max(state.maxHull, baseMaxHull + nextStats.hullBonus);
    state.hull = Math.min(state.maxHull, state.hull + Math.max(0, nextStats.immediateRepair - beforeStats.immediateRepair) + hullIncrease * 0);
    state.revision += 1;
    const checkpoint = saveProgressCheckpoint({ emit: false });
    const current = snapshot();
    const detail = Object.freeze({ upgradeSelected: id, stacks: nextBuild.upgradeStacks[id] });
    const changeRecord = Object.freeze({ previous, current, detail });
    events?.emit('session:upgrade-selected', detail);
    events?.emit('session:changed', changeRecord);
    onChange(changeRecord);
    if (checkpoint) events?.emit('session:checkpoint-saved', { checkpoint: cloneValue(checkpoint) });
    return true;
  }

  function setStats(stats) {
    if (!isSessionStats(stats)) throw new TypeError('stats must contain bounded finite campaign values');
    if (!['briefing', 'playing', 'paused', 'upgrade', 'chapterComplete'].includes(state.mode)) return invalid('playing');
    const previous = snapshot();
    state.stats = cloneValue(stats);
    state.revision += 1;
    const changeRecord = Object.freeze({
      previous,
      current: snapshot(),
      detail: Object.freeze({ statsChanged: true }),
    });
    events?.emit('session:changed', changeRecord);
    onChange(changeRecord);
    return true;
  }

  function setStarterWeapon(starterWeapon) {
    if (!['menu', 'briefing', 'victory', 'defeat'].includes(state.mode)) return invalid(state.mode);
    if (state.mode === 'briefing' && (state.stats.roomsStarted > 0 || state.build.pendingOffer || state.build.ownedUpgrades.length > 0)) {
      throw new Error('starter weapon is locked after campaign progression begins');
    }
    const previous = snapshot();
    assignBuild({ starterWeapon });
    state.maxHull = baseMaxHull;
    state.hull = Math.min(state.hull, state.maxHull);
    state.revision += 1;
    const current = snapshot();
    const detail = Object.freeze({ starterWeaponChanged: starterWeapon });
    const changeRecord = Object.freeze({ previous, current, detail });
    events?.emit('session:changed', changeRecord);
    onChange(changeRecord);
    return true;
  }

  function continuePendingOffer() {
    if (state.mode !== 'briefing' || !state.build.pendingOffer) return invalid('upgrade');
    return transition('upgrade', { checkpointOfferContinued: true });
  }

  function reconcileCompatibilityHull(hull, { maxHull: requestedMaxHull = state.maxHull } = {}) {
    if (!Number.isFinite(hull) || hull < 0) throw new TypeError('hull must be a non-negative finite number');
    if (!Number.isFinite(requestedMaxHull) || requestedMaxHull <= 0) {
      throw new TypeError('maxHull must be positive and finite');
    }
    if (!['playing', 'paused', 'upgrade'].includes(state.mode)) return invalid('playing');
    const previous = snapshot();
    state.maxHull = requestedMaxHull;
    state.hull = Math.min(requestedMaxHull, hull);
    if (state.hull <= 0) {
      state.terminalReason = 'hullBreach';
      const defeated = publishTransition(previous, 'defeat', {
        reason: 'hullBreach',
        hullCompatibilitySync: true,
      });
      if (defeated) applyDefeatRule();
      return defeated;
    }
    state.revision += 1;
    const changeRecord = Object.freeze({
      previous,
      current: snapshot(),
      detail: Object.freeze({ hullCompatibilitySync: true }),
    });
    events?.emit('session:changed', changeRecord);
    onChange(changeRecord);
    return true;
  }

  function reset() {
    const previous = snapshot();
    state = {
      mode: 'menu',
      runMode: null,
      seed: null,
      chapterIndex: 0,
      route: null,
      room: null,
      build: createUpgradeBuild(),
      hull: baseMaxHull,
      maxHull: baseMaxHull,
      stats: createStats(),
      terminalReason: null,
      revision: previous.revision + 1,
    };
    cachedBuildStats = deriveBuildStats(state.build);
    buildRevision += 1;
    activeCampaign = createCampaign(0, 'standard');
    campaignCompletionGrant = null;
    encounterDirector.reset(events);
    encounterDirector = createDirector({
      mode: 'standard', quality: encounterQuality, seed: 0, durationScale: encounterDurationScale,
    });
    objectivePublishElapsed = 0;
    lastObjectivePublishKey = null;
    events?.clear?.();
    const current = snapshot();
    const transitionRecord = Object.freeze({ previous, current, detail: { reset: true } });
    events?.emit('session:transition', transitionRecord);
    onTransition(transitionRecord);
    onChange(transitionRecord);
    return true;
  }

  if (deterministicCampaignTest && campaignTestAuthority) {
    Object.defineProperty(campaignTestAuthority, 'completeCurrentNode', {
      configurable: true,
      value() {
        if (state.route?.kind !== 'campaign' || state.mode !== 'playing'
          || !directorTestAuthority?.completeObjective?.()) return false;
        updateRoom({ presentationPending: 0 }, 0, null);
        updateRoom({ presentationPending: 0 }, 0, null);
        return state.mode !== 'playing';
      },
    });
  }

  return Object.freeze({
    startRun,
    startRoom,
    updateRoom,
    pause,
    resume,
    completeRoom,
    damageHull,
    upgradeHullCapacity,
    setBuild,
    setStarterWeapon,
    continuePendingOffer,
    selectUpgrade,
    setStats,
    reconcileCompatibilityHull,
    reset,
    restoreCheckpoint,
    getEncounterSnapshot: () => encounterDirector.getSnapshot(),
    getMode: () => state.mode,
    getHull: () => state.hull,
    getMaxHull: () => state.maxHull,
    getChapterIndex: () => state.chapterIndex,
    getBuildStats: () => cachedBuildStats,
    getBuildRevision: () => buildRevision,
    getEnemyTelegraphFloorSeconds: () => state.room?.boss?.telegraphFloorSeconds
      ?? state.room?.pressure?.telegraphFloorSeconds
      ?? 0.55,
    isObjectiveManaged: () => Boolean(state.room?.objectiveManaged),
    isCombatFrozen: () => Boolean(state.room?.combatFrozen),
    getPersistenceStatus: () => runSave?.getStatus?.() ?? null,
    snapshot,
  });
}
