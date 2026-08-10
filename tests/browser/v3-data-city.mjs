import assert from 'node:assert/strict';
import { APP_URL, withPage } from './harness.mjs';

const DATA_CITY_URL = new URL('?campaign-test=1&objective-seed=4112', APP_URL).href;
const KEY = Object.freeze({
  up: ['w', 'KeyW'], down: ['s', 'KeyS'], left: ['a', 'KeyA'], right: ['d', 'KeyD'],
});

async function snapshot(page) {
  return page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot()`);
}

async function playerState(page) {
  return page.evaluate(`(()=>{
    const app=globalThis.__NEON_TIDE_V3__;
    const player=app.world.get(app.world.query('player').at(0));
    return {x:player?.x??0,y:player?.y??0,mode:app.session.getMode()};
  })()`);
}

async function holdAxisUntil(page, axis, target, start, tolerance = 0.3) {
  const direction = target > start ? 1 : -1;
  const name = axis === 'x' ? (direction > 0 ? 'right' : 'left') : (direction > 0 ? 'up' : 'down');
  const [key, code] = KEY[name];
  await page.dispatchKey('rawKeyDown', key, code);
  try {
    return await page.evaluate(`(async()=>{
      const app=globalThis.__NEON_TIDE_V3__;
      const axis=${JSON.stringify(axis)},target=${Number(target)},start=${Number(start)};
      const direction=target>start?1:-1,tolerance=${Number(tolerance)},deadline=performance.now()+5500;
      return new Promise((resolve,reject)=>{
        const poll=()=>{
          const player=app.world.get(app.world.query('player').at(0));
          const mode=app.session.getMode();
          if(!player||mode!=='playing'){reject(new Error('movement interrupted in '+mode));return;}
          const coordinate=axis==='x'?player.x:player.y;
          if(Math.abs(target-coordinate)<=tolerance||(direction>0?coordinate>=target:coordinate<=target)){
            resolve({x:player.x,y:player.y,mode});return;
          }
          if(performance.now()>=deadline){reject(new Error('axis movement timeout '+coordinate+' -> '+target));return;}
          requestAnimationFrame(poll);
        };requestAnimationFrame(poll);
      });
    })()`);
  } finally {
    await page.dispatchKey('keyUp', key, code);
  }
}

async function driveTo(page, x, y, tolerance = 0.36) {
  let player = await playerState(page);
  for (let correction = 0; correction < 10; correction += 1) {
    if (Math.hypot(x - player.x, y - player.y) <= tolerance * 2.4) return player;
    const axis = Math.abs(x - player.x) >= Math.abs(y - player.y) ? 'x' : 'y';
    const target = axis === 'x' ? x : y;
    const start = axis === 'x' ? player.x : player.y;
    if (Math.abs(target - start) > tolerance) player = await holdAxisUntil(page, axis, target, start, tolerance);
    await page.evaluate(`new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    player = await playerState(page);
  }
  throw new Error(`keyboard route failed: ${JSON.stringify({ player, x, y })}`);
}

async function chooseUpgrade(page) {
  await page.waitForPage(`!document.querySelector('#upgrade-panel').hidden&&Boolean(document.querySelector('#upgrade-options .upgrade-option'))`);
  const upgradeId = await page.evaluate(`(()=>{
    const cards=globalThis.__NEON_TIDE_V3__.session.snapshot().build.pendingOffer.cards;
    return ['repair-swarm','echo-shield','phase-overclock','ion-drive','prism-core']
      .find((id)=>cards.includes(id))??cards[0];
  })()`);
  await page.trustedClick(`#upgrade-options .upgrade-option[data-upgrade-id="${upgradeId}"]`);
}

