import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { openDatabase } from '../server/database.mjs';
import { legalActions } from '../src/engine.js';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

test('production entry point starts on loopback:3000, restarts with durable sessions/requests/records and recovers expired deadlines', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'twelve-start-')), filename = path.join(root,'test.sqlite');
  const env = { ...process.env, APP_PROFILE:'laptop', APP_ORIGIN:'http://127.0.0.1:3000', API_HOST:'127.0.0.1', API_PORT:'3000', PUBLIC_ACCESS:'local', SESSION_COOKIE_SECURE:'false', TRUST_PROXY:'none', SQLITE_PATH:filename, SESSION_SECRET:randomBytes(32).toString('base64url'), INTERACTIVE_MOVE_MS:'60000', BATCH_CONCURRENCY:'2', MODEL_MOVE_MS:'1000' };
  let child, exited;
  async function start() {
    child = spawn(process.execPath,['server/start.mjs'],{ env, windowsHide:true,stdio:['ignore','pipe','pipe','ipc'] });
    exited = once(child,'exit'); let stderr = '';
    child.stderr.on('data',d=>stderr += d);
    await new Promise((resolve,reject) => {
      const timer = setTimeout(()=>reject(new Error('App startup timeout')),10000);
      child.stdout.on('data',d=>{if (d.toString().includes('Guest arena ready:')) { clearTimeout(timer);resolve(); }});
      child.once('error',e=>{clearTimeout(timer);reject(e);});
      child.once('exit',()=>{clearTimeout(timer);reject(new Error('App exited: '+stderr));});
    });
  }
  async function stop() {
    if (child?.exitCode === null) {
      const processToStop = child;
      if (processToStop.connected) processToStop.send('shutdown'); else processToStop.kill();
      const timer = setTimeout(()=>processToStop.kill(),6000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    child = null;
    // Wait on the actual port state: Windows can briefly retain the listener
    // after the child's exit event. No arbitrary long startup sleep.
    for (let attempt=0;attempt<40;attempt++) {
      const released=await new Promise(resolve=>{const probe=createServer();probe.once('error',()=>resolve(false));probe.listen(3000,'127.0.0.1',()=>probe.close(()=>resolve(true)));});
      if (released) return;
      await delay(50);
    }
    throw new Error('Port 3000 was not released after server shutdown');
  }
  async function call(route, method = 'GET', body, session) {
    const res = await fetch(env.APP_ORIGIN+route,{method,headers:{ Connection:'close', ...(session?.cookie?{ Cookie:session.cookie }:{}), ...(method==='POST'?{Origin:env.APP_ORIGIN,'Content-Type':'application/json','X-CSRF-Token':session?.csrf || ''}:{}) }, ...(body?{body:JSON.stringify(body)}:{})});
    const data = await res.json();
    if (session) { if(res.headers.get('set-cookie'))session.cookie=res.headers.get('set-cookie').split(';')[0]; if(data.csrfToken)session.csrf=data.csrfToken; }
    assert.ok(res.ok,JSON.stringify(data)); return data;
  }
  try {
    await start(); assert.equal((await call('/health/ready')).ready,true);
    const a={},b={};
    await call('/api/guest/session','POST',{name:'restartalice'},a);
    await call('/api/guest/session','POST',{name:'restartbob'},b);
    let room=await call('/api/rooms','POST',{title:'재시작 대국'},a);
    room=await call(`/api/rooms/${room.id}/join`,'POST',{},b);
    await stop();await start();
    assert.equal((await call('/api/rooms','GET',undefined,a)).activeRoomId,room.id);
    for(const client of [a,b])room=await call(`/api/rooms/${room.id}/ready`,'POST',{ready:true,expectedRevision:room.revision},client);
    assert.equal(room.status,'playing');
    const g=await call(`/api/games/${room.gameId}`,'GET',undefined,a),actor=g.state.turn===0?a:b;
    const request={requestId:'durable_request',expectedRevision:0,action:legalActions(g.state)[0]};
    const accepted=await call(`/api/games/${g.id}/actions`,'POST',request,actor);
    await stop(); await start();
    assert.equal((await call('/api/me','GET',undefined,a)).guest.name,'restartalice');
    assert.equal((await call(`/api/rooms/${room.id}`,'GET',undefined,b)).gameId,g.id);
    assert.deepEqual(await call(`/api/games/${g.id}/actions`,'POST',request,actor),accepted);
    assert.equal((await call(`/api/games/${g.id}/record`,'GET',undefined,b)).moves.length,1);
    await stop();
    const db=openDatabase(filename); db.prepare('UPDATE games SET deadline_at=? WHERE id=?').run(Date.now()-1000,g.id); db.close();
    await start();
    const recovered=await call(`/api/games/${g.id}`,'GET',undefined,a);
    assert.equal(recovered.state.termination,'timeout'); assert.equal(recovered.revision,2); assert.equal(recovered.deadlineAt,null);
    assert.equal((await call('/api/rooms','GET',undefined,a)).rooms.length,0);
    await stop(); await start();
    assert.equal((await call(`/api/games/${g.id}/record`,'GET',undefined,a)).events.length,2);
  } finally { await stop(); assert.equal(path.dirname(root),os.tmpdir()); await rm(root,{recursive:true,force:true}); }
});
