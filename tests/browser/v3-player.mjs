import assert from 'node:assert/strict';
import { sleep, withPage } from './harness.mjs';

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

async function v3PlayerScenario() {
  await withPage('v3-player-desktop', {}, async (page) => {
    await page.startGame();
    await page.waitForPage(`Boolean(globalThis.__NEON_TIDE_V3__?.getDebugSnapshot().player)`);
    page.requireDev('isolated v3 player sandbox probe');
    await page.gameEvaluate(`clearWorldEntities();$state.enemySpawnTimer=Infinity;$state.formationTimer=Infinity;$state.shardSpawnTimer=Infinity;return true`);

    const surface = await page.evaluate(`({
      canvases:document.querySelectorAll('canvas').length,
      touchActions:[...document.querySelectorAll('#touch-controls button')].map((button)=>button.textContent.trim()),
      aimIds:[...document.querySelectorAll('[id*="aim"],[class*="aim"]')].map((node)=>node.id||node.className),
      player:globalThis.__NEON_TIDE_V3__.getDebugSnapshot().player,
    })`);
    assert.equal(surface.canvases, 1);
    assert.deepEqual(surface.touchActions, ['潮矛E', '相位']);
    assert.deepEqual(surface.aimIds, []);
    assert.deepEqual(Object.keys(surface.player).sort(), [
      'autoFireRateBuffTimer', 'autoPulseTimer', 'autoShotsFired', 'cameraLead', 'dashCharges', 'dashTimer',
      'facing', 'inputDevice', 'perfectPhaseWindow', 'phaseTimer', 'position', 'velocity',
    ]);

    const start = surface.player.position;
    await page.dispatchKey('rawKeyDown', 'd', 'KeyD');
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().player.position.x > ${start.x + 0.05}`);
    await page.dispatchKey('keyUp', 'd', 'KeyD');
    const keyboard = await page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot()`);
    assert.equal(keyboard.player.inputDevice, 'keyboard');
    assert.ok(Math.hypot(keyboard.player.cameraLead.x, keyboard.player.cameraLead.y) > 0);

    const beforePointer = keyboard.player.position;
    await page.evaluate(`window.dispatchEvent(new MouseEvent('mousemove',{clientX:1,clientY:1,bubbles:true}));true`);
    await sleep(40);
    const afterPointer = await page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().player`);
    assert.ok(distance(beforePointer, afterPointer.position) < 0.25, JSON.stringify({ beforePointer, afterPointer }));
    assert.equal('aimX' in afterPointer, false);
    assert.equal('aimY' in afterPointer, false);

    const accessiblePhase = await page.evaluate(`({
      role:document.querySelector('#dash-pips').getAttribute('role'),
      min:document.querySelector('#dash-pips').getAttribute('aria-valuemin'),
      max:document.querySelector('#dash-pips').getAttribute('aria-valuemax'),
      now:document.querySelector('#dash-pips').getAttribute('aria-valuenow'),
      text:document.querySelector('#dash-pips').getAttribute('aria-valuetext'),
      live:document.querySelector('#phase-status').getAttribute('aria-live'),
    })`);
    assert.deepEqual(accessiblePhase, {
      role:'progressbar',min:'0',max:'2',now:'2',text:'相位冲刺 2.00 / 2；2 格就绪',live:'polite',
    });

    const autoLock = await page.gameEvaluate(`
      clearWorldEntities();
      $player.position.set(0,0);$player.velocity.set(0,0);$player.facing.set(1,0);syncPlayerTransform();
      const nearest=spawnEnemy('chaser',new THREE.Vector2(1.4,0));
      const priority=spawnEnemy('chaser',new THREE.Vector2(-5,1));
      priority.weakPoint=true;
      nearest.group.visible=true;priority.group.visible=true;
      $state.weaponEnergy=100;$state.laserState='ready';$state.dashTimer=0;$state.dashInvulnTimer=0;
      const started=startLaserCharge();
      const locked={x:$state.laserDirection.x,y:$state.laserDirection.y,mode:$state.laserTargetMode,index:$state.laserTargetIndex};
      input.actions=Object.freeze({moveX:1,moveY:0,dashPressed:false,ultimatePressed:false,inputDevice:'keyboard'});
      updatePlayer(1/60);
      syncLaserTransform();
      const afterMove={direction:{x:$state.laserDirection.x,y:$state.laserDirection.y},facing:{x:$player.facing.x,y:$player.facing.y}};
      clearLaserState();clearWorldEntities();
      $player.facing.set(0,-1);$state.weaponEnergy=100;$state.laserState='ready';
      const neutralStarted=startLaserCharge();
      const neutral={started:neutralStarted,mode:$state.laserTargetMode,index:$state.laserTargetIndex,direction:{x:$state.laserDirection.x,y:$state.laserDirection.y}};
      clearLaserState();
      return {started,locked,afterMove,neutral};
    `);
    assert.equal(autoLock.started, true);
    assert.equal(autoLock.locked.mode, 'target');
    assert.equal(autoLock.locked.index, 1);
    assert.ok(autoLock.locked.x < 0, JSON.stringify(autoLock));
    assert.ok(autoLock.afterMove.facing.x > 0, JSON.stringify(autoLock));
    assert.ok(Math.abs(autoLock.afterMove.direction.x-autoLock.locked.x)<1e-12);
    assert.ok(Math.abs(autoLock.afterMove.direction.y-autoLock.locked.y)<1e-12);
    assert.deepEqual(autoLock.neutral, {started:true,mode:'neutral',index:-1,direction:{x:0,y:-1}});

    await page.pressKey(' ', 'Space');
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().player.dashCharges[0] < 0.1`);
    const dashed = await page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().player`);
    assert.ok(dashed.phaseTimer > 0);
    assert.ok(dashed.perfectPhaseWindow >= 0 && dashed.perfectPhaseWindow <= 0.12);

    page.requireDev('perfect phase semantic collision probe');
    const perfect = await page.gameEvaluate(`
      $state.perfectPhaseWindow=0.1;$state.dashCharges=[0,1];$state.slowMotionScale=1;$state.slowMotionTimer=0;
      $state.autoFireRateBuffTimer=0;$state.autoPulseTimer=AUTO_PULSE_INTERVAL;
      const queuedBefore=globalThis.__NEON_TIDE_V3__.events.getStats().queued;
      const avoided=triggerPerfectPhase({nearMissCandidate:true,nearMissResolved:false,group:{position:new THREE.Vector3($player.position.x,$player.position.y,0)}});
      const queuedAfter=globalThis.__NEON_TIDE_V3__.events.getStats().queued;
      return {avoided,charges:[...$state.dashCharges],buff:$state.autoFireRateBuffTimer,pulseTimer:$state.autoPulseTimer,window:$state.perfectPhaseWindow,slow:$state.slowMotionTimer,queuedBefore,queuedAfter};
    `);
    assert.equal(perfect.avoided, true);
    assert.deepEqual(perfect.charges, [0.35, 1]);
    assert.equal(perfect.window, 0);
    assert.ok(perfect.buff > 0);
    assert.ok(perfect.pulseTimer <= 0.55 * 0.75 + 1e-9, JSON.stringify(perfect));
    assert.equal(perfect.slow, 0);
    assert.equal(perfect.queuedAfter, perfect.queuedBefore + 1);

    const pulseAttack = await page.gameEvaluate(`
      clearWorldEntities();$state.enemySpawnTimer=Infinity;$state.formationTimer=Infinity;$state.shardSpawnTimer=Infinity;
      const nearest=createChaser(new THREE.Vector2($player.position.x+1,$player.position.y));
      const weak=createChaser(new THREE.Vector2($player.position.x-4,$player.position.y));
      nearest.hp=4;nearest.maxHp=4;nearest.priority=0;
      weak.hp=4;weak.maxHp=4;weak.priority=0;weak.weakPoint=true;
      $state.autoFireRateBuffTimer=0;$state.autoPulseTimer=0;$state.stats.autoPulseShots=0;$state.stats.autoPulseLog=[];
      const particlesBefore=particles.length;const ripplesBefore=ripples.length;
      const queuedBefore=globalThis.__NEON_TIDE_V3__.events.getStats().queued;
      const audioCalls=[];const originalAudioEvent=audio.event;
      audio.event=(name,intensity)=>{audioCalls.push({name,intensity});return true;};
      try{updateAutomaticPulse(0);}finally{audio.event=originalAudioEvent;}
      const queuedAfter=globalThis.__NEON_TIDE_V3__.events.getStats().queued;
      return {nearestHp:nearest.hp,weakHp:weak.hp,record:$state.stats.autoPulseLog.at(-1),particles:particles.length-particlesBefore,ripples:ripples.length-ripplesBefore,audioCalls,queuedBefore,queuedAfter};
    `);
    assert.equal(pulseAttack.nearestHp, 4, JSON.stringify(pulseAttack));
    assert.equal(pulseAttack.weakHp, 3, JSON.stringify(pulseAttack));
    assert.equal(pulseAttack.record.hit, true);
    assert.equal(pulseAttack.record.targetIndex, 1);
    assert.equal(pulseAttack.record.damage, 1);
    assert.equal(pulseAttack.record.hpBefore, 4);
    assert.equal(pulseAttack.record.hpAfter, 3);
    assert.ok(pulseAttack.particles > 0 && pulseAttack.ripples > 0, JSON.stringify(pulseAttack));
    assert.deepEqual(pulseAttack.audioCalls.map(({name})=>name), ['laserHit']);
    assert.equal(pulseAttack.queuedAfter, pulseAttack.queuedBefore + 1);

    const cadence = await page.gameEvaluate(`
      clearWorldEntities();$state.enemySpawnTimer=Infinity;$state.formationTimer=Infinity;$state.shardSpawnTimer=Infinity;
      const measure=(activateBuff)=>{
        $state.autoFireRateBuffTimer=0;$state.autoPulseTimer=AUTO_PULSE_INTERVAL;
        $state.stats.autoPulseShots=0;$state.stats.autoPulseLog=[];
        if(activateBuff){$state.perfectPhaseWindow=0.1;triggerPerfectPhase({nearMissCandidate:true,nearMissResolved:false,group:{position:new THREE.Vector3($player.position.x,$player.position.y,0)}});}
        const startedAt=$state.elapsed;
        for(let guard=0;guard<120&&$state.stats.autoPulseLog.length<2;guard+=1){
          $state.elapsed+=1/60;
          updateAutomaticPulse(1/60);
          $state.autoFireRateBuffTimer=Math.max(0,$state.autoFireRateBuffTimer-1/60);
        }
        const times=$state.stats.autoPulseLog.map((entry)=>entry.elapsed-startedAt);
        return {times,first:times[0],interval:times[1]-times[0]};
      };
      return {base:measure(false),buffed:measure(true)};
    `);
    assert.ok(cadence.base.first > cadence.buffed.first, JSON.stringify(cadence));
    assert.ok(cadence.base.interval > cadence.buffed.interval, JSON.stringify(cadence));
    assert.ok(Math.abs(cadence.buffed.interval/cadence.base.interval-0.75)<0.08, JSON.stringify(cadence));

    const equivalence = await page.evaluate(`(async()=>{
      const [{createPlayerState,updatePlayerState},{createFixedLoop}]=await Promise.all([
        import('/src/systems/player-system.js'),
        import('/src/game/fixed-loop.js'),
      ]);
      const replay=(renderHz)=>{
        const player=createPlayerState();
        let simulatedAt=0;
        let renderCount=0;
        const actionAt=(time)=>({
          moveX:time<1.5?1:time<2.34?-0.45:0.2,
          moveY:time<1?0.35:-0.25,
          dashPressed:Math.abs(time-0.6666666667)<1e-6||Math.abs(time-2.1666666667)<1e-6,
          ultimatePressed:false,
          inputDevice:'keyboard',
        });
        const loop=createFixedLoop({
          stepSeconds:1/60,
          maxCatchUpSteps:6,
          onStep(dt){ updatePlayerState(player,actionAt(simulatedAt),dt);simulatedAt+=dt; },
          onRender(){ renderCount+=1; },
        });
        loop.reset(0);
        const frameMs=1000/renderHz;
        for(let frame=1;frame<=renderHz*3;frame+=1) loop.tick(frame*frameMs);
        return {position:player.position,stats:loop.getStats(),renderCount};
      };
      return {sixty:replay(60),thirty:replay(30)};
    })()`);
    assert.equal(equivalence.sixty.stats.steps, equivalence.thirty.stats.steps);
    assert.notEqual(equivalence.sixty.renderCount, equivalence.thirty.renderCount);
    assert.ok(distance(equivalence.sixty.position, equivalence.thirty.position) <= 0.03, JSON.stringify(equivalence));

    const gamepad = await page.evaluate(`(async()=>{
      const {normalizeActionSnapshot}=await import('/src/systems/input-system.js');
      return normalizeActionSnapshot({gamepad:{axes:[-1,0],buttons:[]}});
    })()`);
    assert.equal(gamepad.inputDevice, 'gamepad');
    assert.equal(gamepad.moveX, -1);
    assert.equal(gamepad.moveY, 0);
  });

  await withPage('v3-player-mobile-390x844', {
    width: 390,
    height: 844,
    mobile: true,
    touch: true,
    deviceScaleFactor: 3,
  }, async (page) => {
    await page.tap('#primary-button');
    await page.waitForPage(`!document.querySelector('#overlay').classList.contains('visible')`);
    const layout = await page.evaluate(`(()=>{
      const selectors=['#joystick','#laser-button','#dash-button'];
      const boxes=Object.fromEntries(selectors.map((selector)=>{
        const rect=document.querySelector(selector).getBoundingClientRect();
        return [selector,{left:rect.left,top:rect.top,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height}];
      }));
      const overlap=(a,b)=>Math.max(a.left,b.left)<Math.min(a.right,b.right)&&Math.max(a.top,b.top)<Math.min(a.bottom,b.bottom);
      return {
        boxes,
        overlaps:[overlap(boxes['#joystick'],boxes['#laser-button']),overlap(boxes['#joystick'],boxes['#dash-button']),overlap(boxes['#laser-button'],boxes['#dash-button'])],
        viewport:{width:innerWidth,height:innerHeight},
        canvasCount:document.querySelectorAll('canvas').length,
      };
    })()`);
    assert.equal(layout.canvasCount, 1);
    assert.deepEqual(layout.overlaps, [false, false, false], JSON.stringify(layout));
    for (const box of Object.values(layout.boxes)) {
      assert.ok(box.left >= 0 && box.top >= 0 && box.right <= layout.viewport.width && box.bottom <= layout.viewport.height, JSON.stringify(layout));
    }

    const beforeSwitch = await page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().player.position.x`);
    await page.dispatchKey('rawKeyDown', 'd', 'KeyD');
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().player.position.x > ${beforeSwitch + 0.03}`);
    const provenance = await page.evaluate(`(()=>{
      const system=globalThis.__NEON_TIDE_V3__.inputSystem;
      system.setTouchVector(0,1);
      const before=system.getLastActiveDevice();
      document.querySelector('#dash-button').click();
      return {before,after:system.getLastActiveDevice(),press:system.getLastPressDevice()};
    })()`);
    assert.deepEqual(provenance, {before:'touch',after:'keyboard',press:'keyboard'});
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().player?.dashCharges.some((charge)=>charge<0.2)`);
    const switchDash = await page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot()`);
    await page.dispatchKey('keyUp', 'd', 'KeyD');
    assert.equal(switchDash.player.inputDevice, 'keyboard');
    assert.equal(switchDash.input.pressDevice, 'keyboard');
    assert.ok(switchDash.player.position.x > beforeSwitch);
    assert.ok(switchDash.player.facing.x > 0);
    assert.equal(await page.evaluate(`document.querySelector('#dash-button').tagName`), 'BUTTON');
    assert.equal(await page.evaluate(`document.querySelector('#laser-button').tagName`), 'BUTTON');
  });
}

export const v3PlayerScenarios = [
  ['v3 player no-aim vertical slice', v3PlayerScenario],
];
