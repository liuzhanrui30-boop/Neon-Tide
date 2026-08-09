import assert from 'node:assert/strict';
import { APP_URL, withPage } from './browser/harness.mjs';

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
});
console.log('ok 1 - production release probe survives stable chunk splitting');
console.log('1..1');
