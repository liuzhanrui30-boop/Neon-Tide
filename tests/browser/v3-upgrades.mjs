import assert from 'node:assert/strict';
import { APP_URL, withPage } from './harness.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const KEYS = {
  a: ['a', 'KeyA'], d: ['d', 'KeyD'], w: ['w', 'KeyW'], s: ['s', 'KeyS'],
};

async function setMovement(page, desired, held) {
  for (const key of [...held]) {
    if (desired.has(key)) continue;
    await page.dispatchKey('keyUp', ...KEYS[key]);
    held.delete(key);
  }
  for (const key of desired) {
    if (held.has(key)) continue;
    await page.dispatchKey('rawKeyDown', ...KEYS[key]);
    held.add(key);
  }
}

function movementToward(player, target, threshold = 0.18) {
  const desired = new Set();
  const dx = target.x - player.x;
  const dy = target.y - player.y;
  if (dx > threshold) desired.add('d'); else if (dx < -threshold) desired.add('a');
  if (dy > threshold) desired.add('w'); else if (dy < -threshold) desired.add('s');
  return desired;
}

async function completeAnchorRoom(page) {
  const held = new Set();
  const deadline = Date.now() + 45_000;
  try {
    while (Date.now() < deadline) {
      const state = await page.evaluate(`(()=>{const api=globalThis.__NEON_TIDE_V3__;const debug=api.getDebugSnapshot();return {mode:debug.session.mode,player:debug.player?.position,objective:debug.encounter.objective};})()`);
      if (state.mode === 'upgrade') return;
      assert.equal(state.mode, 'playing');
      assert.equal(state.objective.type, 'anchors');
      const target = state.objective.anchors.find(({ completed }) => !completed);
      if (!target) {
        await setMovement(page, new Set(), held);
        await sleep(40);
        continue;
      }
      await setMovement(page, movementToward(state.player, target), held);
      await sleep(40);
    }
  } finally {
    await setMovement(page, new Set(), held);
  }
  throw new Error('natural anchor room did not reach its upgrade offer');
}

async function beginRun(page, starterWeapon) {
  await page.waitForPage(`(()=>{const api=globalThis.__NEON_TIDE_V3__;if(!api?.session||typeof api.getDebugSnapshot!=='function')return false;const debug=api.getDebugSnapshot();return debug?.session?.mode==='menu'&&debug.session.build?.pendingOffer===null;})()`);
  const selected = await page.evaluate(`globalThis.__NEON_TIDE_V3__.session.setStarterWeapon(${JSON.stringify(starterWeapon)})`);
  assert.equal(selected, true);
  await page.startGame();
  await page.waitForPage(`(()=>{const debug=globalThis.__NEON_TIDE_V3__?.getDebugSnapshot?.();return debug?.session?.mode==='playing'&&debug.encounter?.objective?.type==='anchors'&&Number.isFinite(debug.player?.position?.x)&&Number.isFinite(debug.player?.position?.y)&&debug.weapons;})()`);
}

async function readOffer(page) {
  await page.waitForPage(`!document.querySelector('#upgrade-panel').hidden`);
  return page.evaluate(`(()=>{
    const api=globalThis.__NEON_TIDE_V3__;
    const session=api.getDebugSnapshot().session;
    const buttons=[...document.querySelectorAll('#upgrade-options .upgrade-option')];
    return {
      mode:session.mode,
      build:session.build,
      ids:buttons.map((button)=>button.dataset.upgradeId),
      text:buttons.map((button)=>button.textContent),
      labels:buttons.map((button)=>button.getAttribute('aria-label')),
      active:document.activeElement?.dataset?.upgradeId ?? null,
      inert:document.querySelector('#canvas-root').inert,
      inputs:api.inputSystem.snapshot(),
      events:api.getDebugSnapshot().events,
    };
  })()`);
}

