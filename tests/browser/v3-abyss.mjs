import assert from 'node:assert/strict';
import { APP_URL, withPage } from './harness.mjs';

const ABYSS_URL = new URL('?campaign-test=1&boss-test=1&objective-seed=7301', APP_URL).href;

async function snapshot(page) {
  return page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot()`);
}

async function completeOrdinaryNode(page) {
  assert.equal(await page.evaluate(`globalThis.__NEON_TIDE_V3__.campaignTest.completeCurrentNode()`), true);
  await page.waitForPage(`globalThis.__NEON_TIDE_V3__.session.getMode()!=='playing'`);
  const mode = await page.evaluate(`globalThis.__NEON_TIDE_V3__.session.getMode()`);
  if (mode === 'upgrade') {
    await page.trustedClick('#upgrade-options .upgrade-option');
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.session.getMode()==='playing'`);
  } else if (mode === 'chapterComplete') {
    await page.trustedClick('#primary-button');
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.session.getMode()==='playing'`);
  } else throw new Error(`unexpected pre-Boss mode: ${mode}`);
}

async function reachMaw(page) {
  await page.startGame();
  for (let index = 0; index < 3; index += 1) await completeOrdinaryNode(page);
  await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().session.room?.boss?.id==='abyss-maw'`);
  await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().encounter.bossBehavior?.parts?.body?.entityId>0`);
}

export const v3AbyssScenarios = [
  ['v3 Abyss Maw rejects fixed orbit, accepts varied route and cleans natural collision victory', async () => {
    await withPage('v3-abyss-maw-natural', { appUrl: ABYSS_URL }, async (page) => {
      await reachMaw(page);
      assert.equal(await page.evaluate(`typeof globalThis.__NEON_TIDE_V3__.bossTest.runCircle`), 'function');
      const fixed = await page.evaluate(`globalThis.__NEON_TIDE_V3__.bossTest.runCircle(240)`);
      assert.equal(fixed.phase, 'hunt');
      assert.equal(fixed.destroyedOrgans, 0);
      assert.ok(fixed.orbitCounterTriggers > 0);

      const readable = await page.evaluate(`(()=>{
        const app=globalThis.__NEON_TIDE_V3__;
        const snap=app.getDebugSnapshot();
        return {
          bossParts:snap.world.pools.bossPart.count,
          warnings:snap.world.pools.warning.count,
          hazards:snap.world.pools.enemyHazard.count,
          rendered:snap.renderer.active,
          objectiveType:document.querySelector('#mission-panel')?.dataset.objectiveType,
          hudText:document.querySelector('#mission-objective')?.textContent,
        };
      })()`);
      assert.ok(readable.bossParts >= 4);
      assert.ok(readable.warnings + readable.hazards > 0);
      assert.ok(readable.rendered > 0);
      assert.equal(readable.objectiveType, 'boss');
      assert.match(readable.hudText, /深渊巨口/);

      const varied = await page.evaluate(`globalThis.__NEON_TIDE_V3__.bossTest.runVaried(90)`);
      assert.equal(varied.phase, 'weakPoints');
      assert.equal(varied.suctionOutcome.succeeded, true);
      assert.equal(varied.parts.organs.length, 3);
      assert.ok(varied.parts.organs.every((organ)=>organ.weakPoint&&!organ.invulnerable));
      assert.ok(varied.attacksSeen.includes('suction-current'));
      assert.ok(varied.attacksSeen.includes('tentacle-fan'));

      const organStrike = await page.evaluate(`globalThis.__NEON_TIDE_V3__.bossTest.strikeOrgans()`);
      assert.ok(organStrike.summary.damageRecords.filter((record)=>record.targetKind==='bossPart').length >= 3);
      assert.equal(organStrike.encounter.bossBehavior.phase, 'enraged');
      assert.equal(organStrike.encounter.bossBehavior.destroyedOrgans, 3);
      assert.notDeepEqual(organStrike.encounter.bossBehavior.arenaCenter, { x: 0, y: 0 });

      const coreStrike = await page.evaluate(`globalThis.__NEON_TIDE_V3__.bossTest.strikeCore()`);
      assert.ok(coreStrike.summary.damageRecords.some((record)=>record.targetKind==='bossPart'&&record.destroyed));
      await page.evaluate(`globalThis.__NEON_TIDE_V3__.bossTest.settle()`);
      await page.waitForPage(`globalThis.__NEON_TIDE_V3__.session.getMode()==='upgrade'`);
      const victory = await snapshot(page);
      assert.equal(victory.session.route.roomIndex, 4);
      assert.equal(victory.session.stats.roomsCompleted, 4);
      assert.equal(victory.world.pools.bossPart.count, 0);
      assert.equal(victory.encounter.bossBehavior.ownedEntityCount, 0);
      assert.equal(victory.encounter.bossBehavior.clean, true);
      assert.equal(victory.events.dropped, 0);
    });
  }],
  ['v3 Standard death at Abyss Maw reconstructs chapter entry without midpoint checkpoint', async () => {
    await withPage('v3-abyss-maw-standard-retry', { appUrl: ABYSS_URL }, async (page) => {
      await reachMaw(page);
      assert.equal(await page.evaluate(`globalThis.__NEON_TIDE_V3__.session.damageHull(globalThis.__NEON_TIDE_V3__.session.getHull())`), true);
      await page.waitForPage(`globalThis.__NEON_TIDE_V3__.session.getMode()==='briefing'`);
      const retry = await snapshot(page);
      assert.equal(retry.session.runMode, 'standard');
      assert.equal(retry.session.chapterIndex, 0);
      assert.equal(retry.session.route.roomIndex, 0);
      assert.equal(retry.session.stats.roomsStarted, 0);
      assert.equal(retry.session.stats.roomsCompleted, 0);
      assert.equal(retry.session.build.offerSequence, 0);
      assert.equal(await page.evaluate(`localStorage.getItem('neon-tide:v3:checkpoint')`), null);
      assert.equal(retry.world.pools.bossPart.count, 0);
    });
  }],
];
