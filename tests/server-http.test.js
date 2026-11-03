import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { randomBytes,randomUUID } from 'node:crypto';
import { fixture,startMatch } from './helpers/http.mjs';
import { openDatabase } from '../server/database.mjs';
import { digest } from '../server/security.mjs';
import { legalActions,applyAction } from '../src/engine.js';

function rawUpgrade(port,headers) {
  return new Promise((resolve,reject)=>{const socket=connect(port,'127.0.0.1'),chunks=[];
    socket.setTimeout(3000,()=>socket.destroy(new Error('upgrade timeout')));socket.on('error',reject);
    socket.on('connect',()=>socket.write(`GET /ws HTTP/1.1\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${Object.entries(headers).map(([k,v])=>`${k}: ${v}\r\n`).join('')}\r\n`));
    socket.on('data',d=>{chunks.push(d);const value=Buffer.concat(chunks).toString();if(value.startsWith('HTTP/1.1 101')){socket.destroy();resolve(value);}});socket.on('end',()=>resolve(Buffer.concat(chunks).toString()));});
}
test('guests need no password, may share names, resume by opaque cookie, and cannot reuse old account sessions',async()=>{
  await fixture(async f=>{
    const a=f.client(),b=f.client();
    assert.equal((await a.call('/api/me')).data.guest,null);
    assert.equal((await a.call('/api/me')).data.guestMode,true);
    for(const endpoint of ['register','login','logout'])assert.equal((await a.call('/api/auth/'+endpoint,'POST',{})).status,404);
    assert.equal((await a.call('/api/admin/health')).status,404);
    assert.equal((await a.call('/api/guest/session','POST',{name:'name',role:'admin'})).status,422);
    assert.equal((await a.call('/api/guest/session','POST',{name:'<script>'})).status,422);
    const first=await a.enter('같은 이름'),second=await b.enter('같은 이름');
    assert.notEqual(first.data.guest.id,second.data.guest.id);assert.equal(first.data.guest.name,second.data.guest.name);
    assert.match(first.headers.get('set-cookie'),/HttpOnly; SameSite=Lax/);
    assert.equal(f.db.prepare('SELECT password_hash FROM users WHERE id=?').get(first.data.guest.id).password_hash,'!guest-no-password');
    assert.deepEqual((await a.enter('다른 이름')).data,first.data);
    const resumed=f.client();resumed.cookie=a.cookie;
    assert.deepEqual((await resumed.call('/api/me')).data.guest,first.data.guest);
    const legacyId=randomUUID(),legacyToken=randomBytes(32).toString('base64url');
    f.db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(legacyId,'old-account','old-account','legacy-password-hash','admin',Date.now());
    f.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,NULL)').run(digest(f.config.secret,'session',legacyToken),legacyId,f.config.origin,Date.now()+100000);
    const legacy=f.client();legacy.cookie='twelve-session='+legacyToken;
    assert.equal((await legacy.call('/api/me')).data.guest,null);
    assert.equal((await legacy.call('/api/rooms','POST',{})).status,401);
    assert.equal(f.db.prepare('SELECT password_hash FROM users WHERE id=?').get(legacyId).password_hash,'legacy-password-hash');
    const noName=f.client();assert.match((await noName.enter()).data.guest.name,/^게스트 /);
    f.db.prepare('UPDATE sessions SET expires_at=0').run();assert.equal((await a.call('/api/me')).data.guest,null);
  });
});
test('guest issuance and room mutations retain exact Origin/Host/CSRF checks and persistent issuance limits',async()=>{
  await fixture(async f=>{
    const a=f.client();
    assert.equal((await a.call('/api/guest/session','POST',{}, {Origin:'https://evil.org'})).status,403);
    assert.equal((await a.call('/api/guest/session','POST',{}, {Origin:''})).status,403);
    assert.equal((await a.call('/api/guest/session','POST','{bad')).status,400);
    await a.enter('guest');
    for(const headers of [{'X-CSRF-Token':'wrong'},{Origin:'https://evil.org'},{'Sec-Fetch-Site':'cross-site'}])assert.equal((await a.call('/api/rooms','POST',{},headers)).status,403);
    assert.equal((await a.call('/api/me','GET',undefined,{Host:'evil.org'})).status,403);
    assert.equal((await a.call('/api/me','GET',undefined,{Origin:'https://evil.org'})).status,403);
    f.db.prepare('UPDATE auth_limits SET count=80').run();
    const b=f.client();assert.equal((await b.call('/api/guest/session','POST',{}, {'x-forwarded-for':'203.0.113.7'})).status,429);
    assert.equal((await a.call('/api/me')).data.guest.name,'guest');
    f.db.prepare('UPDATE auth_limits SET window_at=0').run();await b.enter();
  });
});
test('two concurrent joins claim one vacant seat; readiness and start permissions reject spectators and stale revisions',async()=>{
  await fixture(async f=>{
    const a=f.client(),b=f.client(),c=f.client();for(const x of [a,b,c])await x.enter('게스트');
    const r=(await a.call('/api/rooms','POST',{title:'친구 대국'})).data;
    assert.equal((await a.call(`/api/rooms/${r.id}/start`,'POST',{expectedRevision:0})).status,404);
    const replies=await Promise.all([b.call(`/api/rooms/${r.id}/join`,'POST',{}),c.call(`/api/rooms/${r.id}/join`,'POST',{})]);
    assert.deepEqual(replies.map(x=>x.status).sort(),[200,409]);
    const joined=replies[0].status===200?b:c,spectator=joined===b?c:b;
    let room=(await a.call(`/api/rooms/${r.id}`)).data;
    assert.equal(room.seats.length,2);assert.equal(room.gameId,null);
    assert.equal((await joined.call(`/api/rooms/${r.id}/join`,'POST',{})).data.revision,room.revision);
    assert.equal((await spectator.call(`/api/rooms/${r.id}/ready`,'POST',{ready:true,expectedRevision:room.revision})).status,403);
    assert.equal((await joined.call(`/api/rooms/${r.id}/start`,'POST',{expectedRevision:room.revision})).status,404);
    assert.equal((await a.call(`/api/rooms/${r.id}/ready`,'POST',{ready:true,expectedRevision:0})).status,409);
    room=(await a.call(`/api/rooms/${r.id}/ready`,'POST',{ready:true,expectedRevision:room.revision})).data;
    room=(await joined.call(`/api/rooms/${r.id}/ready`,'POST',{ready:true,expectedRevision:room.revision})).data;
    assert.equal(room.status,'playing');
    const retry=await joined.call(`/api/rooms/${r.id}/ready`,'POST',{ready:true,expectedRevision:room.revision-2});
    assert.equal(retry.data.gameId,room.gameId);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM games').get().n,1);
    assert.equal((await a.call('/api/rooms','POST',{})).status,409);
    assert.equal((await a.call(`/api/rooms/${r.id}/leave`,'POST',{})).status,409);
  });
});
test('concurrent actions commit one revision; only seat owners act and retries/records retain repetition history',async()=>{
  await fixture(async f=>{
    const a=f.client(),b=f.client(),spectator=f.client();await a.enter('alice');await b.enter('bob');await spectator.enter('alice');
    const {game:g,actor}=await startMatch(a,b),route=`/api/games/${g.id}/actions`,action=legalActions(g.state)[0];
    const request={expectedRevision:0,requestId:'concurrent_first',action};
    assert.equal((await spectator.call(route,'POST',request)).status,403);
    assert.equal((await (actor===a?b:a).call(route,'POST',request)).status,403);
    const replies=await Promise.all([actor.call(route,'POST',request),actor.call(route,'POST',{...request,requestId:'concurrent_second'})]);
    assert.deepEqual(replies.map(r=>r.status).sort(),[200,409]);const index=replies[0].status===200?0:1;
    assert.deepEqual((await actor.call(route,'POST',{...request,requestId:index===0?'concurrent_first':'concurrent_second'})).data,replies[index].data);
    const record=(await spectator.call(`/api/games/${g.id}/record`)).data;
    assert.equal(record.revision,1);assert.equal(record.moves.length,1);assert.equal(record.state.positions.length,2);
    assert.deepEqual(JSON.parse(JSON.stringify(applyAction(record.initialState,action))),record.state);
    assert.equal((await f.client().call(route,'POST',request)).status,401);
    assert.equal((await a.call('/api/games','POST',{opponent:'bob'})).status,404);
  });
});
test('waiting guests may leave/rejoin; replacement resets readiness and host closing never deletes records',async()=>{
  await fixture(async f=>{
    const a=f.client(),b=f.client(),c=f.client();await a.enter();await b.enter();await c.enter();
    let r=(await a.call('/api/rooms','POST',{})).data;
    r=(await b.call(`/api/rooms/${r.id}/join`,'POST',{})).data;
    r=(await a.call(`/api/rooms/${r.id}/ready`,'POST',{ready:true,expectedRevision:r.revision})).data;
    r=(await b.call(`/api/rooms/${r.id}/leave`,'POST',{})).data;
    assert.equal(r.seats.length,1);assert.equal(r.seats[0].ready,false);
    r=(await c.call(`/api/rooms/${r.id}/join`,'POST',{})).data;assert.equal(r.seats.length,2);
    assert.equal((await b.call(`/api/rooms/${r.id}/leave`,'POST',{})).status,403);
    assert.equal((await a.call(`/api/rooms/${r.id}/leave`,'POST',{})).data.status,'closed');
    assert.equal((await b.call(`/api/rooms/${r.id}/join`,'POST',{})).status,404);
    assert.equal((await a.call('/api/rooms')).data.rooms.length,0);
    assert.equal((await a.call('/api/rooms','POST',{})).status,201);
  });
});
test('room start rolls back game and room state together on storage failure',async()=>{
  await fixture(async f=>{
    const a=f.client(),b=f.client();await a.enter();await b.enter();
    let r=(await a.call('/api/rooms','POST',{})).data;r=(await b.call(`/api/rooms/${r.id}/join`,'POST',{})).data;
    r=(await a.call(`/api/rooms/${r.id}/ready`,'POST',{ready:true,expectedRevision:r.revision})).data;
    f.db.exec("CREATE TRIGGER fail_room BEFORE UPDATE ON rooms WHEN NEW.status='playing' BEGIN SELECT RAISE(ABORT,'injected room failure'); END;");
    assert.equal((await b.call(`/api/rooms/${r.id}/ready`,'POST',{ready:true,expectedRevision:r.revision})).status,500);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM games').get().n,0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM game_participants').get().n,0);
    assert.equal((await a.call(`/api/rooms/${r.id}`)).data.status,'waiting');
    f.db.exec('DROP TRIGGER fail_room');assert.equal((await b.call(`/api/rooms/${r.id}/ready`,'POST',{ready:true,expectedRevision:r.revision})).data.status,'playing');
  });
});
test('desktop guests use Secure host-only cookies; new origins cannot recover another seat by nickname',async()=>{
  await fixture(async f=>{
    const a=f.client(),b=f.client();const first=await a.enter('alice');await b.enter('bob');
    assert.match(first.headers.get('set-cookie'),/^__Host-twelve-session=/);assert.match(first.headers.get('set-cookie'),/; Secure$/);assert.doesNotMatch(first.headers.get('set-cookie'),/Domain=/);
    assert.equal((await a.call('/api/me','GET',undefined,{'x-forwarded-proto':'http'})).status,403);
    const {game,actor}=await startMatch(a,b),cookie=actor.cookie;
    f.config.origin='https://forest-stream-river.trycloudflare.com';assert.equal((await actor.call('/api/me')).data.guest,null);
    actor.csrf='';const fresh=await actor.enter('alice');assert.notEqual(fresh.data.guest.id,first.data.guest.id);assert.notEqual(actor.cookie,cookie);
    assert.equal((await actor.call(`/api/games/${game.id}/actions`,'POST',{requestId:'new_origin_move',expectedRevision:0,action:legalActions(game.state)[0]})).status,403);
    assert.equal((await a.call(`/api/games/${game.id}/record`)).data.id,game.id);
  },true);
});
test('allowlisted main/archive assets work, removed login assets stay absent, data and WS boundaries remain protected',async()=>{
  await fixture(async f=>{
    const c=f.client();for(const removed of ['/local','/src/ai-worker.js'])assert.equal((await c.call(removed)).status,404);for(const route of ['/','/src/online.js','/src/online.css','/experiments','/health/live','/health/ready'])assert.equal((await c.call(route)).status,200,route);
    for(const route of ['/arena.html','/arena'])assert.match((await c.call(route)).data,/src\/app.js/);
    for(const route of ['/src/arena.js','/src/arena.css','/data/laptop-dev.sqlite','/data/laptop-dev.sqlite-wal','/data/laptop-dev.sqlite-shm','/backups/backup.sqlite','/.env','/.env.desktop.example','/models/registry.json','/server/guests.mjs','/artifacts/private/games.jsonl','/package.json'])assert.equal((await c.call(route)).status,404,route);
    assert.equal((await c.call('/%zz')).status,400);assert.equal((await c.call('/api/me','PUT')).status,405);
    assert.equal((await c.call('/api/experiments')).status,200);await c.enter();
    assert.equal((await c.call('/api/rooms','POST',JSON.stringify({x:'x'.repeat(9000)}))).status,413);
    assert.equal((await c.call('/api/rooms','POST',{}, {'Content-Type':'text/plain'})).status,415);
    const host=new URL(f.config.origin).host;
    assert.match(await rawUpgrade(f.port,{Host:host,Origin:'https://evil.org',Cookie:c.cookie}),/^HTTP\/1.1 403/);
    assert.match(await rawUpgrade(f.port,{Host:host,Origin:f.config.origin}),/^HTTP\/1.1 401/);
    assert.match(await rawUpgrade(f.port,{Host:host,Origin:f.config.origin,Cookie:c.cookie}),/^HTTP\/1.1 101/);
  });
});
test('bounded HTTP storage contention returns 503 and the same action then commits',async()=>{
  await fixture(async f=>{
    const a=f.client(),b=f.client();await a.enter();await b.enter();const {game,actor}=await startMatch(a,b);
    const req={requestId:'busy_retry_request',expectedRevision:0,action:legalActions(game.state)[0]},other=openDatabase(f.config.dbPath);
    try{other.exec('BEGIN IMMEDIATE');const r=await actor.call(`/api/games/${game.id}/actions`,'POST',req);assert.equal(r.status,503);assert.equal(r.headers.get('retry-after'),'1');}
    finally{other.exec('ROLLBACK');other.close();}
    assert.equal((await actor.call(`/api/games/${game.id}/actions`,'POST',req)).data.revision,1);
  });
});