async function completePrerequisiteNode(page) {
  assert.equal(await page.evaluate(`globalThis.__NEON_TIDE_V3__.campaignTest.completeCurrentNode()`), true);
  await page.waitForPage(`globalThis.__NEON_TIDE_V3__.session.getMode()!=='playing'`);
  const mode = await page.evaluate(`globalThis.__NEON_TIDE_V3__.session.getMode()`);
  if (mode === 'upgrade') {
    const enteringDataCity = await page.evaluate(`globalThis.__NEON_TIDE_V3__.session.snapshot().route?.chapterIndex===1`);
    if (enteringDataCity) {
      await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().campaignContent.loads['data-city']==='loaded'`);
    }
    await chooseUpgrade(page);
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.session.getMode()==='playing'`);
  } else if (mode === 'chapterComplete') {
    await page.trustedClick('#primary-button');
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.session.getMode()==='playing'`);
  } else throw new Error(`unexpected prerequisite mode ${mode}`);
}

async function reachProtocolZero(page, runMode = 'standard') {
  if (runMode === 'abyss') await page.trustedClick('input[name="run-mode"][value="abyss"]');
  await page.startGame();
  for (let index = 0; index < 7; index += 1) await completePrerequisiteNode(page);
  await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().campaignContent.loads['data-city']==='loaded'`);
  await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().encounter.bossBehavior?.bossId==='protocol-zero'`);
  await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().encounter.bossBehavior?.parts?.body?.entityId>0`);
  await page.gameEvaluate(`
    $state.enemySpawnTimer=Infinity;
    $state.formationTimer=Infinity;
    $state.shardSpawnTimer=Infinity;
    return true;
  `);
}

async function clearFirewall(page) {
  for (let index = 0; index < 4; index += 1) {
    const marked = (await snapshot(page)).encounter.bossBehavior.firewall.markedQuadrant;
    await driveTo(page, marked.xSign * 5.6, marked.ySign * 3.8);
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().encounter.bossBehavior.firewall.clears>${index}`, 5000);
  }
  await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().encounter.bossBehavior.phase==='trafficGrid'`);
  return snapshot(page);
}

async function clearTrafficGrid(page) {
  for (let index = 0; index < 4; index += 1) {
    const current = await snapshot(page);
    const safe = current.encounter.bossBehavior.safeCells.find((cell) => cell.truthful);
    await driveTo(page, safe.x, safe.y, 0.28);
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().encounter.bossBehavior.trafficGrid.clears>${index}`, 5000);
  }
  await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().encounter.bossBehavior.phase==='cloneNodes'`);
  return snapshot(page);
}

