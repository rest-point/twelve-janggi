import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,mkdir,copyFile,rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fixture,startMatch } from './helpers/http.mjs';
import { replayFrames } from '../src/record-replay.js';
import { initialState,positionKey } from '../src/engine.js';
import { openDatabase } from '../server/database.mjs';
import { createGames } from '../server/games.mjs';
import { createModelCatalog } from '../server/model-catalog.mjs';
import { createModelService } from '../server/model-service.mjs';
import { createModelMatches } from '../server/model-matches.mjs';
import { sha256 } from '../bench/common.mjs';

const fake=()=>({ready:async()=>({elapsedMs:1}),think:async r=>({action:r.legalActions[0],elapsedMs:1}),close(){}});
// This is a whole 100-game batch wait, not the referee's 60s per-move limit.
// Supported Windows/Node 24 hosts can spend over 60s starting 200 supervisors.
const realBatchWaitMs=Number(process.env.REAL_BATCH_TEST_WAIT_MS||180000);
assert.ok(Number.isSafeInteger(realBatchWaitMs)&&realBatchWaitMs>=60000&&realBatchWaitMs<=600000,'Invalid real batch test wait');
async function until(read,predicate,ms=15000){const end=Date.now()+ms;while(Date.now()<end){const value=await read();if(predicate(value))return value;await new Promise(r=>setTimeout(r,30));}assert.fail('Batch did not reach the expected persistent state');}
const selection=()=>({modelA:'greedy-v1',modelB:'random-v1',requestId:randomUUID()});

test('production-sized real batches accumulate 100 then 200 games for either ordering, preserving all replays and balanced seats',async()=>{
  await fixture(async f=>{
    const a=f.client();await a.enter();const first=selection();
    const [one,duplicate]=await Promise.all([a.call('/api/model-matches','POST',first),a.call('/api/model-matches','POST',first)]);
    assert.equal(one.status,202);assert.equal(one.data.expectedGames,100);assert.equal(one.data.addedGames,100);
    assert.equal(duplicate.data.batchId,one.data.batchId);assert.equal(f.db.prepare('SELECT count(*) n FROM model_matches').get().n,100);
    assert.equal((await a.call('/api/model-matches','POST',selection())).status,409);
    const id=one.data.id;
    const hundred=await until(()=>f.app.models.detail(id),s=>s.recordedGames===100,realBatchWaitMs);
    assert.equal(hundred.status,'completed');assert.equal(hundred.games.length,100);assert.equal(hundred.batches.length,1);
    const firstIds=hundred.games.map(g=>g.gameId);
    // Game indices append by insertion order even when the wall clock changes.
    f.db.prepare('UPDATE model_batches SET created_at=created_at+10000000').run();
    const second=await a.call('/api/model-matches','POST',{modelA:'random-v1',modelB:'greedy-v1',requestId:randomUUID()});
    assert.equal(second.status,202);assert.equal(second.data.id,id);assert.equal(second.data.expectedGames,200);
    const done=await until(()=>f.app.models.detail(id),s=>s.recordedGames===200,realBatchWaitMs);
    assert.equal(done.failedGames,0);assert.equal(done.games.length,200);assert.equal(done.batches.length,2);
    assert.deepEqual(done.games.slice(0,100).map(g=>g.gameId),firstIds);
    assert.equal((await a.call('/api/model-matches')).data.experiments.length,1);
    for(const p of done.summary.participants){assert.equal(p.wins+p.draws+p.losses,200);assert.equal(p.winRate,p.wins/200);assert.equal(p.scoreRate,(p.wins+p.draws/2)/200);}
    for(const b of done.batches){
      const jobs=f.db.prepare('SELECT j.* FROM model_batch_games bg JOIN model_matches j ON j.id=bg.match_id WHERE batch_id=? ORDER BY game_index').all(b.id);
      assert.equal(jobs.length,100);assert.equal(jobs.filter(j=>j.a_side===0).length,50);assert.equal(jobs.filter(j=>j.first===0).length,100);
      assert.equal(b.config.openingPlies,0);assert.equal(b.config.startPolicy,'blue-first-v1');
      assert.equal(jobs.filter(j=>j.first===j.a_side).length,50);
      for(let i=0;i<100;i++){
        assert.equal(jobs[i].a_side,i%2);
        assert.deepEqual(JSON.parse(jobs[i].start_state),initialState());
        assert.deepEqual(JSON.parse(jobs[i].opening),[]);
      }
    }
    for(let index=0;index<200;index++){
      const record=f.app.models.record(id,index),frames=replayFrames(record),game=f.app.games.record(record.gameId);
      assert.equal(positionKey(frames.at(-1).state),record.finalKey);assert.deepEqual(frames.at(-1).state.positions,game.state.positions);
      assert.equal(record.opening.length,0);assert.equal(record.startState.ply,0);assert.equal(record.startState.positions.length,1);
      assert.equal(record.moves[0].ply,1);assert.equal(record.moves[0].side,0);assert.equal(game.deadlineAt,null);
    }
    assert.equal((await a.call(`/api/model-matches/${id}/games/199`)).status,200);
    assert.equal((await a.call(`/api/model-matches/${id}/games/200`)).status,404);
  },false,{modelOptions:{batchSize:100}});
});
test('resuming a 100-game batch retains completed games and retries only interrupted jobs with new tokens',async()=>{
  let turns=0;const releases=[];
  await fixture(async f=>{
    const a=f.client();await a.enter();const submitted=(await a.call('/api/model-matches','POST',selection())).data;
    await until(()=>f.app.models.detail(submitted.id),s=>s.recordedGames>=4&&releases.length>0);
    const completed=f.db.prepare("SELECT id,game_id,attempt FROM model_matches WHERE status='completed'").all();
    f.app.models.close();const models=createModelService(f.db,f.app.games,{clientFactory:fake,maxPlies:1});
    try{
      await models.ready;models.tick();for(const release of releases)release({error:'infra-error',elapsedMs:1});
      const done=await until(()=>models.detail(submitted.id),s=>s.recordedGames===100);
      assert.equal(done.expectedGames,100);assert.equal(done.games.length,100);
      for(const before of completed)assert.deepEqual(f.db.prepare('SELECT id,game_id,attempt FROM model_matches WHERE id=?').get(before.id),before);
      assert.ok(done.attempts.some(a=>a.error==='server-restart'));
      assert.equal(f.db.prepare('SELECT count(*) n FROM model_matches').get().n,100);
    }finally{models.close();}
  },false,{modelOptions:{batchSize:100,maxPlies:1,clientFactory:()=>({...fake(),think:r=>++turns<=6?Promise.resolve({action:r.legalActions[0],elapsedMs:1}):new Promise(resolve=>releases.push(resolve))})}});
});

