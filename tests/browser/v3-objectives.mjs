import assert from 'node:assert/strict';
import { APP_URL, sleep, withPage } from './harness.mjs';

const TEST_URL = new URL('?objective-seed=1476', APP_URL).href;
const EDGE_CENTER = Object.freeze({ x: 9.1, y: 0 });
const EDGE_RADIUS = 0.9;
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
    const api=globalThis.__NEON_TIDE_V3__;
    const debug=api.getDebugSnapshot();
    return {
      mode:debug.session.mode,
      room:debug.session.room,
      objective:debug.encounter.objective,
      player:debug.player?.position,
      bridge:debug.objectiveBridge,
      renderer:debug.renderer,
      world:debug.world,
      enemies:[...api.world.query('enemy')].map((id)=>api.world.get(id)).filter(Boolean),
    };
  })()`);
}

function movementKeys(dx, dy, tolerance = 0.15) {
  const desired = new Set();
  if (dx > tolerance) desired.add('d');
  else if (dx < -tolerance) desired.add('a');
  if (dy > tolerance) desired.add('w');
  else if (dy < -tolerance) desired.add('s');
  return desired;
}

function objectiveBlockers(objective) {
  if (objective.type === 'anchors') {
    return objective.anchors.filter(({ completed }) => !completed)
      .map(({ x, y, radius }) => ({ x, y, radius: radius + 0.65 }));
  }
  if (objective.type === 'moving-zone') {
    return [{ x: objective.safeZone.x, y: objective.safeZone.y, radius: objective.safeZone.radius + 0.65 }];
  }
  if (objective.type === 'core-harvest') {
    return objective.cores.filter(({ collected }) => !collected)
      .map(({ x, y, radius }) => ({ x, y, radius: radius + 0.9 }));
  }
  if (objective.type === 'escort') {
    return [{ x: objective.escort.x, y: objective.escort.y, radius: objective.escort.supportRadius + 0.65 }];
  }
  return [];
}

function segmentIsClear(start, end, blockers) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  return blockers.every((blocker) => {
    const projection = lengthSquared > 0
      ? Math.max(0, Math.min(1, ((blocker.x - start.x) * dx + (blocker.y - start.y) * dy) / lengthSquared))
      : 0;
    return Math.hypot(
      blocker.x - (start.x + dx * projection),
      blocker.y - (start.y + dy * projection),
    ) >= blocker.radius;
  });
}

function segmentLeavesClearance(start, end, blockers) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  return blockers.every((blocker) => {
    const startDx = start.x - blocker.x;
    const startDy = start.y - blocker.y;
    const startDistance = Math.hypot(startDx, startDy);
    if (startDistance >= blocker.radius) return segmentIsClear(start, end, [blocker]);
    const endDistance = Math.hypot(end.x - blocker.x, end.y - blocker.y);
    return endDistance > startDistance && startDx * dx + startDy * dy >= 0;
  });
}

function safeStagingPath(start, goal, blockers) {
  assert.equal(segmentIsClear(goal, goal, blockers), true, 'fixed edge circle must remain outside authored targets');
  if (segmentIsClear(start, goal, blockers)) return [goal];
  const step = 0.45;
  const minX = -9.9;
  const minY = -6.3;
  const columns = 45;
  const rows = 29;
  const point = (index) => ({
    x: minX + (index % columns) * step,
    y: minY + Math.floor(index / columns) * step,
  });
  const count = columns * rows;
  const blocked = new Uint8Array(count);
  for (let index = 0; index < count; index += 1) {
    const candidate = point(index);
    blocked[index] = blockers.some((entry) => Math.hypot(candidate.x - entry.x, candidate.y - entry.y) < entry.radius) ? 1 : 0;
  }
  const nearestClear = (origin, canConnect = segmentIsClear) => {
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < count; index += 1) {
      if (blocked[index]) continue;
      const candidate = point(index);
      const distance = Math.hypot(candidate.x - origin.x, candidate.y - origin.y);
      if (distance < bestDistance && canConnect(origin, candidate, blockers)) {
        best = index;
        bestDistance = distance;
      }
    }
    return best;
  };
  const startIndex = nearestClear(start, segmentLeavesClearance);
  const goalIndex = nearestClear(goal);
  assert.ok(startIndex >= 0 && goalIndex >= 0, 'edge-circle staging has no clear grid endpoint');
  const previous = new Int32Array(count).fill(-1);
  const visited = new Uint8Array(count);
  const queue = new Int32Array(count);
  let head = 0;
  let tail = 0;
  queue[tail++] = startIndex;
  visited[startIndex] = 1;
  const directions = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  while (head < tail && !visited[goalIndex]) {
    const current = queue[head++];
    const column = current % columns;
    const row = Math.floor(current / columns);
    for (const [columnDelta, rowDelta] of directions) {
      const nextColumn = column + columnDelta;
      const nextRow = row + rowDelta;
      if (nextColumn < 0 || nextColumn >= columns || nextRow < 0 || nextRow >= rows) continue;
      const next = nextRow * columns + nextColumn;
      if (blocked[next] || visited[next]) continue;
      if (!segmentIsClear(point(current), point(next), blockers)) continue;
      visited[next] = 1;
      previous[next] = current;
      queue[tail++] = next;
    }
  }
  assert.equal(visited[goalIndex], 1, 'edge-circle staging route must avoid all authored targets');
  const reversed = [];
  for (let cursor = goalIndex; cursor !== -1; cursor = previous[cursor]) reversed.push(point(cursor));
  reversed.reverse();
  const path = [];
  let anchor = start;
  for (let index = 0; index < reversed.length;) {
    let furthest = index;
    while (furthest + 1 < reversed.length && segmentIsClear(anchor, reversed[furthest + 1], blockers)) furthest += 1;
    path.push(reversed[furthest]);
    anchor = reversed[furthest];
    index = furthest + 1;
  }
  if (!segmentIsClear(anchor, goal, blockers)) path.push(point(goalIndex));
  path.push(goal);
  return path;
}

async function moveTo(page, target, held, {
  tolerance = 0.24, timeoutMs = 8_000, expectedType = null, requireZero = false, samples = null,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await readState(page);
    assert.equal(state.mode, 'playing', `movement left gameplay: ${JSON.stringify(state)}`);
    if (expectedType) assert.equal(state.objective?.type, expectedType);
    if (requireZero) assert.equal(state.objective?.progress, 0,
      `${expectedType} advanced before the authored route change: ${JSON.stringify(state.objective)}`);
    samples?.push({ ...state.player });
    const dx = target.x - state.player.x;
    const dy = target.y - state.player.y;
    if (Math.hypot(dx, dy) <= tolerance) {
      await stopMovement(page, held);
      return state;
    }
    await setMovement(page, movementKeys(dx, dy), held);
    await sleep(35);
  }
  throw new Error(`timed out moving to ${JSON.stringify(target)}`);
}

async function proveEdgeCircleDoesNotProgress(page, expectedType) {
  const held = new Set();
  const samples = [];
  try {
    const initial = await readState(page);
    const circleStart = { x: EDGE_CENTER.x + EDGE_RADIUS, y: EDGE_CENTER.y };
    const stagingPath = safeStagingPath(initial.player, circleStart, objectiveBlockers(initial.objective));
    for (const waypoint of stagingPath) {
      await moveTo(page, waypoint, held, { expectedType, requireZero: true, timeoutMs: 10_000 });
    }
    const waypointCount = 24;
    for (let index = 1; index <= waypointCount; index += 1) {
      const angle = (index / waypointCount) * Math.PI * 2;
      await moveTo(page, {
        x: EDGE_CENTER.x + Math.cos(angle) * EDGE_RADIUS,
        y: EDGE_CENTER.y + Math.sin(angle) * EDGE_RADIUS,
      }, held, { expectedType, requireZero: true, samples, tolerance: 0.2 });
    }
  } finally {
    await stopMovement(page, held);
  }
  await sleep(320);
  const after = await readState(page);
  assert.equal(after.objective.progress, 0, `${expectedType} progressed on the fixed-radius edge circle`);
  assert.ok(samples.length >= 20);
  const radii = samples.map(({ x, y }) => Math.hypot(x - EDGE_CENTER.x, y - EDGE_CENTER.y));
  assert.ok(Math.min(...radii) >= 0.4 && Math.max(...radii) <= 1.65,
    `input route was not a bounded edge circle: ${JSON.stringify({ min: Math.min(...radii), max: Math.max(...radii) })}`);
  return { samples: samples.length, minRadius: Math.min(...radii), maxRadius: Math.max(...radii) };
}

function activeTarget(objective, player) {
  if (!objective || !player) return null;
  if (objective.type === 'anchors') return objective.anchors.find((entry) => !entry.completed) ?? null;
  if (objective.type === 'moving-zone') return objective.safeZone;
  if (objective.type === 'escort') return objective.escort;
  if (objective.type === 'core-harvest') {
    return objective.cores.filter((entry) => !entry.collected)
      .sort((a, b) => Math.hypot(a.x - player.x, a.y - player.y) - Math.hypot(b.x - player.x, b.y - player.y))[0] ?? null;
  }
  return null;
}

async function completeRouteObjective(page, expectedType) {
  const held = new Set();
  const positions = [];
  const targetPositions = [];
  let maximumProgress = 0;
  const deadline = Date.now() + 90_000;
  try {
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
      const radius = Math.max(0.24, Number(target.radius ?? target.supportRadius ?? 0.65) * 0.42);
      const desired = Math.hypot(dx, dy) > radius ? movementKeys(dx, dy) : new Set();
      await setMovement(page, desired, held);
      await sleep(45);
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

async function completeNaturalEliteHunt(page) {
  const initial = await readState(page);
  assert.equal(initial.objective.type, 'elite-hunt');
  const expectedIds = initial.objective.eliteTargets.map(({ sourceId }) => sourceId);
  await page.waitForPage(`(()=>{
    const api=globalThis.__NEON_TIDE_V3__;
    const expected=${JSON.stringify(expectedIds)};
    const live=new Set([...api.world.query('enemy')].map((id)=>api.world.get(id)?.sourceId));
    return expected.every((id)=>live.has(id));
  })()`, 5_000);

  const held = new Set();
  const observed = new Set();
  const deadline = Date.now() + 80_000;
  try {
    while (Date.now() < deadline) {
      const state = await readState(page);
      for (const sourceId of expectedIds) {
        if (!state.enemies.some((enemy) => enemy.sourceId === sourceId)) observed.add(sourceId);
      }
      if (state.mode === 'upgrade') break;
      assert.equal(state.mode, 'playing', `elite hunt ended early: ${JSON.stringify(state)}`);
      assert.equal(state.objective.type, 'elite-hunt');
      const target = state.enemies.find((enemy) => expectedIds.includes(enemy.sourceId));
      if (target) await setMovement(page, movementKeys(target.x - state.player.x, target.y - state.player.y, 0.45), held);
      else await stopMovement(page, held);
      if (Math.floor((Date.now() / 800)) % 2 === 0) await page.pressKey(' ', 'Space');
      await sleep(50);
    }
  } finally {
    await stopMovement(page, held);
  }
  const finished = await readState(page);
  assert.equal(finished.mode, 'upgrade', `elite hunt did not complete: ${JSON.stringify(finished)}`);
  assert.equal(finished.objective.progress, finished.objective.target);
  assert.deepEqual([...observed].sort((a, b) => a - b), [...expectedIds].sort((a, b) => a - b));
  return expectedIds;
}

export const v3ObjectiveScenarios = [
  ['v3 production objectives reject an edge circle and complete through natural real input', async () => {
    await withPage('v3-natural-objective-flow', { appUrl: TEST_URL }, async (page) => {
      await page.startGame();
      await page.waitForPage(`globalThis.__NEON_TIDE_V3__?.getDebugSnapshot().encounter.objective?.type === 'anchors'`);
      const authorityProbe = await page.evaluate(`(()=>{
        'use strict';
        const api=globalThis.__NEON_TIDE_V3__;
        const session=api.session.snapshot();
        const encounter=api.getDebugSnapshot().encounter;
        const before=encounter.objective.anchors[0].x;
        let sessionMutation=false;let encounterMutation=false;
        try{session.room.objective.anchors[0].x=999;}catch{sessionMutation=true;}
        try{encounter.objective.anchors[0].x=999;}catch{encounterMutation=true;}
        return {
          frozen:Object.isFrozen(session.room.objective.anchors[0])&&Object.isFrozen(encounter.objective.anchors[0]),
          sessionMutation,encounterMutation,before,
          after:api.getDebugSnapshot().encounter.objective.anchors[0].x,
          liveGetter:'getLiveEncounterObjective' in api.session,
          authorityLeak:'objectiveAuthority' in api,
        };
      })()`);
      assert.deepEqual(authorityProbe, {
        frozen: true, sessionMutation: true, encounterMutation: true,
        before: authorityProbe.before, after: authorityProbe.before, liveGetter: false, authorityLeak: false,
      });

      const expected = ['anchors', 'moving-zone', 'core-harvest', 'escort'];
      const edgeResults = [];
      const routeResults = [];
      for (let index = 0; index < expected.length; index += 1) {
        edgeResults.push(await proveEdgeCircleDoesNotProgress(page, expected[index]));
        routeResults.push(await completeRouteObjective(page, expected[index]));
        const beforeUpgrade = await readState(page);
        assert.equal(beforeUpgrade.room.objectiveManaged, true);
        assert.equal(beforeUpgrade.room.combatFrozen, true);
        await page.trustedClick('.upgrade-option');
        await page.waitForPage(`(()=>{
          const debug=globalThis.__NEON_TIDE_V3__?.getDebugSnapshot();
          return debug?.session.mode==='playing'&&debug?.encounter.objective?.type===${JSON.stringify(index < expected.length - 1 ? expected[index + 1] : 'elite-hunt')};
        })()`, 5_000);
      }
      const eliteIds = await completeNaturalEliteHunt(page);
      assert.equal(edgeResults.length, 4);
      assert.equal(routeResults.length, 4);
      assert.equal(eliteIds.length, 2);
      assert.ok(routeResults.every((entry) => entry.bridge.cleanupEvents > 0));
    });
  }],
];