async function fireRealTideLance(page) {
  const before = (await snapshot(page)).weapons.lanceShots;
  await page.gameEvaluate(`$state.weaponEnergy=100;input.laserBuffer=0;return true`);
  await page.evaluate(`new Promise((resolve)=>setTimeout(resolve,700))`);
  const availability = await page.gameEvaluate(`return getLaserAvailability()`);
  assert.equal(availability.canStart, true, `Tide Lance unavailable: ${JSON.stringify(availability)}`);
  await page.dispatchKey('rawKeyDown', 'e', 'KeyE');
  try {
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().weapons.lanceShots>${before}`, 4000);
  } finally {
    await page.dispatchKey('keyUp', 'e', 'KeyE');
  }
  return snapshot(page);
}

async function lanceUntil(page, condition, maximumShots) {
  for (let shot = 0; shot < maximumShots; shot += 1) {
    const current = await snapshot(page);
    if (condition(current)) return current;
    if (current.session.mode !== 'playing') return current;
    if (current.encounter.bossBehavior.phase === 'kernel') await driveTo(page, 0, 0, 0.28);
    await fireRealTideLance(page);
    await page.evaluate(`new Promise((resolve)=>setTimeout(resolve,420))`);
  }
  return snapshot(page);
}

export const v3DataCityScenarios = [
  ['v3 Data City Protocol Zero truthful grid and real weapon victory', async () => {
    await withPage('v3-data-city-standard', { appUrl: DATA_CITY_URL, reducedMotion: true, forcedColors: true }, async (page) => {
      await reachProtocolZero(page);
      assert.equal(await page.evaluate(`'bossTest' in globalThis.__NEON_TIDE_V3__`), false);
      const traffic = await clearFirewall(page);
      const truthful = traffic.encounter.bossBehavior.safeCells.filter((cell) => cell.truthful);
      assert.equal(truthful.length, 1);
      assert.equal(traffic.encounter.bossBehavior.safeCells.filter((cell) => cell.shape === truthful[0].shape).length, 1);
      assert.equal(traffic.encounter.bossBehavior.safeRoute.openLanes, 1);
      assert.ok(traffic.encounter.bossBehavior.safeCells.every((cell) => typeof cell.shape === 'string' && Number.isInteger(cell.pulseBeat)));
      const safeVisuals = await page.evaluate(`(()=>{
        const app=globalThis.__NEON_TIDE_V3__,result=[];
        for(const kind of ['bossPart','enemy','objective']) for(const id of app.world.query(kind)){
          const entity=app.world.get(id);
          if(entity?.type==='protocol-safe-cell') result.push({kind,variant:entity.variant,state:entity.state,sequence:entity.sequence});
        }
        return result;
      })()`);
      assert.equal(safeVisuals.filter(({ state }) => state === 'truthful').length, 1);
      assert.equal(safeVisuals.find(({ state }) => state === 'truthful').kind, 'bossPart');
      assert.ok(safeVisuals.some(({ kind }) => kind === 'objective'));

      const clones = await clearTrafficGrid(page);
      assert.equal(new Set(clones.encounter.bossBehavior.parts.nodes.map((node) => node.shape)).size, 3);
      const cloneVisualKinds = await page.evaluate(`(()=>{
        const app=globalThis.__NEON_TIDE_V3__,kinds=[];
        for(const kind of ['bossPart','enemy','objective']) for(const id of app.world.query(kind)){
          if(app.world.get(id)?.type==='protocol-clone-node') kinds.push(kind);
        }
        return kinds.sort();
      })()`);
      assert.deepEqual(cloneVisualKinds, ['bossPart', 'enemy', 'objective']);
      await driveTo(page, 0, 0, 0.3);
      const fired = await fireRealTideLance(page);
      assert.ok(fired.weapons.lastLanceAim.targetIds.some((id) => clones.encounter.bossBehavior.parts.nodes.some((node) => node.entityId === id)));
      assert.ok(fired.encounter.bossBehavior.damageByWeapon['tide-lance'] > 0);
      const postClones = await lanceUntil(page, (current) => (
        current.encounter.bossBehavior.phase === 'kernel' || current.session.mode === 'upgrade'
      ), 8);
      if (postClones.session.mode === 'playing') {
        await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().encounter.bossBehavior.phase==='kernel'`, 10000);
        await driveTo(page, 0, 0, 0.3);
        await lanceUntil(page, (current) => current.session.mode === 'upgrade', 25);
      }
      await page.waitForPage(`globalThis.__NEON_TIDE_V3__.session.getMode()==='upgrade'`, 10000);
      const victory = await snapshot(page);
      assert.equal(victory.encounter.bossBehavior.clean, true);
      assert.equal(victory.encounter.bossBehavior.ownedEntityCount, 0);
      assert.equal(victory.world.pools.bossPart.count, 0);
      assert.ok(victory.encounter.bossBehavior.maxOwnedEntityCount <= 48);
      assert.ok(victory.encounter.bossBehavior.maxSimultaneousWarnings <= 3);
      assert.equal(victory.events.dropped, 0);
    });
  }],
  ['v3 Abyss Protocol Zero decoys preserve shape and rhythm evidence', async () => {
    await withPage('v3-data-city-abyss', { appUrl: DATA_CITY_URL, reducedMotion: true, forcedColors: true }, async (page) => {
      await reachProtocolZero(page, 'abyss');
      const traffic = await clearFirewall(page);
      assert.equal(traffic.encounter.bossBehavior.mode, 'abyss');
      assert.equal(traffic.encounter.bossBehavior.safeCells.filter((cell) => cell.truthful).length, 1);
      assert.ok(traffic.encounter.bossBehavior.safeCells.some((cell) => cell.decoy));
      assert.ok(traffic.encounter.bossBehavior.safeCells.every((cell) => typeof cell.shape === 'string' && Number.isInteger(cell.pulseBeat)));
      const real = traffic.encounter.bossBehavior.safeCells.find((cell) => cell.truthful);
      const decoys = traffic.encounter.bossBehavior.safeCells.filter((cell) => cell.decoy);
      assert.ok(decoys.every((cell) => cell.shape !== real.shape && cell.pulseBeat !== real.pulseBeat));
      assert.ok(['unique-shape-and-primary-beat', real.shape].includes(traffic.encounter.bossBehavior.safeRoute.evidence));
      assert.equal(traffic.encounter.bossBehavior.safeRoute.openLanes, 1);
      assert.ok(traffic.encounter.bossBehavior.maxSimultaneousWarnings <= 4);
    });
  }],
];
