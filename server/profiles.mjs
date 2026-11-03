import { requireThat } from './security.mjs';
import { positionKey } from '../src/engine.js';

const uuid=value=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
const modelId=value=>typeof value==='string'&&/^[a-z0-9][a-z0-9-]{0,99}$/.test(value);
export function createProfiles(db,games,models){
  const joins=`FROM games g JOIN game_participants p ON p.game_id=g.id
    JOIN users u ON u.id=p.user_id JOIN game_participants op ON op.game_id=g.id AND op.side<>p.side
    JOIN users ou ON ou.id=op.user_id LEFT JOIN model_players mp ON mp.user_id=p.user_id
    LEFT JOIN model_versions mv ON mv.id=mp.model_version_id LEFT JOIN model_players omp ON omp.user_id=op.user_id
    LEFT JOIN model_versions omv ON omv.id=omp.model_version_id
    LEFT JOIN model_matches j ON j.game_id=g.id LEFT JOIN model_batch_games bg ON bg.match_id=j.id
    LEFT JOIN model_batches b ON b.id=bg.batch_id LEFT JOIN model_series ms ON ms.id=b.series_id`;
  const result=`CASE WHEN g.infra_error IS NOT NULL OR (g.mode='aivai' AND j.status<>'completed') THEN 'unfinished'
    WHEN g.result IS NULL THEN 'unfinished' WHEN json_extract(g.result,'$')='draw' THEN 'draw'
    WHEN json_extract(g.result,'$')=p.side THEN 'win' ELSE 'loss' END`;
  function filters(query){
    requireThat([...query.keys()].every(k=>['mode','scope','version','opponent','outcome','cursor','limit'].includes(k)),422,'허용하지 않는 전적 필터입니다.');
    for(const key of new Set(query.keys()))requireThat(query.getAll(key).length===1,422,'필터를 중복 지정할 수 없습니다.');
    const f={mode:query.get('mode')||'all',scope:query.get('scope')||'batch',version:query.get('version')||'',opponent:query.get('opponent')||'',outcome:query.get('outcome')||'all',limit:Number(query.get('limit')||20)};
    requireThat(['all','pvp','pvai'].includes(f.mode)&&['batch','human'].includes(f.scope)&&['all','win','draw','loss','unfinished'].includes(f.outcome),422,'전적 필터가 올바르지 않습니다.');
    requireThat(!f.version||modelId(f.version),422,'모델 버전이 올바르지 않습니다.');
    requireThat(!f.opponent||modelId(f.opponent)||uuid(f.opponent),422,'상대 필터가 올바르지 않습니다.');
    requireThat(Number.isSafeInteger(f.limit)&&f.limit>=1&&f.limit<=50,422,'조회 개수가 올바르지 않습니다.');
    let cursor=null;
    if(query.has('cursor')){try{const raw=query.get('cursor');requireThat(raw.length<=180&&/^[a-zA-Z0-9_-]+$/.test(raw),422,'페이지가 올바르지 않습니다.');cursor=JSON.parse(Buffer.from(raw,'base64url'));requireThat(Array.isArray(cursor)&&cursor.length===3&&Number.isSafeInteger(cursor[0])&&cursor[0]>=0&&uuid(cursor[1])&&[0,1].includes(cursor[2]),422,'페이지가 올바르지 않습니다.');}catch{requireThat(false,422,'페이지가 올바르지 않습니다.');}}
    return {f,cursor};
  }
  function history(where,args,query,profile){
    games.recover();const {f,cursor}=filters(query);
    if(profile.kind==='guest'){
      requireThat(!f.version&&f.scope==='batch',422,'사람 전적에는 모델 버전/평가 구분을 지정하지 않습니다.');
      where.push("g.mode IN ('pvp','pvai')");
      if(f.mode!=='all'){where.push('g.mode=?');args.push(f.mode);}
    }else{
      requireThat(f.mode==='all',422,'모델 전적은 사람 대국/모델 평가로 선택하세요.');
      if(f.scope==='batch')where.push("g.mode='aivai'","g.source='manual'","j.id IS NOT NULL","ms.deleted_at IS NULL");
      else where.push("g.mode='pvai'");
      if(f.version){requireThat(db.prepare('SELECT 1 FROM model_versions WHERE id=? AND model_id=?').get(f.version,profile.id),422,'이 모델의 실행 버전이 아닙니다.');where.push('mv.id=?');args.push(f.version);}
    }
    if(f.opponent){where.push('(op.user_id=? OR omv.model_id=?)');args.push(f.opponent,f.opponent);}
    if(f.outcome!=='all'){where.push(`(${result})=?`);args.push(f.outcome);}
    const clause=where.join(' AND ');
    const summaryRow=db.prepare(`SELECT count(*) AS total,
      coalesce(sum((${result})='win'),0) AS wins,coalesce(sum((${result})='draw'),0) AS draws,
      coalesce(sum((${result})='loss'),0) AS losses,coalesce(sum((${result})='unfinished'),0) AS unfinished ${joins} WHERE ${clause}`).get(...args);
    const summary={...summaryRow,completed:summaryRow.wins+summaryRow.draws+summaryRow.losses};
    summary.winRate=summary.completed?summary.wins/summary.completed:null;
    const pageWhere=cursor?' AND (g.created_at<? OR (g.created_at=? AND g.id<?) OR (g.created_at=? AND g.id=? AND p.side<?))':'';
    const pageArgs=cursor?[...args,cursor[0],cursor[0],cursor[1],cursor[0],cursor[1],cursor[2],f.limit+1]:[...args,f.limit+1];
    const rows=db.prepare(`SELECT g.id,g.mode,g.source,g.created_at AS createdAt,g.termination,g.infra_error AS infrastructureError,
      p.side,mv.id AS modelVersionId,ou.id AS opponentId,ou.username AS opponentName,
      omv.model_id AS opponentModelId,omv.id AS opponentVersionId,(${result}) AS outcome,
      json_extract(g.current_state,'$.ply') AS plies,ms.id AS seriesId,
      CASE WHEN b.id IS NOT NULL THEN (SELECT count(*) FROM model_batch_games pbg JOIN model_batches pb ON pb.id=pbg.batch_id
        WHERE pb.series_id=b.series_id AND (pb.rowid<b.rowid OR (pb.rowid=b.rowid AND pbg.game_index<bg.game_index))) END AS seriesIndex
      ${joins} WHERE ${clause}${pageWhere} ORDER BY g.created_at DESC,g.id DESC,p.side DESC LIMIT ?`).all(...pageArgs);
    const more=rows.length>f.limit,list=rows.slice(0,f.limit),last=list.at(-1);
    return {profile,summary,filters:f,games:list.map(r=>({...r,href:r.seriesId?`/experiments?run=${r.seriesId}&game=${r.seriesIndex}`:`/records?game=${r.id}`})),
      nextCursor:more?Buffer.from(JSON.stringify([last.createdAt,last.id,last.side])).toString('base64url'):null};
  }
  return {
    guest(id,query){
      requireThat(uuid(id),404,'플레이어를 찾을 수 없습니다.');
      const person=db.prepare('SELECT id,username AS name FROM users WHERE id=? AND id NOT IN (SELECT user_id FROM model_players)').get(id);
      requireThat(person,404,'플레이어를 찾을 수 없습니다.');return history(['p.user_id=?'],[id],query,{...person,kind:'guest'});
    },
    model(id,query){
      requireThat(modelId(id),404,'모델을 찾을 수 없습니다.');const model=db.prepare('SELECT id,name FROM models WHERE id=?').get(id);
      requireThat(model,404,'모델을 찾을 수 없습니다.');
      const versions=db.prepare('SELECT id,manifest,created_at AS createdAt FROM model_versions WHERE model_id=? ORDER BY created_at DESC,rowid DESC').all(id)
        .map(v=>({id:v.id,name:JSON.parse(v.manifest).name,version:JSON.parse(v.manifest).version,createdAt:v.createdAt}));
      return {...history(['mv.model_id=?'],[id],query,{...model,kind:'model'}),versions};
    },
    record(id){
      requireThat(uuid(id)&&!models.gameDeleted(id),404,'대국을 찾을 수 없습니다.');
      const g=games.record(id),job=db.prepare('SELECT first,a_side,opening,model_a,model_b FROM model_matches WHERE game_id=?').get(id);
      const initial=g.initialState;
      return {id:g.id,index:0,revision:g.revision,first:job?.first??initial.turn,aSide:job?.a_side??0,
        opening:job?JSON.parse(job.opening):[],startState:{...initial,log:[]},moves:g.moves,
        winner:g.state.winner,termination:g.state.termination,finalKey:positionKey(g.state),finalPly:g.state.ply,
        participants:g.participants.map(p=>({...p,modelId:p.modelVersionId?db.prepare('SELECT model_id FROM model_versions WHERE id=?').get(p.modelVersionId)?.model_id:null})),mode:g.mode,infrastructureError:g.infrastructureError,deadlineAt:g.deadlineAt,serverNow:g.serverNow,
        attempts:db.prepare('SELECT revision,side,stage,elapsed_ms AS elapsedMs,accepted,error FROM model_attempts WHERE game_id=? ORDER BY revision,stage').all(id)};
    },
  };
}
