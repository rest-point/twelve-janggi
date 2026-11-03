import { transaction } from './database.mjs';
import { requireThat } from './security.mjs';

export function createModelDescriptions(db){
  function get(registryId){return db.prepare(`SELECT developer,characteristics,motivation,revision,updated_at AS updatedAt
    FROM model_descriptions WHERE registry_id=?`).get(registryId)||{developer:'',characteristics:'',motivation:'',revision:0,updatedAt:null};}
  return {
    get,
    save(model,guestId,body){
      requireThat(Object.keys(body).every(k=>['developer','characteristics','motivation','expectedRevision'].includes(k)),422,'허용하지 않는 모델 설명 항목입니다.');
      requireThat(Number.isSafeInteger(body.expectedRevision)&&body.expectedRevision>=0,422,'설명 revision이 필요합니다.');
      const values={};
      for(const [key,max]of [['developer',80],['characteristics',2000],['motivation',2000]]){
        requireThat(typeof body[key]==='string',422,'설명은 문자열로 작성하세요.');
        const value=body[key].normalize('NFKC').replace(/\r\n?/g,'\n').trim();
        requireThat(value.length<=max&&!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)&&(key!=='developer'||!/[\r\n\t]/.test(value)),422,`${key==='developer'?'개발자 이름':'모델 설명'}은 ${max}자 이하의 텍스트로 작성하세요.`);
        values[key]=value;
      }
      return transaction(db,()=>{
        const previous=get(model.registryId);requireThat(previous.revision===body.expectedRevision,409,'다른 팀원이 설명을 수정했습니다. 최신 설명을 불러온 뒤 다시 작성하세요.');
        db.prepare(`INSERT INTO model_descriptions VALUES(?,?,?,?,?,?,?) ON CONFLICT(registry_id) DO UPDATE SET
          developer=excluded.developer,characteristics=excluded.characteristics,motivation=excluded.motivation,
          revision=excluded.revision,updated_at=excluded.updated_at,updated_by=excluded.updated_by`)
          .run(model.registryId,values.developer,values.characteristics,values.motivation,previous.revision+1,Date.now(),guestId);
        return get(model.registryId);
      });
    },
  };
}
