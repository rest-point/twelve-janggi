import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ROOT,loadRegistry,sha256 } from '../bench/common.mjs';
import { transaction } from './database.mjs';
import { requireThat } from './security.mjs';

export async function createModelCatalog(db) {
  const registry=await loadRegistry();
  const sourceFiles=['src/engine.js','bench/common.mjs','bench/model-worker.mjs','server/games.mjs','server/model-service.mjs','server/model-matches.mjs','server/model-process.mjs','server/model-host.mjs','package-lock.json'];
  const environment={node:process.version,platform:os.platform(),release:os.release(),arch:os.arch(),
    hashes:Object.fromEntries(await Promise.all(sourceFiles.map(async f=>[f,sha256(await readFile(path.join(ROOT,f)))])))};
  const approved=[];
  transaction(db,()=>{
    for(const m of registry){
      const modelId=m.id.replace(/-v\d+$/,'');
      const digest=sha256(JSON.stringify({artifactHash:m.artifactHash,environment}));
      const old=db.prepare('SELECT * FROM model_versions WHERE id=?').get(m.id);
      let id=m.id;
      if(old&&old.digest!==digest){
        const previous=JSON.parse(old.manifest),previousEnvironment=JSON.parse(old.environment);
        requireThat(previous.artifactHash===m.artifactHash&&old.digest===sha256(JSON.stringify({artifactHash:previous.artifactHash,environment:previousEnvironment})),503,`모델 ${m.id}의 불변 버전이 변경되었습니다. 새 버전 ID를 등록하세요.`);
        // Preserve prior executions. A changed runner/runtime gets a new immutable
        // execution ID, while the artifact ID still groups the same model pair.
        id=`${m.id}-${digest.slice(0,12)}`;
      }
      const existing=db.prepare('SELECT digest FROM model_versions WHERE id=?').get(id);
      requireThat(!existing||existing.digest===digest,503,'모델 실행 버전의 해시가 일치하지 않습니다.');
      // Display names can change independently of the registered artifact.
      const name=m.id==='team-contender-v2'?'장군: JANGGUN':m.name;
      const resolved={...m,id,registryId:m.id};approved.push({...resolved,name});
      if(!existing){
        db.prepare('INSERT OR IGNORE INTO models VALUES(?,?)').run(modelId,name);
        const {entryPath,...manifest}=resolved;
        db.prepare('INSERT INTO model_versions VALUES(?,?,?,?,?,?,?)').run(id,modelId,id,digest,JSON.stringify(manifest),JSON.stringify(environment),Date.now());
        const playerId=randomUUID();db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(playerId,name,`model:${id}`,'!model-no-password','user',Date.now());
        db.prepare('INSERT INTO model_players VALUES(?,?)').run(playerId,id);
      }
    }
  });
  const byId=new Map(approved.map(m=>[m.id,m]));
  return {
    list(){return approved.map(m=>({id:m.id,registryId:m.registryId,modelId:m.registryId.replace(/-v\d+$/,''),name:m.name,version:m.version,moveMs:60000}));},
    has(id){return byId.has(id);},
    get(id){const m=byId.get(id);requireThat(m,422,'승인된 모델 버전을 선택하세요.');return m;},
    player(id){this.get(id);return db.prepare('SELECT user_id FROM model_players WHERE model_version_id=?').get(id).user_id;},
  };
}
