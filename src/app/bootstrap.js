import * as THREE from 'three';
import { createEntityWorld, selectEntityCapacities } from '../game/entity-world.js';
import { createEventQueue, createPresentationEventConsumer } from '../game/events.js';
import { createFixedLoop } from '../game/fixed-loop.js';
import { createGameSession } from '../game/session.js';
import { selectRenderQuality } from '../game/render-quality.js';
import { createEntityRenderer } from '../render/entity-renderer.js';
import { createRunSave } from '../persistence/run-save.js';
import { createLegacyRuntime } from './legacy-runtime.js';
import { createInputSystem } from '../systems/input-system.js';
import { createHudRenderer } from '../render/hud-renderer.js';
import { createWeaponSystem } from '../systems/weapon-system.js';
import { createProjectileSystem } from '../systems/projectile-system.js';
import { createCollisionSystem } from '../systems/collision-system.js';

const STEP_SECONDS = 1 / 60;
const MAX_CATCH_UP_STEPS = 6;

function getBrowserStorage() {
  try {
    return globalThis.localStorage;
  } catch {
    // Private/blocked storage is a normal recovery path, not an app failure.
    return null;
  }
}

export function bootstrapNeonTide(options = {}) {
  const events = createEventQueue(256);
  const runSave = createRunSave(options.storage ?? getBrowserStorage());
  const coarsePointer = options.coarsePointer
    ?? (globalThis.matchMedia?.('(pointer: coarse)').matches ?? false);
  const entityQuality = options.entityQuality ?? selectRenderQuality({
    coarsePointer,
    reducedMotion: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    viewportWidth: globalThis.innerWidth ?? 1440,
    devicePixelRatio: globalThis.devicePixelRatio ?? 1,
  });
  const entityCapacities = options.entityCapacities ?? selectEntityCapacities({
    coarsePointer: coarsePointer || entityQuality.tier === 'mobile',
  });
  const entityScene = new THREE.Scene();
  const world = createEntityWorld({ capacities: entityCapacities });
  const entityRenderer = createEntityRenderer({
    scene: entityScene,
    quality: entityQuality,
    capacities: entityCapacities,
  });
  const inputSystem = createInputSystem();
  const hudRenderer = createHudRenderer();
  const weaponSystem = createWeaponSystem();
  const projectileSystem = createProjectileSystem();
  const collisionSystem = createCollisionSystem();
  let projectedPlayer = null;
  const playerProjection = Object.freeze({
    publish(snapshot) {
      projectedPlayer = Object.freeze({
        ...snapshot,
        position: Object.freeze({ ...snapshot.position }),
        velocity: Object.freeze({ ...snapshot.velocity }),
        facing: Object.freeze({ ...snapshot.facing }),
        dashCharges: Object.freeze([...snapshot.dashCharges]),
        cameraLead: Object.freeze({ ...snapshot.cameraLead }),
      });
      return projectedPlayer;
    },
    reset() {
      projectedPlayer = null;
    },
    getSnapshot() {
      return projectedPlayer;
    },
  });
  let runtime = null;
  let loop = null;
  let animationFrameId = null;
  let disposed = false;
  let debugApi = null;
  const presentationEvents = createPresentationEventConsumer({
    capacity: 64,
    onEvent(event) {
      runtime?.consumePresentationEvent?.(event);
    },
  });

  const session = createGameSession({
    development: import.meta.env.DEV,
    events,
    runSave,
    encounterQuality: entityQuality,
    onChange({ previous, current, detail }) {
      const nowMs = performance.now();
      const startsNewAttempt = current.mode === 'briefing'
        && (detail?.checkpointRestored
          || (detail?.runMode && ['menu', 'victory', 'defeat'].includes(previous.mode)));
      if (startsNewAttempt) {
        world.reset();
        weaponSystem.reset();
        projectileSystem.reset();
        collisionSystem.reset();
        entityRenderer.reset();
        presentationEvents.reset();
      }
      if (detail?.reset) {
        loop?.reset(nowMs);
        runtime?.reset(current);
        playerProjection.reset();
        world.reset();
        weaponSystem.reset();
        projectileSystem.reset();
        collisionSystem.reset();
        entityRenderer.reset();
        presentationEvents.reset();
        return;
      }
      if (current.mode === 'paused') loop?.pause(nowMs);
      else if (previous.mode === 'paused') loop?.resume(nowMs);
      else if (current.mode === 'chapterComplete' && previous.mode === 'playing') {
        // The compatibility campaign immediately starts the next authoritative
        // room after its checkpoint commit. Keep the legacy projection alive
        // during that synchronous handoff rather than suspending/restarting
        // audio and render state for a transient mode.
        return;
      }
      else if (current.mode === 'briefing' && previous.mode === 'defeat') {
        // Checkpoint restores and Abyss retries both replace the complete run;
        // do not leave compatibility entities, timers, or upgrades alive.
        loop?.reset(nowMs);
        // Preserve the inherited defeat dialog until the player explicitly
        // continues a Standard checkpoint. `startGame()` performs the runtime
        // reset immediately before it opens the restored room.
        if (current.runMode === 'standard' && detail?.checkpointRestored) return;
        runtime?.reset(current);
        return;
      } else if (current.mode === 'briefing' && ['menu', 'victory'].includes(previous.mode)) loop?.reset(nowMs);
      runtime?.applySession(current);
    },
  });

  // Restore only the validated chapter-entry snapshot. This happens before the
  // compatibility runtime starts, so observers never see a partially restored
  // gameplay session. The menu remains the explicit Continue boundary.
  session.restoreCheckpoint();

  loop = createFixedLoop({
    stepSeconds: STEP_SECONDS,
    maxCatchUpSteps: MAX_CATCH_UP_STEPS,
    onStep(dt) {
      try {
        const beforeStep = session.snapshot();
        if (beforeStep.mode === 'playing' && beforeStep.room?.objectiveManaged && beforeStep.room.combatFrozen) {
          const frozenPlayerId = world.query('player').at(0);
          session.updateRoom({
            world,
            player: frozenPlayerId ? world.get(frozenPlayerId) : projectedPlayer,
            presentationPending: events.getStats().queued,
          }, dt, events);
          hudRenderer.render({ objective: session.snapshot().room?.objective });
          return;
        }
        runtime?.simulate(dt);
        if (session.snapshot().mode !== 'playing') return;
        const playerId = runtime?.syncCombatWorld(world);
        if (!Number.isSafeInteger(playerId)) return;
        weaponSystem.update(world, playerId, dt, events);
        projectileSystem.update(world, dt, events);
        const summary = collisionSystem.resolve(world, session, dt, events);
        runtime?.applyCombatSummary(world, summary);
        if (session.snapshot().room?.objectiveManaged) {
          const objectiveInput = summary.damageRecords
            .filter((record) => record.destroyed && record.targetKind === 'enemy')
            .map((record) => ({
              type: 'enemy:destroyed',
              payload: { id: record.targetId, sourceId: record.targetSourceId },
            }));
          session.updateRoom({
            world,
            player: world.get(playerId),
            presentationPending: events.getStats().queued,
          }, dt, { input: objectiveInput, emit: events.emit });
          hudRenderer.render({ objective: session.snapshot().room?.objective });
        }
      } finally {
        events.drain(presentationEvents.consume);
      }
    },
    onRender(alpha) {
      entityRenderer.sync(world, alpha);
      runtime?.render(alpha);
    },
  });

  runtime = createLegacyRuntime({
    session,
    loop,
    events,
    inputSystem,
    playerProjection,
    hudRenderer,
    entityRenderer,
  });
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
      presentationEvents: presentationEvents.getStats(),
      world: world.getStats(),
      renderer: entityRenderer.getStats(),
      weapons: weaponSystem.getStats(),
      projectiles: projectileSystem.getStats(),
      collisions: collisionSystem.getStats(),
      encounter: session.getEncounterSnapshot(),
      legacy: runtime.getDebugSnapshot(),
      player: playerProjection.getSnapshot(),
      input: Object.freeze({
        inputDevice: inputSystem.getLastActiveDevice(),
        pressDevice: inputSystem.getLastPressDevice(),
      }),
      hud: hudRenderer.getDebugSnapshot(),
      persistence: runSave.getStatus(),
      disposed,
    });
  }

  function dispose() {
    if (disposed) return false;
    disposed = true;
    if (animationFrameId !== null) window.cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
    runtime.dispose();
    inputSystem.dispose();
    hudRenderer.dispose();
    entityRenderer.dispose();
    world.dispose();
    events.clear();
    if (globalThis.__NEON_TIDE_V3__ === debugApi) delete globalThis.__NEON_TIDE_V3__;
    return true;
  }

  const app = Object.freeze({
    session,
    loop,
    events,
    runSave,
    world,
    entityRenderer,
    inputSystem,
    hudRenderer,
    weaponSystem,
    projectileSystem,
    collisionSystem,
    presentationEvents,
    dispose,
    getDebugSnapshot,
  });
  debugApi = app;
  Object.defineProperty(globalThis, '__NEON_TIDE_V3__', {
    configurable: true,
    value: debugApi,
  });
  animationFrameId = window.requestAnimationFrame(frame);
  return app;
}
