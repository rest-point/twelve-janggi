import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers/http.mjs';
import { ModelProcess } from '../server/model-process.mjs';
import { createModelService } from '../server/model-service.mjs';
import { createModelCatalog } from '../server/model-catalog.mjs';
import { initialState,legalActions,positionKey } from '../src/engine.js';
import { replayFrames } from '../src/record-replay.js';

async function until(read,predicate,ms=8000) {
  const end=Date.now()+ms;
  while(Date.now()<end){const value=await read();if(predicate(value))return value;await new Promise(r=>setTimeout(r,20));}
  assert.fail('Timed out waiting for persistent model result');
}
const fake=()=>({ready:async()=>({elapsedMs:1}),think:async r=>({action:r.legalActions[0],elapsedMs:1}),close(){}});

test('simultaneous readiness starts exactly one game without owner start; old updates cannot undo readiness',async()=>{
  await fixture(async f=>{
    const a=f.client(),b=f.client();await a.enter();await b.enter();
    let room=(await a.call('/api/rooms','POST',{})).data;
    room=(await b.call(`/api/rooms/${room.id}/join`,'POST',{})).data;
    const route=`/api/rooms/${room.id}/ready`,body={ready:true,expectedRevision:room.revision};
    const replies=await Promise.all([a.call(route,'POST',body),b.call(route,'POST',body)]);
    assert.deepEqual(replies.map(r=>r.status),[200,200]);
    room=(await a.call(`/api/rooms/${room.id}`)).data;
    assert.equal(room.status,'playing');assert.equal(f.db.prepare('SELECT count(*) n FROM games').get().n,1);
    assert.equal((await a.call(route,'POST',body)).data.gameId,room.gameId);
    assert.equal((await b.call(route,'POST',{...body,ready:false})).status,409);
    assert.equal((await a.call(`/api/rooms/${room.id}/start`,'POST',{})).status,404);
  });
});

test('manual model matches require a guest and CSRF, retain idempotency, use 60s and replay every saved position',async()=>{
  await fixture(async f=>{
    const a=f.client(),anonymous=f.client(),body={modelA:'greedy-v1',modelB:'random-v1',requestId:randomUUID()};
    assert.equal((await anonymous.call('/api/model-matches','POST',body)).status,401);
    assert.deepEqual((await a.call('/api/model-matches')).data.experiments,[]);
    // A fresh checkout has no archived runs. Archive availability must not depend
    // on private developer artifacts; archive contents have isolated fixtures.
    const archive=await a.call('/api/experiments');
    assert.equal(archive.status,200);assert.ok(Array.isArray(archive.data.experiments));
    const models=(await a.call('/api/models')).data;assert.equal(models.moveMs,60000);
    assert.ok(models.models.every(m=>m.moveMs===60000&&m.modelId&&m.id));
    await a.enter();
    assert.equal((await a.call('/api/model-matches','POST',body,{'X-CSRF-Token':'bad'})).status,403);
    assert.equal((await a.call('/api/model-matches','POST',{...body,modelB:'unapproved'})).status,422);
    assert.equal((await a.call('/api/model-matches','POST',{...body,command:'arbitrary'})).status,422);
    const [one,two]=await Promise.all([a.call('/api/model-matches','POST',body),a.call('/api/model-matches','POST',body)]);
    assert.equal(one.status,202);assert.equal(two.data.id,one.data.id);
    assert.equal((await a.call('/api/model-matches','POST',{...body,modelA:'minimax-v1'})).status,409);
    const id=one.data.id,detail=await until(async()=>(await a.call(`/api/model-matches/${id}`)).data,r=>r.status==='completed');
    assert.equal(detail.attempt,1);assert.equal(detail.config.options.moveMs,60000);
    assert.equal((await a.call('/api/model-matches')).data.experiments.length,1);
    const record=(await a.call(`/api/model-matches/${id}/games/0`)).data,frames=replayFrames(record);
    const game=f.app.games.record(detail.gameId);
    assert.ok(record.moves.length>0);assert.ok(record.moves.every(m=>m.elapsedMs>=0));
    assert.deepEqual(frames.at(-1).state.positions,game.state.positions);
    assert.equal(positionKey(frames.at(-1).state),record.finalKey);
    assert.ok(record.attempts.every(a=>Number.isFinite(a.elapsedMs)));
    assert.equal(f.db.prepare('SELECT count(*) n FROM model_versions').get().n,models.models.length);
  },false,{modelOptions:{maxPlies:20}});
});

