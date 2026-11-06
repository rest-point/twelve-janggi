import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/http.mjs';
import { initialState, isLegalAction } from '../src/engine.js';

test('analysis assets and ordered navigation are served; analysis requires guest/CSRF and never creates matches or records', async () => {
  await fixture(async f=>{
    for(const path of ['/analysis','/analysis/','/analysis.html','/src/analysis.js','/src/analysis-state.js','/src/analysis.css']){
      const response=await f.client().call(path);assert.equal(response.status,200,path);
    }
    const html=(await f.client().call('/analysis')).text;
    assert.ok(html.indexOf('href="/experiments"')<html.indexOf('href="/analysis"'));
    assert.ok(html.indexOf('href="/analysis"')<html.indexOf('href="/records"'));
    const a=f.client(),body={modelId:'greedy-v1',position:initialPosition(),actions:[],linePlies:3};
    assert.equal((await a.call('/api/analysis','POST',body)).status,401);
    await a.enter();
    assert.equal((await a.call('/api/analysis','POST',body,{'X-CSRF-Token':'bad'})).status,403);
    assert.equal((await a.call('/api/analysis','POST',{...body,modelId:'missing'})).status,422);
    assert.equal((await a.call('/api/analysis','POST',{...body,config:{}})).status,422);
    const before=f.db.prepare('SELECT count(*) n FROM games').get().n;
    const response=await a.call('/api/analysis','POST',body);
    assert.equal(response.status,200,JSON.stringify(response.data));
    assert.equal(response.data.line.length,3);
    assert.equal(f.db.prepare('SELECT count(*) n FROM games').get().n,before);
    assert.equal(f.db.prepare('SELECT count(*) n FROM model_matches').get().n,0);
    assert.equal((await a.call('/api/model-matches')).data.experiments.length,0);
  },false,{analysisOptions:{clientFactory:()=>({ready:async()=>({}),close(){},think:async r=>({action:r.legalActions[0],elapsedMs:1,info:{nodes:1}})})}});
});
function initialPosition(){const s=initialState();return {board:s.board,hands:s.hands,turn:s.turn};}

test('every registered model analyzes a live position through its real permission-restricted process',async()=>{
  await fixture(async f=>{
    const client=f.client();await client.enter();
    const models=(await client.call('/api/models')).data.models;
    for(const m of models){
      const response=await client.call('/api/analysis','POST',{modelId:m.id,position:initialPosition(),actions:[],linePlies:1});
      assert.equal(response.status,200,m.id+': '+JSON.stringify(response.data));
      assert.equal(isLegalAction(initialState(),response.data.action),true,m.id);
    }
  });
});
