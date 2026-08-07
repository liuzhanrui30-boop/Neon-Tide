import assert from 'node:assert/strict';
import { sleep, WALL_STALL_MS, withPage } from './harness.mjs';

const STEP_SECONDS = 1 / 60;
const nearlyEqual = (actual, expected, epsilon = 1e-9) => Math.abs(actual - expected) <= epsilon;

async function v3FoundationLoopScenario() {
  await withPage('v3-foundation-loop', {}, async (page) => {
    const initial = await page.evaluate(`globalThis.__NEON_TIDE_V3__?.getDebugSnapshot()`);
    assert.equal(initial.session.mode, 'menu');
    assert.equal(initial.loop.paused, false);
    assert.equal(initial.legacy.mode, 'menu');
    assert.equal(initial.loop.stepSeconds, STEP_SECONDS);
    assert.equal(initial.loop.maxCatchUpSteps, 6);

    await page.startGame();
    const playing = await page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot()`);
    assert.equal(playing.session.mode, 'playing');
    assert.equal(playing.legacy.mode, 'playing');
    assert.equal(playing.loop.paused, false);
    assert.equal(playing.session.revision >= 2, true);

    page.requireDev('fixed simulation and render separation probe');
    const renderOnly = await page.gameEvaluate(`
      clearWorldEntities();
      $state.enemySpawnTimer=999;
      const before={elapsed:$state.elapsed,health:$state.health,debug:globalThis.__NEON_TIDE_V3__.getDebugSnapshot().legacy};
      globalThis.__NEON_TIDE_RUNTIME_HOOKS__.renderCompatibilityFrame(0.1);
      globalThis.__NEON_TIDE_RUNTIME_HOOKS__.renderCompatibilityFrame(0.9);
      globalThis.__NEON_TIDE_RUNTIME_HOOKS__.renderCompatibilityFrame(0.5);
      const after={elapsed:$state.elapsed,health:$state.health,debug:globalThis.__NEON_TIDE_V3__.getDebugSnapshot().legacy};
      return {before,after};
    `);
    assert.equal(renderOnly.after.elapsed, renderOnly.before.elapsed);
    assert.equal(renderOnly.after.health, renderOnly.before.health);
    assert.equal(renderOnly.after.debug.simulationSteps, renderOnly.before.debug.simulationSteps);
    assert.equal(renderOnly.after.debug.renderCalls, renderOnly.before.debug.renderCalls + 3);

    await page.click('#pause-button');
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().session.mode === 'paused'`);
    const paused = await page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot()`);
    assert.equal(paused.loop.paused, true);
    assert.equal(paused.legacy.mode, 'paused');
    const pausedSteps = paused.loop.steps;
    const pausedElapsed = paused.legacy.elapsed;
    const droppedBeforePause = paused.loop.droppedSteps;

    await page.evaluate(`(()=>{const until=performance.now()+${WALL_STALL_MS};while(performance.now()<until){};return true})()`, { idempotent: false });
    await sleep(80);
    const stalled = await page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot()`);
    assert.equal(stalled.session.mode, 'paused');
    assert.equal(stalled.loop.paused, true);
    assert.equal(stalled.loop.steps, pausedSteps);
    assert.equal(stalled.legacy.elapsed, pausedElapsed);
    assert.equal(stalled.loop.droppedSteps, droppedBeforePause);

    await page.trustedClick('#primary-button');
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().session.mode === 'playing'`);
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().loop.steps > ${pausedSteps}`);
    const resumed = await page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot()`);
    const resumedStepDelta = resumed.loop.steps - pausedSteps;
    assert.equal(resumed.loop.paused, false);
    assert.equal(resumed.legacy.mode, 'playing');
    assert.ok(resumedStepDelta >= 1 && resumedStepDelta <= 6);
    assert.ok(nearlyEqual(resumed.legacy.elapsed - pausedElapsed, resumedStepDelta * STEP_SECONDS), JSON.stringify(resumed));

    await sleep(50);
    const afterResume = await page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot()`);
    const laterStepDelta = afterResume.loop.steps - resumed.loop.steps;
    assert.ok(laterStepDelta >= 1 && laterStepDelta <= 4, JSON.stringify(afterResume.loop));
    assert.ok(nearlyEqual(afterResume.legacy.elapsed - resumed.legacy.elapsed, laterStepDelta * STEP_SECONDS), JSON.stringify(afterResume));
    assert.ok(afterResume.loop.droppedSteps >= droppedBeforePause);

    const realDamage = await page.gameEvaluate(`
      const enemy={nearMissCandidate:true,nearMissResolved:false,group:{position:new THREE.Vector3(0,0,0)}};
      const accepted=damagePlayer(enemy);
      return {accepted,legacy:$state.health,session:globalThis.__NEON_TIDE_V3__.session.snapshot().hull};
    `);
    assert.deepEqual(realDamage, { accepted:true,legacy:2,session:2 });

    const sessionDamage = await page.evaluate(`(()=>{
      const accepted=globalThis.__NEON_TIDE_V3__.session.damageHull(1);
      const snapshot=globalThis.__NEON_TIDE_V3__.getDebugSnapshot();
      return {accepted,legacy:snapshot.legacy.health,session:snapshot.session.hull,mode:snapshot.session.mode};
    })()`);
    assert.deepEqual(sessionDamage, { accepted:true,legacy:1,session:1,mode:'playing' });

    const fatalDamage = await page.gameEvaluate(`
      const enemy={nearMissCandidate:true,nearMissResolved:false,group:{position:new THREE.Vector3(0,0,0)}};
      const accepted=damagePlayer(enemy);
      const snapshot=globalThis.__NEON_TIDE_V3__.getDebugSnapshot();
      return {accepted,legacy:snapshot.legacy.health,session:snapshot.session.hull,mode:snapshot.session.mode,legacyMode:$state.mode};
    `);
    assert.deepEqual(fatalDamage, { accepted:true,legacy:0,session:0,mode:'defeat',legacyMode:'gameover' });
    await page.waitForPage(`document.querySelector('#overlay').classList.contains('visible')`);

    await page.trustedClick('#primary-button');
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().session.mode === 'playing'`);
    const replay = await page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot()`);
    assert.equal(replay.session.hull, replay.session.maxHull);
    assert.equal(replay.legacy.health, replay.session.hull);
    assert.equal(replay.legacy.mode, 'playing');
    assert.equal(replay.loop.paused, false);
    assert.ok(replay.events.dropped === 0, JSON.stringify(replay.events));

    await page.gameEvaluate(`$state.elapsed=12;return $state.elapsed`);
    await page.click('#pause-button');
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().loop.paused === true`);
    const reset = await page.evaluate(`(()=>{
      globalThis.__NEON_TIDE_V3__.session.reset();
      return globalThis.__NEON_TIDE_V3__.getDebugSnapshot();
    })()`);
    assert.equal(reset.session.mode, 'menu');
    assert.equal(reset.loop.paused, false);
    assert.equal(reset.loop.steps, 0);
    assert.equal(reset.loop.accumulatorSeconds, 0);
    assert.equal(reset.legacy.mode, 'menu');
    assert.equal(reset.legacy.elapsed, 0);
    assert.equal(reset.legacy.simulationSteps, 0);
    assert.equal(reset.legacy.renderCalls, 0);
  });
}

export const v3FoundationScenarios = [
  ['v3 foundation loop', v3FoundationLoopScenario],
];
