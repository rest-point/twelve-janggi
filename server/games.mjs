import { randomInt, randomUUID } from 'node:crypto';
import { initialState, RULESET, isLegalAction, applyAction, positionKey } from '../src/engine.js';
import { transaction } from './database.mjs';
import { requireThat } from './security.mjs';

export function createGames(db, { moveMs = 60000, now = Date.now } = {}) {
  const blocked=new Set();
  const row = id => { const r = db.prepare('SELECT * FROM games WHERE id=?').get(id); requireThat(r, 404, '대국을 찾을 수 없습니다.'); return r; };
  const participants = id => db.prepare(`SELECT p.side,u.id,u.username,mp.model_version_id AS modelVersionId
    FROM game_participants p JOIN users u ON p.user_id=u.id LEFT JOIN model_players mp ON mp.user_id=u.id
    WHERE p.game_id=? ORDER BY p.side`).all(id).map(p => ({ ...p,kind:p.modelVersionId?'model':'guest' }));
  function snapshot(r) {
    return { id: r.id, ruleset: r.ruleset, state: JSON.parse(r.current_state), revision: r.revision,
      turnStartedAt: r.turn_started_at, deadlineAt: r.deadline_at, participants: participants(r.id),mode:r.mode,source:r.source,infrastructureError:r.infra_error||(blocked.has(r.id)?'storage-error':null),serverNow: now() };
  }
  function save(r, state, at, kind) {
    const revision = r.revision + 1, deadline = state.winner === null ? at + moveMs : null;
    db.prepare(`UPDATE games SET current_state=?,revision=?,turn_started_at=?,deadline_at=?,result=?,termination=? WHERE id=? AND revision=?`)
      .run(JSON.stringify(state), revision, at, deadline, state.winner === null ? null : JSON.stringify(state.winner), state.termination, r.id, r.revision);
    db.prepare('INSERT INTO game_events VALUES(?,?,?,?,?)').run(r.id, revision, kind, at, JSON.stringify(state));
    if(state.winner!==null){
      db.prepare('DELETE FROM room_seats WHERE room_id IN (SELECT id FROM rooms WHERE game_id=?)').run(r.id);
      db.prepare('DELETE FROM rooms WHERE game_id=?').run(r.id);
    }
    return row(r.id);
  }
  function expire(r, at) {
    if (r.result === null && !r.infra_error && !blocked.has(r.id) && at >= r.deadline_at) {
      const state = JSON.parse(r.current_state);
      const model=participants(r.id)[state.turn]?.kind==='model';
      return save(r, { ...state, winner: 1 - state.turn, termination: model?'model-timeout':'timeout', reason: '서버의 수당 60초가 지났습니다.' }, at, 'timeout');
    }
    return r;
  }
  function recover() {
    return transaction(db, () => {
      const at = now(), expired = db.prepare('SELECT * FROM games WHERE result IS NULL AND infra_error IS NULL AND deadline_at<=?').all(at);
      for (const r of expired) expire(r, at);
      return expired.length;
    });
  }
  // Called by the room start transaction, so seats/game/status commit together.
  function createInTransaction(userId,opponentId,{mode='pvp',source='room',first=randomInt(2),startState}={}) {
    requireThat(opponentId!==userId&&db.prepare('SELECT id FROM users WHERE id=?').get(opponentId),422,'서로 다른 참가자가 필요합니다.');
    const id=randomUUID(),at=now(),state=startState||initialState(first);
    db.prepare('INSERT INTO games(id,ruleset,initial_state,current_state,turn_started_at,deadline_at,created_at,mode,source) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id,RULESET,JSON.stringify(state),JSON.stringify(state),at,at+moveMs,at,mode,source);
    db.prepare('INSERT INTO game_participants VALUES(?,?,?)').run(id,0,userId);
    db.prepare('INSERT INTO game_participants VALUES(?,?,?)').run(id,1,opponentId);
    return snapshot(row(id));
  }
  return {
    block(id){blocked.add(id);},
    recover,
    createInTransaction,
    create(userId,opponentId) { return transaction(db,()=>createInTransaction(userId,opponentId)); },
    finish(id,winner,termination) {return transaction(db,()=>{const r=row(id),s=JSON.parse(r.current_state);if(s.winner!==null||r.infra_error)return snapshot(r);
      return snapshot(save(r,{...s,winner,termination,reason:termination},now(),termination));});},
    list(userId) {
      recover();
      return db.prepare(`SELECT g.* FROM games g JOIN game_participants p ON p.game_id=g.id WHERE p.user_id=? ORDER BY g.created_at DESC LIMIT 100`).all(userId).map(snapshot);
    },
    get(id) { return transaction(db, () => snapshot(expire(row(id), now()))); },
    record(id) {
      const game = this.get(id);
      return { ...game, initialState: JSON.parse(row(id).initial_state),
        moves: db.prepare('SELECT * FROM moves WHERE game_id=? ORDER BY ply').all(id).map(m => ({ ply: m.ply, side: m.side, action: JSON.parse(m.action), elapsedMs: m.elapsed_ms, positionKey: m.position_key, requestId: m.request_id })),
        events: db.prepare('SELECT revision,kind,received_at AS receivedAt FROM game_events WHERE game_id=? ORDER BY revision').all(id) };
    },
    act(id, userId, kind, input) {
      requireThat(input && typeof input === 'object' && !Array.isArray(input), 422, '요청 형식이 올바르지 않습니다.');
      requireThat(Object.keys(input).every(k => ['requestId', 'expectedRevision', ...(kind === 'action' ? ['action'] : [])].includes(k)), 422, '허용하지 않는 착수 필드입니다.');
      requireThat(typeof input.requestId === 'string' && /^[a-zA-Z0-9_-]{8,80}$/.test(input.requestId) && Number.isSafeInteger(input.expectedRevision) && input.expectedRevision >= 0, 422, 'requestId와 expectedRevision이 필요합니다.');
      let action = input.action;
      if (kind === 'action') {
        requireThat(action && typeof action === 'object' && !Array.isArray(action) && Object.keys(action).length === 2 && Object.keys(action).every(k => ['from','to','drop'].includes(k)), 422, '착수 형식이 올바르지 않습니다.');
        action = Object.hasOwn(action, 'drop') ? { drop: action.drop, to: action.to } : { from: action.from, to: action.to };
      }
      const payload = JSON.stringify({ kind, expectedRevision: input.expectedRevision, ...(kind === 'action' ? { action } : {}) });
      return transaction(db, () => {
        let r = row(id);
        const seat = db.prepare('SELECT side FROM game_participants WHERE game_id=? AND user_id=?').get(id, userId);
        requireThat(seat, 403, '참가자만 착수할 수 있습니다.');
        const previous = db.prepare('SELECT * FROM game_requests WHERE game_id=? AND request_id=?').get(id, input.requestId);
        if (previous) {
          requireThat(previous.user_id === userId && previous.payload === payload, 409, '다른 요청에 사용한 requestId입니다.');
          return JSON.parse(previous.response);
        }
        const at = now();
        r = expire(r, at);
        const state = JSON.parse(r.current_state);
        // Terminal/deadline rejection commits an expired result instead of rolling it back.
        if (state.winner !== null) return { status: 409, body: { error: '이미 종료된 대국입니다.', game: snapshot(r) } };
        requireThat(!r.infra_error&&!blocked.has(id),503,'모델 계산을 재시도 중입니다.');
        requireThat(r.revision === input.expectedRevision, 409, 'revision이 변경되었습니다. 상태를 다시 조회하세요.');
        if (kind === 'action') requireThat(state.turn === seat.side, 403, '자기 차례에만 착수할 수 있습니다.');
        let next;
        if (kind === 'resign') next = { ...state, winner: 1 - seat.side, termination: 'resignation', reason: '참가자가 기권했습니다.' };
        else {
          requireThat(isLegalAction(state, action), 422, '불법 착수입니다.');
          next = applyAction(state, action);
          db.prepare('INSERT INTO moves VALUES(?,?,?,?,?,?,?,?)').run(id, next.ply, seat.side, JSON.stringify(action), Math.max(0, at - r.turn_started_at), positionKey(next), input.requestId, at);
        }
        const response = { status: 200, body: snapshot(save(r, next, at, kind)) };
        db.prepare('INSERT INTO game_requests VALUES(?,?,?,?,?)').run(id, input.requestId, userId, payload, JSON.stringify(response));
        return response;
      });
    },
  };
}
