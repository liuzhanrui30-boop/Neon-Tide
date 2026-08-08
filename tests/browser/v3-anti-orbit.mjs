import assert from 'node:assert/strict';
import { APP_URL, sleep, withPage } from './harness.mjs';
import { OBJECTIVE_BOUNDARY_ORBIT } from '../../src/content/encounters.js';

const TEST_URL = new URL('?objective-seed=1476', APP_URL).href;
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

function movementKeys(dx, dy, tolerance = 0.14) {
  const desired = new Set();
  if (dx > tolerance) desired.add('d');
  else if (dx < -tolerance) desired.add('a');
  if (dy > tolerance) desired.add('w');
  else if (dy < -tolerance) desired.add('s');
  return desired;
}

async function readState(page) {
  return page.evaluate(`(()=>{
    const api=globalThis.__NEON_TIDE_V3__;
    const debug=api.getDebugSnapshot();
    const counterEntities=[...api.world.query('objective')]
      .map((id)=>api.world.get(id)).filter((entry)=>entry?.objectiveType==='anti-orbit');
    return {
      mode:debug.session.mode,
      hull:debug.session.hull,
      player:debug.player?.position,
      objective:debug.encounter.objective,
      antiOrbit:debug.encounter.antiOrbit,
      counterEntities,
      renderedObjectives:debug.renderer.pools?.objective?.count ?? 0,
    };
  })()`);
}

async function moveTo(page, target, held, { timeoutMs = 8_000, observe = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readState(page);
    assert.equal(state.mode, 'playing', `anti-orbit input left gameplay: ${JSON.stringify(state)}`);
    observe?.(state);
    const dx = target.x - state.player.x;
    const dy = target.y - state.player.y;
    if (Math.hypot(dx, dy) <= 0.2) {
      await setMovement(page, new Set(), held);
      return state;
    }
    await setMovement(page, movementKeys(dx, dy), held);
    await sleep(30);
  }
  throw new Error(`anti-orbit movement timed out: ${JSON.stringify(target)}`);
}

async function fixedOrbitTriggersReadablePressure(page) {
  const held = new Set();
  let preview = null;
  let active = null;
  const samples = [];
  const initial = await readState(page);
  const anchorsBefore = initial.objective.anchors.map(({ sourceId, x, y }) => ({ sourceId, x, y }));
  const observe = (state) => {
    samples.push({ ...state.player });
    const counter = state.antiOrbit.activeCounter;
    if (!preview && counter?.phase === 'preview' && state.counterEntities.length > 0) {
      preview = {
        counter,
        entities: state.counterEntities,
        renderedObjectives: state.renderedObjectives,
      };
    }
    const geometryShifted = anchorsBefore.some((before) => {
      const current = state.objective.anchors.find(({ sourceId }) => sourceId === before.sourceId);
      return current && Math.hypot(current.x - before.x, current.y - before.y) > 1;
    });
    const collisionReady = state.counterEntities.some(({ collidable, contactDamaging }) => collidable && contactDamaging);
    if (!active && counter?.phase === 'active' && (geometryShifted || collisionReady)) {
      active = {
        counter,
        entities: state.counterEntities,
        objective: state.objective,
        hull: state.hull,
      };
    }
  };

  try {
    await moveTo(page, { x: OBJECTIVE_BOUNDARY_ORBIT.radiusX, y: 0 }, held, { observe });
    for (let lapPoint = 1; lapPoint <= 72 && !active; lapPoint += 1) {
      const angle = (lapPoint / 48) * Math.PI * 2;
      await moveTo(page, {
        x: Math.cos(angle) * OBJECTIVE_BOUNDARY_ORBIT.radiusX,
        y: Math.sin(angle) * OBJECTIVE_BOUNDARY_ORBIT.radiusY,
      }, held, { observe, timeoutMs: 6_000 });
    }
  } finally {
    await setMovement(page, new Set(), held);
  }

  const after = await readState(page);
  assert.ok(preview, `fixed orbit never exposed a readable preview: ${JSON.stringify(after.antiOrbit)}`);
  assert.ok(preview.counter.previewSeconds >= 0.65);
  assert.ok(preview.entities.every(({ collidable, state }) => !collidable && state === 'telegraph'));
  assert.ok(preview.renderedObjectives >= preview.entities.length);
  assert.ok(active, `fixed orbit never reached active route pressure: ${JSON.stringify(after.antiOrbit)}`);
  assert.ok(active.entities.length > 0);

  const shifted = anchorsBefore.some((before) => {
    const current = active.objective.anchors.find(({ sourceId }) => sourceId === before.sourceId);
    return current && Math.hypot(current.x - before.x, current.y - before.y) > 1;
  });
  const collisionPressure = active.entities.some(({ collidable, contactDamaging }) => collidable && contactDamaging);
  assert.ok(shifted || collisionPressure || active.hull < initial.hull,
    `counter neither moved authoritative geometry nor created collision pressure: ${JSON.stringify(active)}`);
  assert.ok(after.antiOrbit.countersStarted >= 1);

  const normalized = samples.slice(-Math.min(samples.length, 180)).map(({ x, y }) => Math.hypot(
    x / OBJECTIVE_BOUNDARY_ORBIT.radiusX,
    y / OBJECTIVE_BOUNDARY_ORBIT.radiusY,
  ));
  assert.ok(normalized.length > 30);
  assert.ok(Math.max(...normalized) - Math.min(...normalized) < 0.38,
    `real fixed-orbit input was not arena-edge motion: ${JSON.stringify({ min: Math.min(...normalized), max: Math.max(...normalized) })}`);
}

async function variedRouteAvoidsFalseCounter(page) {
  const held = new Set();
  const waypoints = [
    { x: 7.8, y: 0.4 }, { x: -1.5, y: 4.8 }, { x: 3.2, y: -4.4 },
    { x: -7.6, y: -1.2 }, { x: 0.3, y: 0.2 }, { x: 6.4, y: 3.6 },
    { x: -4.8, y: -4.2 }, { x: 1.2, y: 4.9 },
  ];
  try {
    for (const waypoint of waypoints) await moveTo(page, waypoint, held, { timeoutMs: 8_000 });
  } finally {
    await setMovement(page, new Set(), held);
  }
  await sleep(250);
  const after = await readState(page);
  assert.equal(after.mode, 'playing');
  assert.equal(after.antiOrbit.countersStarted, 0,
    `varied real input falsely triggered anti-orbit: ${JSON.stringify(after.antiOrbit)}`);
  assert.equal(after.counterEntities.length, 0);
}

export const v3AntiOrbitScenarios = [
  ['v3 natural real input triggers readable orbit pressure without false varied-route counters', async () => {
    await withPage('v3-fixed-orbit-counter', { appUrl: TEST_URL }, async (page) => {
      await page.startGame();
      await page.waitForPage(`globalThis.__NEON_TIDE_V3__?.getDebugSnapshot().encounter.objective?.type === 'anchors'`);
      await fixedOrbitTriggersReadablePressure(page);
    });
    await withPage('v3-varied-route-no-counter', { appUrl: TEST_URL }, async (page) => {
      await page.startGame();
      await page.waitForPage(`globalThis.__NEON_TIDE_V3__?.getDebugSnapshot().encounter.objective?.type === 'anchors'`);
      await variedRouteAvoidsFalseCounter(page);
    });
  }],
];
