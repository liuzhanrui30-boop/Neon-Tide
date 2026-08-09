import * as THREE from 'three';
import { createEntityWorld, selectEntityCapacities } from '../game/entity-world.js';
import { createEventQueue, createPresentationEventConsumer } from '../game/events.js';
import { createFixedLoop } from '../game/fixed-loop.js';
import { createGameSession } from '../game/session.js';
import { selectRenderQuality } from '../game/render-quality.js';
import { createEntityRenderer } from '../render/entity-renderer.js';
import { createRunModePreference, createRunSave } from '../persistence/run-save.js';
import { CAMPAIGN_CHAPTERS, getChapterContentLoadState, loadChapterContent } from '../content/realms.js';
import { createLegacyRuntime } from './legacy-runtime.js';
import { createInputSystem } from '../systems/input-system.js';
import { createHudObjectiveViewModel, createHudRenderer } from '../render/hud-renderer.js';
import { createWeaponSystem } from '../systems/weapon-system.js';
import { createProjectileSystem } from '../systems/projectile-system.js';
import { createCollisionSystem } from '../systems/collision-system.js';
import { createObjectiveWorldBridge } from '../systems/objective-world-bridge.js';
import { createEnemySystem } from '../systems/enemy-system.js';

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
  const storage = options.storage ?? getBrowserStorage();
  const runSave = createRunSave(storage);
  const runModePreference = createRunModePreference(storage);
  const chapterContentErrors = new Map();
  function ensureChapterContent(chapterIndex) {
    const chapter = CAMPAIGN_CHAPTERS[chapterIndex];
    if (!chapter || chapter.index === 0) return Promise.resolve(chapter ?? null);
    return loadChapterContent(chapter.id).catch((error) => {
      chapterContentErrors.set(chapter.id, error instanceof Error ? error.message : String(error));
      return null;
    });
  }
  const coarsePointer = options.coarsePointer
    ?? (globalThis.matchMedia?.('(pointer: coarse)').matches ?? false);
  const entityQuality = options.entityQuality ?? selectRenderQuality({
    coarsePointer,
    reducedMotion: globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    viewportWidth: globalThis.innerWidth ?? 1440,
    devicePixelRatio: globalThis.devicePixelRatio ?? 1,
  });
  const coarseEntityQuality = coarsePointer
    || ['compact', 'coarse', 'touch', 'mobile'].includes(entityQuality.tier);
  const entityCapacities = options.entityCapacities ?? selectEntityCapacities({
    coarsePointer: coarseEntityQuality,
    quality: entityQuality,
  });
  const searchParams = new URLSearchParams(globalThis.location?.search ?? '');
  const objectiveTestMode = import.meta.env.DEV && searchParams.has('objective-test');
  const compatibilityTestMode = import.meta.env.DEV && searchParams.has('compatibility-test');
  const campaignTestMode = import.meta.env.DEV && searchParams.has('campaign-test');
  const campaignRouting = import.meta.env.PROD || campaignTestMode;
  const initialRouteKind = compatibilityTestMode
    ? 'compatibility'
    : campaignRouting
      ? 'campaign'
      : 'authored';
  const campaignTestAuthority = campaignTestMode ? {} : null;
  const requestedCampaignSeed = Number(searchParams.get('objective-seed'));
  const campaignSeed = import.meta.env.DEV && Number.isFinite(requestedCampaignSeed)
    ? requestedCampaignSeed
    : null;
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
  let session = null;
  const enemySystem = createEnemySystem({
    enemyCap: () => session?.snapshot().runMode === 'abyss'
      ? (coarseEntityQuality ? 42 : 56)
      : (coarseEntityQuality ? 36 : 48),
    projectileCap: entityCapacities.enemyProjectile,
    warningCap: () => {
      const abyss = session?.snapshot().runMode === 'abyss';
      return abyss ? (coarseEntityQuality ? 3 : 4) : (coarseEntityQuality ? 2 : 3);
    },
    telegraphFloorSeconds: () => session?.getEnemyTelegraphFloorSeconds?.() ?? 0.55,
  });
  const objectiveBridge = createObjectiveWorldBridge({ world });
  const objectiveAuthority = {};
  let objectiveInputSequence = 0;
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
      const transitionChapter = event.type === 'session:transition'
        ? event.payload?.current?.chapterIndex
        : null;
      if (event.payload?.current?.route?.kind === 'campaign' && transitionChapter > 0) {
        ensureChapterContent(transitionChapter);
      }
      objectiveBridge.consume(event);
      runtime?.consumePresentationEvent?.(event);
    },
  });

  session = createGameSession({
    development: import.meta.env.DEV,
    events,
    runSave,
    encounterQuality: entityQuality,
    encounterDurationScale: options.encounterDurationScale ?? (objectiveTestMode ? 0.18 : 1),
    initialRouteKind,
    deterministicCampaignTest: campaignTestMode,
    campaignTestAuthority,
    objectiveAuthority,
    onChange({ previous, current, detail }) {
      const nowMs = performance.now();
      if (current.route?.kind === 'campaign' && current.chapterIndex > 0) {
        ensureChapterContent(current.chapterIndex);
      }
      const startsNewAttempt = current.mode === 'briefing'
        && (detail?.checkpointRestored
          || (detail?.runMode && ['menu', 'victory', 'defeat'].includes(previous.mode)));
      if (startsNewAttempt) {
        world.reset();
        weaponSystem.reset();
        projectileSystem.reset();
        collisionSystem.reset();
        enemySystem.reset();
        objectiveBridge.reset();
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
        enemySystem.reset();
        objectiveBridge.reset();
        entityRenderer.reset();
        presentationEvents.reset();
        return;
      }
      if (current.mode === 'paused') loop?.pause(nowMs);
      else if (previous.mode === 'paused') loop?.resume(nowMs);
      else if (current.mode === 'chapterComplete' && previous.mode === 'playing'
        && current.route?.kind !== 'campaign') {
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

  function syncObjectiveWorld(objective) {
    objectiveBridge.sync(objective);
  }

  function renderObjectiveHud(objective) {
    hudRenderer.render({
      ...(projectedPlayer ?? {}),
      inputDevice: inputSystem.getLastActiveDevice(),
      objective: createHudObjectiveViewModel(objective),
    });
  }

  loop = createFixedLoop({
    stepSeconds: STEP_SECONDS,
    maxCatchUpSteps: MAX_CATCH_UP_STEPS,
    onStep(dt) {
      try {
        if (session.getMode() === 'playing' && session.isObjectiveManaged() && session.isCombatFrozen()) {
          const frozenPlayerId = world.query('player').at(0);
          session.updateRoom({
            world,
            player: frozenPlayerId ? world.get(frozenPlayerId) : projectedPlayer,
            applyPlayerForce: runtime?.applyExternalForce,
            presentationPending: events.getStats().queued,
          }, dt, events);
          objectiveAuthority.visit(renderObjectiveHud);
          return;
        }
        runtime?.simulate(dt);
        if (session.getMode() !== 'playing') return;
        const playerId = runtime?.syncCombatWorld(world);
        if (!Number.isSafeInteger(playerId)) return;
        let enemySummary = Object.freeze({ destroyedRecords: Object.freeze([]), active: world.query('enemy').length });
        if (session.isObjectiveManaged()) {
          objectiveAuthority.visit((objective) => {
            syncObjectiveWorld(objective);
            enemySummary = enemySystem.update(world, world.get(playerId), objective, dt, events);
          });
        }
        const buildStats = session.getBuildStats();
        weaponSystem.update(world, playerId, dt, events, buildStats);
        projectileSystem.update(world, dt, events);
        const summary = collisionSystem.resolve(world, session, dt, events, buildStats);
        runtime?.applyCombatSummary(world, summary);
        if (session.isObjectiveManaged()) {
          const objectiveInput = summary.damageRecords
            .flatMap((record) => {
              if (record.destroyed && record.targetKind === 'enemy') return [{
                type: 'enemy:destroyed', sequence: ++objectiveInputSequence,
                payload: { id: record.targetId, sourceId: record.targetSourceId, targetSourceId: record.targetSourceId },
              }];
              if (record.targetKind === 'objective') return [{
                type: 'objective:damaged', sequence: ++objectiveInputSequence,
                payload: { id: record.targetId, sourceId: record.targetSourceId, amount: record.amount },
              }];
              return [];
            });
          for (const record of enemySummary.destroyedRecords ?? []) objectiveInput.push({
            type: 'enemy:destroyed', sequence: ++objectiveInputSequence,
            payload: { id: record.id, sourceId: record.sourceId, targetSourceId: record.sourceId, role: record.role },
          });
          if (summary.pickups > 0) objectiveInput.push({
            type: 'pickupCollected',
            sequence: ++objectiveInputSequence,
            payload: { count: summary.pickups, ids: summary.pickupSourceIds },
          });
          for (const completion of summary.objectiveCompletions) objectiveInput.push({
            type: 'objectiveCompleted', sequence: ++objectiveInputSequence, payload: completion,
          });
          session.updateRoom({
            world,
            player: { ...world.get(playerId), buildStats },
            damageRecords: summary.damageRecords,
            applyPlayerForce: runtime?.applyExternalForce,
            presentationPending: events.getStats().queued,
          }, dt, { input: objectiveInput, emit: events.emit });
          objectiveAuthority.visit(renderObjectiveHud);
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
    compatibilityCampaign: compatibilityTestMode,
    campaignRouting,
    campaignSeed,
    runModePreference,
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
      enemies: enemySystem.getStats(world),
      encounter: session.getEncounterSnapshot(),
      objectiveBridge: objectiveBridge.getStats(),
      legacy: runtime.getDebugSnapshot(),
      player: playerProjection.getSnapshot(),
      input: Object.freeze({
        inputDevice: inputSystem.getLastActiveDevice(),
        pressDevice: inputSystem.getLastPressDevice(),
      }),
      hud: hudRenderer.getDebugSnapshot(),
      persistence: runSave.getStatus(),
      campaignContent: Object.freeze({
        loads: getChapterContentLoadState(),
        errors: Object.freeze(Object.fromEntries(chapterContentErrors)),
      }),
      disposed,
    });
  }

  function getReleaseProbe() {
    return Object.freeze({
      apiVersion: 1,
      runtimeReady: Boolean(runtime),
      frameScheduled: animationFrameId !== null,
      routeKind: session.snapshot().route?.kind ?? null,
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
    enemySystem.cleanup(world);
    objectiveBridge.clear();
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
    runModePreference,
    ensureChapterContent,
    world,
    entityRenderer,
    inputSystem,
    hudRenderer,
    weaponSystem,
    projectileSystem,
    collisionSystem,
    enemySystem,
    objectiveBridge,
    presentationEvents,
    ...(campaignTestAuthority?.completeCurrentNode ? { campaignTest: campaignTestAuthority } : {}),
    dispose,
    getDebugSnapshot,
    getReleaseProbe,
  });
  debugApi = app;
  Object.defineProperty(globalThis, '__NEON_TIDE_V3__', {
    configurable: true,
    value: debugApi,
  });
  animationFrameId = window.requestAnimationFrame(frame);
  return app;
}
