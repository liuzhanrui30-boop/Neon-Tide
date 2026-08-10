import assert from 'node:assert/strict';
import { APP_URL, withPage } from './harness.mjs';

const WEAPON_URL = new URL('?weapon-test=1', APP_URL).href;

async function v3WeaponsScenario() {
  await withPage('v3-weapons-no-input', { appUrl: WEAPON_URL }, async (page) => {
    await page.startGame();
    await page.waitForPage(`Boolean(globalThis.__NEON_TIDE_V3__?.getDebugSnapshot().legacy.combatBridge.playerId)`);
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.world.query('objective').length>0&&globalThis.__NEON_TIDE_V3__.getDebugSnapshot().renderer.pools.objective.count>0`);
    page.requireDev('isolated automatic weapon sandbox');
    const naturalObjective = await page.evaluate(`(()=>{
      const api=globalThis.__NEON_TIDE_V3__;
      const id=api.world.query('objective').at(0);
      const objective=api.world.get(id);
      const debug=api.getDebugSnapshot();
      return {id,objective,bridge:debug.objectiveBridge,renderer:debug.renderer.pools.objective};
    })()`);
    assert.equal(naturalObjective.objective.objectiveType, 'anchors');
    assert.equal(naturalObjective.objective.objective, true);
    assert.equal(naturalObjective.objective.team, 1);
    assert.ok(naturalObjective.bridge.entities > 0);
    assert.ok(naturalObjective.renderer.count > 0);

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
    assert.equal(automatic.weapons.shotsByWeapon['arc-drones'], 0);
    assert.equal(automatic.weapons.shotsByWeapon['prism-missiles'], 0);
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

    const hardening = await page.evaluate(`(async()=>{
      const [{createEntityWorld},{createWeaponSystem},{createCollisionSystem,sweptCircleHit},{createEventQueue,createPresentationEventConsumer}]=await Promise.all([
        import('/src/game/entity-world.js'),import('/src/systems/weapon-system.js'),import('/src/systems/collision-system.js'),import('/src/game/events.js')
      ]);
      const cooldownWorld=createEntityWorld({capacities:{player:1,enemy:1,friendlyProjectile:16}});
      const playerId=cooldownWorld.spawn('player',{x:0,y:0,team:1});
      cooldownWorld.spawn('enemy',{x:8,y:0,hp:100,team:2,collidable:true});
      const weapons=createWeaponSystem();
      const sink={emit(){return true;}};
      weapons.update(cooldownWorld,playerId,.1,sink);
      const before=weapons.getStats().cooldowns['prism-missiles'];
      cooldownWorld.write(playerId,{fireTimer:.8});
      weapons.update(cooldownWorld,playerId,.01,sink);
      const edge=weapons.getStats().cooldowns['prism-missiles'];
      weapons.update(cooldownWorld,playerId,.01,sink);
      const held=weapons.getStats().cooldowns['prism-missiles'];

      const contactWorld=createEntityWorld({capacities:{player:1,enemy:3}});
      contactWorld.spawn('player',{x:0,y:0,radius:.4,team:1,collidable:true});
      contactWorld.spawn('enemy',{x:0,y:0,hp:2,radius:1,contactRadius:1,damage:4,team:2,type:'mine',collidable:true,contactDamaging:false});
      contactWorld.spawn('enemy',{x:0,y:0,hp:2,radius:1,contactRadius:1,damage:4,team:2,type:'lancer',collidable:true,contactDamaging:false});
      const hunter=contactWorld.spawn('enemy',{x:0,y:0,hp:2,radius:1,contactRadius:1,damage:1,team:2,type:'chaser',collidable:true,contactDamaging:true});
      let contactDamage=0;
      createCollisionSystem().resolve(contactWorld,{damageHull(amount){contactDamage+=amount;return true;}},1/60,sink);

      const queue=createEventQueue(4);const consumer=createPresentationEventConsumer({capacity:7});
      for(let index=0;index<3000;index+=1){queue.emit('weaponFire',{index});queue.drain(consumer.consume);}
      return {
        cooldown:{before,edge,held},contact:{damage:contactDamage,hunter:Boolean(contactWorld.get(hunter))},
        sweep:{tunnel:sweptCircleHit({previousX:-10,previousY:0,x:10,y:0,radius:.1},{x:0,y:0,radius:.4}),zero:sweptCircleHit({previousX:2,previousY:2,x:2,y:2,radius:.1},{x:2.2,y:2,radius:.2}),extreme:sweptCircleHit({previousX:-1e150,previousY:0,x:1e150,y:0,radius:1},{x:0,y:0,radius:1})},
        queue:queue.getStats(),consumer:consumer.getStats(),
      };
    })()`);
    assert.ok(Math.abs(hardening.cooldown.edge - (hardening.cooldown.before * 0.75 - 0.01)) < 1e-9, JSON.stringify(hardening));
    assert.ok(Math.abs(hardening.cooldown.held - (hardening.cooldown.edge - 0.01)) < 1e-9, JSON.stringify(hardening));
    assert.deepEqual(hardening.contact, { damage: 1, hunter: true });
    assert.deepEqual(hardening.sweep, { tunnel: true, zero: true, extreme: true });
    assert.equal(hardening.queue.dropped, 0);
    assert.equal(hardening.queue.queued, 0);
    assert.equal(hardening.consumer.count, 7);

    const retarget = await page.gameEvaluate(`
      clearWorldEntities();
      $player.position.set(0,0);$player.velocity.set(0,0);$player.facing.set(1,0);syncPlayerTransform();
      $state.weaponEnergy=100;$state.laserState='ready';$state.dashTimer=0;$state.dashInvulnTimer=0;
      const started=startLaserCharge();
      const initial={target:$state.laserTargetIndex,targetId:$state.laserTargetSourceId,directionX:$state.laserDirection.x,mode:$state.laserTargetMode,used:$state.laserRetargetUsed};
      const firstApplied=applyAuthoritativeTideLanceAim({sequence:$state.laserSequence,targetIds:[101],directionX:1,directionY:0,score:10});
      const first={target:$state.laserTargetIndex,targetId:$state.laserTargetSourceId,directionX:$state.laserDirection.x,mode:$state.laserTargetMode,used:$state.laserRetargetUsed};
      const secondApplied=applyAuthoritativeTideLanceAim({sequence:$state.laserSequence,targetIds:[202],directionX:-1,directionY:0,score:20});
      const changed={target:$state.laserTargetIndex,targetId:$state.laserTargetSourceId,directionX:$state.laserDirection.x,mode:$state.laserTargetMode,used:$state.laserRetargetUsed,elapsed:$state.laserElapsed};
      clearLaserState();clearWorldEntities();
      return {started,charge:LASER_RULES.chargeDuration,initial,firstApplied,first,secondApplied,changed};
    `);
    assert.equal(retarget.started, true);
    assert.equal(retarget.charge, 0.28);
    assert.equal(retarget.initial.mode, 'pending');
    assert.equal(retarget.initial.target, -1);
    assert.equal(retarget.initial.targetId, 0);
    assert.equal(retarget.initial.directionX, 1);
    assert.equal(retarget.initial.used, false);
    assert.equal(retarget.firstApplied, true);
    assert.equal(retarget.first.mode, 'target');
    assert.equal(retarget.first.targetId, 101);
    assert.equal(retarget.first.used, false);
    assert.equal(retarget.secondApplied, true);
    assert.equal(retarget.changed.target, -1);
    assert.equal(retarget.changed.targetId, 202);
    assert.ok(retarget.changed.directionX < -0.99, JSON.stringify(retarget));
    assert.equal(retarget.changed.used, true);

    const proxySources = await page.gameEvaluate(`
      clearWorldEntities();
      const mine=spawnEnemy('mine',new THREE.Vector2(-5,-3),{hp:100,maxHp:100});
      const lancer=spawnEnemy('lancer',new THREE.Vector2(5,-3),{hp:100,maxHp:100});
      const hunter=spawnEnemy('hunter',new THREE.Vector2(-5,3),{hp:100,maxHp:100});
      const entering=spawnEnemy('hunter',new THREE.Vector2(5,3),{hp:100,maxHp:100});
      setEnemyState(entering,'enter',5,0);
      return {mine:mine.sourceId,lancer:lancer.sourceId,hunter:hunter.sourceId,entering:entering.sourceId};
    `);
    await page.waitForPage(`(()=>{const ids=new Set(Object.values(${JSON.stringify(proxySources)}));return [...globalThis.__NEON_TIDE_V3__.world.query('enemy')].map(id=>globalThis.__NEON_TIDE_V3__.world.get(id)).filter(entity=>ids.has(entity.sourceId)).length===4;})()`);
    const proxyContacts = await page.evaluate(`(()=>{const api=globalThis.__NEON_TIDE_V3__;const ids=${JSON.stringify(proxySources)};const bySource=Object.fromEntries([...api.world.query('enemy')].map(id=>api.world.get(id)).map(entity=>[entity.sourceId,entity]));return {mine:bySource[ids.mine].contactDamaging,lancer:bySource[ids.lancer].contactDamaging,hunter:bySource[ids.hunter].contactDamaging,entering:bySource[ids.entering].contactDamaging};})()`);
    assert.deepEqual(proxyContacts, { mine: false, lancer: false, hunter: true, entering: false });

    const bossTransition = await page.gameEvaluate(`
      clearWorldEntities();
      session.completeRoom({nextMode:'upgrade',stageIndex:2});
      session.selectUpgrade(session.snapshot().build.pendingOffer.cards[0]);
      session.startRoom({id:'v2.2-boss-compatibility',compatibility:true,chapterIndex:3});
      enterStage(3,false);
      beginBossStage();
      const boss=$enemies.find((enemy)=>enemy.type==='boss');
      setEnemyState(boss,'telegraph',10,10);
      return {stage:$state.stageIndex,bossId:boss.sourceId,hp:boss.hp,state:boss.state};
    `);
    assert.equal(bossTransition.stage, 3);
    assert.equal(bossTransition.state, 'telegraph');
    await page.waitForPage(`(()=>{const api=globalThis.__NEON_TIDE_V3__;const id=api.world.query('bossPart').at(0);const part=id&&api.world.get(id);return part&&part.sourceId===${bossTransition.bossId}&&part.armored&&!part.weakPoint;})()`);
    const armored = await page.evaluate(`(()=>{
      const api=globalThis.__NEON_TIDE_V3__;const part=api.world.get(api.world.query('bossPart').at(0));
      const body=[...api.world.query('enemy')].map(id=>api.world.get(id)).find(entity=>entity.sourceId===part.sourceId);
      const projectile=api.world.spawn('friendlyProjectile',{x:part.x,y:part.y,previousX:part.x,previousY:part.y,damage:4,radius:.1,team:1,weaponId:'armor-probe',collidable:true});
      return {projectile,part,body};
    })()`);
    assert.equal(armored.part.partId, 'core');
    assert.equal(armored.part.armored, true);
    assert.equal(armored.part.weakPoint, false);
    assert.equal(armored.body.invulnerable, true);
    assert.equal(armored.body.contactDamaging, true);
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.world.get(${armored.projectile})===null`);
    const armoredHp = await page.gameEvaluate(`return $enemies.find((enemy)=>enemy.type==='boss')?.hp`);
    assert.equal(armoredHp, bossTransition.hp);

    const weakBefore = await page.gameEvaluate(`const boss=$enemies.find((enemy)=>enemy.type==='boss');setEnemyState(boss,'recover',2,0);return boss.hp`);
    await page.waitForPage(`(()=>{const api=globalThis.__NEON_TIDE_V3__;const part=api.world.get(api.world.query('bossPart').at(0));return part&&part.weakPoint&&!part.armored;})()`);
    const weakProjectile = await page.evaluate(`(()=>{const api=globalThis.__NEON_TIDE_V3__;const part=api.world.get(api.world.query('bossPart').at(0));return api.world.spawn('friendlyProjectile',{x:part.x,y:part.y,previousX:part.x,previousY:part.y,damage:2,radius:.1,team:1,weaponId:'weak-probe',collidable:true});})()`);
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.world.get(${weakProjectile})===null`);
    const weakAfter = await page.gameEvaluate(`return $enemies.find((enemy)=>enemy.type==='boss')?.hp`);
    assert.ok(weakAfter <= weakBefore - 3, JSON.stringify({ weakBefore, weakAfter }));
    const cleanupProjectile = await page.evaluate(`(()=>{const api=globalThis.__NEON_TIDE_V3__;const part=api.world.get(api.world.query('bossPart').at(0));return api.world.spawn('friendlyProjectile',{x:part.x,y:part.y,previousX:part.x,previousY:part.y,damage:999,radius:.1,team:1,weaponId:'boss-cleanup-probe',collidable:true});})()`);
    assert.ok(cleanupProjectile);
    await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().session.mode==='victory'&&globalThis.__NEON_TIDE_V3__.world.query('bossPart').length===0`);
    const finalDebug = await page.evaluate(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot()`);
    assert.equal(finalDebug.events.queued, 0);
    assert.equal(finalDebug.events.dropped, 0);
    assert.equal(finalDebug.legacy.combatBridge.bossParts, 0);
    assert.ok(finalDebug.legacy.combatBridge.consumedWeaponEvents > 0);
    assert.ok(finalDebug.presentationEvents.recent.length <= 64);
  });

  await withPage('v3-weapons-coarse-390x844', {
    appUrl: WEAPON_URL,
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
    touch: true,
  }, async (page) => {
    await page.startGame();
    await page.waitForPage(`Boolean(globalThis.__NEON_TIDE_V3__?.getDebugSnapshot().legacy.combatBridge.playerId)`);
    const caps = await page.evaluate(`(()=>{const debug=globalThis.__NEON_TIDE_V3__.getDebugSnapshot();return {world:debug.world.pools,renderer:debug.renderer.pools,quality:document.documentElement.dataset.renderQuality};})()`);
    assert.equal(caps.world.friendlyProjectile.capacity, 72);
    assert.equal(caps.world.enemyProjectile.capacity, 72);
    assert.equal(caps.renderer.friendlyProjectile.capacity, 72);
    assert.equal(caps.renderer.enemyProjectile.capacity, 72);
    assert.equal(caps.quality, 'mobile');
  });
}

async function v3TideLanceSingleAuthorityScenario() {
  await withPage('v3-tide-lance-single-damage-authority', {
    appUrl: WEAPON_URL,
    reducedMotion: true,
  }, async (page) => {
    await page.startGame();
    await page.waitForPage(`Boolean(globalThis.__NEON_TIDE_V3__?.getDebugSnapshot().legacy.combatBridge.playerId)`);
    page.requireDev('real input Tide Lance mirror pipeline');

    async function prepareNaturalMirror({ bulwark = false } = {}) {
      const source = await page.gameEvaluate(`
        const api=globalThis.__NEON_TIDE_V3__;
        clearWorldEntities();
        for(const id of [...api.world.query('enemy')]) api.world.despawn(id);
        for(const id of [...api.world.query('friendlyProjectile')]) api.world.despawn(id);
        $state.enemySpawnTimer=Infinity;$state.formationTimer=Infinity;$state.shardSpawnTimer=Infinity;
        $state.stageIndex=${bulwark ? 2 : 0};
        $state.elapsed=${bulwark ? 64.4 : 4.4};
        $state.lastFormation=null;$state.lastFormationAt=-Infinity;
        $state.stats.formationCount=0;$state.stats.formationLog=[];
        for(let attempt=0;attempt<${bulwark ? 32 : 1};attempt+=1){
          spawnFormation();
          if($enemies.some((enemy)=>${bulwark
    ? `ENEMY_TYPES[enemy.type]?.role==='Bulwark'`
    : `enemy.type!=='boss'&&enemy.type!=='bulwark'&&enemy.type!=='mine'`})) break;
          for(let index=$enemies.length-1;index>=0;index-=1) removeEnemy(index);
          $state.lastFormation=null;$state.lastFormationAt=-Infinity;
        }
        const target=$enemies.find((enemy)=>enemy&&!enemy.dead&&${bulwark
    ? `ENEMY_TYPES[enemy.type]?.role==='Bulwark'`
    : `enemy.type!=='boss'&&enemy.type!=='bulwark'&&enemy.type!=='mine'`});
        if(!target) throw new Error('authored formation did not create ${bulwark ? 'Bulwark' : 'ordinary'} mirror target');
        for(let index=$enemies.length-1;index>=0;index-=1){if($enemies[index]!==target)removeEnemy(index);}
        const objective=combatBridge.objective;
        let directionX=-(objective?.x??0),directionY=-(objective?.y??0);
        const directionLength=Math.hypot(directionX,directionY);
        if(directionLength<.01){directionX=1;directionY=0;}else{directionX/=directionLength;directionY/=directionLength;}
        const playerX=directionX*2.35,playerY=directionY*2.35;
        $player.position.set(playerX,playerY);$player.velocity.set(0,0);$player.facing.set(directionX,directionY);syncPlayerTransform();
        target.group.position.set(playerX+directionX*3,playerY+directionY*3,2);
        target.velocity.set(0,0);target.hp=20;target.maxHp=20;target.dead=false;target.pendingLaserDeath=false;
        target.priority=100;target.weakPoint=${bulwark ? 'false' : 'true'};
        setEnemyState(target,'recover',10,0);
        $state.weaponEnergy=100;input.laserBuffer=0;$state.dashTimer=0;$state.dashInvulnTimer=0;
        if(!globalThis.__V3_TIDE_AUDIO_ORIGINAL__){
          globalThis.__V3_TIDE_AUDIO_ORIGINAL__=$audio.event.bind($audio);
          $audio.event=(name,...args)=>{
            const probe=globalThis.__V3_TIDE_AUDIO_PROBE__;
            if(probe) probe[name]=(probe[name]??0)+1;
            return globalThis.__V3_TIDE_AUDIO_ORIGINAL__(name,...args);
          };
        }
        globalThis.__V3_TIDE_AUDIO_PROBE__={};
        return {sourceId:target.sourceId,directionX,directionY,type:target.type};
      `);
      await page.waitForPage(`(()=>{
        const api=globalThis.__NEON_TIDE_V3__;
        return [...api.world.query('enemy')].map(id=>api.world.get(id))
          .some((enemy)=>enemy?.sourceId===${source.sourceId});
      })()`);
      return page.evaluate(`(()=>{
        const api=globalThis.__NEON_TIDE_V3__,world=api.world;
        const targetId=[...world.query('enemy')].find(id=>world.get(id)?.sourceId===${source.sourceId});
        const target=world.get(targetId);
        for(const id of [...world.query('friendlyProjectile')]) world.despawn(id);
        const decoy=world.spawn('enemy',{
          x:target.x-${source.directionY}*12,y:target.y+${source.directionX}*12,
          hp:10000,maxHp:10000,radius:.5,team:2,role:'audio-decoy',type:'audio-decoy',
          threat:100,executingTelegraph:true,collidable:true,contactDamaging:false,
          armored:true,weakPoint:false,
        });
        globalThis.__V3_TIDE_AUDIO_PROBE__={};
        const debug=api.getDebugSnapshot();
        return {source:${JSON.stringify(source)},targetId,decoy,target,
          before:{weapons:debug.weapons.lanceShots,records:debug.legacy.combatBridge.tideLanceDamageRecords,
            audio:debug.legacy.combatBridge.tideLanceAudioCues,feedback:debug.legacy.combatBridge.tideLanceFeedbackEvents,
            hp:target.hp}};
      })()`);
    }

    async function fireRealTideLance(probe) {
      await page.dispatchKey('rawKeyDown', 'e', 'KeyE');
      try {
        await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().weapons.lanceShots>${probe.before.weapons}`, 3500);
        await page.waitForPage(`globalThis.__NEON_TIDE_V3__.getDebugSnapshot().legacy.combatBridge.tideLanceDamageRecords>${probe.before.records}`, 3500);
      } finally {
        await page.dispatchKey('keyUp', 'e', 'KeyE');
      }
      const result = await page.evaluate(`(()=>{
        const api=globalThis.__NEON_TIDE_V3__,debug=api.getDebugSnapshot();
        const target=api.world.get(${probe.targetId});
        return {debug,target,audio:globalThis.__V3_TIDE_AUDIO_PROBE__};
      })()`);
      result.legacy = await page.gameEvaluate(`
        const target=$enemies.find((enemy)=>enemy?.sourceId===${probe.source.sourceId});
        return target?{hp:target.hp,dead:target.dead,type:target.type}:null;
      `);
      return result;
    }

    const ordinaryProbe = await prepareNaturalMirror();
    assert.equal(ordinaryProbe.target.armored, false, JSON.stringify(ordinaryProbe));
    const ordinary = await fireRealTideLance(ordinaryProbe);
    const ordinaryBridge = ordinary.debug.legacy.combatBridge;
    assert.equal(ordinaryBridge.damageAuthority, 'ecs');
    assert.equal(ordinaryBridge.tideLanceDamageRecords - ordinaryProbe.before.records, 1, JSON.stringify(ordinary));
    assert.equal(ordinaryBridge.tideLanceAudioCues - ordinaryProbe.before.audio, 1, JSON.stringify(ordinary));
    assert.equal(ordinaryBridge.tideLanceFeedbackEvents - ordinaryProbe.before.feedback, 1, JSON.stringify(ordinary));
    assert.equal(ordinary.audio.laserHit, 1, JSON.stringify(ordinary));
    assert.match(ordinaryBridge.lastTideLanceFeedbackText, /^光矛贯穿 ×1$/);
    assert.equal(ordinaryBridge.lastTideLanceDamageRecords.length, 1, JSON.stringify(ordinary));
    const ordinaryRecord = ordinaryBridge.lastTideLanceDamageRecords[0];
    assert.equal(ordinaryRecord.targetId, ordinaryProbe.targetId);
    assert.equal(ordinaryRecord.weaponId, 'tide-lance');
    assert.equal(ordinaryRecord.hpBefore, ordinaryProbe.before.hp);
    assert.ok(Math.abs((ordinaryRecord.hpBefore - ordinaryRecord.hpAfter) - ordinaryRecord.amount) < 1e-9);
    assert.equal(ordinary.target.hp, ordinaryRecord.hpAfter);
    assert.equal(ordinary.legacy.hp, ordinaryRecord.hpAfter);

    const duplicateFrame = await page.gameEvaluate(`
      const record=combatBridge.lastTideLanceDamageRecords[0];
      const before={
        records:combatBridge.tideLanceDamageRecords,
        audio:combatBridge.tideLanceAudioCues,
        feedback:combatBridge.tideLanceFeedbackEvents,
        feedbackEvents:combatBridge.feedbackEvents,
        laserHit:globalThis.__V3_TIDE_AUDIO_PROBE__.laserHit??0,
        autoText:floatingTexts.filter(({element})=>element?.textContent?.startsWith('AUTO')).length,
      };
      applyCombatSummary(combatBridge.entityWorld,{
        damageRecords:[record],hits:1,damage:record.amount,destroyed:0,
        weaponHitEventEmitted:true,perfectPhases:0,playerDamage:0,
      });
      events.emit('weaponHit',Object.freeze({count:1,byWeapon:Object.freeze({'tide-lance':1})}));
      return {before,pending:combatBridge.pendingFeedback};
    `);
    await page.evaluate(`new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    duplicateFrame.after = await page.evaluate(`(()=>{
      const bridge=globalThis.__NEON_TIDE_V3__.getDebugSnapshot().legacy.combatBridge;
      return {
        records:bridge.tideLanceDamageRecords,
        audio:bridge.tideLanceAudioCues,
        feedback:bridge.tideLanceFeedbackEvents,
        feedbackEvents:bridge.feedbackEvents,
        laserHit:globalThis.__V3_TIDE_AUDIO_PROBE__.laserHit??0,
        autoText:[...document.querySelectorAll('.floating-text')]
          .filter((element)=>element.textContent?.startsWith('AUTO')).length,
      };
    })()`);
    assert.equal(duplicateFrame.after.records, duplicateFrame.before.records + 1, JSON.stringify(duplicateFrame));
    assert.equal(duplicateFrame.after.audio, duplicateFrame.before.audio, JSON.stringify(duplicateFrame));
    assert.equal(duplicateFrame.after.feedback, duplicateFrame.before.feedback, JSON.stringify(duplicateFrame));
    assert.equal(duplicateFrame.after.feedbackEvents, duplicateFrame.before.feedbackEvents, JSON.stringify(duplicateFrame));
    assert.equal(duplicateFrame.after.laserHit, duplicateFrame.before.laserHit, JSON.stringify(duplicateFrame));
    assert.equal(duplicateFrame.after.autoText, duplicateFrame.before.autoText, JSON.stringify(duplicateFrame));
    assert.equal(duplicateFrame.pending, null, JSON.stringify(duplicateFrame));

    await page.waitForGame(`return $state.laserState==='idle'`, Boolean, 3000);
    const bulwarkProbe = await prepareNaturalMirror({ bulwark: true });
    assert.ok(['bulwark', 'elite'].includes(bulwarkProbe.source.type));
    assert.equal(bulwarkProbe.target.hp, 20);
    assert.equal(bulwarkProbe.target.armored, true, JSON.stringify(bulwarkProbe));
    assert.equal(bulwarkProbe.target.weakPoint, false, JSON.stringify(bulwarkProbe));
    const bulwark = await fireRealTideLance(bulwarkProbe);
    const bulwarkBridge = bulwark.debug.legacy.combatBridge;
    assert.equal(bulwarkBridge.tideLanceDamageRecords - bulwarkProbe.before.records, 1, JSON.stringify(bulwark));
    assert.equal(bulwarkBridge.tideLanceAudioCues - bulwarkProbe.before.audio, 1, JSON.stringify(bulwark));
    assert.equal(bulwarkBridge.tideLanceFeedbackEvents - bulwarkProbe.before.feedback, 1, JSON.stringify(bulwark));
    assert.equal(bulwark.audio.laserHit, 1, JSON.stringify(bulwark));
    assert.equal(bulwarkBridge.lastTideLanceDamageRecords.length, 1, JSON.stringify(bulwark));
    const bulwarkRecord = bulwarkBridge.lastTideLanceDamageRecords[0];
    assert.equal(bulwarkRecord.targetId, bulwarkProbe.targetId);
    assert.equal(bulwarkRecord.hpBefore, 20);
    assert.equal(bulwarkRecord.hpAfter, 16.8);
    assert.equal(bulwarkRecord.amount, 3.2);
    assert.equal(bulwarkRecord.armorBreak, true);
    assert.equal(bulwarkRecord.armorBreakKind, 'tide-lance');
    assert.equal(bulwark.target.hp, 16.8);
    assert.equal(bulwark.legacy.hp, 16.8);
    assert.equal(bulwark.target.armored, false, JSON.stringify(bulwark));
    assert.equal(bulwark.target.weakPoint, true, JSON.stringify(bulwark));

    await page.waitForPage(`(()=>{
      const enemy=globalThis.__NEON_TIDE_V3__.world.get(${bulwarkProbe.targetId});
      return enemy?.state==='counter-telegraph'&&enemy.counterToken>0&&enemy.executingTelegraph;
    })()`, 3000);
    const counterBeforeSync = await page.evaluate(`globalThis.__NEON_TIDE_V3__.world.get(${bulwarkProbe.targetId})`);
    await page.evaluate(`new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`);
    const counterAfterSync = await page.evaluate(`globalThis.__NEON_TIDE_V3__.world.get(${bulwarkProbe.targetId})`);
    assert.equal(counterAfterSync.state, counterBeforeSync.state, JSON.stringify({ counterBeforeSync, counterAfterSync }));
    assert.equal(counterAfterSync.counterToken, counterBeforeSync.counterToken, JSON.stringify({ counterBeforeSync, counterAfterSync }));
    assert.equal(counterAfterSync.executingTelegraph, true, JSON.stringify({ counterBeforeSync, counterAfterSync }));

    const fallback = await page.evaluate(`(async()=>{
      const {selectTideLanceDamageAuthority}=await import('/src/game/skill.js');
      return selectTideLanceDamageAuthority({ecsCombatAuthority:false});
    })()`);
    assert.equal(fallback, 'legacy');
  });
}

export const v3WeaponScenarios = Object.freeze([
  ['v3 weapons no-input automatic combat', v3WeaponsScenario],
  ['v3 Tide Lance uses one ECS damage authority for a natural legacy mirror', v3TideLanceSingleAuthorityScenario],
]);
