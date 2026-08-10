import assert from 'node:assert/strict';
import { APP_URL, withPage } from './browser/harness.mjs';
import { createGameSession } from '../src/game/session.js';
import { roomRequestForRunRoute } from '../src/game/run-route.js';

class MemoryRunSave {
  checkpoint = null;
  save(value) { this.checkpoint = structuredClone(value); return true; }
  load() { return this.checkpoint ? structuredClone(this.checkpoint) : null; }
  clear() { this.checkpoint = null; return true; }
  getStatus() { return { available: true }; }
}

function createDataCityCheckpoint() {
  const runSave = new MemoryRunSave();
  const campaignTestAuthority = {};
  const session = createGameSession({
    development: true,
    deterministicTestMode: true,
    deterministicCampaignTest: true,
    campaignTestAuthority,
    initialRouteKind: 'campaign',
    runSave,
  });
  assert.equal(session.startRun('standard', 4112), true);
  for (let index = 0; index < 4; index += 1) {
    assert.equal(session.startRoom(roomRequestForRunRoute(session.snapshot().route)), true);
    assert.equal(campaignTestAuthority.completeCurrentNode(), true);
    if (session.getMode() === 'upgrade') {
      assert.equal(session.selectUpgrade(session.snapshot().build.pendingOffer.cards[0]), true);
    }
  }
  assert.equal(runSave.checkpoint.route.roomIndex, 4);
  assert.equal(runSave.checkpoint.chapterIndex, 1);
  return runSave.checkpoint;
}

await withPage('production-release-probe', { appUrl: APP_URL }, async (page) => {
  assert.equal(page.scriptKind, 'production');
  assert.deepEqual(await page.evaluate(`globalThis.__NEON_TIDE_V3__.getReleaseProbe()`), {
    apiVersion: 1,
    runtimeReady: true,
    frameScheduled: true,
    routeKind: null,
    disposed: false,
  });
  assert.equal(await page.evaluate(`'campaignTest' in globalThis.__NEON_TIDE_V3__`), false);
  assert.equal(await page.evaluate(`'bossTest' in globalThis.__NEON_TIDE_V3__`), false);
  assert.equal(await page.evaluate(`'repairHull' in globalThis.__NEON_TIDE_V3__`), false);
  const productionCombatBridge = await page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().legacy.combatBridge`);
  for (const field of [
    'tideLanceDamageRecords', 'tideLanceAudioCues', 'tideLanceFeedbackEvents',
    'lastTideLanceDamageRecords', 'lastTideLanceFeedbackText',
  ]) assert.equal(Object.hasOwn(productionCombatBridge, field), false, field);
  const resources = await page.evaluate(`performance.getEntriesByType('resource').map((entry)=>entry.name)`);
  assert.ok(resources.some((url) => url.includes('runtime-legacy-')));
  assert.ok(resources.some((url) => url.includes('gameplay-core-')));
  assert.equal(resources.some((url) => /chapter-(data-city|star-forge|void-cathedral)-/.test(url)), false);
  await page.startGame();
  const started = await page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().session`);
  assert.equal(started.route.kind, 'campaign');
  assert.equal(started.route.roomIndex, 0);
  assert.equal(started.room.timing.authoredTargetDurationSeconds, 58);
  assert.equal(started.room.pressure.enemySpeed, 1);
  const directCompletion = await page.evaluate(`(()=>{
    const api=globalThis.__NEON_TIDE_V3__;
    const before=api.session.snapshot();
    let message=null;
    try { api.session.completeRoom({}); } catch (error) { message=String(error?.message||error); }
    const after=api.session.snapshot();
    return {message,before:{mode:before.mode,stats:before.stats,route:before.route},after:{mode:after.mode,stats:after.stats,route:after.route}};
  })()`);
  assert.match(directCompletion.message, /natural campaign completion authorization/);
  assert.deepEqual(directCompletion.after, directCompletion.before);
});

const coldCheckpoint = createDataCityCheckpoint();
const COLD_URL = new URL('?campaign-test=1&boss-test=1&duration-scale=0.01', APP_URL).href;
await withPage('production-data-city-cold-checkpoint', {
  appUrl: COLD_URL,
  initialCheckpoint: coldCheckpoint,
  expectedReleaseRouteKind: 'campaign',
}, async (page) => {
  assert.equal(page.scriptKind, 'production');
  await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().campaignContent.loads['data-city']==='loaded'`);
  const restored = await page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot()`);
  assert.equal(restored.session.mode, 'briefing');
  assert.equal(restored.session.route.roomIndex, 4);
  assert.equal(restored.session.chapterIndex, 1);
  assert.equal(restored.campaignContent.loads['data-city'], 'loaded');
  assert.equal(await page.evaluate(`'campaignTest' in globalThis.__NEON_TIDE_V3__`), false);
  assert.equal(await page.evaluate(`'bossTest' in globalThis.__NEON_TIDE_V3__`), false);
  assert.equal(await page.evaluate(`'repairHull' in globalThis.__NEON_TIDE_V3__`), false);
  const resourcesBefore = await page.evaluate(`performance.getEntriesByType('resource').map((entry)=>entry.name)`);
  assert.ok(resourcesBefore.some((url) => /chapter-data-city-/.test(url)));
  assert.equal(resourcesBefore.some((url) => /chapter-(star-forge|void-cathedral)-/.test(url)), false);
  await page.startGame();
  await page.waitForPage(`globalThis.__NEON_TIDE_V3__.session.getMode()==='playing'`);
  await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().encounter.objective.dataLane?.directDamage===0`);
  const started = await page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot()`);
  assert.equal(started.session.room.templateId, 'escort-skiff');
  assert.equal(started.encounter.chapterPacing.chapterId, 'data-city');
  assert.equal(started.encounter.chapterPacing.roomId, 'data-city:escort-uplink');
  assert.equal(started.encounter.chapterPacing.warningCap, 2);
  assert.equal(started.encounter.objective.dataLane.directDamage, 0);
  assert.equal(started.encounter.objective.dataLane.dashRecoveryRateMultiplier, 0.65);
  assert.deepEqual(started.encounter.chapterPacing.rolesIntroduced, []);
  assert.equal(started.encounter.timing.effectiveTargetDurationSeconds, 65, 'production ignores test duration query');
});
console.log('ok 1 - production release probe survives stable chunk splitting and rejects public campaign settlement');
console.log('ok 2 - production Data City cold checkpoint awaits lazy authored content without test authority');
console.log('1..2');
