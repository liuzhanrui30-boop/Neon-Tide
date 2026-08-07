import { maxHullForRunBuild, normalizeRunBuild } from './run-build.js';

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
const ALLOWED_TRANSITIONS = Object.freeze({
  menu: new Set(['briefing']),
  briefing: new Set(['playing', 'menu']),
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
    && Number.isInteger(value.roomsCompleted) && value.roomsCompleted >= 0
    && value.roomsCompleted <= value.roomsStarted
    && Number.isFinite(value.damageTaken) && value.damageTaken >= 0 && value.damageTaken <= 1_000_000_000
    && Number.isFinite(value.score) && value.score >= 0 && value.score <= 1_000_000_000;
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

  let state = {
    mode: 'menu',
    runMode: null,
    seed: null,
    chapterIndex: 0,
    room: null,
    build: { ownedUpgrades: [] },
    hull: baseMaxHull,
    maxHull: baseMaxHull,
    stats: createStats(),
    terminalReason: null,
    revision: 0,
  };

  function snapshot() {
    return Object.freeze({
      mode: state.mode,
      runMode: state.runMode,
      seed: state.seed,
      chapterIndex: state.chapterIndex,
      room: cloneValue(state.room),
      build: cloneValue(state.build),
      hull: state.hull,
      maxHull: state.maxHull,
      stats: Object.freeze(cloneValue(state.stats)),
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
    if (nextMode === state.mode || !ALLOWED_TRANSITIONS[state.mode]?.has(nextMode)) return invalid(nextMode);
    return publishTransition(snapshot(), nextMode, detail, beforeNotify);
  }

  function checkpointFromState() {
    const savedAt = now();
    if (!Number.isFinite(savedAt) || savedAt < 0) throw new TypeError('checkpoint clock must return a non-negative finite timestamp');
    return {
      version: 1,
      mode: 'standard',
      seed: state.seed,
      chapterIndex: state.chapterIndex,
      build: cloneValue(state.build),
      hull: state.hull,
      stats: cloneValue(state.stats),
      savedAt,
    };
  }

  function saveChapterCheckpoint({ emit = true } = {}) {
    if (state.runMode !== 'standard' || state.mode !== 'chapterComplete' || !runSave) return false;
    const checkpoint = checkpointFromState();
    const saved = runSave.save(checkpoint);
    if (saved && emit) events?.emit('session:checkpoint-saved', { checkpoint: cloneValue(checkpoint) });
    return saved ? checkpoint : null;
  }

  function maxHullFromBuild(build) {
    return maxHullForRunBuild(build, baseMaxHull);
  }

  function isCheckpoint(checkpoint) {
    return checkpoint
      && checkpoint.version === 1
      && checkpoint.mode === 'standard'
      && Number.isFinite(checkpoint.seed)
      && Number.isInteger(checkpoint.chapterIndex) && checkpoint.chapterIndex >= 0
      && normalizeRunBuild(checkpoint.build)
      && Number.isFinite(checkpoint.hull) && checkpoint.hull > 0
      && isSessionStats(checkpoint.stats)
      && Number.isFinite(checkpoint.savedAt) && checkpoint.savedAt >= 0;
  }

  function restoreCheckpoint(checkpoint = runSave?.load()) {
    if (!isCheckpoint(checkpoint) || !['menu', 'defeat'].includes(state.mode)) return false;
    const normalizedBuild = normalizeRunBuild(checkpoint.build);
    const restoredMaxHull = maxHullFromBuild(normalizedBuild);
    if (!normalizedBuild || !Number.isFinite(restoredMaxHull) || checkpoint.hull > restoredMaxHull) {
      runSave?.clear({ corruption: true });
      return false;
    }
    const previous = snapshot();
    state.runMode = 'standard';
    state.seed = checkpoint.seed;
    state.chapterIndex = checkpoint.chapterIndex;
    state.room = null;
    state.build = cloneValue(normalizedBuild);
    state.maxHull = restoredMaxHull;
    state.hull = Math.min(state.maxHull, checkpoint.hull);
    state.stats = cloneValue(checkpoint.stats);
    state.terminalReason = null;
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
    if (state.runMode === 'standard') return restoreCheckpoint();
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
    state.room = null;
    state.build = { ownedUpgrades: [] };
    state.hull = baseMaxHull;
    state.maxHull = baseMaxHull;
    state.stats = createStats();
    state.terminalReason = null;
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
    state.room = cloneValue(room);
    if (Number.isInteger(room.chapterIndex) && room.chapterIndex >= 0) state.chapterIndex = room.chapterIndex;
    state.stats.roomsStarted += 1;
    const changed = transition('playing', { room: state.room });
    if (changed) events?.emit('room:started', { room: cloneValue(state.room), chapterIndex: state.chapterIndex });
    return changed;
  }

  function pause() {
    if (state.mode !== 'playing') return invalid('paused');
    return transition('paused');
  }

  function resume() {
    if (state.mode !== 'paused') return invalid('playing');
    return transition('playing', { resumed: true });
  }

  function completeRoom(result = {}) {
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TypeError('result must be an object');
    if (state.mode !== 'playing') {
      const requested = result.outcome === 'victory' ? 'victory' : result.outcome === 'defeat' ? 'defeat' : result.nextMode ?? 'chapterComplete';
      return invalid(requested);
    }
    state.stats.roomsCompleted += 1;
    if (Number.isFinite(result.score)) state.stats.score += result.score;
    if (Number.isInteger(result.chapterIndex) && result.chapterIndex >= 0) state.chapterIndex = result.chapterIndex;
    const nextMode = result.outcome === 'victory'
      ? 'victory'
      : result.outcome === 'defeat'
        ? 'defeat'
        : result.nextMode ?? 'chapterComplete';
    if (!['upgrade', 'chapterComplete', 'victory', 'defeat'].includes(nextMode)) {
      throw new TypeError('room completion nextMode must be upgrade, chapterComplete, victory, or defeat');
    }
    if (nextMode === 'victory' || nextMode === 'defeat') state.terminalReason = result.reason ?? nextMode;
    if (nextMode === 'defeat') state.hull = 0;
    let checkpoint = null;
    const changed = transition(
      nextMode,
      { result: cloneValue(result) },
      nextMode === 'chapterComplete' ? () => { checkpoint = saveChapterCheckpoint({ emit: false }); } : null,
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
    if (!['briefing', 'playing', 'paused', 'upgrade', 'chapterComplete'].includes(state.mode)) return invalid('playing');
    const buildMaxHull = maxHullFromBuild(normalizedBuild);
    if (!Number.isFinite(buildMaxHull) || buildMaxHull < state.maxHull) {
      throw new TypeError('build cannot reduce hull capacity');
    }
    const previous = snapshot();
    state.build = cloneValue(normalizedBuild);
    // Capacity is derived from the versioned build, never from an extra
    // checkpoint field. A live run cannot silently lose a capacity upgrade.
    state.maxHull = buildMaxHull;
    state.revision += 1;
    const changeRecord = Object.freeze({
      previous,
      current: snapshot(),
      detail: Object.freeze({ buildChanged: true }),
    });
    events?.emit('session:changed', changeRecord);
    onChange(changeRecord);
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
      room: null,
      build: { ownedUpgrades: [] },
      hull: baseMaxHull,
      maxHull: baseMaxHull,
      stats: createStats(),
      terminalReason: null,
      revision: previous.revision + 1,
    };
    events?.clear?.();
    const current = snapshot();
    const transitionRecord = Object.freeze({ previous, current, detail: { reset: true } });
    events?.emit('session:transition', transitionRecord);
    onTransition(transitionRecord);
    onChange(transitionRecord);
    return true;
  }

  return Object.freeze({
    startRun,
    startRoom,
    pause,
    resume,
    completeRoom,
    damageHull,
    upgradeHullCapacity,
    setBuild,
    setStats,
    reconcileCompatibilityHull,
    reset,
    restoreCheckpoint,
    getPersistenceStatus: () => runSave?.getStatus?.() ?? null,
    snapshot,
  });
}
