import assert from 'node:assert/strict';
import { APP_URL, sleep, withPage } from './harness.mjs';
import { ENEMY_ROLE_IDS } from '../../src/content/enemies.js';

const TEST_URL = new URL('?objective-test&objective-seed=90210', APP_URL).href;
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

async function stop(page, held) {
  await setMovement(page, new Set(), held);
}

async function read(page) {
  return page.evaluate(`(()=>{
    const api=globalThis.__NEON_TIDE_V3__;
    const debug=api.getDebugSnapshot();
    const entities=(kind)=>[...api.world.query(kind)].map((id)=>api.world.get(id)).filter(Boolean);
    return {
      mode:debug.session.mode,
      objective:debug.encounter.objective,
      threat:debug.encounter.threatState,
      player:debug.player?.position,
      hull:debug.session.hull,
      warnings:entities('warning'),
      enemies:entities('enemy'),
      renderer:debug.renderer,
    };
  })()`);
}

function movement(dx, dy, tolerance = 0.22) {
  const keys = new Set();
  if (dx > tolerance) keys.add('d'); else if (dx < -tolerance) keys.add('a');
  if (dy > tolerance) keys.add('w'); else if (dy < -tolerance) keys.add('s');
  return keys;
}

async function driveTo(page, target, held, radius = 0.35, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await read(page);
    if (state.mode !== 'playing') return state;
    const dx = target.x - state.player.x;
    const dy = target.y - state.player.y;
    if (Math.hypot(dx, dy) <= radius) {
      await stop(page, held);
      return state;
    }
    await setMovement(page, movement(dx, dy), held);
    await sleep(45);
  }
  throw new Error(`driveTo timed out: ${JSON.stringify(target)}`);
}

async function completeObjective(page) {
  const held = new Set();
  try {
    const initial = await read(page);
    const type = initial.objective.type;
    const deadline = Date.now() + 18_000;
    while (Date.now() < deadline) {
      const state = await read(page);
      if (state.mode === 'upgrade') return type;
      assert.equal(state.mode, 'playing', `${type} ended early: ${JSON.stringify(state)}`);
      const objective = state.objective;
      let target = null;
      let radius = 0.4;
      if (type === 'anchors') {
        target = objective.anchors.find(({ completed }) => !completed);
        radius = Math.max(0.35, target?.radius * 0.45);
      } else if (type === 'moving-zone') {
        target = objective.safeZone;
        radius = Math.max(0.35, target.radius * 0.45);
      } else if (type === 'core-harvest') {
        target = objective.cores.find(({ collected }) => !collected);
        radius = Math.max(0.35, target?.radius * 0.42);
      } else if (type === 'escort') {
        target = objective.escort;
        radius = Math.max(0.45, target.supportRadius * 0.4);
      } else if (type === 'elite-hunt') {
        target = state.enemies.find((enemy) => objective.eliteTargets.some(({ sourceId }) => sourceId === enemy.sourceId));
        radius = 1.25;
      }
      if (target && state.player) {
        const dx = target.x - state.player.x;
        const dy = target.y - state.player.y;
        await setMovement(page, Math.hypot(dx, dy) > radius ? movement(dx, dy) : new Set(), held);
      } else await stop(page, held);
      if (type === 'elite-hunt' || state.hull <= 2) await page.pressKey(' ', 'Space');
      await sleep(55);
    }
    throw new Error(`${type} did not complete`);
  } finally {
    await stop(page, held);
  }
}

async function collectThreatEvidence(page) {
  const held = new Set();
  const directions = [new Set(['w', 'd']), new Set(['s', 'd']), new Set(['s', 'a']), new Set(['w', 'a'])];
  let directionIndex = 0;
  let nextTurn = 0;
  let nextDash = 0;
  let simultaneous = null;
  const deadline = Date.now() + 35_000;
  try {
    while (Date.now() < deadline) {
      const now = Date.now();
      const state = await read(page);
      if (state.mode === 'upgrade') {
        await stop(page, held);
        await page.trustedClick('.upgrade-option');
        await page.waitForPage(`globalThis.__NEON_TIDE_V3__?.getDebugSnapshot().session.mode === 'playing'`);
        nextTurn = 0;
        nextDash = 0;
        continue;
      }
      assert.equal(state.mode, 'playing', `threat evidence ended early: ${JSON.stringify(state)}`);
      if (now >= nextTurn) {
        await setMovement(page, directions[directionIndex++ % directions.length], held);
        nextTurn = now + 520;
      }
      if (now >= nextDash) {
        await page.pressKey(' ', 'Space');
        nextDash = now + 1050;
      }
      const owners = new Set(state.warnings.map(({ ownerId }) => ownerId));
      const progress = new Set(state.warnings.map(({ progress }) => progress.toFixed(3)));
      if (owners.size >= 2 && progress.size >= 2) {
        simultaneous = state;
      }
      if (ENEMY_ROLE_IDS.every((role) => state.threat.rolesSeen.includes(role)) && simultaneous) {
        return { ...simultaneous, threat: state.threat };
      }
      await sleep(45);
    }
  } finally {
    await stop(page, held);
  }
  const state = await read(page);
  throw new Error(`natural role/warning reachability timed out: ${JSON.stringify({ roles: state.threat?.rolesSeen, warnings: state.warnings })}`);
}

export const v3EnemyScenarios = [
  ['v3 natural encounters reach all enemy roles and keep concurrent warnings independently visible', async () => {
    await withPage('v3-natural-enemy-roster', { appUrl: TEST_URL }, async (page) => {
      await page.startGame();
      await page.waitForPage(`globalThis.__NEON_TIDE_V3__?.getDebugSnapshot().encounter.objective?.type === 'anchors'`);
      for (let room = 0; room < 2; room += 1) {
        await completeObjective(page);
        await page.trustedClick('.upgrade-option');
        await page.waitForPage(`globalThis.__NEON_TIDE_V3__?.getDebugSnapshot().session.mode === 'playing'`);
      }
      const current = await read(page);
      assert.equal(current.objective.type, 'core-harvest');
      assert.ok(current.threat.chapterIndex >= 2);
      const evidence = await collectThreatEvidence(page);
      assert.deepEqual([...evidence.threat.rolesSeen].sort(), [...ENEMY_ROLE_IDS].sort());
      const owners = new Set(evidence.warnings.map(({ ownerId }) => ownerId));
      assert.ok(owners.size >= 2);
      assert.ok(new Set(evidence.warnings.map(({ progress }) => progress.toFixed(3))).size >= 2);
      assert.ok(evidence.warnings.every(({ opacity, collidable, flags }) => opacity > 0 && !collidable && flags === 0));
      assert.equal(evidence.renderer.pools.warning.count, evidence.warnings.length);
      assert.equal(evidence.renderer.warningVisibility.hiddenActive, 0);
      assert.ok(evidence.warnings.length > 0);
    });
  }],
];
