import assert from 'node:assert/strict';
import { APP_URL, withPage } from './harness.mjs';

const DATA_CITY_URL = new URL('?campaign-test=1&objective-seed=4112&duration-scale=0.1', APP_URL).href;
const KEY = Object.freeze({
  up: ['w', 'KeyW'], down: ['s', 'KeyS'], left: ['a', 'KeyA'], right: ['d', 'KeyD'],
});

async function snapshot(page) {
  return page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot()`);
}

async function warningOwnerCount(page) {
  return page.evaluate(`(()=>{const app=globalThis.__NEON_TIDE_V3__,owners=new Set();for(const id of app.world.query('warning')){const e=app.world.get(id);owners.add(e.ownerId||e.id);}return owners.size})()`);
}

async function followPublicObjective(page, objectiveType, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let maximumWarningOwners = 0;
  let last = null;
  const routes = new Set();
  while (Date.now() < deadline) {
    const current = await snapshot(page);
    if (current.session.mode !== 'playing') return { terminal: current, last, maximumWarningOwners, routes: [...routes] };
    const objective = current.encounter.objective;
    assert.equal(objective.type, objectiveType);
    maximumWarningOwners = Math.max(maximumWarningOwners, await warningOwnerCount(page));
    if (objective.corridor?.authoredRoute) routes.add(objective.corridor.authoredRoute);
    let target;
    if (objectiveType === 'escort') target = objective.escort;
    else if (objectiveType === 'storm-corridor') target = objective.safeZone;
    else target = objective.crises.find(({ completed }) => !completed) ?? objective.crises.at(-1);
    const player = current.player?.position ?? { x: 0, y: 0 };
    const dx = target.x - player.x;
    const dy = target.y - player.y;
    const held = [];
    if (dx > 0.22) held.push(KEY.right);
    else if (dx < -0.22) held.push(KEY.left);
    if (dy > 0.22) held.push(KEY.up);
    else if (dy < -0.22) held.push(KEY.down);
    for (const [key, code] of held) await page.dispatchKey('rawKeyDown', key, code);
    const distance = Math.hypot(dx, dy);
    const dashReady = (current.player?.dashCharges ?? []).some((charge) => charge >= 0.999);
    const dashHeld = objectiveType === 'storm-corridor' && dashReady
      && (distance > 1.7 || objective.stormExposure > 0.25);
    if (dashHeld) {
      await page.dispatchKey('rawKeyDown', ' ', 'Space');
    }
    try {
      last = await page.evaluate(`new Promise((resolve)=>{
        let frames=0,last=null,lastPlaying=null;
        const poll=()=>{
          const app=globalThis.__NEON_TIDE_V3__,s=app.getDebugSnapshot(),o=s.encounter.objective,p=s.player?.position;
          last={mode:s.session.mode,hull:s.session.hull,route:s.session.route,objective:o?{type:o.type,status:o.status,failureReason:o.failureReason,progress:o.progress,target:o.target,stormExposure:o.stormExposure??0,safeZone:o.safeZone,corridor:o.corridor,crosslink:o.crosslink}:null,player:p};
          if(s.session.mode==='playing')lastPlaying=last;
          if(++frames>=8||s.session.mode!=='playing'){resolve(lastPlaying??last);return;}requestAnimationFrame(poll);
        };requestAnimationFrame(poll);
      })`);
    } finally {
      if (dashHeld) await page.dispatchKey('keyUp', ' ', 'Space');
      for (const [key, code] of held) await page.dispatchKey('keyUp', key, code);
    }
  }
  throw new Error(`${objectiveType} public-target follower timed out: ${JSON.stringify(last)}`);
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

async function dashDriveTo(page, x, y, tolerance = 0.3) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const current = await snapshot(page);
    if (current.session.mode !== 'playing') throw new Error(`dash movement interrupted in ${current.session.mode}`);
    const player = current.player.position;
    const dx = x - player.x;
    const dy = y - player.y;
    if (Math.hypot(dx, dy) <= tolerance) return player;
    const held = [];
    if (dx > 0.16) held.push(KEY.right); else if (dx < -0.16) held.push(KEY.left);
    if (dy > 0.16) held.push(KEY.up); else if (dy < -0.16) held.push(KEY.down);
    for (const [key, code] of held) await page.dispatchKey('rawKeyDown', key, code);
    const dashHeld = Math.hypot(dx, dy) > 1.35
      && current.player.dashCharges.some((charge) => charge >= 0.999);
    if (dashHeld) await page.dispatchKey('rawKeyDown', ' ', 'Space');
    try {
      await page.evaluate(`new Promise((resolve)=>{let frames=0;const poll=()=>{if(++frames>=8){resolve();return;}requestAnimationFrame(poll)};requestAnimationFrame(poll)})`);
    } finally {
      if (dashHeld) await page.dispatchKey('keyUp', ' ', 'Space');
      for (const [key, code] of held) await page.dispatchKey('keyUp', key, code);
    }
  }
  throw new Error(`dash keyboard route timed out: ${JSON.stringify({ x, y })}`);
}

async function chooseUpgrade(page) {
  await page.waitForPage(`!document.querySelector('#upgrade-panel').hidden&&Boolean(document.querySelector('#upgrade-options .upgrade-option'))`);
  const upgradeId = await page.evaluate(`(()=>{
    const cards=globalThis.__NEON_TIDE_V3__.session.snapshot().build.pendingOffer.cards;
    return ['repair-swarm','objective-halo','tide-wake','tide-reserve','escort-repair','echo-shield','ion-drive','phase-overclock','prism-core']
      .find((id)=>cards.includes(id))??cards[0];
  })()`);
  await page.trustedClick(`#upgrade-options .upgrade-option[data-upgrade-id="${upgradeId}"]`);
}