async function selectUpgrade(page, id) {
  await page.trustedClick(`#upgrade-options [data-upgrade-id="${id}"]`);
  await page.waitForPage(`globalThis.__NEON_TIDE_V3__?.getDebugSnapshot().session.mode==='playing'`);
  await page.waitForPage(`document.querySelector('#upgrade-panel').hidden && document.activeElement?.tagName==='CANVAS'`);
}

async function measureMovingZoneRate(page) {
  await page.waitForPage(`globalThis.__NEON_TIDE_V3__?.getDebugSnapshot().encounter.objective?.type==='moving-zone'`);
  const held = new Set();
  let start = null;
  let finish = null;
  const deadline = Date.now() + 20_000;
  try {
    while (Date.now() < deadline) {
      const state = await page.evaluate(`(()=>{const debug=globalThis.__NEON_TIDE_V3__.getDebugSnapshot();return {mode:debug.session.mode,player:debug.player.position,objective:debug.encounter.objective};})()`);
      assert.equal(state.mode, 'playing');
      const zone = state.objective.safeZone;
      await setMovement(page, movementToward(state.player, zone, Math.max(0.12, zone.radius * 0.16)), held);
      const distance = Math.hypot(state.player.x - zone.x, state.player.y - zone.y);
      if (!start && distance < zone.radius * 0.42) {
        start = { elapsed: state.objective.elapsed, progress: state.objective.progress };
      }
      if (start && state.objective.elapsed - start.elapsed >= 0.5) {
        finish = { elapsed: state.objective.elapsed, progress: state.objective.progress };
        break;
      }
      await sleep(40);
    }
  } finally {
    await setMovement(page, new Set(), held);
  }
  assert.ok(start && finish, 'moving-zone measurement did not complete');
  return (finish.progress - start.progress) / (finish.elapsed - start.elapsed);
}

