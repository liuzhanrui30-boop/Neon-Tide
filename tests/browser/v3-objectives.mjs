import assert from 'node:assert/strict';
import { withPage } from './harness.mjs';

export const v3ObjectiveScenarios = [
  ['v3 objective routes resist fixed edge circles', async () => {
    await withPage('v3-objective-routes', {}, async (page) => {
      await page.startGame();
      const result = await page.evaluate(`(async()=>{
        const [{createObjective,updateObjective},{ENCOUNTER_TEMPLATES}]=await Promise.all([
          import('/src/systems/objective-system.js'),import('/src/content/encounters.js')
        ]);
        const byType=Object.fromEntries(ENCOUNTER_TEMPLATES.map(template=>[template.type,template]));
        const types=['anchors','moving-zone','core-harvest','escort'];
        const output={};
        for(const [typeIndex,type] of types.entries()){
          const objective=createObjective(byType[type],700+typeIndex);
          for(let step=0;step<720;step+=1){
            const angle=(step/720)*Math.PI*2;
            updateObjective(objective,null,{x:Math.cos(angle)*9.2,y:Math.sin(angle)*9.2},1/60,null);
          }
          const edgeProgress=objective.progress;
          if(type==='anchors'){
            for(const target of objective.anchors) updateObjective(objective,null,target,target.requiredSeconds,null);
          }else if(type==='moving-zone'){
            for(let step=0;step<180;step+=1) updateObjective(objective,null,objective.safeZone,1/60,null);
          }else if(type==='core-harvest'){
            for(const target of objective.cores) updateObjective(objective,null,target,1/60,null);
          }else{
            for(let step=0;step<180;step+=1) updateObjective(objective,null,objective.escort,1/60,null);
          }
          output[type]={edgeProgress,changedProgress:objective.progress,status:objective.status};
        }
        return output;
      })()`);
      for (const type of ['anchors', 'moving-zone', 'core-harvest', 'escort']) {
        assert.equal(result[type].edgeProgress, 0, `${type} advanced on the fixed edge circle: ${JSON.stringify(result[type])}`);
        assert.ok(result[type].changedProgress > 0, `${type} ignored its route change: ${JSON.stringify(result[type])}`);
      }
    });
  }],
];