async function pressDash(page) {
  await page.dispatchKey('rawKeyDown', 'd', 'KeyD');
  await page.dispatchKey('rawKeyDown', ' ', 'Space');
  await page.evaluate(`new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
  await page.dispatchKey('keyUp', ' ', 'Space');
  await page.dispatchKey('keyUp', 'd', 'KeyD');
  await page.waitForPage(`(()=>{const p=globalThis.__NEON_TIDE_V3__.world.get(globalThis.__NEON_TIDE_V3__.world.query('player').at(0));return Math.min(p.dashCharge0,p.dashCharge1)<0.25})()`, 1000);
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

async function continueNaturalRoom(page, diagnostics = null) {
  await page.waitForPage(`globalThis.__NEON_TIDE_V3__.session.getMode()!=='playing'`, 20000);
  const before = await snapshot(page);
  if (before.session.mode === 'upgrade') {
    await chooseUpgrade(page);
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.session.getMode()==='playing'`);
  } else if (before.session.mode === 'chapterComplete') {
    await page.trustedClick('#primary-button');
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.session.getMode()==='playing'`);
  } else throw new Error(`unexpected natural room mode ${before.session.mode}: ${JSON.stringify({
    terminalReason: before.session.terminalReason,
    objective: before.encounter.objective,
    diagnostics,
  })}`);
  return before;
}

async function measureDataLaneRecovery(page) {
  await driveTo(page, 0, 3.1, 0.28);
  const baselineStart = await page.evaluate(`performance.now()`);
  await pressDash(page);
  await page.waitForPage(`(()=>{const p=globalThis.__NEON_TIDE_V3__.world.get(globalThis.__NEON_TIDE_V3__.world.query('player').at(0));return Math.min(p.dashCharge0,p.dashCharge1)>=0.5})()`, 4000);
  const baselineMs = (await page.evaluate(`performance.now()`)) - baselineStart;
  await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().legacy.stageIndex===1`, 5000);
  const environmentDeadline = Date.now() + 14000;
  while (Date.now() < environmentDeadline) {
    const phase = await page.gameEvaluate(`return environmentFrame.phase`);
    const current = await snapshot(page);
    if (current.session.mode !== 'playing') throw new Error(`lane wait interrupted in ${current.session.mode}`);
    if (phase === 'active' && Math.abs(current.player.position.y) <= 0.24) break;
    const target = ['telegraph', 'active'].includes(phase)
      ? { x: 0, y: 0 }
      : current.encounter.objective.escort;
    await driveTo(page, target.x, target.y, phase === 'active' ? 0.2 : 0.45);
    await page.evaluate(`new Promise((resolve)=>setTimeout(resolve,100))`);
  }
  assert.equal(await page.gameEvaluate(`return environmentFrame.phase`), 'active');
  assert.ok(Math.abs((await snapshot(page)).player.position.y) <= 0.24);
  const laneStart = await page.evaluate(`performance.now()`);
  await pressDash(page);
  await page.waitForPage(`(()=>{const p=globalThis.__NEON_TIDE_V3__.world.get(globalThis.__NEON_TIDE_V3__.world.query('player').at(0));return Math.min(p.dashCharge0,p.dashCharge1)>0.12})()`, 1500);
  const pausedCharge = await page.evaluate(`(()=>{const a=globalThis.__NEON_TIDE_V3__,p=a.world.get(a.world.query('player').at(0));return Math.min(p.dashCharge0,p.dashCharge1)})()`);
  await page.trustedClick('#pause-button');
  await page.waitForPage(`globalThis.__NEON_TIDE_V3__.session.getMode()==='paused'`);
  await page.evaluate(`new Promise((resolve)=>setTimeout(resolve,500))`);
  const frozenCharge = await page.evaluate(`(()=>{const a=globalThis.__NEON_TIDE_V3__,p=a.world.get(a.world.query('player').at(0));return Math.min(p.dashCharge0,p.dashCharge1)})()`);
  assert.ok(Math.abs(frozenCharge - pausedCharge) < 1e-6, 'pause freezes lane recovery');
  await page.trustedClick('#primary-button');
  await page.waitForPage(`globalThis.__NEON_TIDE_V3__.session.getMode()==='playing'`);
  await page.waitForPage(`(()=>{const p=globalThis.__NEON_TIDE_V3__.world.get(globalThis.__NEON_TIDE_V3__.world.query('player').at(0));return Math.min(p.dashCharge0,p.dashCharge1)>=0.5})()`, 4000);
  const laneMs = (await page.evaluate(`performance.now()`)) - laneStart - 500;
  assert.ok(laneMs > baselineMs * 1.32, `lane recovery must be slower: ${baselineMs} vs ${laneMs}`);
  return { baselineMs, laneMs };
}

