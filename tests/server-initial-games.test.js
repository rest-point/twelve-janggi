import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp,mkdir,copyFile,rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { openDatabase } from '../server/database.mjs';
import { createGames } from '../server/games.mjs';
import { createModelCatalog } from '../server/model-catalog.mjs';
import { createModelMatches } from '../server/model-matches.mjs';
import { createModelService } from '../server/model-service.mjs';
import { makeJob } from '../bench/common.mjs';
import { replayFrames } from '../src/record-replay.js';

const fake=()=>({ready:async()=>({elapsedMs:1}),think:async r=>({action:r.legalActions[0],elapsedMs:1}),close(){}});
test('opening retirement preserves old games, invalidates pending work and starts a fresh alternating initial-position record',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'twelve-initial-upgrade-')),migrations=path.join(root,'old'),filename=path.join(root,'test.sqlite');
  await mkdir(migrations);for(const file of ['001-foundation.sql','002-guest-rooms.sql','003-model-matches.sql','004-room-lifecycle-batches.sql','005-model-management.sql'])await copyFile('db/migrations/'+file,path.join(migrations,file));
  let db=openDatabase(filename,{migrations}),models;
  try{
    const catalog=await createModelCatalog(db),guest=randomUUID();
    db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(guest,'guest','guest:'+guest,'!guest-no-password','user',1);db.prepare('INSERT INTO guests VALUES(?,?)').run(guest,1);
    db.prepare('INSERT INTO model_descriptions VALUES(?,?,?,?,?,?,?)').run('greedy-v1','author','retained features','reason',1,1,guest);
    const games=createGames(db),store=createModelMatches(db,games,catalog,{batchSize:4}),body={modelA:'greedy-v1',modelB:'minimax-v1',requestId:randomUUID()},old=store.submit(guest,body);
    const config=JSON.parse(db.prepare('SELECT config FROM model_batches WHERE id=?').get(old.batchId).config);delete config.startPolicy;config.openingPlies=4;
    db.prepare('UPDATE model_batches SET config=? WHERE id=?').run(JSON.stringify(config),old.batchId);
    const jobs=db.prepare('SELECT j.*,bg.game_index FROM model_matches j JOIN model_batch_games bg ON bg.match_id=j.id WHERE bg.batch_id=? ORDER BY bg.game_index').all(old.batchId),completed=[];
    for(const j of jobs){
      const schedule=makeJob(j.game_index,config);
      db.prepare('UPDATE model_matches SET first=?,a_side=?,opening=?,start_state=? WHERE id=?').run(schedule.first,schedule.aSide,JSON.stringify(schedule.opening),JSON.stringify(schedule.startState),j.id);
      if(j.game_index===3)continue;
      const players=[catalog.player(j.model_a),catalog.player(j.model_b)];if(schedule.aSide===1)players.reverse();
      const game=games.createInTransaction(...players,{mode:'aivai',source:'manual',first:schedule.first,startState:schedule.startState});
      if(j.game_index<2){games.finish(game.id,0,'model-error');completed.push({...db.prepare('SELECT * FROM games WHERE id=?').get(game.id)});}
      db.prepare('UPDATE model_matches SET status=?,game_id=?,attempt=1,attempt_token=? WHERE id=?').run(j.game_index<2?'completed':'running',game.id,j.game_index<2?null:'old-token',j.id);
      db.prepare('INSERT INTO model_match_attempts VALUES(?,?,?,NULL)').run(j.id,1,game.id);
      if(j.game_index===2)db.prepare('INSERT INTO model_attempts VALUES(?,?,?,?,?,?,?)').run(game.id,0,schedule.first,'think',0,0,'running');
    }
    const originalBatch={...db.prepare('SELECT rowid,* FROM model_batches WHERE id=?').get(old.batchId)},versions=db.prepare('SELECT * FROM model_versions ORDER BY id').all();
    db.close();db=openDatabase(filename);
    assert.equal(db.prepare('SELECT count(*) n FROM model_series WHERE deleted_at IS NOT NULL').get().n,1);
    for(const game of completed)assert.deepEqual({...db.prepare('SELECT * FROM games WHERE id=?').get(game.id)},game);
    assert.deepEqual({...db.prepare('SELECT rowid,* FROM model_batches WHERE id=?').get(old.batchId)},originalBatch);
    assert.deepEqual(db.prepare('SELECT * FROM model_versions ORDER BY id').all(),versions);
    assert.equal(db.prepare("SELECT count(*) n FROM model_matches WHERE status IN ('queued','running')").get().n,0);
    assert.equal(db.prepare("SELECT count(*) n FROM model_matches WHERE error='opening-policy-retired' AND attempt_token IS NULL").get().n,2);
    assert.equal(db.prepare("SELECT count(*) n FROM games WHERE infra_error='opening-policy-retired' AND result IS NULL").get().n,1);
    assert.equal(db.prepare("SELECT count(*) n FROM model_attempts WHERE error='opening-policy-retired'").get().n,1);
    models=createModelService(db,createGames(db),{clientFactory:fake,batchSize:4,maxPlies:2});await models.ready;models.tick();
    assert.equal(models.list().experiments.length,0);assert.throws(()=>models.detail(old.id),/찾을 수/);assert.throws(()=>models.record(old.id,0),/찾을 수/);
    assert.throws(()=>models.submit(guest,body),/삭제한 대전/);
    const fresh=models.submit(guest,{...body,requestId:randomUUID()});assert.notEqual(fresh.id,old.id);assert.equal(fresh.expectedGames,4);
    for(let i=0;i<300&&models.detail(fresh.id).recordedGames<4;i++){models.tick();await new Promise(r=>setTimeout(r,10));}
    assert.equal(models.detail(fresh.id).recordedGames,4);
    for(let i=0;i<4;i++){const record=models.record(fresh.id,i);assert.equal(record.opening.length,0);assert.equal(record.startState.ply,0);assert.equal(record.first===record.aSide,i%2===0);replayFrames(record);}
    assert.equal(db.prepare('SELECT count(*) n FROM model_series').get().n,2);
    assert.equal(db.prepare('SELECT characteristics FROM model_descriptions').get().characteristics,'retained features');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
  }finally{models?.close();db.close();assert.equal(path.dirname(root),os.tmpdir());await rm(root,{recursive:true,force:true});}
});
