import assert from 'node:assert/strict';
import { APP_URL, withPage } from './harness.mjs';

const ABYSS_URL = new URL('?campaign-test=1&objective-seed=7301', APP_URL).href;
const KEY = Object.freeze({
  up: ['w', 'KeyW'],
  down: ['s', 'KeyS'],
  left: ['a', 'KeyA'],
  right: ['d', 'KeyD'],
});

async function snapshot(page) {
  return page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot()`);
}

async function playerState(page) {
  return page.evaluate(`(()=>{
    const app=globalThis.__NEON_TIDE_V3__;
    const id=app.world.query('player').at(0);
    const player=id?app.world.get(id):null;
    return {x:player?.x??0,y:player?.y??0,mode:app.session.getMode()};
  })()`);
}

async function holdAxisUntil(page, axis, target, start, tolerance) {
  const direction = target > start ? 1 : -1;
  const name = axis === 'x'
    ? (direction > 0 ? 'right' : 'left')
    : (direction > 0 ? 'up' : 'down');
  const [key, code] = KEY[name];
  await page.dispatchKey('rawKeyDown', key, code);
  try {
    return await page.evaluate(`(async()=>{
      const app=globalThis.__NEON_TIDE_V3__;
      const axis=${JSON.stringify(axis)};
      const target=${Number(target)};
      const start=${Number(start)};
      const tolerance=${Number(tolerance)};
      const direction=target>start?1:-1;
      const deadline=performance.now()+5200;
      return new Promise((resolve,reject)=>{
        const poll=()=>{
          const id=app.world.query('player').at(0);
          const player=id?app.world.get(id):null;
          const mode=app.session.getMode();
          if(!player||mode!=='playing'){
            reject(new Error('movement interrupted in '+mode));
            return;
          }
          const coordinate=axis==='x'?player.x:player.y;
          const reached=Math.abs(target-coordinate)<=tolerance
            || (direction>0?coordinate>=target:coordinate<=target);
          if(reached){
            resolve({x:player.x,y:player.y,mode,frames:app.getDebugSnapshot().encounter.elapsed});
            return;
          }
          if(performance.now()>=deadline){
            reject(new Error('keyboard axis hold timed out at '+coordinate+' toward '+target));
            return;
          }
          requestAnimationFrame(poll);
        };
        requestAnimationFrame(poll);
      });
    })()`);
  } finally {
    await page.dispatchKey('keyUp', key, code);
  }
}

async function driveTo(page, targetX, targetY, { tolerance = 0.42 } = {}) {
  let player = await playerState(page);
  if (player.mode !== 'playing') throw new Error(`movement interrupted in ${player.mode}`);

  if (Math.abs(targetX - player.x) > tolerance) {
    player = await holdAxisUntil(page, 'x', targetX, player.x, tolerance);
  }
  if (Math.abs(targetY - player.y) > tolerance) {
    player = await holdAxisUntil(page, 'y', targetY, player.y, tolerance);
  }

  if (Math.hypot(targetX - player.x, targetY - player.y) <= tolerance * 2.8) return player;
  throw new Error(`keyboard route failed to reach ${targetX},${targetY}: ${JSON.stringify(player)}`);
}

async function primeTideLance(page) {
  const readiness = await page.gameEvaluate(`
    $state.weaponEnergy=100;
    input.laserBuffer=0;
    return {availability:getLaserAvailability(),laserState:$state.laserState,mode:$state.mode,
      dashTimer:$state.dashTimer,dashInvulnTimer:$state.dashInvulnTimer,
      elapsed:$state.elapsed,stageIndex:$state.stageIndex,stageEnd:STAGES[$state.stageIndex]?.end};
  `);
  assert.equal(readiness.availability.canStart, true, `Tide Lance readiness: ${JSON.stringify(readiness)}`);
}

async function fireTideLance(page) {
  const before = (await snapshot(page)).weapons.lanceShots;
  await page.dispatchKey('rawKeyDown', 'e', 'KeyE');
  try {
    await page.evaluate(`(async()=>{
      const app=globalThis.__NEON_TIDE_V3__;
      const before=${Number(before)};
      const deadline=performance.now()+2600;
      return new Promise((resolve,reject)=>{
        const poll=()=>{
          const snapshot=app.getDebugSnapshot();
          if(snapshot.weapons.lanceShots>before){resolve(snapshot.weapons.lanceShots);return;}
          if(performance.now()>=deadline){
            reject(new Error('real Tide Lance input was not accepted: '+JSON.stringify({
              mode:snapshot.session.mode,phase:snapshot.encounter.bossBehavior?.phase,
              lanceShots:snapshot.weapons.lanceShots,before,
            })));
            return;
          }
          requestAnimationFrame(poll);
        };
        requestAnimationFrame(poll);
      });
    })()`);
  } finally {
    await page.dispatchKey('keyUp', 'e', 'KeyE');
  }
  return snapshot(page);
}

async function faceAwayFromNearestOrgan(page) {
  const state = await page.evaluate(`(()=>{
    const app=globalThis.__NEON_TIDE_V3__;
    const player=app.world.get(app.world.query('player').at(0));
    const organs=app.getDebugSnapshot().encounter.bossBehavior.parts.organs
      .filter((organ)=>!organ.destroyed).map((organ)=>app.world.get(organ.entityId)).filter(Boolean)
      .sort((left,right)=>Math.hypot(left.x-player.x,left.y-player.y)-Math.hypot(right.x-player.x,right.y-player.y)||left.id-right.id);
    return {player:{x:player.x,y:player.y},target:organs[0]};
  })()`);
  const dx = state.target.x - state.player.x;
  const dy = state.target.y - state.player.y;
  const targetX = state.player.x + (Math.abs(dx) >= Math.abs(dy) ? (dx > 0 ? -0.9 : 0.9) : 0);
  const targetY = state.player.y + (Math.abs(dx) < Math.abs(dy) ? (dy > 0 ? -0.9 : 0.9) : 0);
  await driveTo(page, targetX, targetY, { tolerance: 0.18 });
  return snapshot(page);
}

async function completeOrdinaryNode(page) {
  assert.equal(await page.evaluate(`globalThis.__NEON_TIDE_V3__.campaignTest.completeCurrentNode()`), true);
  await page.waitForPage(`globalThis.__NEON_TIDE_V3__.session.getMode()!=='playing'`);
  const mode = await page.evaluate(`globalThis.__NEON_TIDE_V3__.session.getMode()`);
  if (mode === 'upgrade') {
    await page.waitForPage(`!document.querySelector('#upgrade-panel').hidden&&Boolean(document.querySelector('#upgrade-options .upgrade-option'))`);
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
  await page.gameEvaluate(`
    clearWorldEntities();
    $state.enemySpawnTimer=Infinity;
    $state.formationTimer=Infinity;
    $state.shardSpawnTimer=Infinity;
    return true;
  `);
}

async function performFixedOuterOrbit(page) {
  const perimeter = [[8.2, 4.8], [-8.2, 4.8], [-8.2, -4.8], [8.2, -4.8], [8.2, 0]];
  for (const [x, y] of perimeter) await driveTo(page, x, y, { tolerance: 0.48 });
  await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().encounter.bossBehavior.orbitCounterTriggers>0`, 8000);
  return snapshot(page);
}

