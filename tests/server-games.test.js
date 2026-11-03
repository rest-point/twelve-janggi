import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, databaseHealth } from '../server/database.mjs';
import { createGames } from '../server/games.mjs';
import { applyAction, legalActions, createPosition } from '../src/engine.js';

async function fixture(work) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'twelve-db-')), filename = path.join(root, 'test.sqlite');
  let db = openDatabase(filename), at = 100000;
  const clock = () => at;
  const add = id => db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id, id, id, 'unused-test-hash', 'user', at);
  for (const id of ['alice','bob','viewer']) add(id);
  const context = { root, filename, get db() { return db; }, service:() => createGames(db, { now:clock }), setTime:v => at = v, reopen() { db.close(); db = openDatabase(filename); return this.service(); } };
  try { await work(context); } finally { db.close(); assert.equal(path.dirname(root), os.tmpdir()); await rm(root, { recursive:true, force:true }); }
}
function input(game, suffix = 'one') { return { expectedRevision:game.revision, requestId:`request_${suffix}`, action:legalActions(game.state)[0] }; }

test('SQLite uses real WAL/FK/busy timeout; migrations are durable, checked and transactional', async () => {
  await fixture(async f => {
    assert.deepEqual(databaseHealth(f.db), { ready:true, journal:'wal', foreignKeys:1, busyTimeout:250, schema:['001-foundation.sql','002-guest-rooms.sql','003-model-matches.sql','004-room-lifecycle-batches.sql','005-model-management.sql','006-initial-model-games.sql','007-profile-indexes.sql'] });
    assert.throws(() => f.db.prepare('INSERT INTO sessions(token_hash,user_id,origin,expires_at) VALUES(?,?,?,?)').run('hash','missing','origin',1));
    f.reopen(); assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 3);
    const migrations = path.join(f.root,'migrations'); await mkdir(migrations);
    await copyFile('db/migrations/001-foundation.sql', path.join(migrations,'001-foundation.sql'));
    await copyFile('db/migrations/002-guest-rooms.sql', path.join(migrations,'002-guest-rooms.sql'));
    await copyFile('db/migrations/003-model-matches.sql',path.join(migrations,'003-model-matches.sql'));
    await copyFile('db/migrations/004-room-lifecycle-batches.sql',path.join(migrations,'004-room-lifecycle-batches.sql'));
    await copyFile('db/migrations/005-model-management.sql',path.join(migrations,'005-model-management.sql'));
    await copyFile('db/migrations/006-initial-model-games.sql',path.join(migrations,'006-initial-model-games.sql'));
    await copyFile('db/migrations/007-profile-indexes.sql',path.join(migrations,'007-profile-indexes.sql'));
    await writeFile(path.join(migrations,'008-broken.sql'), 'CREATE TABLE should_rollback(id TEXT); INVALID SQL;');
    assert.throws(() => openDatabase(f.filename, { migrations }));
    assert.equal(f.db.prepare("SELECT name FROM sqlite_master WHERE name='should_rollback'").get(), undefined);
    await writeFile(path.join(migrations,'001-foundation.sql'), '-- edited history');
    assert.throws(() => openDatabase(f.filename, { migrations }), /checksum/);
  });
});
test('referee enforces identity, turn, legal action, revision and payload-bound idempotency; exact replay retains positions', async () => {
  await fixture(f => {
    const games = f.service(), g = games.create('alice','bob'), actor = g.participants[g.state.turn].id, req = input(g);
    assert.throws(() => games.act(g.id, 'viewer', 'action', req), /참가자/);
    assert.throws(() => games.act(g.id, g.participants[1-g.state.turn].id, 'action', req), /차례/);
    assert.throws(() => games.act(g.id, actor, 'action', { ...req, action:{ from:0,to:0 } }), /불법/);
    assert.throws(() => games.act(g.id, actor, 'action', { ...req, elapsedMs:0, result:0 }), /필드/);
    f.setTime(g.turnStartedAt + 125);
    const first = games.act(g.id, actor, 'action', req);
    assert.equal(first.status, 200); assert.equal(first.body.revision, 1);
    assert.deepEqual(games.act(g.id, actor, 'action', { ...req, action:{ to:req.action.to, from:req.action.from } }), first);
    assert.throws(() => games.act(g.id, actor, 'action', { ...req, expectedRevision:1 }), /requestId/);
    assert.throws(() => games.act(g.id, actor, 'action', { ...req, requestId:'request_stale' }), /revision/);
    const record = games.record(g.id);
    assert.equal(record.moves.length,1); assert.equal(record.moves[0].elapsedMs,125);
    assert.deepEqual(JSON.parse(JSON.stringify(applyAction(record.initialState, record.moves[0].action))), record.state);
    assert.equal(record.state.positions.length,2);
    const restored = f.reopen().get(g.id); assert.deepEqual(restored.state,record.state); assert.equal(restored.deadlineAt,first.body.deadlineAt);
  });
});
test('deadline boundary rejects late moves and restart recovers terminal state exactly once', async () => {
  await fixture(f => {
    let games = f.service(); const g = games.create('alice','bob'), actor = g.participants[g.state.turn].id;
    f.setTime(g.deadlineAt-1);
    assert.equal(games.act(g.id,actor,'action',input(g)).status,200);
    const next = games.get(g.id), other = next.participants[next.state.turn].id;
    f.setTime(next.deadlineAt);
    assert.equal(games.act(g.id,other,'action',input(next,'late')).status,409);
    assert.equal(games.get(g.id).state.termination,'timeout'); assert.equal(games.get(g.id).revision,2);
    assert.equal(games.recover(),0); assert.equal(games.record(g.id).moves.length,1);
    const second = games.create('alice','bob'); f.setTime(second.deadlineAt+5000);
    games = f.reopen(); assert.equal(games.recover(),1); assert.equal(games.recover(),0);
    const restored = games.get(second.id); assert.equal(restored.state.winner,1-second.state.turn); assert.equal(restored.deadlineAt,null); assert.equal(restored.revision,1);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM game_events WHERE game_id=?').get(second.id).n,1);
  });
});
test('DB write failure rolls back move, state, event and request together; retry commits once', async () => {
  await fixture(f => {
    const games = f.service(), g = games.create('alice','bob'), actor = g.participants[g.state.turn].id, req = input(g);
    f.db.exec("CREATE TRIGGER fail_game BEFORE UPDATE ON games BEGIN SELECT RAISE(ABORT,'injected save failure'); END;");
    assert.throws(() => games.act(g.id,actor,'action',req), /injected/);
    for (const table of ['moves','game_requests','game_events']) assert.equal(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,0);
    assert.equal(games.get(g.id).revision,0);
    f.db.exec('DROP TRIGGER fail_game'); assert.equal(games.act(g.id,actor,'action',req).status,200);
    assert.equal(games.act(g.id,actor,'action',req).body.revision,1);
  });
});
test('busy DB has finite failure and permits a later retry without losing the game', async () => {
  await fixture(f => {
    const games = f.service(), g = games.create('alice','bob'), other = openDatabase(f.filename);
    try { other.exec('BEGIN IMMEDIATE'); assert.throws(() => games.act(g.id,g.participants[g.state.turn].id,'action',input(g)), /locked/); }
    finally { other.exec('ROLLBACK'); other.close(); }
    assert.equal(games.act(g.id,g.participants[g.state.turn].id,'action',input(g)).body.revision,1);
  });
});
test('participant resignation is persistent, idempotent and never erases repetition history', async () => {
  await fixture(f => {
    const games = f.service(), g = games.create('alice','bob'), req = { requestId:'resign_request',expectedRevision:0 };
    const r = games.act(g.id,'alice','resign',req); assert.equal(r.body.state.winner,1);
    assert.deepEqual(r.body.state.positions,g.state.positions); assert.deepEqual(games.act(g.id,'alice','resign',req),r);
    assert.equal(f.reopen().get(g.id).state.termination,'resignation');
  });
});

