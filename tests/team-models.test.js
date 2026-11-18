import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, createPosition, legalActions, isLegalAction, applyAction, positionKey } from '../src/engine.js';
import { loadRegistry } from '../bench/common.mjs';
import { ModelProcess } from '../server/model-process.mjs';
import * as mcts from '../models/team-mcts-v1.mjs';

function fixture(pieces, turn=0, hands=[[],[]]) {
  const board=Array(12).fill(null);
  for (const [square,side,kind] of pieces) board[square]={side,kind};
  return createPosition({board,turn,hands});
}
function request(state,config={}) { return {state,legalActions:legalActions(state),budgetMs:1000,seed:42,config}; }

test('Team MCTS preserves baseline versions and declares its shared helper',async()=>{
  const registry=await loadRegistry();
  for(const id of ['random-v1','greedy-v1','minimax-v1']) assert.ok(registry.some(m=>m.id===id));
  const model=registry.find(m=>m.id==='team-mcts-v1');
  assert.ok(model);
  assert.ok(model.files.includes('./team-search-common.mjs'));
  assert.equal(model.ruleset,'twelve-janggi-strict-v2');
});

test('Team MCTS chooses legal moves for either starter and never mutates referee input',()=>{
  for(const turn of [0,1]) {
    const state=initialState(turn),r=request(state,{maxSimulations:16,thinkMs:500}),before=structuredClone(r);
    const output=mcts.think(r);
    assert.ok(isLegalAction(state,output.action));
    assert.deepEqual(r,before);
    for(const key of ['nodes','completedDepth','searchMs']) assert.ok(Number.isFinite(output.info[key])&&output.info[key]>=0);
  }
});

test('Team MCTS prefers immediate strict-rule try or mate, without capturing a king',()=>{
  const cases=[
    fixture([[2,0,'king'],[11,1,'king']]),
    fixture([[0,0,'king'],[9,1,'king']],1),
    fixture([[0,0,'king'],[5,0,'bishop'],[6,0,'rook'],[10,0,'bishop'],[3,1,'king']])
  ];
  for(const state of cases) {
    const {action}=mcts.think(request(state,{maxSimulations:32,thinkMs:500}));
    const next=applyAction(state,action,false);
    assert.equal(next.winner,state.turn);
    assert.equal(next.board.filter(p=>p?.kind==='king').length,2);
  }
});

test('Team MCTS uses the referee rules for check evasions and prisoner deployment',()=>{
  const cases=[fixture([[4,0,'king'],[0,0,'bishop'],[8,0,'pawn'],[5,1,'rook'],[11,1,'king']],0,[['pawn'],[]]),
    fixture([[0,0,'king'],[11,1,'king']],0,[['rook','pawn'],[]]),
    fixture([[0,0,'king'],[11,1,'king']],1,[[],['bishop','pawn']])];
  for(const state of cases) {
    const {action}=mcts.think(request(state,{maxSimulations:16,thinkMs:500}));
    assert.ok(isLegalAction(state,action));
    if(action.drop) assert.notEqual(action.to%4,state.turn===0?3:0);
  }
});

test('MCTS uses adversarial UCT and preserves seeded completed-rollout counts',()=>{
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

test('a terminal repetition successor is sampled as a draw and original history survives',()=>{
  const state=initialState();
  state.positions.push(...legalActions(state).flatMap(a=>{const key=positionKey(applyAction(state,a,false));return [key,key];}));
  const before=structuredClone(state);
  const r=mcts.analyze(request(state,{maxSimulations:16,thinkMs:10000}));
  assert.ok(r.completed>0);
  assert.ok(r.candidates.every(c=>c.draws===c.visits));
  assert.deepEqual(state,before);
});

test('tiny budgets return a legal fallback and finished games are rejected',()=>{
  const end=fixture([[2,0,'king'],[11,1,'king']]);
  const finished=applyAction(end,{from:2,to:3},false);
  const state=initialState();
  const r=request(state);r.budgetMs=1;
  assert.ok(isLegalAction(state,mcts.think(r).action));
  assert.throws(()=>mcts.think(request(finished)));
});

test('MCTS counts only started simulations as completed or discarded',()=>{
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

test('Team MCTS loads and answers through the permission-restricted web ModelProcess',async()=>{
  const model=(await loadRegistry()).find(m=>m.id==='team-mcts-v1');
  const process=new ModelProcess(model);
  try {
    assert.equal((await process.ready()).error,undefined,model.id+' startup');
    const state=initialState(),r={protocol:'js-v1',requestId:model.id,ruleset:state.ruleset,
      ...request(state,model.config),budgetMs:1000};
    const reply=await process.think(r,2000);
    assert.equal(reply.error,undefined,model.id+' think');
    assert.ok(isLegalAction(state,reply.action));
  } finally {process.close();}
});
