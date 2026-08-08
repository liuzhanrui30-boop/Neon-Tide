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
      hazards:entities('enemyHazard'),
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
  const observedRoles = new Set();
  const lancerPreviews = new Map();
  let lancerParity = null;
  let wardenParity = null;
  let lancerSafeParity = null;
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
      assert.equal(state.mode, 'playing', `threat evidence ended early: ${JSON.stringify({
        mode: state.mode, objective: state.objective?.type, observedRoles: [...observedRoles],
        lancerParity: Boolean(lancerParity), wardenParity: Boolean(wardenParity),
        lancerSafeParity: Boolean(lancerSafeParity), simultaneous: Boolean(simultaneous),
      })}`);
      for (const role of state.renderer.observations.enemyRoles) {
        if (ENEMY_ROLE_IDS.includes(role)) observedRoles.add(role);
      }
      if (state.renderer.pools.enemy.count === state.enemies.length) {
        for (const enemy of state.enemies) observedRoles.add(enemy.role);
      }
      for (const warning of state.warnings) {
        if (warning.type === 'lancer-beam' && warning.opacity > 0 && !warning.collidable) {
          lancerPreviews.set(warning.ownerId, warning);
        }
      }
      for (const [ownerId, preview] of lancerPreviews) {
        const nodes = state.hazards.filter((hazard) => hazard.ownerId === ownerId && hazard.type === 'lancer-beam-node');
        if (nodes.length === 0) continue;
        const cos = Math.cos(preview.rotation);
        const sin = Math.sin(preview.rotation);
        const contained = nodes.every((node) => {
          const dx = node.x - preview.x;
          const dy = node.y - preview.y;
          const along = dx * cos + dy * sin;
          const across = -dx * sin + dy * cos;
          return node.collidable && node.contactDamaging
            && Math.abs(along) + node.radius <= preview.scaleX / 2 + 1e-6
            && Math.abs(across) + node.radius <= preview.scaleY / 2 + 1e-6;
        });
        if (contained) lancerParity = { preview, nodes };
      }
      const wardenGap = state.hazards.find(({ role }) => role === 'warden-gap');
      const wardenNode = wardenGap && state.hazards.find(({ role, collidable }) => role === 'warden-wall' && collidable);
      const lancerSafe = state.hazards.find(({ role }) => role === 'safe-sector');
      if (wardenGap && wardenNode
        && state.renderer.pools.enemyHazard.count === state.hazards.length
        && !wardenGap.collidable && wardenGap.scaleX === wardenGap.radius && wardenGap.scaleY === wardenGap.radius
        && wardenGap.radius > wardenNode.radius) {
        wardenParity = { wardenGap, wardenNode };
      }
      if (lancerSafe && state.renderer.pools.enemyHazard.count === state.hazards.length
        && !lancerSafe.collidable && lancerSafe.scaleX === lancerSafe.radius && lancerSafe.scaleY === lancerSafe.radius) {
        lancerSafeParity = lancerSafe;
      }
      const rendered = state.renderer.observations;
      if (rendered.lancerPreviewsRendered > 0 && rendered.lancerBeamNodesRendered > 0
        && rendered.lancerBeamNodesOutsidePreview === 0) {
        lancerParity = {
          previewsRendered: rendered.lancerPreviewsRendered,
          nodesRendered: rendered.lancerBeamNodesRendered,
          outsidePreview: rendered.lancerBeamNodesOutsidePreview,
        };
      }
      if (rendered.wardenGapRenderedRadius > rendered.wardenWallRenderedRadius
        && rendered.wardenWallRenderedRadius > 0) {
        wardenParity = {
          wardenGap: { radius: rendered.wardenGapRenderedRadius },
          wardenNode: { radius: rendered.wardenWallRenderedRadius },
        };
      }
      if (rendered.lancerSafeRenderedRadius > 0) {
        lancerSafeParity = { radius: rendered.lancerSafeRenderedRadius };
      }
      if (now >= nextTurn) {
        const objective = state.objective;
        const target = objective.type === 'anchors'
          ? objective.anchors.find(({ completed }) => !completed)
          : objective.type === 'moving-zone' ? objective.safeZone
            : objective.type === 'core-harvest' ? objective.cores.find(({ collected }) => !collected)
              : objective.type === 'escort' ? objective.escort
                : objective.type === 'elite-hunt'
                  ? state.enemies.find((enemy) => objective.eliteTargets.some(({ sourceId }) => sourceId === enemy.sourceId))
                  : null;
        const targetRadius = objective.type === 'escort' ? objective.escort.supportRadius * 0.38
          : objective.type === 'moving-zone' ? objective.safeZone.radius * 0.4
            : objective.type === 'elite-hunt' ? 1.25 : 0.42;
        const evidenceRadius = objective.type === 'core-harvest'
          ? Math.max(1.35, (target?.radius ?? 0.5) * 2.4)
          : targetRadius;
        if (target && state.player) {
          const dx = target.x - state.player.x;
          const dy = target.y - state.player.y;
          await setMovement(page, Math.hypot(dx, dy) > evidenceRadius ? movement(dx, dy) : new Set(), held);
        } else {
          await setMovement(page, directions[directionIndex++ % directions.length], held);
        }
        nextTurn = now + 120;
      }
      if (now >= nextDash) {
        await page.pressKey(' ', 'Space');
        nextDash = now + (state.hull <= 2 ? 520 : 850);
      }
      const owners = new Set(state.warnings.map(({ ownerId }) => ownerId));
      const progress = new Set(state.warnings.map(({ progress }) => progress.toFixed(3)));
      if (owners.size >= 2 && progress.size >= 2) {
        simultaneous = state;
      }
      if (state.renderer.observations.maxSimultaneousWarningOwners >= 2
        && state.renderer.observations.maxIndependentWarningProgress >= 2) {
        simultaneous ??= state;
      }
      if (ENEMY_ROLE_IDS.every((role) => observedRoles.has(role))
        && simultaneous && lancerParity && wardenParity && lancerSafeParity) {
        return {
          ...simultaneous,
          threat: state.threat,
          observedRoles: [...observedRoles],
          lancerParity,
          hazardParity: { ...wardenParity, lancerSafe: lancerSafeParity },
        };
      }
      await sleep(45);
    }
  } finally {
    await stop(page, held);
  }
  const state = await read(page);
  throw new Error(`natural role/warning reachability timed out: ${JSON.stringify({
    roles: state.threat?.rolesSeen, observedRoles: [...observedRoles],
    warnings: state.warnings, lancerParity: Boolean(lancerParity),
    wardenParity: Boolean(wardenParity), lancerSafeParity: Boolean(lancerSafeParity),
  })}`);
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
      assert.deepEqual([...evidence.observedRoles].sort(), [...ENEMY_ROLE_IDS].sort());
      assert.ok(evidence.warnings.every(({ opacity, collidable, flags }) => opacity > 0 && !collidable && flags === 0));
      assert.equal(evidence.renderer.pools.warning.count, evidence.warnings.length);
      assert.equal(evidence.renderer.warningVisibility.hiddenActive, 0);
      assert.ok(evidence.renderer.observations.maxSimultaneousWarningOwners >= 2);
      assert.ok(evidence.renderer.observations.maxIndependentWarningProgress >= 2);
      assert.equal(evidence.renderer.observations.maxHiddenActiveWarnings, 0);
      assert.ok(evidence.lancerParity.nodesRendered > 0);
      assert.equal(evidence.lancerParity.outsidePreview, 0);
      assert.ok(evidence.hazardParity.wardenGap.radius > evidence.hazardParity.wardenNode.radius);
    });
  }],
  ['v3 compact runtime caps match Standard and Abyss director limits end to end', async () => {
    await withPage('v3-compact-enemy-caps', {
      appUrl: TEST_URL, width: 390, height: 844, deviceScaleFactor: 2, mobile: true, touch: true,
    }, async (page) => {
      await page.startGame();
      await page.waitForPage(`globalThis.__NEON_TIDE_V3__?.getDebugSnapshot().encounter.threatState?.lastWave`);
      const standard = await page.evaluate(`(()=>{
        const debug=globalThis.__NEON_TIDE_V3__.getDebugSnapshot();
        return {world:debug.world.pools,enemies:debug.enemies,limits:debug.encounter.threatState.lastWave.limits};
      })()`);
      assert.equal(standard.world.enemy.capacity, 42);
      assert.equal(standard.world.enemyProjectile.capacity, 72);
      assert.deepEqual(standard.enemies.caps, { enemy: 36, projectile: 72, warning: 2 });
      assert.deepEqual(standard.limits, {
        activeEnemyCap: 36, projectileCap: 72, simultaneousWarningCap: 2, blockedAreaBudget: 0.38,
      });

      await page.evaluate(`(()=>{
        const api=globalThis.__NEON_TIDE_V3__;
        api.session.reset();
        api.session.startRun('abyss',4409);
        return api.session.startRoom({campaign:true,chapterIndex:0});
      })()`);
      await page.waitForPage(`globalThis.__NEON_TIDE_V3__?.getDebugSnapshot().encounter.threatState?.lastWave`);
      const abyss = await page.evaluate(`(()=>{
        const debug=globalThis.__NEON_TIDE_V3__.getDebugSnapshot();
        return {enemies:debug.enemies,limits:debug.encounter.threatState.lastWave.limits};
      })()`);
      assert.deepEqual(abyss.enemies.caps, { enemy: 42, projectile: 72, warning: 3 });
      assert.deepEqual(abyss.limits, {
        activeEnemyCap: 42, projectileCap: 72, simultaneousWarningCap: 3, blockedAreaBudget: 0.42,
      });
    });
  }],
];