async function completeAuthoredDataCityRooms(page) {
  await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().encounter.chapterPacing?.roomId==='data-city:escort-uplink'`);
  await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().encounter.objective.dataLane?.directDamage===0`);
  const entry = await snapshot(page);
  assert.equal(entry.campaignContent.loads['data-city'], 'loaded');
  assert.equal(entry.encounter.chapterPacing.teachingStage, 'introduce');
  assert.equal(entry.encounter.objective.dataLane?.directDamage, 0);
  const recovery = await measureDataLaneRecovery(page);
  await page.reload();
  await page.startGame();
  await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().encounter.chapterPacing?.roomId==='data-city:escort-uplink'`);
  const escortFollow = await followPublicObjective(page, 'escort');
  const escortDone = await continueNaturalRoom(page, escortFollow.last);
  assert.equal(escortDone.encounter.objective.status, 'completed');
  assert.ok(escortDone.encounter.objective.escort.authoredRoute === 'escort-inner-rail');
  assert.ok(escortFollow.maximumWarningOwners <= 2);
  const upgradesAfterEscort = escortDone.session.build.ownedUpgrades.length;

  await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().encounter.chapterPacing?.roomId==='data-city:storm-switchback'`);
  const stormFollow = await followPublicObjective(page, 'storm-corridor');
  const stormDone = await continueNaturalRoom(page, stormFollow.last);
  assert.equal(stormDone.encounter.objective.status, 'completed');
  assert.equal(stormDone.encounter.objective.corridor.authoredRoute, 'maintenance-gap');
  assert.ok(stormFollow.routes.includes('alternating-corridor'));
  assert.ok(stormFollow.routes.includes('maintenance-gap'));
  assert.ok((stormFollow.last?.objective?.stormExposure ?? Infinity) < 2.5);
  assert.ok(stormFollow.maximumWarningOwners <= 2);

  await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().encounter.chapterPacing?.roomId==='data-city:dual-crisis'`);
  const crisisFollow = await followPublicObjective(page, 'dual-crisis');
  const crisisDone = await continueNaturalRoom(page, crisisFollow.last);
  assert.equal(crisisDone.encounter.objective.status, 'completed');
  assert.equal(crisisDone.encounter.objective.crosslink.priority, 'least-charged');
  assert.ok(crisisDone.encounter.objective.crises[0].x * crisisDone.encounter.objective.crises[1].x
    + crisisDone.encounter.objective.crises[0].y * crisisDone.encounter.objective.crises[1].y < 0);
  assert.ok(crisisFollow.maximumWarningOwners <= 3);
  assert.ok(crisisDone.session.build.ownedUpgrades.length >= upgradesAfterEscort);
  return recovery;
}

async function reachProtocolZero(page, runMode = 'standard') {
  if (runMode === 'abyss') await page.trustedClick('input[name="run-mode"][value="abyss"]');
  await page.startGame();
  for (let index = 0; index < 4; index += 1) await completePrerequisiteNode(page);
  await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().campaignContent.loads['data-city']==='loaded'`);
  await completeAuthoredDataCityRooms(page);
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
    await driveTo(page, 0, 0, 0.24);
    await page.waitForPage(`document.querySelector('#mission-panel')?.dataset.presentationKind==='protocol-firewall'`);
    const presentation = await page.evaluate(`(()=>{
      const panel=document.querySelector('#mission-panel'),app=globalThis.__NEON_TIDE_V3__;
      let marker=null;
      for(const kind of ['objective','enemy','bossPart']) for(const id of app.world.query(kind)){
        const entity=app.world.get(id);if(entity?.type==='protocol-firewall-marker') marker={id,kind,x:entity.x,y:entity.y,variant:entity.variant,state:entity.state};
      }
      return {marker,text:document.querySelector('#mission-objective')?.textContent??'',dataset:{...panel.dataset},rendered:app.entityRenderer.getStats().observations.protocolFirewallMarkersRendered};
    })()`);
    assert.ok(presentation.marker, 'world presentation exposes the marked quadrant');
    assert.ok(presentation.text.includes('防火墙'));
    assert.equal(presentation.marker.variant, presentation.dataset.presentationShape);
    assert.equal(presentation.marker.state, presentation.dataset.presentationRadiusBand);
    assert.ok(presentation.rendered > 0);
    await driveTo(page, presentation.marker.x, presentation.marker.y, 0.3);
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().encounter.bossBehavior.firewall.clears>${index}`, 5000);
  }
  await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().encounter.bossBehavior.phase==='trafficGrid'`);
  return snapshot(page);
}

