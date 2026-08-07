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

export function createGameSession(options = {}) {
  const development = options.development ?? true;
  const events = options.events ?? null;
  const onTransition = options.onTransition ?? (() => {});
  const onChange = options.onChange ?? (() => {});
  const baseMaxHull = options.maxHull ?? 3;
  if (!Number.isFinite(baseMaxHull) || baseMaxHull <= 0) throw new TypeError('maxHull must be positive and finite');
  if (events && typeof events.emit !== 'function') throw new TypeError('events must expose emit(type, payload)');
  if (typeof onTransition !== 'function') throw new TypeError('onTransition must be a function');
  if (typeof onChange !== 'function') throw new TypeError('onChange must be a function');

  let state = {
    mode: 'menu',
    runMode: null,
    seed: null,
    chapterIndex: 0,
    room: null,
    build: {},
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

  function transition(nextMode, detail = {}) {
    if (!MODE_SET.has(nextMode)) return invalid(nextMode);
    if (nextMode === state.mode || !ALLOWED_TRANSITIONS[state.mode]?.has(nextMode)) return invalid(nextMode);
    const previous = snapshot();
    state.mode = nextMode;
    state.revision += 1;
    const current = snapshot();
    const transitionRecord = Object.freeze({ previous, current, detail: cloneValue(detail) });
    events?.emit('session:transition', transitionRecord);
    onTransition(transitionRecord);
    onChange(transitionRecord);
    return true;
  }

  function startRun(runMode, seed) {
    if (!RUN_MODES.has(runMode)) throw new TypeError('run mode must be standard or abyss');
    if (!Number.isFinite(seed)) throw new TypeError('run seed must be a finite seed');
    if (!['menu', 'victory', 'defeat'].includes(state.mode)) return invalid('briefing');
    state.runMode = runMode;
    state.seed = seed;
    state.chapterIndex = 0;
    state.room = null;
    state.build = {};
    state.hull = baseMaxHull;
    state.maxHull = baseMaxHull;
    state.stats = createStats();
    state.terminalReason = null;
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
    const changed = transition(nextMode, { result: cloneValue(result) });
    if (changed) events?.emit('room:completed', { result: cloneValue(result), nextMode });
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
      return transition('defeat', { reason: 'hullBreach' });
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

  function reconcileCompatibilityHull(hull, { maxHull: requestedMaxHull = state.maxHull } = {}) {
    if (!Number.isFinite(hull) || hull < 0) throw new TypeError('hull must be a non-negative finite number');
    if (!Number.isFinite(requestedMaxHull) || requestedMaxHull <= 0) {
      throw new TypeError('maxHull must be positive and finite');
    }
    if (!['playing', 'paused', 'upgrade'].includes(state.mode)) return invalid('playing');
    const previous = snapshot();
    state.maxHull = requestedMaxHull;
    state.hull = Math.min(requestedMaxHull, hull);
    state.revision += 1;
    const changeRecord = Object.freeze({
      previous,
      current: snapshot(),
      detail: Object.freeze({ hullCompatibilitySync: true }),
    });
    events?.emit('session:changed', changeRecord);
    onChange(changeRecord);
    if (state.hull <= 0) {
      state.terminalReason = 'hullBreach';
      return transition('defeat', { reason: 'hullBreach', compatibilitySync: true });
    }
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
      build: {},
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
    reconcileCompatibilityHull,
    reset,
    snapshot,
  });
}
