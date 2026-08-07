import { createEventQueue } from '../game/events.js';
import { createFixedLoop } from '../game/fixed-loop.js';
import { createGameSession } from '../game/session.js';
import { createLegacyRuntime } from './legacy-runtime.js';

const STEP_SECONDS = 1 / 60;
const MAX_CATCH_UP_STEPS = 6;

export function bootstrapNeonTide() {
  const events = createEventQueue(256);
  let runtime = null;
  let loop = null;
  let animationFrameId = null;
  let disposed = false;
  let debugApi = null;

  const session = createGameSession({
    development: import.meta.env.DEV,
    events,
    onChange({ previous, current, detail }) {
      const nowMs = performance.now();
      if (detail?.reset) {
        loop?.reset(nowMs);
        runtime?.reset(current);
        return;
      }
      if (current.mode === 'paused') loop?.pause(nowMs);
      else if (previous.mode === 'paused') loop?.resume(nowMs);
      else if (current.mode === 'briefing' && ['menu', 'victory', 'defeat'].includes(previous.mode)) loop?.reset(nowMs);
      runtime?.applySession(current);
    },
  });

  loop = createFixedLoop({
    stepSeconds: STEP_SECONDS,
    maxCatchUpSteps: MAX_CATCH_UP_STEPS,
    onStep(dt) {
      runtime?.simulate(dt);
    },
    onRender(alpha) {
      runtime?.render(alpha);
    },
  });

  runtime = createLegacyRuntime({ session, loop, events });
  runtime.start();
  loop.reset(performance.now());

  function frame(nowMs) {
    if (disposed) return;
    loop.tick(nowMs);
    animationFrameId = window.requestAnimationFrame(frame);
  }

  function getDebugSnapshot() {
    return Object.freeze({
      session: session.snapshot(),
      loop: loop.getStats(),
      events: events.getStats(),
      legacy: runtime.getDebugSnapshot(),
      disposed,
    });
  }

  function dispose() {
    if (disposed) return false;
    disposed = true;
    if (animationFrameId !== null) window.cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
    runtime.dispose();
    events.clear();
    if (globalThis.__NEON_TIDE_V3__ === debugApi) delete globalThis.__NEON_TIDE_V3__;
    return true;
  }

  const app = Object.freeze({ session, loop, events, dispose, getDebugSnapshot });
  debugApi = app;
  Object.defineProperty(globalThis, '__NEON_TIDE_V3__', {
    configurable: true,
    value: debugApi,
  });
  animationFrameId = window.requestAnimationFrame(frame);
  return app;
}