async function performNaturalRouteBreaks(page) {
  const route = [
    [-7.4, 0], [7.4, 0], [-7.4, 0], [7.4, 0], [0, 0],
    [0, 5.2], [0, -5.2], [0, 5.2], [0, -5.2], [0, 5.2], [0, -5.2], [0, 0],
    [-7.4, 0], [7.4, 0], [-7.4, 0], [7.4, 0],
  ];
  for (const [x, y] of route) await driveTo(page, x, y, { tolerance: 0.38 });
  for (let correction = 0; correction < 8; correction += 1) {
    const current = await snapshot(page);
    if (current.encounter.bossBehavior.phase === 'weakPoints') break;
    const center = current.encounter.bossBehavior.arenaCenter;
    await driveTo(page, center.x, center.y, { tolerance: 0.3 });
    await driveTo(page, center.x + (correction % 2 === 0 ? -7.4 : 7.4), center.y, { tolerance: 0.38 });
  }
  await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().encounter.bossBehavior.phase==='weakPoints'`, 8000);
  const shiftedCenter = (await snapshot(page)).encounter.bossBehavior.arenaCenter;
  await primeTideLance(page);
  await driveTo(page, shiftedCenter.x, shiftedCenter.y, { tolerance: 0.3 });
  await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().encounter.bossBehavior.parts.organs.every((organ)=>organ.weakPoint&&!organ.invulnerable)`, 4000);
  return snapshot(page);
}