export const v3UpgradeScenarios = [
  ['v3 Overload offer survives reload, rejects skipping, restores selection, and drives Arc chains', async () => {
    await withPage('v3-overload-checkpoint-upgrades', { appUrl: `${APP_URL}?objective-test=1&objective-seed=2` }, async (page) => {
      await beginRun(page, 'arc-drones');
      await completeAnchorRoom(page);
      const offered = await readOffer(page);
      assert.equal(offered.mode, 'upgrade');
      assert.deepEqual(offered.ids, offered.build.pendingOffer.cards);
      assert.deepEqual(offered.ids, ['overclock', 'magnet-field', 'overload-relay']);
      assert.ok(offered.text.every((text) => text.includes('0 → 1') && text.includes('//')));
      assert.ok(offered.labels.every((label) => /层数 0 → 1/.test(label) && label.includes('arc-drones')));
      assert.equal(offered.active, offered.ids[0]);
      assert.equal(offered.inert, true);
      assert.deepEqual(offered.inputs, {
        moveX: 0, moveY: 0, dashPressed: false, ultimatePressed: false, inputDevice: 'keyboard',
      });
      assert.equal('aimX' in offered.inputs, false);
      assert.equal(offered.events.dropped, 0);

      const pendingBuild = offered.build;
      const skip = await page.evaluate(`(()=>{try{globalThis.__NEON_TIDE_V3__.session.startRoom({campaign:true,chapterIndex:1});return {threw:false};}catch(error){return {threw:true,message:error.message,session:globalThis.__NEON_TIDE_V3__.session.snapshot()};}})()`);
      assert.equal(skip.threw, true);
      assert.match(skip.message, /upgrade -> playing/);
      assert.deepEqual(skip.session.build, pendingBuild);

      await page.evaluate(`(()=>{const saved=JSON.parse(localStorage.getItem('neon-tide:v3:checkpoint'));saved.version=1;delete saved.route;localStorage.setItem('neon-tide:v3:checkpoint',JSON.stringify(saved));return true;})()`);

      await page.reload();
      const restoredPendingDebug = await page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot()`);
      const restoredPending = restoredPendingDebug.session;
      assert.equal(restoredPending.mode, 'briefing');
      assert.deepEqual(restoredPending.build, pendingBuild);
      assert.deepEqual(restoredPending.route, skip.session.route);
      assert.equal(restoredPendingDebug.persistence.migrations, 1);
      await page.trustedClick('#primary-button');
      const continued = await readOffer(page);
      assert.equal(continued.mode, 'upgrade');
      assert.deepEqual(continued.build, pendingBuild);

      await selectUpgrade(page, 'overload-relay');
      await page.waitForPage(`globalThis.__NEON_TIDE_V3__?.getDebugSnapshot().weapons.lastBuildStats?.chainTargets===3`);
      await page.waitForPage(`(()=>{const api=globalThis.__NEON_TIDE_V3__;return [...api.world.query('friendlyProjectile')].map((id)=>api.world.get(id)).some((entry)=>entry?.type==='arc-chain'&&entry.chainCount===3&&Math.abs(entry.chainRadius-6.6)<1e-9);})()`, 10_000);
      const selected = await page.evaluate(`(()=>{const api=globalThis.__NEON_TIDE_V3__;const debug=api.getDebugSnapshot();const projectiles=[...api.world.query('friendlyProjectile')].map((id)=>api.world.get(id));return {build:debug.session.build,stats:debug.weapons.lastBuildStats,projectiles,focusedCanvas:document.activeElement?.tagName==='CANVAS',events:debug.events,nextRoom:{route:debug.session.route,templateId:debug.session.room?.templateId,chapterIndex:debug.session.chapterIndex,realmIndex:debug.legacy.stageIndex,realm:document.documentElement.dataset.realm,threatBudget:debug.session.room?.threatBudget}};})()`);
      assert.equal(selected.build.upgradeStacks['overload-relay'], 1);
      assert.equal(selected.build.pendingOffer, null);
      assert.equal(selected.stats.starterWeapon, 'arc-drones');
      assert.ok(selected.projectiles.every(({ weaponId }) => weaponId === 'arc-drones'));
      assert.ok(selected.projectiles.some(({ type, chainCount, chainRadius }) => type === 'arc-chain' && chainCount === 3 && Math.abs(chainRadius - 6.6) < 1e-9));
      assert.equal(selected.focusedCanvas, true);
      assert.equal(selected.events.dropped, 0);

      const selectedBuild = selected.build;
      await page.evaluate(`(()=>{const saved=JSON.parse(localStorage.getItem('neon-tide:v3:checkpoint'));saved.version=1;delete saved.route;localStorage.setItem('neon-tide:v3:checkpoint',JSON.stringify(saved));return true;})()`);
      await page.reload();
      const restoredSelectedDebug = await page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot()`);
      const restoredSelected = restoredSelectedDebug.session;
      assert.equal(restoredSelected.mode, 'briefing');
      assert.deepEqual(restoredSelected.build, selectedBuild);
      assert.deepEqual(restoredSelected.route, selected.nextRoom.route);
      assert.equal(restoredSelected.build.pendingOffer, null);
      assert.equal(restoredSelectedDebug.persistence.migrations, 1);
      await page.startGame();
      await page.waitForPage(`(()=>{const debug=globalThis.__NEON_TIDE_V3__?.getDebugSnapshot?.();return debug?.session?.mode==='playing'&&debug.session.room?.templateId&&Number.isFinite(debug.player?.position?.x)&&debug.weapons?.lastBuildStats;})()`);
      const resumed = await page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot()`);
      assert.deepEqual(resumed.session.build, selectedBuild);
      assert.equal(resumed.session.mode, 'playing');
      assert.equal(resumed.weapons.lastBuildStats?.starterWeapon ?? 'arc-drones', 'arc-drones');
      assert.deepEqual({
        route: resumed.session.route,
        templateId: resumed.session.room.templateId,
        chapterIndex: resumed.session.chapterIndex,
        realmIndex: resumed.legacy.stageIndex,
        realm: await page.evaluate(`document.documentElement.dataset.realm`),
        threatBudget: resumed.session.room.threatBudget,
      }, selected.nextRoom);
      assert.equal(resumed.events.dropped, 0);
    });
  }],
  ['v3 Rift choice through a natural room produces one authoritative Prism starter with finite traversal', async () => {
    await withPage('v3-rift-upgrades', { appUrl: `${APP_URL}?objective-test=1&objective-seed=8` }, async (page) => {
      await beginRun(page, 'prism-missiles');
      await completeAnchorRoom(page);
      const offered = await readOffer(page);
      assert.deepEqual(offered.ids, ['prism-fan', 'rift-bore', 'ion-drive']);
      await selectUpgrade(page, 'rift-bore');
      await page.waitForPage(`(()=>{const debug=globalThis.__NEON_TIDE_V3__?.getDebugSnapshot?.();return debug?.session?.mode==='playing'&&Number.isFinite(debug.player?.position?.x)&&Number.isFinite(debug.player?.position?.y)&&debug.weapons?.lastBuildStats?.projectilePierce===1;})()`);
      await page.waitForPage(`(()=>{const api=globalThis.__NEON_TIDE_V3__;return [...api.world.query('friendlyProjectile')].map((id)=>api.world.get(id)).some((entry)=>entry?.type==='prism-missile'&&entry.hitBudgetRemaining===2);})()`, 10_000);
      const evidence = await page.evaluate(`(()=>{const api=globalThis.__NEON_TIDE_V3__;const debug=api.getDebugSnapshot();const projectiles=[...api.world.query('friendlyProjectile')].map((id)=>api.world.get(id));return {build:debug.session.build,stats:debug.weapons.lastBuildStats,projectiles,events:debug.events};})()`);
      assert.equal(evidence.build.upgradeStacks['rift-bore'], 1);
      assert.equal(evidence.stats.starterWeapon, 'prism-missiles');
      assert.equal(evidence.stats.projectilePierce, 1);
      assert.equal(evidence.stats.projectileSpeedMultiplier, 1.08);
      assert.ok(evidence.projectiles.length > 0);
      assert.ok(evidence.projectiles.every(({ weaponId }) => weaponId === 'prism-missiles'));
      assert.ok(evidence.projectiles.some(({ type, hitBudgetRemaining, speed }) => (
        type === 'prism-missile' && hitBudgetRemaining === 2 && Math.abs(speed - 4.8 * 1.08) < 1e-9
      )));
      assert.equal(evidence.events.dropped, 0);
    });
  }],
  ['v3 Tide choice through natural rooms accelerates the real moving objective', async () => {
    await withPage('v3-tide-upgrades', { appUrl: `${APP_URL}?objective-test=1&objective-seed=6` }, async (page) => {
      await beginRun(page, 'pulse-cannon');
      await completeAnchorRoom(page);
      const offered = await readOffer(page);
      assert.deepEqual(offered.ids, ['overclock', 'tide-reserve', 'objective-halo']);
      await selectUpgrade(page, 'objective-halo');
      await page.waitForPage(`globalThis.__NEON_TIDE_V3__?.getDebugSnapshot().weapons.lastBuildStats?.objectiveProximityMultiplier===1.2`);
      const rate = await measureMovingZoneRate(page);
      const evidence = await page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot()`);
      assert.equal(evidence.session.build.upgradeStacks['objective-halo'], 1);
      assert.equal(evidence.weapons.lastBuildStats.starterWeapon, 'pulse-cannon');
      assert.equal(evidence.weapons.lastBuildStats.objectiveProximityMultiplier, 1.2);
      assert.ok(rate > 1.1 && rate < 1.3, JSON.stringify({ rate }));
      const friendly = await page.evaluate(`(()=>{const api=globalThis.__NEON_TIDE_V3__;return [...api.world.query('friendlyProjectile')].map((id)=>api.world.get(id));})()`);
      assert.ok(friendly.every(({ weaponId }) => weaponId === 'pulse-cannon'));
      assert.equal(evidence.events.dropped, 0);
    });
  }],
];
