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
      const dx = target.x - state.player.x;
      const dy = target.y - state.player.y;
      const desired = new Set();
      if (dx > 0.18) desired.add('d'); else if (dx < -0.18) desired.add('a');
      if (dy > 0.18) desired.add('w'); else if (dy < -0.18) desired.add('s');
      await setMovement(page, desired, held);
      await sleep(40);
    }
  } finally {
    await setMovement(page, new Set(), held);
  }
  throw new Error('natural anchor room did not reach its upgrade offer');
}

export const v3UpgradeScenarios = [
  ['v3 natural room offers accessible deterministic build cards and applies gameplay stats', async () => {
    await withPage('v3-natural-upgrades', { appUrl: `${APP_URL}?objective-test=1&objective-seed=123` }, async (page) => {
      await page.startGame();
      await page.waitForPage(`globalThis.__NEON_TIDE_V3__?.getDebugSnapshot().encounter.objective?.type==='anchors'`);
      await completeAnchorRoom(page);
      await page.waitForPage(`!document.querySelector('#upgrade-panel').hidden`);
      const offered = await page.evaluate(`(()=>{
        const api=globalThis.__NEON_TIDE_V3__;
        const session=api.getDebugSnapshot().session;
        const buttons=[...document.querySelectorAll('#upgrade-options .upgrade-option')];
        return {
          mode:session.mode,
          pending:session.build.pendingOffer,
          ids:buttons.map((button)=>button.dataset.upgradeId),
          text:buttons.map((button)=>button.textContent),
          labels:buttons.map((button)=>button.getAttribute('aria-label')),
          active:document.activeElement?.dataset?.upgradeId ?? null,
          inert:document.querySelector('#canvas-root').inert,
          inputs:api.inputSystem.snapshot(),
        };
      })()`);
      assert.equal(offered.mode, 'upgrade');
      assert.deepEqual(offered.ids, offered.pending.cards);
      assert.deepEqual(offered.ids, ['echo-shield', 'overload-relay', 'lance-overload']);
      assert.ok(offered.text.every((text) => text.includes('0 → 1') && text.includes('//')));
      assert.ok(offered.labels.every((label) => /层数 0 → 1/.test(label)));
      assert.equal(offered.active, offered.ids[0]);
      assert.equal(offered.inert, true);
      assert.deepEqual(offered.inputs, {
        moveX: 0, moveY: 0, dashPressed: false, ultimatePressed: false, inputDevice: 'keyboard',
      });
      assert.equal('aimX' in offered.inputs, false);

      await page.pressKey('2', 'Digit2');
      await page.waitForPage(`globalThis.__NEON_TIDE_V3__?.getDebugSnapshot().session.mode==='playing'`);
      await page.waitForPage(`globalThis.__NEON_TIDE_V3__?.getDebugSnapshot().weapons.lastBuildStats?.chainTargets===3`);
      await page.waitForPage(`(()=>{const api=globalThis.__NEON_TIDE_V3__;return [...api.world.query('friendlyProjectile')].map((id)=>api.world.get(id)).some((entry)=>entry?.type==='arc-chain'&&entry.chainCount===3);})()`, 8_000);
      const selected = await page.evaluate(`(()=>{
        const api=globalThis.__NEON_TIDE_V3__;
        const debug=api.getDebugSnapshot();
        const arcs=[...api.world.query('friendlyProjectile')].map((id)=>api.world.get(id)).filter((entry)=>entry?.type==='arc-chain');
        return {
          build:debug.session.build,
          stats:debug.weapons.lastBuildStats,
          arcChains:arcs.map(({chainCount})=>chainCount),
          panelHidden:document.querySelector('#upgrade-panel').hidden,
          focusedCanvas:document.activeElement?.tagName==='CANVAS',
        };
      })()`);
      assert.equal(selected.build.upgradeStacks['overload-relay'], 1);
      assert.equal(selected.build.pendingOffer, null);
      assert.equal(selected.stats.chainTargets, 3);
      assert.ok(selected.arcChains.some((count) => count === 3));
      assert.equal(selected.panelHidden, true);
      assert.equal(selected.focusedCanvas, true);
    });
  }],
];
