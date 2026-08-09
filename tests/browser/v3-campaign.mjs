import assert from 'node:assert/strict';
import { APP_URL, withPage } from './harness.mjs';

const CAMPAIGN_URL = new URL('?campaign-test=1&objective-seed=4242', APP_URL).href;

async function snapshot(page) {
  return page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot()`);
}

async function resourceNames(page) {
  return page.evaluate(`performance.getEntriesByType('resource').map((entry)=>entry.name)`);
}

function hasChapterResource(resources, chapter) {
  const fragments = {
    'data-city': ['chapter-data-city', 'chapter-chunks/data-city'],
    'star-forge': ['chapter-star-forge', 'chapter-chunks/star-forge'],
    'void-cathedral': ['chapter-void-cathedral', 'chapter-chunks/void-cathedral'],
  }[chapter];
  return resources.some((url) => fragments.some((fragment) => url.includes(fragment)));
}

async function completeNode(page) {
  const before = await snapshot(page);
  assert.equal(before.session.mode, 'playing');
  assert.equal(before.session.route.kind, 'campaign');
  assert.equal(before.session.room.id, before.session.route.templateId);
  const node = {
    routeIndex: before.session.route.roomIndex,
    chapterIndex: before.session.chapterIndex,
    kind: before.session.room.kind,
    id: before.session.room.id,
  };
  assert.equal(await page.evaluate(`globalThis.__NEON_TIDE_V3__.session.completeRoom()`), true);
  await page.waitForPage(`globalThis.__NEON_TIDE_V3__.session.getMode()!=='playing'`);
  const completed = await snapshot(page);
  if (completed.session.mode === 'upgrade') {
    assert.equal(completed.session.build.pendingOffer.cards.length, 3);
    await page.trustedClick('#upgrade-options .upgrade-option');
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.session.getMode()==='playing'`);
    await page.waitForPage(`document.querySelector('#upgrade-panel').hidden`);
    return { ...node, outcome: 'upgrade' };
  }
  if (completed.session.mode === 'chapterComplete') {
    assert.equal(completed.session.build.pendingOffer ?? null, null);
    await page.trustedClick('#primary-button');
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.session.getMode()==='playing'`);
    return { ...node, outcome: 'chapterComplete' };
  }
  assert.equal(completed.session.mode, 'victory');
  return { ...node, outcome: 'victory' };
}

export const v3CampaignScenarios = [
  ['v3 campaign routes four lazy chapters with Standard resume and Abyss full reset', async () => {
    await withPage('v3-campaign-standard-abyss', { appUrl: CAMPAIGN_URL }, async (page) => {
      const menu = await page.evaluate(`(()=>({
        mode:globalThis.__NEON_TIDE_V3__.session.getMode(),
        selected:document.querySelector('input[name="run-mode"]:checked')?.value,
        labels:[...document.querySelectorAll('.mode-option')].map((entry)=>entry.textContent.trim()),
        map:[...document.querySelectorAll('#journey-strip li')].map((entry)=>({realm:entry.dataset.realm,state:entry.dataset.state,nodes:entry.querySelectorAll('.chapter-nodes i').length})),
        input:globalThis.__NEON_TIDE_V3__.inputSystem.snapshot(),
      }))()`);
      assert.equal(menu.mode, 'menu', 'a persisted preference must never auto-start a run');
      assert.equal(menu.selected, 'standard');
      assert.ok(menu.labels[0].includes('章节检查点'));
      assert.ok(menu.labels[1].includes('整局重开'));
      assert.deepEqual(menu.map.map(({ realm, nodes }) => [realm, nodes]), [
        ['abyss', 4], ['data-city', 4], ['star-forge', 4], ['void-cathedral', 3],
      ]);
      assert.equal('aimX' in menu.input, false);
      const initialResources = await resourceNames(page);
      assert.equal(hasChapterResource(initialResources, 'data-city'), false);
      assert.equal(hasChapterResource(initialResources, 'star-forge'), false);
      assert.equal(hasChapterResource(initialResources, 'void-cathedral'), false);

      await page.startGame();
      let route = [];
      let upgrades = 0;
      for (let index = 0; index < 4; index += 1) {
        const node = await completeNode(page);
        route.push(node);
        if (node.outcome === 'upgrade') upgrades += 1;
      }
      let standard = await snapshot(page);
      assert.equal(standard.session.mode, 'playing');
      assert.equal(standard.session.chapterIndex, 1);
      assert.equal(standard.session.route.roomIndex, 4);
      assert.equal(upgrades, 3);
      const entryCheckpoint = await page.evaluate(`JSON.parse(localStorage.getItem('neon-tide:v3:checkpoint'))`);
      assert.equal(entryCheckpoint.chapterIndex, 1);
      assert.equal(entryCheckpoint.route.roomIndex, 4);
      assert.deepEqual(entryCheckpoint.build, standard.session.build);
      await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().campaignContent.loads['data-city']==='loaded'`);
      let resources = await resourceNames(page);
      assert.equal(hasChapterResource(resources, 'data-city'), true);
      assert.equal(hasChapterResource(resources, 'star-forge'), false);
      assert.equal(hasChapterResource(resources, 'void-cathedral'), false);

      assert.equal(await page.evaluate(`globalThis.__NEON_TIDE_V3__.session.damageHull(globalThis.__NEON_TIDE_V3__.session.getHull())`), true);
      await page.waitForPage(`globalThis.__NEON_TIDE_V3__.session.getMode()==='briefing'`);
      const restoredAfterDeath = await snapshot(page);
      assert.equal(restoredAfterDeath.session.chapterIndex, 1);
      assert.equal(restoredAfterDeath.session.route.roomIndex, 4);
      assert.deepEqual(restoredAfterDeath.session.build, entryCheckpoint.build);
      assert.equal(await page.evaluate(`document.querySelector('#primary-label').textContent`), '从都市继续');

      await page.reload();
      const reloadState = await snapshot(page);
      assert.equal(reloadState.session.mode, 'briefing');
      assert.equal(reloadState.session.chapterIndex, 1);
      assert.deepEqual(reloadState.session.build, entryCheckpoint.build);
      assert.equal(await page.evaluate(`document.querySelector('input[name="run-mode"]:checked').value`), 'standard');
      await page.startGame();

      while ((await snapshot(page)).session.mode !== 'victory') {
        const node = await completeNode(page);
        route.push(node);
        if (node.outcome === 'upgrade') upgrades += 1;
        const current = await snapshot(page);
        resources = await resourceNames(page);
        if (current.session.chapterIndex >= 2) {
          await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().campaignContent.loads['star-forge']==='loaded'`);
          resources = await resourceNames(page);
          assert.equal(hasChapterResource(resources, 'star-forge'), true);
        }
        if (current.session.chapterIndex >= 3) {
          await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().campaignContent.loads['void-cathedral']==='loaded'`);
          resources = await resourceNames(page);
          assert.equal(hasChapterResource(resources, 'void-cathedral'), true);
        }
      }
      standard = await snapshot(page);
      assert.equal(standard.session.stats.roomsCompleted, 15);
      assert.equal(upgrades, 9);
      assert.deepEqual(route.map(({ chapterIndex }) => chapterIndex), [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3]);
      assert.equal(route.filter(({ kind }) => kind === 'room').length, 11);
      assert.equal(route.filter(({ kind }) => kind === 'boss').length, 4);
      assert.equal(standard.session.build.offerSequence, 9);
      assert.equal(standard.events.dropped, 0);

      await page.trustedClick('.mode-option.danger');
      assert.equal(await page.evaluate(`globalThis.__NEON_TIDE_V3__.session.getMode()`), 'victory');
      assert.equal(await page.evaluate(`localStorage.getItem('neon-tide:v3:mode-preference')`), 'abyss');
      await page.startGame();
      const abyssStart = await snapshot(page);
      assert.equal(abyssStart.session.runMode, 'abyss');
      assert.equal(abyssStart.session.chapterIndex, 0);
      assert.equal(abyssStart.session.route.roomIndex, 0);
      assert.equal(await page.evaluate(`localStorage.getItem('neon-tide:v3:checkpoint')`), null);
      await completeNode(page);
      assert.equal(await page.evaluate(`globalThis.__NEON_TIDE_V3__.session.damageHull(globalThis.__NEON_TIDE_V3__.session.getHull())`), true);
      await page.waitForPage(`globalThis.__NEON_TIDE_V3__.session.getMode()==='briefing'`);
      const abyssReset = await snapshot(page);
      assert.equal(abyssReset.session.runMode, 'abyss');
      assert.equal(abyssReset.session.chapterIndex, 0);
      assert.equal(abyssReset.session.route.roomIndex, 0);
      assert.deepEqual(abyssReset.session.stats, { roomsStarted: 0, roomsCompleted: 0, damageTaken: 0, score: 0 });
      assert.equal(await page.evaluate(`localStorage.getItem('neon-tide:v3:checkpoint')`), null);
      const abyssButton = await page.evaluate(`document.querySelector('#primary-label').textContent`);
      assert.equal(abyssButton, '重新坠入深渊');
      assert.doesNotMatch(abyssButton, /继续/);

      await page.reload();
      const preferenceOnly = await snapshot(page);
      assert.equal(preferenceOnly.session.mode, 'menu');
      assert.equal(await page.evaluate(`document.querySelector('input[name="run-mode"]:checked').value`), 'abyss');
      assert.equal(await page.evaluate(`document.querySelector('#overlay').classList.contains('visible')`), true);
    });
  }],
];
