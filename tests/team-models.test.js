import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, createPosition, legalActions, isLegalAction, applyAction, positionKey } from '../src/engine.js';
import { loadRegistry } from '../bench/common.mjs';
import { ModelProcess } from '../server/model-process.mjs';

async function models() {
  const registry = await loadRegistry();
  for (const id of ['team-greedy-v1','team-minimax-v1','team-mcts-v1']) {
    assert.ok(registry.some(m => m.id === id), `Missing registered model ${id}`);
  }
  return Promise.all(['greedy','minimax','mcts'].map(name => import(`../models/team-${name}-v1.mjs`)));
}
function fixture(pieces, turn=0, hands=[[],[]]) {
  const board=Array(12).fill(null);
  for (const [square,side,kind] of pieces) board[square]={side,kind};
  return createPosition({board,turn,hands});
}
function request(state,config={}) { return {state,legalActions:legalActions(state),budgetMs:1000,seed:42,config}; }

test('three new model IDs preserve baseline versions and declare shared helpers',async()=>{
  await models();
  const registry=await loadRegistry();
  for(const id of ['random-v1','greedy-v1','minimax-v1']) assert.ok(registry.some(m=>m.id===id));
  for(const id of ['team-greedy-v1','team-minimax-v1','team-mcts-v1']) {
    const m=registry.find(m=>m.id===id);
    assert.ok(m.files.includes('./team-search-common.mjs'));
    assert.equal(m.ruleset,'twelve-janggi-strict-v2');
  }
});

test('new agents choose legal moves for either starter and never mutate referee input',async()=>{
  for(const model of await models()) for(const turn of [0,1]) {
    const state=initialState(turn),r=request(state,{depth:2,maxSimulations:16,thinkMs:500}),before=structuredClone(r);
    const output=model.think(r);
    assert.ok(isLegalAction(state,output.action));
    assert.deepEqual(r,before);
    for(const key of ['nodes','completedDepth','searchMs']) assert.ok(Number.isFinite(output.info[key])&&output.info[key]>=0);
  }
});

test('new agents prefer immediate strict-rule try or mate, without capturing a king',async()=>{
  const cases=[
    fixture([[2,0,'king'],[11,1,'king']]),
    fixture([[0,0,'king'],[9,1,'king']],1),
    fixture([[0,0,'king'],[5,0,'bishop'],[6,0,'rook'],[10,0,'bishop'],[3,1,'king']])
  ];
  for(const model of await models()) for(const state of cases) {
    const {action}=model.think(request(state,{depth:3,maxSimulations:32,thinkMs:500}));
    const next=applyAction(state,action,false);
    assert.equal(next.winner,state.turn);
    assert.equal(next.board.filter(p=>p?.kind==='king').length,2);
  }
});

test('check evasions and prisoner deployment use the referee rules for all agents',async()=>{
  const cases=[fixture([[4,0,'king'],[0,0,'bishop'],[8,0,'pawn'],[5,1,'rook'],[11,1,'king']],0,[['pawn'],[]]),
    fixture([[0,0,'king'],[11,1,'king']],0,[['rook','pawn'],[]]),
    fixture([[0,0,'king'],[11,1,'king']],1,[[],['bishop','pawn']])];
  for(const model of await models()) for(const state of cases) {
    const {action}=model.think(request(state,{depth:2,maxSimulations:16,thinkMs:500}));
    assert.ok(isLegalAction(state,action));
    if(action.drop) assert.notEqual(action.to%4,state.turn===0?3:0);
  }
});