test('room codes are absent; resignation removes room and seats atomically but preserves records and repeated requests',async()=>{
  await fixture(async f=>{
    const a=f.client(),b=f.client();await a.enter();await b.enter();const {room,game}=await startMatch(a,b);
    assert.equal('code' in room,false);assert.ok(!f.db.prepare('PRAGMA table_info(rooms)').all().some(c=>c.name==='code'));
    assert.equal((await a.call('/api/rooms/ABC234')).status,404);
    const request={requestId:randomUUID(),expectedRevision:game.revision},route=`/api/games/${game.id}/resign`;
    f.db.exec("CREATE TRIGGER reject_room_cleanup BEFORE DELETE ON rooms BEGIN SELECT RAISE(ABORT,'test cleanup failure'); END");
    assert.equal((await a.call(route,'POST',request)).status,500);
    assert.equal(f.app.games.get(game.id).state.winner,null);assert.equal(f.db.prepare('SELECT count(*) n FROM room_seats').get().n,2);
    f.db.exec('DROP TRIGGER reject_room_cleanup');const accepted=await a.call(route,'POST',request);assert.equal(accepted.status,200);
    assert.deepEqual((await a.call(route,'POST',request)).data,accepted.data);
    assert.equal((await a.call('/api/rooms')).data.rooms.length,0);assert.equal((await a.call(`/api/rooms/${room.id}`)).status,404);
    assert.equal(f.db.prepare('SELECT count(*) n FROM room_seats').get().n,0);
    assert.equal((await a.call(`/api/games/${game.id}/record`)).data.state.termination,'resignation');
  });
});

