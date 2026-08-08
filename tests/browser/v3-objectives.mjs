import assert from 'node:assert/strict';
import { APP_URL, sleep, withPage } from './harness.mjs';

const TEST_URL = new URL('?objective-test', APP_URL).href;
const KEY_DEFS = Object.freeze({
  a: ['a', 'KeyA'], d: ['d', 'KeyD'], w: ['w', 'KeyW'], s: ['s', 'KeyS'],
});

async function setMovement(page, desired, held) {
  for (const key of [...held]) {
    if (desired.has(key)) continue;
    const [value, code] = KEY_DEFS[key];
    await page.dispatchKey('keyUp', value, code);
    held.delete(key);
  }
  for (const key of desired) {
    if (held.has(key)) continue;
    const [value, code] = KEY_DEFS[key];
    await page.dispatchKey('rawKeyDown', value, code);
    held.add(key);
  }
}

async function stopMovement(page, held) {
  await setMovement(page, new Set(), held);
}

async function readState(page) {
  return page.evaluate(`(()=>{
    const debug=globalThis.__NEON_TIDE_V3__.getDebugSnapshot();
    return {
      mode:debug.session.mode,
      room:debug.session.room,
      objective:debug.encounter.objective,
      player:debug.player?.position,
      bridge:debug.objectiveBridge,
      renderer:debug.renderer,
      world:debug.world,
    };
  })()`);
}

function activeTarget(objective, player) {
  if (!objective || !player) return null;
  if (objective.type === 'anchors') return objective.anchors.find((entry) => !entry.completed) ?? null;
  if (objective.type === 'moving-zone' || objective.type === 'storm-corridor') return objective.safeZone;
  if (objective.type === 'escort') return objective.escort;
  if (objective.type === 'core-harvest') {
    return objective.cores.filter((entry) => !entry.collected)
      .sort((a, b) => Math.hypot(a.x - player.x, a.y - player.y) - Math.hypot(b.x - player.x, b.y - player.y))[0] ?? null;
  }
  return null;
}

async function playObjectiveWithKeys(page, expectedType) {
  const held = new Set();
  const positions = [];
  const targetPositions = [];
  let maximumProgress = 0;
  const deadline = Date.now() + 24000;
  try {
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__?.getDebugSnapshot().objectiveBridge.entities > 0`, 3000);
    while (Date.now() < deadline) {
      const state = await readState(page);
      if (state.mode === 'upgrade') break;
      assert.equal(state.mode, 'playing', `objective run ended early: ${JSON.stringify(state)}`);
      assert.equal(state.objective?.type, expectedType, JSON.stringify(state.objective));
      if (state.bridge.entities === 0 && (state.room.combatFrozen || state.objective.status === 'completed')) {
        await stopMovement(page, held);
        await sleep(40);
        continue;
      }
      assert.ok(state.bridge.entities > 0, `objective geometry was not materialized: ${JSON.stringify(state.bridge)}`);
      assert.ok((state.renderer.pools?.objective?.count ?? 0) + (state.renderer.pools?.pickup?.count ?? 0) > 0,
        `objective geometry was not rendered: ${JSON.stringify(state.renderer)}`);
      maximumProgress = Math.max(maximumProgress, Number(state.objective.progress) || 0);
      positions.push({ ...state.player });
      const target = activeTarget(state.objective, state.player);
      assert.ok(target, `no playable target for ${expectedType}: ${JSON.stringify(state.objective)}`);
      targetPositions.push({ x: target.x, y: target.y });
      const dx = target.x - state.player.x;
      const dy = target.y - state.player.y;
      const radius = Math.max(0.28, Number(target.radius ?? target.supportRadius ?? 0.65) * 0.48);
      const desired = new Set();
      if (Math.hypot(dx, dy) > radius) {
        if (dx > 0.18) desired.add('d');
        else if (dx < -0.18) desired.add('a');
        if (dy > 0.18) desired.add('w');
        else if (dy < -0.18) desired.add('s');
      }
      await setMovement(page, desired, held);
      await sleep(55);
    }
  } finally {
    await stopMovement(page, held);
  }
  const finished = await readState(page);
  assert.equal(finished.mode, 'upgrade', `${expectedType} did not complete: ${JSON.stringify(finished)}`);
  assert.equal(finished.bridge.entities, 0, `cleanup left objective entities alive: ${JSON.stringify(finished.bridge)}`);
  assert.ok(maximumProgress > 0, `${expectedType} never advanced through real input`);
  const travel = positions.reduce((total, point, index) => index === 0 ? 0 : total
    + Math.hypot(point.x - positions[index - 1].x, point.y - positions[index - 1].y), 0);
  assert.ok(travel > 0.5, `${expectedType} completed without meaningful player travel (${travel})`);
  const distinctTargets = new Set(targetPositions.map(({ x, y }) => `${x.toFixed(1)}:${y.toFixed(1)}`));
  assert.ok(distinctTargets.size > 1, `${expectedType} did not require a route change: ${JSON.stringify([...distinctTargets])}`);
  return { travel, distinctTargets: distinctTargets.size, bridge: finished.bridge };
}

export const v3ObjectiveScenarios = [
  ['v3 natural objectives are visible and completed through real browser input', async () => {
    await withPage('v3-natural-objective-flow', { appUrl: TEST_URL }, async (page) => {
      await page.startGame();
      await page.waitForPage(`globalThis.__NEON_TIDE_V3__?.getDebugSnapshot().encounter.objective?.type === 'anchors'`);
      const expected = ['anchors', 'moving-zone', 'core-harvest', 'escort'];
      const results = [];
      for (let index = 0; index < expected.length; index += 1) {
        results.push(await playObjectiveWithKeys(page, expected[index]));
        const beforeUpgrade = await readState(page);
        assert.equal(beforeUpgrade.room.objectiveManaged, true);
        assert.equal(beforeUpgrade.room.combatFrozen, true);
        await page.trustedClick('.upgrade-option');
        if (index < expected.length - 1) {
          await page.waitForPage(`(()=>{
            const debug=globalThis.__NEON_TIDE_V3__?.getDebugSnapshot();
            return debug?.session.mode==='playing'&&debug?.encounter.objective?.type===${JSON.stringify(expected[index + 1])};
          })()`, 5000);
        }
      }
      assert.equal(results.length, 4);
      assert.ok(results.every((entry) => entry.bridge.cleanupEvents > 0));
      const eliteSourceId = 734003201;
      await page.evaluate(`globalThis.__NEON_TIDE_V3__.events.emit('objective:spawn',{
        objectiveId:'elite-browser-probe',role:'elite-target',targets:[{id:'elite-1',sourceId:${eliteSourceId},x:2,y:1}]
      })`);
      await page.waitForPage(`[...globalThis.__NEON_TIDE_V3__.world.query('enemy')]
        .some((id)=>globalThis.__NEON_TIDE_V3__.world.get(id)?.sourceId===${eliteSourceId})`);
      const elite = await page.evaluate(`[...globalThis.__NEON_TIDE_V3__.world.query('enemy')]
        .map((id)=>globalThis.__NEON_TIDE_V3__.world.get(id)).find((entry)=>entry?.sourceId===${eliteSourceId})`);
      assert.equal(elite.sourceId, eliteSourceId);
      assert.equal(elite.role, 'elite');
    });
  }],
];
