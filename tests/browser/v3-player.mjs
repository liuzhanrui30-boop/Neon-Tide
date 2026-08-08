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
      'autoFireRateBuffTimer', 'cameraLead', 'dashCharges', 'dashTimer', 'facing', 'inputDevice',
      'perfectPhaseWindow', 'phaseTimer', 'position', 'velocity',
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

    await page.pressKey(' ', 'Space');
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().player.dashCharges[0] < 0.1`);
    const dashed = await page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().player`);
    assert.ok(dashed.phaseTimer > 0);
    assert.ok(dashed.perfectPhaseWindow >= 0 && dashed.perfectPhaseWindow <= 0.12);

    page.requireDev('perfect phase semantic collision probe');
    const perfect = await page.gameEvaluate(`
      $state.perfectPhaseWindow=0.1;$state.dashCharges=[0,1];$state.slowMotionScale=1;$state.slowMotionTimer=0;
      const queuedBefore=globalThis.__NEON_TIDE_V3__.events.getStats().queued;
      const avoided=triggerPerfectPhase({nearMissCandidate:true,nearMissResolved:false,group:{position:new THREE.Vector3($player.position.x,$player.position.y,0)}});
      const queuedAfter=globalThis.__NEON_TIDE_V3__.events.getStats().queued;
      return {avoided,charges:[...$state.dashCharges],buff:$state.autoFireRateBuffTimer,window:$state.perfectPhaseWindow,slow:$state.slowMotionTimer,queuedBefore,queuedAfter};
    `);
    assert.equal(perfect.avoided, true);
    assert.deepEqual(perfect.charges, [0.35, 1]);
    assert.equal(perfect.window, 0);
    assert.ok(perfect.buff > 0);
    assert.equal(perfect.slow, 0);
    assert.equal(perfect.queuedAfter, perfect.queuedBefore + 1);

    const equivalence = await page.evaluate(`(async()=>{
      const {createPlayerState,updatePlayerState,FIXED_PLAYER_STEP}=await import('/src/systems/player-system.js');
      const replay=(renderHz)=>{
        const player=createPlayerState();
        const fixedPerRender=60/renderHz;
        for(let frame=0;frame<renderHz*3;frame+=1){
          for(let fixed=0;fixed<fixedPerRender;fixed+=1){
            const step=frame*fixedPerRender+fixed;
            updatePlayerState(player,{
              moveX:step<90?1:step<140?-0.45:0.2,
              moveY:step<60?0.35:-0.25,
              dashPressed:step===40||step===130,
              ultimatePressed:false,
              inputDevice:'keyboard',
            },FIXED_PLAYER_STEP);
          }
        }
        return player.position;
      };
      return {sixty:replay(60),thirty:replay(30)};
    })()`);
    assert.ok(distance(equivalence.sixty, equivalence.thirty) <= 0.03, JSON.stringify(equivalence));

    const gamepad = await page.evaluate(`(()=>{
      const input=globalThis.__NEON_TIDE_V3__.inputSystem;
      input.setGamepadState({axes:[-1,0],buttons:[]});
      return input.snapshot();
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

    await page.tap('#dash-button');
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().player?.inputDevice === 'touch'`);
    const touchDash = await page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().player`);
    assert.ok(touchDash.dashCharges.some((charge) => charge < 0.2));
    assert.equal(await page.evaluate(`document.querySelector('#dash-button').tagName`), 'BUTTON');
    assert.equal(await page.evaluate(`document.querySelector('#laser-button').tagName`), 'BUTTON');
  });
}

export const v3PlayerScenarios = [
  ['v3 player no-aim vertical slice', v3PlayerScenario],
];