async function clearTrafficGrid(page) {
  for (let index = 0; index < 4; index += 1) {
    const safe = await page.evaluate(`(()=>{const app=globalThis.__NEON_TIDE_V3__;for(const kind of ['bossPart','enemy','objective'])for(const id of app.world.query(kind)){const e=app.world.get(id);if(e?.type==='protocol-safe-cell'&&e.state==='truthful')return {x:e.x,y:e.y};}return null})()`);
    assert.ok(safe, 'truthful cell has visible world presentation');
    await dashDriveTo(page, safe.x, safe.y, 0.28);
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().encounter.bossBehavior.trafficGrid.clears>${index}`, 5000);
  }
  await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().encounter.bossBehavior.phase==='cloneNodes'`);
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
      const automaticBefore = (await snapshot(page)).weapons.shotsFired;
      await page.waitForPage(`(()=>{const s=globalThis.__NEON_TIDE_V3__.getDebugSnapshot();return s.weapons.shotsFired>${automaticBefore}&&Object.values(s.encounter.bossBehavior.damageByWeapon).some((v)=>v>0)})()`, 10000);
      const automaticHit = await snapshot(page);
      assert.ok(automaticHit.encounter.bossBehavior.parts.nodes.some((node) => (
        automaticHit.weapons.lastTargetId === node.entityId || node.hp < node.maxHp
      )), 'automatic weapon naturally targets a visible clone node');
      await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().encounter.bossBehavior.phase==='kernel'`, 16000);
      await driveTo(page, 0, 0, 0.3);
      await page.waitForPage(`globalThis.__NEON_TIDE_V3__.session.getMode()==='upgrade'`, 12000);
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
      const rhythmSample = async () => page.evaluate(`(()=>{
        const app=globalThis.__NEON_TIDE_V3__,cells=[];
        for(const kind of ['bossPart','enemy','objective']) for(const id of app.world.query(kind)){
          const e=app.world.get(id);if(e?.type==='protocol-safe-cell')cells.push({kind,variant:e.variant,state:e.state,phase:e.phase,sequence:e.sequence});
        }
        return {cells,renderer:app.entityRenderer.getStats().observations,prompt:document.querySelector('#mission-objective')?.textContent??''};
      })()`);
      const first = await rhythmSample();
      await page.evaluate(`new Promise((resolve)=>setTimeout(resolve,320))`);
      const second = await rhythmSample();
      assert.equal(first.cells.length, 6);
      assert.ok(first.cells.some(({ phase, sequence }) => phase === sequence));
      assert.notDeepEqual(first.cells.map(({ phase }) => phase), second.cells.map(({ phase }) => phase));
      assert.ok(second.renderer.protocolRhythmEntitiesRendered > 0);
      assert.ok(second.renderer.protocolRhythmActiveRendered > 0);
      assert.ok(second.prompt.includes('离散节拍'));
    });
  }],
];