test('alpha-beta score equals independent exhaustive minimax including repetitions',async()=>{
  const [,minimax]=await models();
  const {evaluate,terminalScore}=await import('../models/team-search-common.mjs');
  function oracle(s,d,side,rootPly) {
    if(s.winner!==null)return terminalScore(s,side,rootPly);
    if(d===0)return evaluate(s,side);
    const values=legalActions(s).map(a=>oracle(applyAction(s,a,false),d-1,side,rootPly));
    return (s.turn===side?Math.max:Math.min)(...values);
  }
  const start=initialState(), key=positionKey(start);
  const draws={...start,positions:[key,...legalActions(start).flatMap(a=>{
    const successor=positionKey(applyAction(start,a,false));return [successor,successor];
  })]};
  const positions=[start,initialState(1),{...start,positions:[key,key]},draws];
  for(const state of positions) {
    const plain=oracle(state,3,state.turn,state.ply);
    const chosen=minimax.analyze(request(state,{depth:3,thinkMs:10000}));
    assert.equal(chosen.info.completedDepth,3);
    assert.equal(chosen.score,plain);
    assert.equal(oracle(applyAction(state,chosen.action,false),2,state.turn,state.ply),plain);
  }
});

test('MCTS uses adversarial UCT and preserves seeded completed-rollout counts',async()=>{
  const [,,mcts]=await models();
  const parent={state:{turn:1},visits:40,children:[
    {visits:20,wins:18,draws:0,losses:2}, {visits:20,wins:2,draws:0,losses:18}]};
  assert.equal(mcts.selectChild(parent,0),parent.children[1]);
  assert.equal(mcts.selectChild(parent,1),parent.children[0]);
  const state=initialState(),r=request(state,{maxSimulations:40,thinkMs:10000});r.budgetMs=20000;
  const a=mcts.analyze(r),b=mcts.analyze(r);
  assert.deepEqual(a.candidates,b.candidates);
  assert.deepEqual(a.action,b.action);
  assert.equal(a.attempts,40);
  assert.equal(a.completed,a.candidates.reduce((n,c)=>n+c.visits,0));
  for(const c of a.candidates)assert.equal(c.wins+c.draws+c.losses,c.visits);
});

test('a terminal repetition successor is sampled as a draw and original history survives',async()=>{
  const [,,mcts]=await models();
  const state=initialState();
  state.positions.push(...legalActions(state).flatMap(a=>{const key=positionKey(applyAction(state,a,false));return [key,key];}));
  const before=structuredClone(state);
  const r=mcts.analyze(request(state,{maxSimulations:16,thinkMs:10000}));
  assert.ok(r.completed>0);
  assert.ok(r.candidates.every(c=>c.draws===c.visits));
  assert.deepEqual(state,before);
});

test('tiny budgets return a legal fallback and finished games are rejected',async()=>{
  const end=fixture([[2,0,'king'],[11,1,'king']]);
  const finished=applyAction(end,{from:2,to:3},false);
  for(const model of await models()) {
    const state=initialState();
    const r=request(state);r.budgetMs=1;
    assert.ok(isLegalAction(state,model.think(r).action));
    assert.throws(()=>model.think(request(finished)));
  }
});

test('MCTS counts only started simulations as completed or discarded',async()=>{
  const [,,mcts]=await models();
  const r=request(initialState());r.budgetMs=1;
  const stopped=mcts.analyze(r);
  assert.equal(stopped.attempts,0);
  assert.equal(stopped.completed,0);
  assert.equal(stopped.discarded,0);
  const truncated=mcts.analyze(request(initialState(),{maxSimulations:4,rolloutPlies:1,thinkMs:10000}));
  assert.equal(truncated.attempts,4);
  assert.equal(truncated.completed,0);
  assert.equal(truncated.discarded,4);
  assert.deepEqual(truncated.candidates,[]);
});

test('all new models load and answer through the permission-restricted web ModelProcess',async()=>{
  await models();
  for(const model of (await loadRegistry()).filter(m=>m.id.startsWith('team-'))) {
    const process=new ModelProcess(model);
    try {
      assert.equal((await process.ready()).error,undefined,model.id+' startup');
      const state=initialState(),r={protocol:'js-v1',requestId:model.id,ruleset:state.ruleset,
        ...request(state,model.config),budgetMs:1000};
      const reply=await process.think(r,2000);
      assert.equal(reply.error,undefined,model.id+' think');
      assert.ok(isLegalAction(state,reply.action));
    } finally {process.close();}
  }
});
