import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,copyFile,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../server/database.mjs';
import { createGames } from '../server/games.mjs';
import { createRooms } from '../server/rooms.mjs';
import { legalActions,initialState,applyAction,positionKey } from '../src/engine.js';

test('upgrading a real M1 database preserves old accounts and full records; waiting rooms have no game deadline',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'twelve-migration-')),migrations=path.join(root,'old-migrations'),file=path.join(root,'test.sqlite');
  await mkdir(migrations);await copyFile('db/migrations/001-foundation.sql',path.join(migrations,'001-foundation.sql'));
  let db=openDatabase(file,{migrations});let at=100000;
  try{
    for(const id of ['oldA','oldB'])db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id,id,id,'unchanged-old-hash','user',at);
    const initial=initialState(0),action=legalActions(initial)[0],next=applyAction(initial,action);const g={id:'legacy-game'};
    const state={...next,winner:1,termination:'resignation'};
    db.prepare('INSERT INTO games(id,ruleset,initial_state,current_state,revision,turn_started_at,deadline_at,result,termination,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(g.id,initial.ruleset,JSON.stringify(initial),JSON.stringify(state),2,at,null,'1','resignation',at);
    for(const [side,id] of ['oldA','oldB'].entries())db.prepare('INSERT INTO game_participants VALUES(?,?,?)').run(g.id,side,id);
    db.prepare('INSERT INTO moves VALUES(?,?,?,?,?,?,?,?)').run(g.id,1,0,JSON.stringify(action),123,positionKey(next),'legacy-action',at);
    db.prepare('INSERT INTO game_requests VALUES(?,?,?,?,?)').run(g.id,'legacy-action','oldA',JSON.stringify(action),JSON.stringify({revision:1}));
    for(const [revision,s]of [initial,next,state].entries())db.prepare('INSERT INTO game_events VALUES(?,?,?,?,?)').run(g.id,revision,revision===0?'start':revision===1?'action':'resign',at,JSON.stringify(s));
    const tables=['users','games','moves','game_participants','game_requests','game_events'];
    const columns=Object.fromEntries(tables.map(t=>[t,db.prepare(`PRAGMA table_info(${t})`).all().map(c=>c.name).join(',')]));
    const before=Object.fromEntries(tables.map(t=>[t,JSON.stringify(db.prepare(`SELECT ${columns[t]} FROM ${t} ORDER BY rowid`).all())]));
    db.close();db=openDatabase(file);
    for(const t of tables)assert.equal(JSON.stringify(db.prepare(`SELECT ${columns[t]} FROM ${t} ORDER BY rowid`).all()),before[t],t);
    for(const id of ['guestA','guestB']){db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id,'동일 이름','guest:'+id,'!guest-no-password','user',at);db.prepare('INSERT INTO guests VALUES(?,?)').run(id,at);}
    const games=createGames(db,{now:()=>at});const rooms=createRooms(db,games,{now:()=>at});let room=rooms.create('guestA',{});
    at+=864000000;assert.equal(rooms.get(room.id).gameId,null);
    assert.equal(db.prepare('SELECT count(*) AS n FROM games').get().n,1);
    room=rooms.join(room.id,'guestB');
    for(const id of ['guestA','guestB'])room=rooms.ready(room.id,id,{ready:true,expectedRevision:room.revision});
    assert.equal(room.status,'playing');
    assert.equal(games.get(room.gameId).deadlineAt,at+60000);
    assert.deepEqual(games.record(g.id).state.positions,state.positions);
  }finally{db.close();assert.equal(path.dirname(root),os.tmpdir());await rm(root,{recursive:true,force:true});}
});