test('player vs AI uses server referee and preserves one model process across human turns',async()=>{
  let created=0,closed=0;
  await fixture(async f=>{
    const a=f.client();await a.enter();
    let room=(await a.call('/api/rooms','POST',{mode:'pvai',modelVersionId:'greedy-v1'})).data;
    assert.equal(room.seats[1].ready,true);assert.equal(room.gameId,null);
    room=(await a.call(`/api/rooms/${room.id}/ready`,'POST',{ready:true,expectedRevision:room.revision})).data;
    assert.equal(room.status,'playing');
    let game=f.app.games.get(room.gameId);
    assert.equal(game.deadlineAt-game.turnStartedAt,60000);
    for(let turn=0;turn<3;turn++){
      game=await until(()=>f.app.games.get(room.gameId),g=>g.state.turn===0||g.state.winner!==null);
      if(game.state.winner!==null)break;
      assert.equal((await a.call(`/api/games/${game.id}/actions`,'POST',{requestId:randomUUID(),expectedRevision:game.revision,action:legalActions(game.state)[0]})).status,200);
    }
    await until(()=>f.app.games.get(room.gameId),g=>g.state.turn===0||g.state.winner!==null);
    assert.equal(created,1);
    game=f.app.games.get(room.gameId);
    if(game.state.winner===null)await a.call(`/api/games/${game.id}/resign`,'POST',{requestId:randomUUID(),expectedRevision:game.revision});
    assert.ok(f.app.games.record(game.id).moves.some(m=>m.side===1));
  },false,{modelOptions:{clientFactory:()=>{created++;return {...fake(),close(){closed++;}};}}});
  assert.equal(closed,1);
});

test('worker host failure retries a persistent job and keeps the incomplete attempt out of official outcomes',async()=>{
  let created=0;
  await fixture(async f=>{
    const a=f.client();await a.enter();
    const id=(await a.call('/api/model-matches','POST',{modelA:'greedy-v1',modelB:'random-v1',requestId:randomUUID()})).data.id;
    const detail=await until(()=>f.app.models.detail(id),j=>j.status==='completed');
    assert.equal(detail.attempt,2);assert.equal(detail.attempts.length,2);
    assert.equal(detail.attempts[0].error,'worker-host-error');
    const incomplete=f.app.games.get(detail.attempts[0].gameId);
    assert.equal(incomplete.state.winner,null);assert.equal(incomplete.infrastructureError,'worker-host-error');
    assert.equal(detail.summary.participants.reduce((n,p)=>n+p.wins+p.draws+p.losses,0),2);
    const saved=f.app.models.record(id);assert.equal(replayFrames(saved).at(-1).state.ply,saved.finalPly);
  },false,{modelOptions:{maxPlies:4,clientFactory:()=>++created===1?{...fake(),ready:async()=>({error:'infra-error',elapsedMs:1})}:fake()}});
});

test('server restart requeues running manual matches, rejects the old attempt token and retains both attempts',async()=>{
  let release;
  await fixture(async f=>{
    const a=f.client();await a.enter();
    const id=f.app.models.submit((await a.call('/api/me')).data.guest.id,{modelA:'greedy-v1',modelB:'random-v1',requestId:randomUUID()}).id;
    f.app.models.tick();await until(()=>release,Boolean);
    const before=f.app.models.detail(id);f.app.models.close();
    const models=createModelService(f.db,f.app.games,{clientFactory:fake,maxPlies:4});
    try{
      await models.ready;assert.equal(models.detail(id).status,'queued');models.tick();
      release({action:legalActions(initialState())[0],elapsedMs:1});
      const after=await until(()=>models.detail(id),j=>j.status==='completed');
      assert.equal(after.attempt,2);assert.notEqual(after.gameId,before.gameId);
      assert.equal(after.attempts[0].error,'server-restart');assert.equal(f.app.games.record(before.gameId).moves.length,0);
      assert.equal(f.db.prepare('SELECT count(*) n FROM model_matches').get().n,1);
    }finally{models.close();}
  },false,{modelOptions:{clientFactory:()=>({...fake(),think:()=>new Promise(r=>{release=r;})})}});
});

