import assert from 'node:assert/strict';
import { withPage } from './harness.mjs';

async function v3WeaponsScenario() {
  await withPage('v3-weapons-no-input', {}, async (page) => {
    await page.startGame();
    await page.waitForPage(`Boolean(globalThis.__NEON_TIDE_V3__?.getDebugSnapshot().legacy.combatBridge.playerId)`);
    page.requireDev('isolated automatic weapon sandbox');
    await page.gameEvaluate(`
      clearWorldEntities();
      $state.enemySpawnTimer=Infinity;$state.formationTimer=Infinity;$state.shardSpawnTimer=Infinity;
      $player.position.set(0,0);$player.velocity.set(0,0);syncPlayerTransform();
      return true;
    `);

    const setup = await page.evaluate(`(()=>{
      const api=globalThis.__NEON_TIDE_V3__;
      const world=api.world;
      const fodder=world.spawn('enemy',{x:0,y:2,hp:100,maxHp:100,radius:0.45,team:2,role:'swarm',threat:1,collidable:true});
      const executing=world.spawn('enemy',{x:7,y:0,hp:100,maxHp:100,radius:0.55,team:2,role:'lancer',threat:5,executingTelegraph:true,collidable:true});
      globalThis.__V3_WEAPON_PROBE__={fodder,executing};
      return {
        fodder,executing,
        canvases:document.querySelectorAll('canvas').length,
        input:api.inputSystem.snapshot(),
        pool:api.getDebugSnapshot().world.pools.friendlyProjectile,
      };
    })()`);
    assert.equal(setup.canvases, 1);
    assert.deepEqual(setup.input, {
      moveX: 0,
      moveY: 0,
      dashPressed: false,
      ultimatePressed: false,
      inputDevice: 'keyboard',
    });
    assert.equal('aimX' in setup.input, false);
    assert.equal('aimY' in setup.input, false);
    assert.equal(setup.pool.capacity, 96);

    await page.waitForPage(`(()=>{
      const {executing}=globalThis.__V3_WEAPON_PROBE__;
      const target=globalThis.__NEON_TIDE_V3__.world.get(executing);
      return target&&target.hp<100;
    })()`);
    const automatic = await page.evaluate(`(()=>{
      const api=globalThis.__NEON_TIDE_V3__;
      const {fodder,executing}=globalThis.__V3_WEAPON_PROBE__;
      return {
        fodderHp:api.world.get(fodder)?.hp,
        executingHp:api.world.get(executing)?.hp,
        weapons:api.getDebugSnapshot().weapons,
        collisions:api.getDebugSnapshot().collisions,
        renderer:api.getDebugSnapshot().renderer,
        player:api.getDebugSnapshot().player,
      };
    })()`);
    assert.ok(automatic.executingHp < 100, JSON.stringify(automatic));
    assert.equal(automatic.fodderHp, 100, JSON.stringify(automatic));
    assert.equal(automatic.weapons.lastTargetId, setup.executing);
    assert.ok(automatic.weapons.shotsByWeapon['pulse-cannon'] > 0);
    assert.ok(automatic.weapons.shotsByWeapon['arc-drones'] > 0);
    assert.ok(automatic.weapons.shotsByWeapon['prism-missiles'] > 0);
    assert.ok(automatic.collisions.totalHits > 0);
    assert.equal(automatic.renderer.mounted, true);
    assert.ok(automatic.renderer.pools.friendlyProjectile.count > 0);
    assert.ok(Math.hypot(automatic.player.velocity.x, automatic.player.velocity.y) < 0.01);

    await page.evaluate(`(()=>{
      const api=globalThis.__NEON_TIDE_V3__;
      const {executing}=globalThis.__V3_WEAPON_PROBE__;
      api.world.write(executing,{executingTelegraph:false,threat:1});
      return true;
    })()`);
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().weapons.lastTargetId===globalThis.__V3_WEAPON_PROBE__.fodder`);

    const beforeMove = await page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().player.position.x`);
    await page.dispatchKey('rawKeyDown', 'd', 'KeyD');
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().player.position.x>${beforeMove + 4.2}`);
    await page.dispatchKey('keyUp', 'd', 'KeyD');
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().weapons.lastTargetId===globalThis.__V3_WEAPON_PROBE__.executing`);
    const moved = await page.evaluate(`({
      player:globalThis.__NEON_TIDE_V3__.getDebugSnapshot().player.position,
      target:globalThis.__NEON_TIDE_V3__.getDebugSnapshot().weapons.lastTargetId,
    })`);
    assert.ok(moved.player.x > beforeMove + 4.2, JSON.stringify(moved));
    assert.equal(moved.target, setup.executing);

    const lance = await page.evaluate(`(async()=>{
      const {TIDE_LANCE_CHARGE_SECONDS,TIDE_LANCE_RETARGET_SECONDS,selectTideLanceLine}=await import('/src/systems/weapon-system.js');
      const line=selectTideLanceLine({x:0,y:0,facing:{x:0,y:1}},[
        {id:1,x:2,y:0,radius:0.4,threat:1},
        {id:2,x:5,y:0,radius:0.5,threat:8,weakPoint:true,type:'boss'},
      ],[{id:3,x:6,y:0,radius:0.6,objective:true,objectiveType:'core'}]);
      return {charge:TIDE_LANCE_CHARGE_SECONDS,retarget:TIDE_LANCE_RETARGET_SECONDS,line};
    })()`);
    assert.equal(lance.charge, 0.28);
    assert.equal(lance.retarget, 0.14);
    assert.deepEqual(lance.line.targetIds, [1, 2, 3]);
    assert.ok(lance.line.directionX > 0.99);

    const retarget = await page.gameEvaluate(`
      clearWorldEntities();
      $player.position.set(0,0);$player.velocity.set(0,0);$player.facing.set(1,0);syncPlayerTransform();
      const first=spawnEnemy('chaser',new THREE.Vector2(2,0));
      const second=spawnEnemy('chaser',new THREE.Vector2(-5,0));
      first.weakPoint=true;first.priority=0;second.priority=0;
      $state.weaponEnergy=100;$state.laserState='ready';$state.dashTimer=0;$state.dashInvulnTimer=0;
      const started=startLaserCharge();
      const initial={target:$state.laserTargetIndex,directionX:$state.laserDirection.x,used:$state.laserRetargetUsed};
      first.weakPoint=false;second.weakPoint=true;second.state='dash';
      updateLaser(1/60);
      const changed={target:$state.laserTargetIndex,directionX:$state.laserDirection.x,used:$state.laserRetargetUsed,elapsed:$state.laserElapsed};
      first.weakPoint=true;first.state='dash';first.priority=100;
      updateLaser(1/60);
      const final={target:$state.laserTargetIndex,directionX:$state.laserDirection.x,used:$state.laserRetargetUsed,elapsed:$state.laserElapsed};
      clearLaserState();clearWorldEntities();
      return {started,charge:LASER_RULES.chargeDuration,initial,changed,final};
    `);
    assert.equal(retarget.started, true);
    assert.equal(retarget.charge, 0.28);
    assert.deepEqual(retarget.initial, { target: 0, directionX: 1, used: false });
    assert.equal(retarget.changed.target, 1);
    assert.ok(retarget.changed.directionX < -0.99, JSON.stringify(retarget));
    assert.equal(retarget.changed.used, true);
    assert.equal(retarget.final.target, 1);
    assert.equal(retarget.final.used, true);
    assert.ok(retarget.final.elapsed < 0.14);
  });
}

export const v3WeaponScenarios = Object.freeze([
  ['v3 weapons no-input automatic combat', v3WeaponsScenario],
]);
