import { randomInt,randomUUID } from 'node:crypto';
import { BLUE_FIRST_POLICY,makeJob,seedOf,percentile } from '../bench/common.mjs';
import { positionKey } from '../src/engine.js';
import { transaction } from './database.mjs';
import { requireThat } from './security.mjs';

// model_matches remains the durable per-game job table. A series groups an
// unordered pair of immutable model artifacts; each explicit request adds a batch.
export function createModelMatches(db,games,catalog,{batchSize=100,maxPlies=256}={}) {
  const names=new Map();
  function registryId(id){
    if(!names.has(id)){const row=db.prepare('SELECT manifest FROM model_versions WHERE id=?').get(id);
      requireThat(row,404,'모델 버전을 찾을 수 없습니다.');const m=JSON.parse(row.manifest);names.set(id,m.registryId||m.id);}
    return names.get(id);
  }
  function series(id){
    const direct=db.prepare('SELECT * FROM model_series WHERE id=? AND deleted_at IS NULL').get(id);if(direct)return direct;
    const alias=db.prepare(`SELECT s.* FROM model_series s JOIN model_batches b ON b.series_id=s.id
      JOIN model_batch_games bg ON bg.batch_id=b.id WHERE bg.match_id=? AND s.deleted_at IS NULL`).get(id);
    requireThat(alias,404,'대전을 찾을 수 없습니다.');return {...alias,legacyMatch:id};
  }
  const aSide=(j,s)=>registryId(j.model_a)===s.model_a?j.a_side:1-j.a_side;
  function jobs(s){return db.prepare(`SELECT j.*,bg.game_index AS batchIndex,b.id AS batchId,
      g.result,g.termination,g.current_state,g.initial_state,g.infra_error,
      (SELECT count(*) FROM moves WHERE game_id=j.game_id) AS plies,
      (SELECT coalesce(sum(elapsed_ms),0) FROM moves WHERE game_id=j.game_id) AS elapsedMs
    FROM model_batches b JOIN model_batch_games bg ON bg.batch_id=b.id JOIN model_matches j ON j.id=bg.match_id
    LEFT JOIN games g ON g.id=j.game_id WHERE b.series_id=? ORDER BY b.rowid,bg.game_index`).all(s.id);}
  function summary(s){
    const counts=db.prepare(`SELECT count(*) AS total,sum(j.status='completed') AS completed,
      sum(j.status='queued') AS queued,sum(j.status='running') AS running,sum(j.status='error') AS failed
      FROM model_batches b JOIN model_batch_games bg ON bg.batch_id=b.id JOIN model_matches j ON j.id=bg.match_id WHERE b.series_id=?`).get(s.id);
    const status=counts.running?'running':counts.queued?'queued':counts.failed?'error':'completed';
    return {id:s.id,models:{a:s.model_a,b:s.model_b},createdAt:new Date(s.updated_at).toISOString(),status,
      expectedGames:counts.total,recordedGames:counts.completed||0,failedGames:counts.failed||0,
      error:counts.failed?`${counts.failed}국 미완료`:null,moveMs:60000};
  }
  return {
    submit(guestId,body){
      requireThat(Object.keys(body).every(k=>['modelA','modelB','requestId'].includes(k)),422,'허용하지 않는 대전 설정입니다.');
      requireThat(typeof body.requestId==='string'&&/^[a-zA-Z0-9_-]{8,80}$/.test(body.requestId),422,'요청 ID가 필요합니다.');
      requireThat(typeof body.modelA==='string'&&typeof body.modelB==='string',422,'모델 버전을 선택하세요.');
      return transaction(db,()=>{
        const old=db.prepare('SELECT * FROM model_batches WHERE requested_by=? AND request_id=?').get(guestId,body.requestId);
        if(old){
          requireThat(db.prepare('SELECT deleted_at FROM model_series WHERE id=?').get(old.series_id).deleted_at===null,410,'삭제한 대전의 요청입니다. 새 요청으로 실행하세요.');
          const previous=db.prepare('SELECT j.model_a,j.model_b FROM model_matches j JOIN model_batch_games bg ON bg.match_id=j.id WHERE bg.batch_id=? LIMIT 1').get(old.id);
          requireThat(JSON.stringify([previous.model_a,previous.model_b].sort())===JSON.stringify([body.modelA,body.modelB].sort()),409,'다른 설정에 사용한 요청 ID입니다.');
          return {...summary(series(old.series_id)),batchId:old.id,addedGames:old.game_count};
        }
        const chosen=[catalog.get(body.modelA),catalog.get(body.modelB)].sort((a,b)=>a.registryId<b.registryId?-1:1);
        requireThat(chosen[0].registryId!==chosen[1].registryId,422,'서로 다른 모델 버전을 선택하세요.');
        requireThat(!db.prepare("SELECT id FROM model_matches WHERE requested_by=? AND status IN ('queued','running')").get(guestId),409,'진행 중인 모델 대전이 있습니다.');
        const at=Date.now(),batchId=randomUUID(),seed=randomInt(0,0x100000000);
        let s=db.prepare('SELECT * FROM model_series WHERE model_a=? AND model_b=? AND deleted_at IS NULL').get(chosen[0].registryId,chosen[1].registryId);
        if(!s){s={id:randomUUID(),model_a:chosen[0].registryId,model_b:chosen[1].registryId,created_at:at,updated_at:at};
          db.prepare('INSERT INTO model_series(id,model_a,model_b,created_at,updated_at) VALUES(?,?,?,?,?)').run(s.id,s.model_a,s.model_b,at,at);}
        const config={seed,moveMs:60000,concurrency:2,openingPlies:0,startPolicy:BLUE_FIRST_POLICY,maxPlies,modelVersions:{a:chosen[0].id,b:chosen[1].id}};
        db.prepare('INSERT INTO model_batches VALUES(?,?,?,?,?,?,?,?)').run(batchId,s.id,guestId,body.requestId,seed,batchSize,JSON.stringify(config),at);
        const insert=db.prepare(`INSERT INTO model_matches(id,requested_by,request_id,model_a,model_b,first,seed,status,created_at,a_side,opening,start_state)
          VALUES(?,?,?,?,?,?,?,'queued',?,?,?,?)`);
        for(let index=0;index<batchSize;index++){
          const id=randomUUID(),schedule=makeJob(index,config);
          insert.run(id,guestId,`batch_${batchId}_${index}`,chosen[0].id,chosen[1].id,schedule.first,seedOf(seed,index),at,schedule.aSide,JSON.stringify(schedule.opening),JSON.stringify(schedule.startState));
          db.prepare('INSERT INTO model_batch_games VALUES(?,?,?)').run(batchId,index,id);
        }
        db.prepare('UPDATE model_series SET updated_at=? WHERE id=?').run(at,s.id);
        return {...summary(series(s.id)),batchId,addedGames:batchSize};
      });
    },
    list(){return {experiments:db.prepare('SELECT * FROM model_series WHERE deleted_at IS NULL ORDER BY updated_at DESC,id LIMIT 100').all().map(summary)};},
    remove(id,guestId){return transaction(db,()=>{
      const previous=db.prepare('SELECT deleted_at FROM model_series WHERE id=?').get(id);
      if(previous&&previous.deleted_at!==null)return {id,deleted:true,gameIds:[]};
      const s=series(id),all=jobs(s);
      const attempts=db.prepare(`SELECT a.game_id FROM model_match_attempts a JOIN model_batch_games bg ON bg.match_id=a.match_id
        JOIN model_batches b ON b.id=bg.batch_id WHERE b.series_id=?`).all(s.id);
      const gameIds=[...new Set([...all.map(j=>j.game_id),...attempts.map(a=>a.game_id)].filter(Boolean))];
      db.prepare('UPDATE model_series SET deleted_at=?,deleted_by=? WHERE id=?').run(Date.now(),guestId,s.id);
      for(const j of all)if(['queued','running'].includes(j.status)){
        if(j.game_id){db.prepare("UPDATE games SET infra_error=coalesce(infra_error,'series-deleted') WHERE id=? AND result IS NULL").run(j.game_id);
          db.prepare("UPDATE model_attempts SET error='series-deleted' WHERE game_id=? AND error='running'").run(j.game_id);}
        db.prepare("UPDATE model_matches SET status='error',error='series-deleted',attempt_token=NULL WHERE id=?").run(j.id);
      }
      return {id:s.id,deleted:true,gameIds};
    });},
    gameDeleted(id){return !!db.prepare(`SELECT s.id FROM model_series s JOIN model_batches b ON b.series_id=s.id
      JOIN model_batch_games bg ON bg.batch_id=b.id JOIN model_matches j ON j.id=bg.match_id
      WHERE s.deleted_at IS NOT NULL AND (j.game_id=? OR EXISTS(SELECT 1 FROM model_match_attempts a WHERE a.match_id=j.id AND a.game_id=?)) LIMIT 1`).get(id,id);},
    detail(id){
      const s=series(id),all=jobs(s),completed=all.filter(j=>j.status==='completed'&&j.result!==null);
      const participants=[s.model_a,s.model_b].map(modelId=>({modelId,wins:0,draws:0,losses:0,winRate:null,scoreRate:null,timing:{p95Ms:null,meanMs:null}}));
      const timing=[[],[]],byGame=new Map(completed.map(j=>[j.game_id,aSide(j,s)]));
      for(const j of completed){const winner=JSON.parse(j.result),side=aSide(j,s);
        for(const [i,p]of participants.entries()){if(winner==='draw')p.draws++;else if(winner===(i===0?side:1-side))p.wins++;else p.losses++;}}
      for(const m of db.prepare(`SELECT m.game_id,m.side,m.elapsed_ms FROM moves m JOIN model_matches j ON j.game_id=m.game_id
        JOIN model_batch_games bg ON bg.match_id=j.id JOIN model_batches b ON b.id=bg.batch_id WHERE b.series_id=? AND j.status='completed'`).all(s.id)){
        const side=byGame.get(m.game_id);if(side!==undefined)timing[m.side===side?0:1].push(m.elapsed_ms);
      }
      participants.forEach((p,i)=>{const n=p.wins+p.draws+p.losses;p.winRate=n?p.wins/n:null;p.scoreRate=n?(p.wins+p.draws/2)/n:null;p.timing.p95Ms=percentile(timing[i],.95);p.timing.meanMs=timing[i].length?timing[i].reduce((sum,t)=>sum+t,0)/timing[i].length:null;});
      const batches=db.prepare('SELECT id,seed,game_count AS gameCount,config,created_at AS createdAt FROM model_batches WHERE series_id=? ORDER BY rowid').all(s.id).map(b=>({...b,config:JSON.parse(b.config)}));
      const latest=batches.at(-1),gamesList=all.flatMap((j,index)=>j.game_id?[{index,batchId:j.batchId,batchIndex:j.batchIndex,gameId:j.game_id,
        winner:j.result===null?null:JSON.parse(j.result),termination:j.termination,plies:j.plies,openingPlies:JSON.parse(j.opening).length,aSide:aSide(j,s),elapsedMs:j.elapsedMs,status:j.status,error:j.error}]:[]);
      return {...summary(s),config:{ruleset:'twelve-janggi-strict-v2',options:{seed:latest.seed,moveMs:60000,concurrency:latest.config.concurrency??(latest.config.legacy?1:2)}},batches,
        summary:{participants,uniqueOpenings:new Set(completed.map(j=>JSON.stringify(JSON.parse(j.initial_state).positions))).size},
        attempts:db.prepare(`SELECT a.attempt,a.game_id AS gameId,a.error FROM model_match_attempts a
          JOIN model_batch_games bg ON bg.match_id=a.match_id JOIN model_batches b ON b.id=bg.batch_id WHERE b.series_id=?`).all(s.id),
        games:gamesList,attempt:Math.max(0,...all.map(j=>j.attempt)),gameId:all[0]?.game_id||null,
        legacyGameIndex:s.legacyMatch?all.findIndex(j=>j.id===s.legacyMatch):undefined};
    },
    record(id,index=0){
      requireThat(Number.isSafeInteger(index)&&index>=0,404,'대국을 찾을 수 없습니다.');const s=series(id);
      const select=`SELECT j.*,b.id AS batchId FROM model_batches b JOIN model_batch_games bg ON bg.batch_id=b.id JOIN model_matches j ON j.id=bg.match_id`;
      const j=s.legacyMatch&&index===0?db.prepare(select+' WHERE j.id=?').get(s.legacyMatch)
        :db.prepare(select+' WHERE b.series_id=? ORDER BY b.rowid,bg.game_index LIMIT 1 OFFSET ?').get(s.id,index);
      requireThat(j,404,'대국을 찾을 수 없습니다.');requireThat(j.game_id,409,'대전을 준비하고 있습니다.');const g=games.record(j.game_id);
      return {index,gameId:g.id,batchId:j.batchId,status:j.status,error:j.error,first:j.first,aSide:aSide(j,s),opening:JSON.parse(j.opening),startState:{...g.initialState,log:[]},moves:g.moves,
        winner:g.state.winner,termination:g.state.termination,finalKey:positionKey(g.state),finalPly:g.state.ply,
        modelVersions:registryId(j.model_a)===s.model_a?{a:j.model_a,b:j.model_b}:{a:j.model_b,b:j.model_a},
        attempts:db.prepare('SELECT revision,side,stage,elapsed_ms AS elapsedMs,accepted,error FROM model_attempts WHERE game_id=? ORDER BY revision,stage').all(g.id)};
    },
  };
}