test('immutable registered model versions refuse changed fingerprints',async()=>{
  await fixture(async f=>{
    f.db.prepare("UPDATE model_versions SET digest='changed' WHERE id='random-v1'").run();
    await assert.rejects(createModelCatalog(f.db),/불변 버전/);
    assert.equal(f.db.prepare('SELECT count(*) n FROM model_versions').get().n,3);
  });
});

test('model rule violations lose the match and never become infrastructure retries',async()=>{
  for(const response of [{error:'model-error'}, {action:{from:0,to:11}}, {error:'model-timeout'}]){
    await fixture(async f=>{
      const a=f.client();await a.enter();
      const id=(await a.call('/api/model-matches','POST',{modelA:'greedy-v1',modelB:'random-v1',requestId:randomUUID()})).data.id;
      const result=await until(()=>f.app.models.detail(id),j=>j.status==='completed');
      assert.equal(result.attempt,1);assert.equal(result.error,null);
      assert.equal(result.games[0].termination,response.error||'illegal-action');
      assert.equal(result.summary.participants.reduce((n,p)=>n+p.wins,0),1);
      assert.equal(f.app.models.record(id).moves.length,0);replayFrames(f.app.models.record(id));
    },false,{modelOptions:{clientFactory:()=>({...fake(),think:async()=>({...response,elapsedMs:1})})}});
  }
});

test('model deadline expiry rejects a late successful response without storing a move',async()=>{
  let release,request;
  await fixture(async f=>{
    const a=f.client();await a.enter();
    const id=f.app.models.submit((await a.call('/api/me')).data.guest.id,{modelA:'greedy-v1',modelB:'random-v1',requestId:randomUUID()}).id;
    f.app.models.tick();await until(()=>release,Boolean);
    const {gameId}=f.app.models.detail(id),before=f.app.games.get(gameId);
    assert.equal(request.budgetMs,60000);assert.equal(before.deadlineAt-before.turnStartedAt,60000);
    f.db.prepare('UPDATE games SET deadline_at=? WHERE id=?').run(Date.now(),gameId);
    f.app.games.recover();release({action:request.legalActions[0],elapsedMs:60001});
    const done=await until(()=>f.app.models.detail(id),j=>j.status==='completed');
    assert.equal(done.games[0].termination,'model-timeout');assert.equal(done.games[0].winner,1-before.state.turn);
    assert.equal(f.app.games.record(gameId).moves.length,0);
    const attempt=f.app.models.record(id).attempts.find(a=>a.stage==='think');
    assert.equal(attempt.elapsedMs,60001);assert.equal(attempt.error,'model-timeout');assert.equal(attempt.accepted,0);
  },false,{modelOptions:{clientFactory:()=>({...fake(),think:r=>{request=r;return new Promise(resolve=>{release=resolve;});}})}});
});

test('model subprocess strips host secrets, rejects undeclared file reads, and kills infinite calculations',async()=>{
  process.env.MODEL_TEST_SECRET='must-not-reach-worker';
  const state=initialState(),request={requestId:'probe-permissions',state,legalActions:legalActions(state),config:{target:path.resolve('.env')}};
  const probe=new ModelProcess({entryPath:path.resolve('tests/fixtures/model-permissions.mjs')});
  try{
    assert.equal((await probe.ready()).error,undefined);
    const result=await probe.think(request,2000);
    assert.equal(result.error,undefined);assert.equal(result.info.nodes,1);assert.equal(result.info.completedDepth,1);
  }finally{probe.close();delete process.env.MODEL_TEST_SECRET;}
  for(const [mode,error]of [['loop','model-timeout'],['throw','model-error'],['exit','infra-error']]){
    const client=new ModelProcess({entryPath:path.resolve('tests/fixtures/model.mjs')});
    try{assert.equal((await client.ready()).error,undefined);const at=Date.now();
      assert.equal((await client.think({...request,config:{mode}},100)).error,error);assert.ok(Date.now()-at<2500);
    }finally{client.close();}
  }
});
