const DEFAULT_STEP_SECONDS = 1 / 60;
const DEFAULT_MAX_CATCH_UP_STEPS = 6;
const EPSILON = 1e-9;

function requirePositiveFinite(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return value;
}

function requireTimestamp(value, name = 'nowMs') {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
}

export function createFixedLoop({
  stepSeconds = DEFAULT_STEP_SECONDS,
  maxCatchUpSteps = DEFAULT_MAX_CATCH_UP_STEPS,
  onStep,
  onRender,
} = {}) {
  requirePositiveFinite(stepSeconds, 'stepSeconds');
  if (!Number.isInteger(maxCatchUpSteps) || maxCatchUpSteps <= 0) {
    throw new TypeError('maxCatchUpSteps must be a positive integer');
  }
  if (typeof onStep !== 'function') throw new TypeError('onStep must be a function');
  if (typeof onRender !== 'function') throw new TypeError('onRender must be a function');

  let accumulatorSeconds = 0;
  let lastNowMs = null;
  let paused = false;
  let frames = 0;
  let steps = 0;
  let droppedSteps = 0;
  let droppedSeconds = 0;
  let frameSeconds = 0;
  let alpha = 0;
  let resets = 0;
  let pauses = 0;
  let resumes = 0;

  function reset(nowMs) {
    lastNowMs = requireTimestamp(nowMs);
    accumulatorSeconds = 0;
    frameSeconds = 0;
    alpha = 0;
    paused = false;
    frames = 0;
    steps = 0;
    droppedSteps = 0;
    droppedSeconds = 0;
    resets += 1;
    return true;
  }

  function pause(nowMs) {
    requireTimestamp(nowMs);
    if (paused) return false;
    paused = true;
    lastNowMs = nowMs;
    frameSeconds = 0;
    pauses += 1;
    return true;
  }

  function resume(nowMs) {
    requireTimestamp(nowMs);
    if (!paused) return false;
    paused = false;
    lastNowMs = nowMs;
    frameSeconds = 0;
    resumes += 1;
    return true;
  }

  function tick(nowMs) {
    requireTimestamp(nowMs);
    if (lastNowMs === null) reset(nowMs);
    frames += 1;

    if (paused) {
      lastNowMs = nowMs;
      frameSeconds = 0;
      alpha = accumulatorSeconds / stepSeconds;
      onRender(alpha);
      return { steps: 0, alpha };
    }

    frameSeconds = Math.max(0, (nowMs - lastNowMs) / 1000);
    lastNowMs = nowMs;
    accumulatorSeconds += frameSeconds;

    const availableSteps = Math.floor((accumulatorSeconds + stepSeconds * EPSILON) / stepSeconds);
    const executedSteps = Math.min(availableSteps, maxCatchUpSteps);
    for (let index = 0; index < executedSteps; index += 1) onStep(stepSeconds);
    steps += executedSteps;
    accumulatorSeconds -= executedSteps * stepSeconds;

    const overflowSteps = availableSteps - executedSteps;
    if (overflowSteps > 0) {
      const overflowSeconds = overflowSteps * stepSeconds;
      accumulatorSeconds -= overflowSeconds;
      droppedSteps += overflowSteps;
      droppedSeconds += overflowSeconds;
    }
    if (accumulatorSeconds < 0 && accumulatorSeconds > -stepSeconds * EPSILON) accumulatorSeconds = 0;
    alpha = Math.min(1 - Number.EPSILON, Math.max(0, accumulatorSeconds / stepSeconds));
    onRender(alpha);
    return { steps: executedSteps, alpha };
  }

  function getStats() {
    return Object.freeze({
      stepSeconds,
      maxCatchUpSteps,
      paused,
      frames,
      steps,
      droppedSteps,
      droppedSeconds,
      accumulatorSeconds,
      frameSeconds,
      alpha,
      lastNowMs,
      resets,
      pauses,
      resumes,
    });
  }

  return Object.freeze({ tick, pause, resume, reset, getStats });
}
