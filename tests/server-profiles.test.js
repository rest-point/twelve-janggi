import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture,startMatch } from './helpers/http.mjs';
import { legalActions,positionKey } from '../src/engine.js';
import { replayFrames } from '../src/record-replay.js';
import { openDatabase } from '../server/database.mjs';
import { createGames } from '../server/games.mjs';
import { createProfiles } from '../server/profiles.mjs';
const fake=()=>({ready:async()=>({elapsedMs:1}),think:async r=>({action:r.legalActions[0],elapsedMs:1}),close(){}});
async function until(read,done){for(let i=0;i<400;i++){const value=await read();if(done(value))return value;await new Promise(r=>setTimeout(r,15));}assert.fail('Profile fixture did not finish');}

test('guest profiles bind personal history to the session and replay resignation with the original positions/timing',async()=>{
  await fixture(async f=>{
    const a=f.client(),b=f.client(),viewer=f.client();assert.equal((await a.call('/api/history/me')).status,401);
    const aid=(await a.enter('같은 이름')).data.guest.id,bid=(await b.enter('같은 이름')).data.guest.id;await viewer.enter('관전자');
    const {game,actor}=await startMatch(a,b),move=await actor.call(`/api/games/${game.id}/actions`,'POST',{requestId:randomUUID(),expectedRevision:0,action:legalActions(game.state)[0]});
    assert.equal(move.status,200);assert.equal((await a.call(`/api/games/${game.id}/resign`,'POST',{requestId:randomUUID(),expectedRevision:1})).status,200);
    const mine=(await a.call('/api/history/me')).data,other=(await viewer.call('/api/profiles/guests/'+bid)).data;
    assert.equal(mine.profile.id,aid);assert.equal(mine.summary.losses,1);assert.equal(other.summary.wins,1);
    assert.equal((await viewer.call('/api/history/me')).data.summary.total,0);
    assert.equal((await viewer.call('/api/history/me?player='+aid)).status,422);
    assert.equal((await viewer.call('/api/profiles/guests/'+randomUUID())).status,404);
    assert.ok(!/password_hash|token_hash|csrfToken/.test(JSON.stringify(mine)));
    const record=(await viewer.call('/api/records/'+game.id)).data,frames=replayFrames(record),raw=f.app.games.record(game.id);
    assert.equal(record.termination,'resignation');assert.equal(record.moves.length,1);assert.ok(record.moves[0].elapsedMs>=0);
    assert.deepEqual(frames.at(-1).state.positions,raw.state.positions);assert.equal(positionKey(frames.at(-1).state),positionKey(raw.state));
    assert.equal(record.participants[0].id,aid);assert.equal(mine.games[0].href,'/records?game='+game.id);
    const bad=structuredClone(record);bad.winner='draw';assert.throws(()=>replayFrames(bad),/기권 결과/);
    const second=openDatabase(f.config.dbPath);try{const profiles=createProfiles(second,createGames(second),f.app.models);assert.deepEqual(profiles.guest(aid,new URLSearchParams()).summary,mine.summary);assert.deepEqual(profiles.record(game.id).moves,record.moves);}finally{second.close();}
  });
});

test('keyset pages retain tied dates and filters count human games without including model batches',async()=>{
  await fixture(async f=>{
    const a=f.client(),b=f.client(),aid=(await a.enter()).data.guest.id,bid=(await b.enter()).data.guest.id,ids=[];
    for(let i=0;i<8;i++){const g=f.app.games.create(aid,bid);f.app.games.finish(g.id,i%3===0?'draw':i%2,i%3===0?'max-plies':'resignation');f.db.prepare('UPDATE games SET created_at=? WHERE id=?').run(1000,g.id);ids.push(g.id);}
    let cursor='',seen=[];
    do{const page=await a.call('/api/history/me?limit=3'+(cursor?'&cursor='+cursor:''));assert.equal(page.status,200);assert.equal(page.data.summary.completed,8);seen.push(...page.data.games.map(g=>g.id));cursor=page.data.nextCursor;}while(cursor);
    assert.equal(seen.length,8);assert.equal(new Set(seen).size,8);assert.deepEqual(seen,[...ids].sort().reverse());
    assert.equal((await a.call('/api/history/me?outcome=draw')).data.summary.draws,3);
    assert.equal((await a.call('/api/history/me?mode=pvai')).data.summary.total,0);
    for(const query of ['limit=51','limit=0','limit=1.1','cursor=invalid','mode=aivai','scope=human','version=greedy-v1','outcome=bad','limit=2&limit=3'])assert.equal((await a.call('/api/history/me?'+query)).status,422,query);
    assert.equal((await a.call('/api/profiles/models/missing')).status,404);
  });
});

