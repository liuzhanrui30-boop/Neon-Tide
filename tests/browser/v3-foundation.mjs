import assert from 'node:assert/strict';
import { sleep, WALL_STALL_MS, withPage } from './harness.mjs';

async function v3FoundationLoopScenario() {
  await withPage('v3-foundation-loop', {}, async (page) => {
    const initial = await page.evaluate(`globalThis.__NEON_TIDE_V3__?.getDebugSnapshot()`);
    assert.equal(initial.session.mode, 'menu');
    assert.equal(initial.loop.paused, false);
    assert.equal(initial.legacy.mode, 'menu');
    assert.equal(initial.loop.stepSeconds, 1 / 60);
    assert.equal(initial.loop.maxCatchUpSteps, 6);

    await page.startGame();
    const playing = await page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot()`);
    assert.equal(playing.session.mode, 'playing');
    assert.equal(playing.legacy.mode, 'playing');
    assert.equal(playing.loop.paused, false);
    assert.equal(playing.session.revision >= 2, true);

    await page.click('#pause-button');
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().session.mode === 'paused'`);
    const paused = await page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot()`);
    assert.equal(paused.loop.paused, true);
    assert.equal(paused.legacy.mode, 'paused');
    const pausedSteps = paused.loop.steps;
    const droppedBeforePause = paused.loop.droppedSteps;

    await page.evaluate(`(()=>{const until=performance.now()+${WALL_STALL_MS};while(performance.now()<until){};return true})()`, { idempotent: false });
    await sleep(80);
    const stalled = await page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot()`);
    assert.equal(stalled.session.mode, 'paused');
    assert.equal(stalled.loop.paused, true);
    assert.equal(stalled.loop.steps, pausedSteps);
    assert.equal(stalled.loop.droppedSteps, droppedBeforePause);

    await page.trustedClick('#primary-button');
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().session.mode === 'playing'`);
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().loop.steps > ${pausedSteps}`);
    const resumed = await page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot()`);
    assert.equal(resumed.loop.paused, false);
    assert.equal(resumed.legacy.mode, 'playing');
    assert.equal(resumed.loop.droppedSteps, droppedBeforePause);
    assert.ok(resumed.loop.frameSeconds < 0.25, `pause time leaked into resumed loop: ${JSON.stringify(resumed.loop)}`);

    assert.equal(await page.evaluate(`globalThis.__NEON_TIDE_V3__.session.damageHull(3)`), true);
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().session.mode === 'defeat'`);
    const defeated = await page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot()`);
    assert.equal(defeated.session.hull, 0);
    assert.equal(defeated.legacy.mode, 'gameover');
    assert.equal(defeated.loop.paused, false);

    await page.trustedClick('#primary-button');
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().session.mode === 'playing'`);
    const replay = await page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot()`);
    assert.equal(replay.session.hull, replay.session.maxHull);
    assert.equal(replay.legacy.mode, 'playing');
    assert.equal(replay.loop.paused, false);
    assert.ok(replay.loop.resets >= 1);
    assert.ok(replay.events.dropped === 0, JSON.stringify(replay.events));
  });
}

export const v3FoundationScenarios = [
  ['v3 foundation loop', v3FoundationLoopScenario],
];