test('threefold repetition survives server-store restart and all eight saved moves replay to the identical terminal state', async () => {
  await fixture(f => {
    let games = f.service(); const g = games.create('alice','bob');
    const board = Array(12).fill(null); board[0] = { side:0,kind:'king' }; board[11] = { side:1,kind:'king' };
    const state = createPosition({ board,turn:0 });
    // Trusted test fixture only; the API never accepts client-supplied positions.
    f.db.prepare('UPDATE games SET initial_state=?,current_state=? WHERE id=?').run(JSON.stringify(state),JSON.stringify(state),g.id);
    const cycle = [{from:0,to:1},{from:11,to:10},{from:1,to:0},{from:10,to:11}];
    for (let i=0;i<8;i++) {
      const current = games.get(g.id); f.setTime(100000+(i+1)*1000);
      games.act(g.id,current.participants[current.state.turn].id,'action',{requestId:`cycle_request_${i}`,expectedRevision:i,action:cycle[i%4]});
      if (i===3) games = f.reopen();
    }
    const record = f.reopen().record(g.id); let replay = record.initialState;
    for (const move of record.moves) replay = applyAction(replay,move.action);
    assert.deepEqual(JSON.parse(JSON.stringify(replay)),record.state);
    assert.equal(record.state.positions.length,9); assert.equal(record.state.termination,'repetition');
    assert.equal(record.state.winner,'draw'); assert.equal(record.revision,8); assert.equal(record.deadlineAt,null);
  });
});
