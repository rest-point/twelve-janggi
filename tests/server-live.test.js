import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { fixture,startMatch } from './helpers/http.mjs';
import { legalActions } from '../src/engine.js';
import { createApplication } from '../server/app.mjs';

async function connect(f,client,{path='/ws',headers={}}={}){
  const ws=new WebSocket(`ws://127.0.0.1:${f.port}${path}`,{origin:f.config.origin,headers:{Host:new URL(f.config.origin).host,Cookie:client.cookie,...(f.config.secure?{'x-forwarded-proto':'https'}:{}),...headers}});
  const queue=[];ws.on('error',()=>{});ws.on('message',data=>queue.push(JSON.parse(data)));
  await once(ws,'open');
  return {ws,send:value=>ws.send(JSON.stringify(value)),async next(predicate){for(let i=0;i<300;i++){const index=queue.findIndex(predicate);if(index>=0)return queue.splice(index,1)[0];await new Promise(r=>setTimeout(r,10));}assert.fail('Expected WebSocket snapshot was not received');}};
}
function rejection(f,client,{path='/ws',headers={}}={}){
  return new Promise((resolve,reject)=>{const ws=new WebSocket(`ws://127.0.0.1:${f.port}${path}`,{origin:headers.Origin||f.config.origin,headers:{Host:new URL(f.config.origin).host,...(client?.cookie?{Cookie:client.cookie}:{}),...(f.config.secure?{'x-forwarded-proto':'https'}:{}),...headers}});
    ws.on('error',()=>{});ws.on('unexpected-response',(_req,res)=>{res.resume();resolve(res.statusCode);});ws.on('open',()=>{ws.terminate();reject(new Error('Unexpectedly accepted upgrade'));});});
}
const snapshot=(scope,id,revision)=>m=>m.type==='snapshot'&&m.scope===scope&&(!id||m.id===id)&&(revision===undefined||m.revision===revision);

test('authenticated snapshots follow readiness, committed move revisions and termination; spectators cannot mutate over WS',async()=>{
  await fixture(async f=>{
    const a=f.client(),b=f.client(),viewer=f.client();await a.enter();await b.enter();await viewer.enter();
    const stream=await connect(f,viewer);assert.ok((await stream.next(snapshot('lobby'))).value.rooms);
    let room=(await a.call('/api/rooms','POST',{})).data;await b.call(`/api/rooms/${room.id}/join`,'POST',{});
    stream.send({type:'subscribe',scope:'room',id:room.id});const initial=await stream.next(snapshot('room',room.id));assert.equal(initial.value.seats.length,2);
    room=(await a.call(`/api/rooms/${room.id}/ready`,'POST',{ready:true,expectedRevision:1})).data;
    await b.call(`/api/rooms/${room.id}/ready`,'POST',{ready:true,expectedRevision:room.revision});
    const started=await stream.next(m=>snapshot('room',room.id)(m)&&m.value.gameId);const id=started.value.gameId;
    stream.send({type:'subscribe',scope:'game',id});const state=await stream.next(snapshot('game',id,0)),game=state.value;
    const actor=game.state.turn===0?a:b,request={requestId:randomUUID(),expectedRevision:0,action:legalActions(game.state)[0]};
    assert.equal((await viewer.call(`/api/games/${id}/actions`,'POST',request)).status,403);
    const replies=await Promise.all([actor.call(`/api/games/${id}/actions`,'POST',request),actor.call(`/api/games/${id}/actions`,'POST',{...request,requestId:randomUUID()})]);
    assert.deepEqual(replies.map(r=>r.status).sort(),[200,409]);const moved=await stream.next(snapshot('game',id,1));assert.equal(moved.value.state.positions.length,2);
    const attack=await connect(f,viewer);const close=once(attack.ws,'close');attack.send({type:'action',scope:'game',id,action:request.action});assert.equal((await close)[0],1008);assert.equal(f.app.games.get(id).revision,1);
    await a.call(`/api/games/${id}/resign`,'POST',{requestId:randomUUID(),expectedRevision:1});const ended=await stream.next(snapshot('game',id,2));assert.equal(ended.value.state.termination,'resignation');assert.equal(ended.value.deadlineAt,null);
    stream.send({type:'subscribe',scope:'game',id});assert.equal((await stream.next(snapshot('game',id,2))).value.state.winner,1);
    stream.ws.terminate();
  });
});

