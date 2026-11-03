import { randomUUID } from 'node:crypto';
import { transaction } from './database.mjs';
import { requireThat } from './security.mjs';

export function createRooms(db,games,{now=Date.now,models=null}={}) {
  const find=id=>{
    requireThat(typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id),404,'방을 찾을 수 없습니다.');
    const row=db.prepare('SELECT * FROM rooms WHERE id=?').get(id);
    requireThat(row,404,'방을 찾을 수 없습니다.');return row;
  };
  const seats=id=>db.prepare(`SELECT s.side,s.user_id AS id,u.username AS name,s.ready,s.ready_revision AS readyRevision,mp.model_version_id AS modelVersionId FROM room_seats s
    JOIN users u ON u.id=s.user_id LEFT JOIN model_players mp ON mp.user_id=s.user_id WHERE s.room_id=? ORDER BY s.side`).all(id).map(s=>({...s,ready:!!s.ready}));
  const snapshot=r=>({id:r.id,title:r.title,ownerId:r.owner_id,status:r.status,gameId:r.game_id,revision:r.revision,mode:r.mode,seats:seats(r.id)});
  function settle() {
    const condition="game_id IN (SELECT id FROM games WHERE result IS NOT NULL OR infra_error IS NOT NULL)";
    db.prepare(`DELETE FROM room_seats WHERE room_id IN (SELECT id FROM rooms WHERE ${condition})`).run();
    db.prepare(`DELETE FROM rooms WHERE ${condition}`).run();
  }
  const active=userId=>userId?db.prepare('SELECT r.* FROM rooms r JOIN room_seats s ON s.room_id=r.id WHERE s.user_id=? LIMIT 1').get(userId):null;
  function mutate(id,userId,work) {
    return transaction(db,()=>{settle();const r=find(id),members=seats(r.id);
      return work(r,members,members.find(s=>s.id===userId))||snapshot(find(id));});
  }
  function autoStart(r){const members=seats(r.id);if(r.status==='waiting'&&members.length===2&&members.every(s=>s.ready)){
    const game=games.createInTransaction(members[0].id,members[1].id,{mode:r.mode,source:'room'});
    db.prepare("UPDATE rooms SET status='playing',game_id=?,revision=revision+1 WHERE id=? AND game_id IS NULL").run(game.id,r.id);
  }}
  return {
    cleanup(){transaction(db,settle);},
    list(userId) {
      games.recover();return transaction(db,()=>{settle();return {
        rooms:db.prepare("SELECT * FROM rooms ORDER BY CASE status WHEN 'waiting' THEN 0 ELSE 1 END,created_at DESC LIMIT 50").all().map(snapshot),activeRoomId:active(userId)?.id||null};});
    },
    get(id) {games.recover();return transaction(db,()=>{settle();return snapshot(find(id));});},
    create(userId,body) {
      requireThat(Object.keys(body).every(k=>['title','mode','modelVersionId'].includes(k)),422,'허용하지 않는 방 설정입니다.');
      requireThat(body.title===undefined||typeof body.title==='string',422,'방 이름이 올바르지 않습니다.');
      const mode=body.mode||'pvp';requireThat(['pvp','pvai'].includes(mode),422,'방 대전 모드가 올바르지 않습니다.');
      const modelPlayer=mode==='pvai'?models?.player(body.modelVersionId):null;requireThat(mode!=='pvai'||modelPlayer,422,'AI 모델을 선택하세요.');
      const title=body.title?.normalize('NFKC').trim()||'함께 두는 십이장기';
      requireThat(title.length<=40&&!/[\u0000-\u001f\u007f]/u.test(title),422,'방 이름은 40자 이하입니다.');
      return transaction(db,()=>{
        settle();requireThat(!active(userId),409,'참가 중인 방으로 먼저 돌아가세요.');
        const id=randomUUID();
        db.prepare("INSERT INTO rooms(id,title,owner_id,status,created_at,mode,model_version_id) VALUES(?,?,?,'waiting',?,?,?)")
          .run(id,title,userId,now(),mode,mode==='pvai'?body.modelVersionId:null);
        db.prepare('INSERT INTO room_seats(room_id,side,user_id,ready) VALUES(?,?,?,0)').run(id,0,userId);
        if(modelPlayer)db.prepare('INSERT INTO room_seats(room_id,side,user_id,ready) VALUES(?,?,?,1)').run(id,1,modelPlayer);
        return snapshot(find(id));
      });
    },
    join(id,userId) {return mutate(id,userId,(r,members,own)=>{
      if(own)return;
      requireThat(r.status==='waiting',409,'이미 시작한 방입니다.');
      requireThat(!active(userId),409,'참가 중인 방으로 먼저 돌아가세요.');
      requireThat(members.length<2,409,'이미 두 명이 참가한 방입니다.');
      db.prepare('INSERT INTO room_seats(room_id,side,user_id,ready) VALUES(?,?,?,0)').run(r.id,1,userId);
      db.prepare('UPDATE room_seats SET ready=0,ready_revision=? WHERE room_id=?').run(r.revision+1,r.id);
      db.prepare('UPDATE rooms SET revision=revision+1 WHERE id=?').run(r.id);
    });},
    ready(id,userId,body) {return mutate(id,userId,(r,members,own)=>{
      requireThat(own,403,'참가자만 준비할 수 있습니다.');requireThat(typeof body.ready==='boolean',422,'준비 상태가 필요합니다.');
      if(own.ready===body.ready)return;
      requireThat(r.status==='waiting',409,'이미 대국이 시작되었습니다.');
      requireThat(Number.isSafeInteger(body.expectedRevision)&&body.expectedRevision>=own.readyRevision&&body.expectedRevision<=r.revision,409,'방 상태가 바뀌었습니다. 다시 확인하세요.');
      db.prepare('UPDATE room_seats SET ready=?,ready_revision=? WHERE room_id=? AND user_id=?').run(Number(body.ready),r.revision+1,r.id,userId);
      db.prepare('UPDATE rooms SET revision=revision+1 WHERE id=?').run(r.id);autoStart(r);
    });},
    leave(id,userId) {return mutate(id,userId,(r,members,own)=>{
      requireThat(own,403,'방 참가자가 아닙니다.');requireThat(r.status!=='playing',409,'대국 중입니다. 기권하거나 대국을 마친 뒤 나갈 수 있습니다.');
      if(r.owner_id===userId){
        db.prepare('DELETE FROM room_seats WHERE room_id=?').run(r.id);db.prepare('DELETE FROM rooms WHERE id=?').run(r.id);
        return {id:r.id,status:'closed'};
      }
      db.prepare('DELETE FROM room_seats WHERE room_id=? AND user_id=?').run(r.id,userId);
      db.prepare('UPDATE room_seats SET ready=0,ready_revision=? WHERE room_id=?').run(r.revision+1,r.id);
      db.prepare('UPDATE rooms SET revision=revision+1 WHERE id=?').run(r.id);
    });},
  };
}
