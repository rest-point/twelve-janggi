import { randomUUID } from 'node:crypto';
import { createModelCatalog } from './model-catalog.mjs';
import { ModelProcess } from './model-process.mjs';
import { createModelMatches } from './model-matches.mjs';
import { createModelDescriptions } from './model-descriptions.mjs';
import { transaction } from './database.mjs';
import { legalActions,isLegalAction } from '../src/engine.js';

export function createModelService(db,games,{clientFactory=m=>new ModelProcess(m),maxPlies=256,batchSize=100}={}) {
  let catalog,batches,closed=false;const active=new Map(),sessions=new Map(),failures=new Map();
  const descriptions=createModelDescriptions(db);
  const currentJob=job=>{if(!job)return true;try{return db.prepare('SELECT attempt_token FROM model_matches WHERE id=?').get(job.id)?.attempt_token===job.token;}catch{return true;}};
  function fail(jobId,gameId,reason) {
    games.block(gameId);
    transaction(db,()=>{
      db.prepare('UPDATE games SET infra_error=? WHERE id=? AND result IS NULL').run(reason,gameId);
      if(jobId){
        const j=db.prepare('SELECT * FROM model_matches WHERE id=? AND game_id=? AND status=\'running\'').get(jobId,gameId);
        if(j){db.prepare('UPDATE model_match_attempts SET error=? WHERE game_id=?').run(reason,gameId);
          db.prepare('UPDATE model_matches SET status=?,error=?,attempt_token=NULL WHERE id=?').run(j.attempt<3?'queued':'error',reason,jobId);}
      }
    });
    failures.delete(gameId);
  }
  const ready=createModelCatalog(db).then(c=>{
    catalog=c;batches=createModelMatches(db,games,catalog,{batchSize,maxPlies});
    transaction(db,()=>{
      for(const j of db.prepare("SELECT * FROM model_matches WHERE status='running'").all()){
        db.prepare("UPDATE games SET infra_error='server-restart' WHERE id=? AND result IS NULL").run(j.game_id);
        db.prepare("UPDATE model_match_attempts SET error='server-restart' WHERE game_id=?").run(j.game_id);
        db.prepare("UPDATE model_matches SET status=?,error='server-restart',attempt_token=NULL WHERE id=?").run(j.attempt<3?'queued':'error',j.id);
      }
      db.prepare(`UPDATE games SET infra_error='server-restart' WHERE result IS NULL AND source<>'manual'
        AND id IN (SELECT game_id FROM model_attempts WHERE error='running')`).run();
    });
    transaction(db,()=>{
      for(const j of db.prepare("SELECT * FROM model_matches WHERE status IN ('queued','running')").all())if(!catalog.has(j.model_a)||!catalog.has(j.model_b)){
        if(j.game_id)db.prepare("UPDATE games SET infra_error='runner-changed' WHERE id=? AND result IS NULL").run(j.game_id);
        db.prepare("UPDATE model_matches SET status='error',error='runner-changed',attempt_token=NULL WHERE id=?").run(j.id);
      }
      for(const r of db.prepare("SELECT DISTINCT g.id,m.model_version_id FROM games g JOIN game_participants p ON p.game_id=g.id JOIN model_players m ON m.user_id=p.user_id WHERE g.mode='pvai' AND g.result IS NULL").all())
        if(!catalog.has(r.model_version_id))db.prepare("UPDATE games SET infra_error='runner-changed' WHERE id=?").run(r.id);
    });
    games.recover();
  });
  async function run(gameId,job=null) {
    const clients=sessions.get(gameId)||new Map();sessions.set(gameId,clients);active.set(gameId,clients);
    try{
      while(!closed){
        if(!currentJob(job))return;
        let g=games.get(gameId);
        if(g.state.winner!==null||g.infrastructureError)break;
        if(job&&g.state.ply>=maxPlies+(job.openingPlies||0)){games.finish(gameId,'draw','max-plies');break;}
        const side=g.state.turn,participant=g.participants[side];if(participant.kind!=='model')break;
        const model=catalog.get(participant.modelVersionId);
        db.prepare('INSERT OR REPLACE INTO model_attempts VALUES(?,?,?,?,?,?,?)').run(gameId,g.revision,side,'think',0,0,'running');
        if(!clients.has(side)){
          const client=clientFactory(model);clients.set(side,client);const startup=await client.ready();if(closed||!currentJob(job))return;
          db.prepare('INSERT OR REPLACE INTO model_attempts VALUES(?,?,?,?,?,?,?)').run(gameId,g.revision,side,'load',startup.elapsedMs,Number(!startup.error),startup.error||null);
          if(startup.error){
            db.prepare("UPDATE model_attempts SET error=? WHERE game_id=? AND revision=? AND stage='think'").run(startup.error,gameId,g.revision);
            if(startup.error==='infra-error')throw new Error('worker-host-error');
            games.finish(gameId,1-side,startup.error);break;
          }
        }
        g=games.get(gameId);if(g.state.winner!==null)break;
        const response=await clients.get(side).think({protocol:'js-v1',ruleset:g.ruleset,requestId:`model_${gameId}_${g.revision}`,
          state:g.state,legalActions:legalActions(g.state),budgetMs:60000,seed:job?.seed??parseInt(gameId.slice(0,8),16),config:model.config},Math.min(60000,Math.max(1,g.deadlineAt-Date.now())));
        if(closed||!currentJob(job))return;
        const current=games.get(gameId);
        if(current.revision!==g.revision||current.state.winner!==null){
          db.prepare("UPDATE model_attempts SET elapsed_ms=?,accepted=0,error=? WHERE game_id=? AND revision=? AND side=? AND stage='think'")
            .run(response.elapsedMs,current.state.termination==='model-timeout'?'model-timeout':'superseded',gameId,g.revision,side);break;
        }
        if(response.error==='infra-error'){
          db.prepare("UPDATE model_attempts SET elapsed_ms=?,error='infra-error' WHERE game_id=? AND revision=? AND side=? AND stage='think'").run(response.elapsedMs,gameId,g.revision,side);
          throw new Error('worker-host-error');
        }
        const error=response.error||(!response.action?'invalid-response':!isLegalAction(g.state,response.action)?'illegal-action':null);
        transaction(db,()=>{db.prepare('UPDATE model_attempts SET elapsed_ms=?,accepted=?,error=? WHERE game_id=? AND revision=? AND side=? AND stage=\'think\'')
          .run(response.elapsedMs,Number(!error),error,gameId,g.revision,side);});
        if(error){games.finish(gameId,1-side,error);break;}
        games.act(gameId,participant.id,'action',{requestId:`model_${gameId}_${g.revision}`,expectedRevision:g.revision,action:response.action});
        // Yield for HTTP and clocks, without animation or artificial delay.
        await new Promise(resolve=>setImmediate(resolve));
      }
      if(job&&!closed){const g=games.get(gameId);if(g.state.winner!==null)db.prepare("UPDATE model_matches SET status='completed',completed_at=?,error=NULL WHERE id=? AND attempt_token=?").run(Date.now(),job.id,job.token);}
    }catch(error){if(!closed&&currentJob(job)){failures.set(gameId,{jobId:job?.id||null,reason:error.message==='worker-host-error'?'worker-host-error':'storage-error'});games.block(gameId);
      try{fail(job?.id,gameId,failures.get(gameId).reason);}catch{/* Retry the infrastructure write on the next tick. */}}}
    finally{let r=null;try{if(!closed)r=db.prepare('SELECT result,infra_error FROM games WHERE id=?').get(gameId);}catch{games.block(gameId);}
      if(closed||job||r?.result!==null||r?.infra_error||failures.has(gameId)){for(const c of clients.values())c.close();sessions.delete(gameId);}active.delete(gameId);if(!closed&&job)setImmediate(()=>{try{tick();}catch{/* The regular scheduler retries a busy store. */}});}
  }
  function tick(){
    if(closed||!catalog)return;
    for(const [id,f]of failures){try{fail(f.jobId,id,f.reason);}catch{return;}}
    for(const [id,clients]of sessions){const r=db.prepare('SELECT result,infra_error FROM games WHERE id=?').get(id);if(!active.has(id)&&(r.result!==null||r.infra_error)){for(const c of clients.values())c.close();sessions.delete(id);}}
    for(const r of db.prepare(`SELECT g.id FROM games g JOIN game_participants p ON p.game_id=g.id AND p.side=json_extract(g.current_state,'$.turn')
      JOIN model_players m ON m.user_id=p.user_id WHERE g.result IS NULL AND g.infra_error IS NULL AND g.mode='pvai'`).all())if(!active.has(r.id))void run(r.id);
    let manualActive=db.prepare("SELECT count(*) AS n FROM model_matches WHERE status='running'").get().n;
    while(manualActive<2){
      const j=db.prepare("SELECT * FROM model_matches WHERE status='queued' ORDER BY created_at LIMIT 1").get();if(!j)break;
      let game,token=randomUUID();
      transaction(db,()=>{
        const players=[catalog.player(j.model_a),catalog.player(j.model_b)];if(j.a_side===1)players.reverse();
        game=games.createInTransaction(...players,{mode:'aivai',source:'manual',first:j.first,startState:j.start_state?JSON.parse(j.start_state):undefined});
        db.prepare("UPDATE model_matches SET status='running',game_id=?,attempt=attempt+1,attempt_token=? WHERE id=? AND status='queued'").run(game.id,token,j.id);
        db.prepare('INSERT INTO model_match_attempts VALUES(?,?,?,NULL)').run(j.id,j.attempt+1,game.id);
      });
      manualActive++;void run(game.id,{id:j.id,token,seed:j.seed,openingPlies:JSON.parse(j.opening).length});
    }
  }
  return {
    ready,tick,
    listModels(){return catalog.list().map(m=>({...m,description:descriptions.get(m.registryId)}));},player(id){return catalog.player(id);},
    describe(id,guestId,body){return descriptions.save(catalog.get(id),guestId,body);},
    remove(id,guestId){const {gameIds,...reply}=batches.remove(id,guestId);for(const gameId of gameIds){
      failures.delete(gameId);const clients=sessions.get(gameId);if(clients){for(const client of clients.values())client.close();clients.clear();}sessions.delete(gameId);
    }return reply;},
    gameDeleted(id){return batches.gameDeleted(id);},
    submit(...args){return batches.submit(...args);},
    list(){return batches.list();},detail(...args){return batches.detail(...args);},record(...args){return batches.record(...args);},
    close(){closed=true;for(const clients of sessions.values())for(const c of clients.values())c.close();sessions.clear();},
  };
}