export const v3AbyssScenarios = [
  ['v3 Abyss Maw rejects a real keyboard orbit, accepts a real keyboard varied route, and dies to real weapons', async () => {
    await withPage('v3-abyss-maw-orbit-pressure', { appUrl: ABYSS_URL, reducedMotion: true }, async (page) => {
      await reachMaw(page);
      assert.equal(await page.evaluate(`'bossTest' in globalThis.__NEON_TIDE_V3__`), false);

      const beforeFixed = await snapshot(page);
      const fixed = await performFixedOuterOrbit(page);
      assert.equal(fixed.encounter.bossBehavior.phase, 'hunt');
      assert.equal(fixed.encounter.bossBehavior.routeBreaks, 0);
      assert.equal(fixed.encounter.bossBehavior.destroyedOrgans, 0);
      assert.ok(fixed.encounter.bossBehavior.orbitCounterTriggers > 0);
      assert.ok(fixed.encounter.bossBehavior.attackCounts.active > 0, 'orbit warning became real damage');
      assert.ok(fixed.session.hull < beforeFixed.session.hull, 'unchanged outer orbit takes real hull damage');
      assert.ok(fixed.session.stats.damageTaken > beforeFixed.session.stats.damageTaken);

      const readable = await page.evaluate(`(()=>{
        const app=globalThis.__NEON_TIDE_V3__;
        const snap=app.getDebugSnapshot();
        return {
          bossParts:snap.world.pools.bossPart.count,
          rendered:snap.renderer.active,
          objectiveType:document.querySelector('#mission-panel')?.dataset.objectiveType,
          hudText:document.querySelector('#mission-objective')?.textContent,
        };
      })()`);
      assert.ok(readable.bossParts >= 4);
      assert.ok(readable.rendered > 0);
      assert.equal(readable.objectiveType, 'boss');
      assert.match(readable.hudText, /深渊巨口/);
    });

    await withPage('v3-abyss-maw-natural', { appUrl: ABYSS_URL, reducedMotion: true }, async (page) => {
      await reachMaw(page);
      assert.equal(await page.evaluate(`'bossTest' in globalThis.__NEON_TIDE_V3__`), false);
      const varied = await performNaturalRouteBreaks(page);
      assert.equal(varied.encounter.bossBehavior.phase, 'weakPoints');
      assert.equal(varied.encounter.bossBehavior.suctionOutcome.succeeded, true);
      assert.ok(varied.encounter.bossBehavior.parts.organs.every((organ) => organ.weakPoint && !organ.invulnerable));
      assert.ok(varied.encounter.bossBehavior.attacksSeen.includes('suction-current'));
      assert.ok(varied.encounter.bossBehavior.attacksSeen.includes('tentacle-fan'));

      const center = varied.encounter.bossBehavior.arenaCenter;
      await driveTo(page, center.x, center.y, { tolerance: 0.3 });
      const beforeLance = await faceAwayFromNearestOrgan(page);
      const fired = await fireTideLance(page);
      const aim = fired.weapons.lastLanceAim;
      const visual = fired.legacy.tideLanceLock;
      assert.ok(aim.targetIds.some((id) => varied.encounter.bossBehavior.parts.organs.some((organ) => organ.entityId === id)));
      assert.ok(Math.abs(visual.directionX - aim.directionX) < 1e-6);
      assert.ok(Math.abs(visual.directionY - aim.directionY) < 1e-6);
      assert.ok(beforeLance.player.facing.x * aim.directionX + beforeLance.player.facing.y * aim.directionY < 0.8,
        'authoritative Boss aim differs from unrelated player facing');
      await page.waitForPage(`(globalThis.__NEON_TIDE_V3__.getDebugSnapshot().encounter.bossBehavior.damageByWeapon['tide-lance']??0)>0`, 6000);
      await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().encounter.bossBehavior.phase==='enraged'`, 30000);
      const enraged = await snapshot(page);
      assert.equal(enraged.encounter.bossBehavior.destroyedOrgans, 3);
      assert.ok(enraged.encounter.bossBehavior.damageByWeapon['pulse-cannon'] > 0);
      await driveTo(page, enraged.encounter.bossBehavior.arenaCenter.x, enraged.encounter.bossBehavior.arenaCenter.y);
      await page.waitForPage(`globalThis.__NEON_TIDE_V3__.session.getMode()==='upgrade'`, 30000);

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
    await withPage('v3-abyss-maw-standard-retry', { appUrl: ABYSS_URL, reducedMotion: true }, async (page) => {
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