test('disconnection never pauses a deadline; reconnect obtains the missed snapshot and session expiry closes the stream',async()=>{
  let now=Date.now();await fixture(async f=>{
    const a=f.client(),b=f.client(),viewer=f.client();await a.enter();await b.enter();const viewerId=(await viewer.enter()).data.guest.id;
    const {game,actor}=await startMatch(a,b);const first=await connect(f,viewer);first.send({type:'subscribe',scope:'game',id:game.id});await first.next(snapshot('game',game.id,0));
    const closed=once(first.ws,'close');first.ws.terminate();await closed;
    await actor.call(`/api/games/${game.id}/actions`,'POST',{requestId:randomUUID(),expectedRevision:0,action:legalActions(game.state)[0]});
    const resumed=await connect(f,viewer);resumed.send({type:'subscribe',scope:'game',id:game.id});const next=await resumed.next(snapshot('game',game.id,1));
    assert.equal(next.value.state.positions.length,2);now=next.value.deadlineAt;f.app.games.recover();
    const expired=await resumed.next(snapshot('game',game.id,2));assert.equal(expired.value.state.termination,'timeout');
    f.db.prepare('UPDATE sessions SET expires_at=0 WHERE user_id=?').run(viewerId);const lost=await once(resumed.ws,'close');assert.equal(lost[0],4401);
  },false,{now:()=>now});
});

test('same-origin server restart restores a WS snapshot with the durable session and expired result',async()=>{
  let now=Date.now();await fixture(async f=>{
    const a=f.client(),b=f.client();await a.enter();await b.enter();const {game}=await startMatch(a,b),stream=await connect(f,a);stream.send({type:'subscribe',scope:'game',id:game.id});await stream.next(snapshot('game',game.id,0));
    const disconnect=once(stream.ws,'close');await new Promise(resolve=>f.app.server.close(resolve));await disconnect;
    now=game.deadlineAt;const resumed=createApplication(f.config,f.db,{now:()=>now});
    try{await resumed.ready;resumed.server.listen(f.port,'127.0.0.1');await once(resumed.server,'listening');
      const again=await connect(f,a);again.send({type:'subscribe',scope:'game',id:game.id});const recovered=await again.next(snapshot('game',game.id,1));assert.equal(recovered.value.state.termination,'timeout');assert.equal(recovered.value.state.positions.length,1);again.ws.terminate();
    }finally{await new Promise(resolve=>resumed.server.close(resolve));}
  },false,{now:()=>now});
});

test('WS rejects unauthenticated, wrong Origin/Host/path and insecure desktop proxy upgrades; bounds message size',async()=>{
  for(const desktop of [false,true])await fixture(async f=>{
    const guest=f.client();await guest.enter();assert.equal(await rejection(f,null),401);
    assert.equal(await rejection(f,guest,{headers:{Origin:'https://evil.org'}}),403);
    assert.equal(await rejection(f,guest,{headers:{Host:'evil.org'}}),403);
    assert.equal(await rejection(f,guest,{path:'/ws?token=forbidden'}),404);
    if(desktop)assert.equal(await rejection(f,guest,{headers:{'x-forwarded-proto':'http'}}),403);
    const valid=await connect(f,guest);await valid.next(snapshot('lobby'));const closed=once(valid.ws,'close');valid.ws.send('x'.repeat(4097));assert.equal((await closed)[0],1009);
  },desktop);
});

test('deleting a model combination makes an existing game subscription unavailable without rewriting its stored result',async()=>{
  const fake=()=>({ready:async()=>({elapsedMs:1}),think:async r=>({action:r.legalActions[0],elapsedMs:1}),close(){}});
  await fixture(async f=>{
    const a=f.client(),guest=(await a.enter()).data.guest.id,submitted=f.app.models.submit(guest,{modelA:'greedy-v1',modelB:'random-v1',requestId:randomUUID()});
    let done;for(let i=0;i<200;i++){done=f.app.models.detail(submitted.id);if(done.status==='completed')break;await new Promise(r=>setTimeout(r,10));}
    assert.equal(done.status,'completed');const id=done.games[0].gameId,before=f.db.prepare('SELECT current_state FROM games WHERE id=?').get(id).current_state;
    const stream=await connect(f,a);stream.send({type:'subscribe',scope:'game',id});await stream.next(snapshot('game',id));f.app.models.remove(done.id,guest);
    assert.equal((await stream.next(m=>m.type==='unavailable'&&m.id===id)).status,404);assert.equal(f.db.prepare('SELECT current_state FROM games WHERE id=?').get(id).current_state,before);stream.ws.terminate();
  },false,{modelOptions:{clientFactory:fake,maxPlies:2}});
});