test('runner changes register a new execution fingerprint and keep the original model version untouched',async()=>{
  await fixture(async f=>{
    const client=f.client(),entered=await client.enter(),body=selection();
    const submitted=f.app.models.submit(entered.data.guest.id,body);
    await until(()=>f.app.models.detail(submitted.id),s=>s.status==='completed');
    const before=f.db.prepare("SELECT * FROM model_versions WHERE id='greedy-v1'").get(),environment=JSON.parse(before.environment);
    environment.node='previous-runtime';const digest=sha256(JSON.stringify({artifactHash:JSON.parse(before.manifest).artifactHash,environment}));
    f.db.prepare('UPDATE model_versions SET environment=?,digest=? WHERE id=?').run(JSON.stringify(environment),digest,before.id);
    const catalog=await createModelCatalog(f.db),current=catalog.list().find(m=>m.registryId==='greedy-v1');
    assert.notEqual(current.id,before.id);assert.match(current.id,/^greedy-v1-[a-f0-9]{12}$/);
    assert.equal(f.db.prepare('SELECT digest FROM model_versions WHERE id=?').get(before.id).digest,digest);
    assert.equal(current.modelId,'greedy');assert.equal((await createModelCatalog(f.db)).list().find(m=>m.registryId==='greedy-v1').id,current.id);
    const store=createModelMatches(f.db,f.app.games,catalog);
    assert.equal(store.submit(entered.data.guest.id,body).batchId,submitted.batchId);
    assert.equal(f.db.prepare('SELECT count(*) n FROM model_matches').get().n,1);
    assert.throws(()=>store.submit(entered.data.guest.id,{...body,modelA:current.id}),/다른 설정/);
  },false,{modelOptions:{maxPlies:1,clientFactory:fake}});
});

test('003 migration groups old opposite-order single matches without rewriting records and drops only expired rooms',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'twelve-batch-upgrade-')),migrations=path.join(root,'old'),filename=path.join(root,'test.sqlite');
  await mkdir(migrations);for(const file of ['001-foundation.sql','002-guest-rooms.sql','003-model-matches.sql'])await copyFile('db/migrations/'+file,path.join(migrations,file));
  let db=openDatabase(filename,{migrations}),models;
  try{
    const catalog=await createModelCatalog(db),guest=randomUUID();db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(guest,'guest','guest:'+guest,'!guest-no-password','user',1);db.prepare('INSERT INTO guests VALUES(?,?)').run(guest,1);
    const games=createGames(db),original=[];
    for(const [i,pair]of [['greedy-v1','random-v1'],['random-v1','greedy-v1']].entries()){
      const game=games.create(catalog.player(pair[0]),catalog.player(pair[1]));games.finish(game.id,0,'model-error');const id=randomUUID();
      db.prepare("INSERT INTO model_matches(id,requested_by,request_id,model_a,model_b,first,seed,status,game_id,attempt,created_at) VALUES(?,?,?,?,?,?,?,'completed',?,1,?)")
        .run(id,guest,'legacy_request_'+i,...pair,game.state.turn,7,game.id,i+1);original.push({id,gameId:game.id,state:db.prepare('SELECT current_state FROM games WHERE id=?').get(game.id).current_state});
    }
    const waiting=randomUUID(),ended=randomUUID();
    for(const [id,code,status,gameId]of [[waiting,'ABC234','waiting',null],[ended,'DEF567','finished',original[0].gameId]]){
      db.prepare('INSERT INTO rooms(id,code,title,owner_id,status,game_id,created_at) VALUES(?,?,?,?,?,?,?)').run(id,code,'old room',guest,status,gameId,1);
      db.prepare('INSERT INTO room_seats(room_id,side,user_id) VALUES(?,?,?)').run(id,0,guest);
    }
    db.close();db=openDatabase(filename);models=createModelService(db,createGames(db),{clientFactory:fake,maxPlies:1});await models.ready;
    assert.equal(db.prepare('SELECT count(*) n FROM rooms').get().n,1);assert.equal(db.prepare('SELECT id FROM rooms').get().id,waiting);
    const one=models.list().experiments;assert.equal(one.length,1);assert.equal(one[0].recordedGames,2);assert.equal(one[0].expectedGames,2);
    assert.equal(models.detail(one[0].id).config.options.concurrency,1);
    const summary=models.detail(one[0].id).summary;assert.deepEqual(summary.participants.map(p=>[p.wins,p.losses]),[[1,1],[1,1]]);
    for(const j of original){assert.equal(db.prepare('SELECT current_state FROM games WHERE id=?').get(j.gameId).current_state,j.state);assert.equal(models.record(j.id,0).gameId,j.gameId);assert.equal(models.record(j.id,0).modelVersions.a,'greedy-v1');}
    const added=models.submit(guest,selection());assert.equal(added.id,one[0].id);assert.equal(added.expectedGames,102);models.tick();
    await until(()=>models.detail(added.id),s=>{models.tick();return s.recordedGames===102;});
    assert.equal(models.list().experiments.length,1);assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
  }finally{models?.close();db.close();assert.equal(path.dirname(root),os.tmpdir());await rm(root,{recursive:true,force:true});}
});