test('model profiles separate human matches and batch evaluations, preserve versions and hide deleted combinations',async()=>{
  await fixture(async f=>{
    const a=f.client(),guest=(await a.enter()).data.guest.id;
    const submitted=(await a.call('/api/model-matches','POST',{modelA:'greedy-v1',modelB:'random-v1',requestId:randomUUID()})).data;
    const done=await until(()=>f.app.models.detail(submitted.id),s=>s.status==='completed');
    let room=(await a.call('/api/rooms','POST',{mode:'pvai',modelVersionId:'greedy-v1'})).data;
    room=(await a.call(`/api/rooms/${room.id}/ready`,'POST',{ready:true,expectedRevision:room.revision})).data;
    const human=f.app.games.get(room.gameId);assert.equal((await a.call(`/api/games/${human.id}/resign`,'POST',{requestId:randomUUID(),expectedRevision:human.revision})).status,200);
    const batch=(await a.call('/api/profiles/models/greedy')).data,humanStats=(await a.call('/api/profiles/models/greedy?scope=human')).data;
    assert.equal(batch.summary.completed,1);assert.equal(batch.summary.draws,1);assert.equal(humanStats.summary.wins,1);
    assert.equal((await a.call('/api/history/me')).data.summary.completed,1);
    assert.equal((await a.call('/api/history/me?mode=pvai')).data.summary.losses,1);
    assert.match(batch.games[0].href,/^\/experiments\?run=/);assert.equal(batch.games[0].seriesIndex,0);
    assert.equal((await a.call('/api/profiles/models/greedy?version=greedy-v1&opponent=random')).data.summary.total,1);
    assert.equal((await a.call('/api/profiles/models/greedy?version=random-v1')).status,422);
    assert.equal((await a.call('/api/profiles/models/greedy?scope=human&mode=pvp')).status,422);
    assert.ok(batch.versions.some(v=>v.id==='greedy-v1'));
    const record=(await a.call('/api/records/'+human.id)).data;replayFrames(record);
    assert.equal(record.participants[1].modelId,'greedy');
    const gameId=done.games[0].gameId;f.app.models.remove(done.id,guest);
    assert.equal((await a.call('/api/profiles/models/greedy')).data.summary.total,0);
    assert.equal((await a.call('/api/records/'+gameId)).status,404);
    assert.equal((await a.call('/api/profiles/models/greedy?scope=human')).data.summary.completed,1);
    assert.equal(f.db.prepare('SELECT count(*) n FROM games').get().n,2);
  },false,{modelOptions:{clientFactory:fake,maxPlies:2}});
});

test('infrastructure retries remain one unfinished profile entry and never become a model loss',async()=>{
  await fixture(async f=>{
    const a=f.client();await a.enter();const submitted=(await a.call('/api/model-matches','POST',{modelA:'greedy-v1',modelB:'random-v1',requestId:randomUUID()})).data;
    await until(()=>f.app.models.detail(submitted.id),s=>s.status==='error');
    const profile=(await a.call('/api/profiles/models/greedy')).data;
    assert.equal(profile.summary.completed,0);assert.equal(profile.summary.losses,0);assert.equal(profile.summary.unfinished,1);assert.equal(profile.games.length,1);
    assert.equal(f.db.prepare('SELECT count(*) n FROM games').get().n,3);
  },false,{modelOptions:{clientFactory:()=>({...fake(),ready:async()=>({error:'infra-error',elapsedMs:1})})}});
});

test('timeout replay validates the losing turn and keeps the recorded initial state',async()=>{
  let time=Date.now();await fixture(async f=>{
    const a=f.client(),b=f.client();await a.enter();await b.enter();const {game}=await startMatch(a,b);time=game.deadlineAt;f.app.games.recover();
    const r=(await a.call('/api/records/'+game.id)).data;assert.equal(r.termination,'timeout');assert.equal(r.winner,1-game.state.turn);replayFrames(r);
    const changed=structuredClone(r);changed.winner=game.state.turn;assert.throws(()=>replayFrames(changed),/시간 초과 결과/);
  },false,{now:()=>time});
});
