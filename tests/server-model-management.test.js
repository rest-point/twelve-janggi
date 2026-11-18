import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers/http.mjs';
import { createModelService } from '../server/model-service.mjs';
import { initialState,legalActions,applyAction,positionKey } from '../src/engine.js';
import { createExperimentStore } from '../scripts/experiment-store.mjs';
import { mkdtemp,mkdir,readFile,writeFile,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const fake=()=>({ready:async()=>({elapsedMs:1}),think:async r=>({action:r.legalActions[0],elapsedMs:1}),close(){}});
const selection=()=>({modelA:'greedy-v1',modelB:'random-v1',requestId:randomUUID()});
async function until(read,predicate){for(let i=0;i<500;i++){const value=await read();if(predicate(value))return value;await new Promise(r=>setTimeout(r,20));}assert.fail('Timed out waiting for model state');}

test('any guest may delete another guest series, hidden records stay deleted and a new request starts a fresh series',async()=>{
  await fixture(async f=>{
    const a=f.client(),b=f.client(),anonymous=f.client();await a.enter();await b.enter();const body=selection();
    const id=(await a.call('/api/model-matches','POST',body)).data.id;
    const done=await until(()=>f.app.models.detail(id),s=>s.status==='completed'),gameId=done.games[0].gameId;
    const counts=()=>['games','moves','model_matches','model_versions'].map(t=>f.db.prepare(`SELECT count(*) n FROM ${t}`).get().n),before=counts();
    const route=`/api/model-matches/${id}/delete`;
    assert.equal((await anonymous.call(route,'POST',{})).status,401);
    assert.equal((await b.call(route,'POST',{}, {'X-CSRF-Token':'bad'})).status,403);
    assert.equal((await b.call(route,'POST',{}, {Origin:'https://evil.org'})).status,403);
    assert.equal((await b.call(route,'POST',{extra:true})).status,422);
    assert.equal((await b.call(route,'POST',{})).status,200);assert.deepEqual(counts(),before);
    assert.equal((await b.call(route,'POST',{})).status,200);
    assert.deepEqual((await a.call('/api/model-matches')).data.experiments,[]);
    for(const endpoint of [`/api/model-matches/${id}`,`/api/model-matches/${id}/games/0`,`/api/games/${gameId}`,`/api/games/${gameId}/record`])assert.equal((await a.call(endpoint)).status,404);
    assert.equal((await a.call('/api/model-matches','POST',body)).status,410);
    const fresh=(await a.call('/api/model-matches','POST',selection())).data;assert.notEqual(fresh.id,id);assert.equal(fresh.expectedGames,1);
    assert.equal(f.db.prepare('SELECT count(*) n FROM model_series').get().n,2);
    assert.equal(f.db.prepare('PRAGMA foreign_key_check').all().length,0);
  },false,{modelOptions:{clientFactory:fake,maxPlies:2}});
});

for(const phase of ['load','think'])test(`deleting a running 100-game series cancels ${phase}, ignores late work and never requeues after restart`,async()=>{
  const pending=[];let closed=0;
  await fixture(async f=>{
    const a=f.client(),b=f.client();await a.enter();await b.enter();const id=(await a.call('/api/model-matches','POST',selection())).data.id;
    await until(()=>pending.length,n=>n===2);const before=f.app.models.detail(id),active=before.games.map(g=>g.gameId);
    const oldJob=f.db.prepare('SELECT id FROM model_matches LIMIT 1').get().id;
    const result=await b.call(`/api/model-matches/${id}/delete`,'POST',{});assert.equal(result.status,200);assert.equal(closed,2);
    for(const done of pending)done();await new Promise(r=>setTimeout(r,30));f.app.models.tick();
    assert.equal(f.db.prepare("SELECT count(*) n FROM model_matches WHERE status IN ('queued','running')").get().n,0);
    assert.equal(f.db.prepare('SELECT count(*) n FROM games').get().n,2);
    for(const gameId of active){const game=f.app.games.record(gameId);assert.equal(game.state.winner,null);assert.equal(game.infrastructureError,'series-deleted');assert.equal(game.moves.length,0);assert.equal((await a.call(`/api/games/${gameId}/record`)).status,404);}
    assert.equal((await a.call(`/api/model-matches/${oldJob}`)).status,404);
    f.app.models.close();const resumed=createModelService(f.db,f.app.games,{clientFactory:fake,maxPlies:1});
    try{await resumed.ready;resumed.tick();assert.equal(resumed.list().experiments.length,0);assert.equal(f.db.prepare('SELECT count(*) n FROM games').get().n,2);}finally{resumed.close();}
  },false,{modelOptions:{batchSize:100,clientFactory:()=>({
    ready:()=>phase==='load'?new Promise(resolve=>pending.push(()=>resolve({elapsedMs:1}))):Promise.resolve({elapsedMs:1}),
    think:r=>new Promise(resolve=>pending.push(()=>resolve({elapsedMs:1,action:r.legalActions[0]}))),close(){closed++;},
  })}});
});

test('failed deletion rolls back jobs and preserves a running worker until a successful retry',async()=>{
  let finish,closed=0;
  await fixture(async f=>{
    const a=f.client(),b=f.client();await a.enter();await b.enter();const id=(await a.call('/api/model-matches','POST',selection())).data.id;
    await until(()=>finish,Boolean);
    f.db.exec("CREATE TRIGGER reject_series_delete BEFORE UPDATE ON model_series WHEN NEW.deleted_at IS NOT NULL BEGIN SELECT RAISE(ABORT,'test'); END");
    assert.equal((await b.call(`/api/model-matches/${id}/delete`,'POST',{})).status,500);assert.equal(closed,0);
    assert.equal(f.app.models.detail(id).status,'running');
    f.db.exec('DROP TRIGGER reject_series_delete');assert.equal((await b.call(`/api/model-matches/${id}/delete`,'POST',{})).status,200);
    finish();await new Promise(r=>setTimeout(r,20));assert.equal(closed,1);
  },false,{modelOptions:{clientFactory:()=>({...fake(),think:r=>new Promise(resolve=>{finish=()=>resolve({action:r.legalActions[0],elapsedMs:1});}),close(){closed++;}})}});
});

test('team descriptions are guest-editable plain text, revision checked and independent of immutable model code',async()=>{
  await fixture(async f=>{
    const a=f.client(),b=f.client(),anonymous=f.client();await a.enter();await b.enter();
    const before=JSON.stringify(f.db.prepare('SELECT * FROM model_versions ORDER BY id').all());
    const route='/api/models/greedy-v1/description',body={developer:'팀원 A',characteristics:'깊이 우선 탐색\n포획 중심 평가',motivation:'계산량과 수읽기를 비교하기 위해 개발',expectedRevision:0};
    assert.equal((await anonymous.call(route,'POST',body)).status,401);
    assert.equal((await a.call(route,'POST',body,{'X-CSRF-Token':'bad'})).status,403);
    assert.equal((await a.call(route,'POST',{...body,command:'bad'})).status,422);
    assert.equal((await a.call(route,'POST',{...body,characteristics:'가'.repeat(2001)})).status,422);
    const saved=await a.call(route,'POST',body);assert.equal(saved.status,200);assert.equal(saved.data.revision,1);
    assert.equal((await b.call('/api/models')).data.models.find(m=>m.registryId==='greedy-v1').description.motivation,body.motivation);
    assert.equal((await b.call(route,'POST',body)).status,409);
    const edits=await Promise.all([a.call(route,'POST',{...body,expectedRevision:1,developer:'A'}),b.call(route,'POST',{...body,expectedRevision:1,developer:'B'})]);
    assert.deepEqual(edits.map(r=>r.status).sort(),[200,409]);
    const large={developer:'팀',characteristics:'가'.repeat(2000),motivation:'나'.repeat(2000),expectedRevision:2};assert.equal((await b.call(route,'POST',large)).status,200);
    const plain=await a.call(route,'POST',{...body,characteristics:'<script>alert("plain")</script>',expectedRevision:3});assert.equal(plain.status,200);assert.equal(plain.data.characteristics,'<script>alert("plain")</script>');
    assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM model_versions ORDER BY id').all()),before);
    assert.equal((await a.call('/api/models/unapproved/description','POST',body)).status,422);
    f.app.models.close();const resumed=createModelService(f.db,f.app.games);try{await resumed.ready;assert.equal(resumed.listModels().find(m=>m.registryId==='greedy-v1').description.revision,4);}finally{resumed.close();}
  });
});

test('retired models are unavailable and approved models start with blank introductions',async()=>{
  await fixture(async f=>{
    const a=f.client();await a.enter();
    const models=(await a.call('/api/models')).data.models;
    const ids=new Set(models.map(model=>model.registryId));
    const retired=['pvs-aspiration-v1','pv-puct-dfpn-v1','batch-puct-dfpn-v1','packed-gemm-puct-v1','tablebase-minimax-reply-v1',
      'team-greedy-v1','team-minimax-v1','azero-v1','tbrl-v1'];
    for(const id of retired) assert.equal(ids.has(id),false);
    assert.ok(ids.has('tablebase-minimax-reply-v2')&&ids.has('packed-gemm-puct-v2'));
    for(const {description} of models){
      assert.deepEqual(description,{developer:'',characteristics:'',motivation:'',revision:0,updatedAt:null});
    }
    assert.equal(f.db.prepare('SELECT count(*) n FROM model_descriptions').get().n,0);
    const body={developer:'',characteristics:'',motivation:'',expectedRevision:0};
    assert.equal((await a.call('/api/models/tablebase-minimax-reply-v1/description','POST',body)).status,422);
  });
});

test('mean thinking time is weighted by accepted moves across both seat assignments',async()=>{
  await fixture(async f=>{
    const a=f.client(),guest=(await a.enter()).data.guest.id,id=f.app.models.submit(guest,selection()).id;
    const jobs=f.db.prepare('SELECT * FROM model_matches ORDER BY rowid').all(),values=[[10,20],[30,40,50,60]];
    for(const [i,j]of jobs.entries()){
      // This timing fixture explicitly covers both seats, independently of the
      // production scheduler's colour/first-move rotation.
      f.db.prepare('UPDATE model_matches SET a_side=? WHERE id=?').run(i,j.id);
      const players=[f.app.models.player(j.model_a),f.app.models.player(j.model_b)];if(i===1)players.reverse();
      let game=f.app.games.createInTransaction(...players,{mode:'aivai',source:'manual',first:0});
      for(const time of values[i]){const action=legalActions(game.state).find(action=>applyAction(game.state,action,false).winner===null);
        const requestId=randomUUID();game=f.app.games.act(game.id,game.participants[game.state.turn].id,'action',{requestId,expectedRevision:game.revision,action}).body;
        f.db.prepare('UPDATE moves SET elapsed_ms=? WHERE game_id=? AND request_id=?').run(time,game.id,requestId);}
      f.app.games.finish(game.id,'draw','max-plies');f.db.prepare("UPDATE model_matches SET game_id=?,status='completed' WHERE id=?").run(game.id,j.id);
    }
    const result=f.app.models.detail(id).summary.participants;assert.equal(result[0].timing.meanMs,110/3);assert.equal(result[1].timing.meanMs,100/3);
  },false,{modelOptions:{batchSize:2,clientFactory:fake}});
});

test('archive mean times come from existing moves without modifying archived summaries',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'twelve-archive-mean-'));
  try{
    const id='2026-11-04T00-00-00-000Z-aabbccdd',directory=path.join(root,id);
    await mkdir(directory);
    const configHash='timing-fixture',records=[];
    for(const [index,times]of [[10,30],[50,70,90]].entries()){
      let state=initialState(0);const startState=state,moves=[];
      for(const elapsedMs of times){
        const side=state.turn,action=legalActions(state).find(a=>applyAction(state,a,false).winner===null);
        state=applyAction(state,action,false);moves.push({side,action,elapsedMs,positionKey:positionKey(state)});
      }
      records.push({runId:id,index,first:0,aSide:index,opening:[],startState,moves});
    }
    await writeFile(path.join(directory,'config.json'),JSON.stringify({runId:id,configHash,options:{games:2,a:'a',b:'b'}}));
    const file=path.join(directory,'summary.json'),before=JSON.stringify({runId:id,configHash,games:2,participants:[{timing:{}},{timing:{}}]});
    await writeFile(file,before);await writeFile(path.join(directory,'games.jsonl'),records.map(JSON.stringify).join('\n')+'\n');
    const store=createExperimentStore(root),detail=await store.detail(id);
    assert.equal(detail.summary.participants[0].timing.meanMs,40);
    assert.equal(detail.summary.participants[1].timing.meanMs,170/3);
    assert.equal(await readFile(file,'utf8'),before);
  }finally{
    assert.equal(path.dirname(root),os.tmpdir());await rm(root,{recursive:true,force:true});
  }
});
