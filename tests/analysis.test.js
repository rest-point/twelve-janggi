import test from 'node:test';
import assert from 'node:assert/strict';
import { AnalysisStudy } from '../src/analysis-state.js';
import { initialState, createPosition, legalActions, applyAction, positionKey } from '../src/engine.js';
import { createAnalysis } from '../server/analysis.mjs';

const start = () => {
  const s = initialState(); return { board:s.board, hands:s.hands, turn:s.turn };
};
const model = { id:'test-v1', registryId:'test-v1', config:{depth:3} };

test('analysis study preserves branches, repetition histories, active cursor and legal replay through export/import', () => {
  const study = new AnalysisStudy(), actions = legalActions(study.current.state);
  const a = study.play(actions[0]);
  const b = study.play(legalActions(a.state)[0]);
  study.select(0);
  const c = study.play(actions[1]);
  assert.equal(study.root.children.length, 2);
  study.select(a.id); assert.equal(study.play(b.action), b);
  assert.equal(study.nodes.size, 4);
  const imported = AnalysisStudy.import(study.export());
  assert.deepEqual(imported.export(), study.export());
  assert.deepEqual(imported.current.state.positions, b.state.positions);
  const before = imported.export();
  assert.throws(() => imported.play({from:0,to:11}));
  assert.deepEqual(imported.export(), before);
  assert.equal(study.nodes.get(c.id).parent, study.root);
});

test('import rejects invalid/cyclic trees, impossible boards and illegal moves; supports referee replay JSON', () => {
  const study = new AnalysisStudy(); study.play(legalActions(study.current.state)[0]);
  const saved = study.export();
  for (const nodes of [[{id:1,parent:1,action:saved.nodes[0].action}], [{...saved.nodes[0],action:{from:0,to:11}}], [...saved.nodes,...saved.nodes]]) {
    assert.throws(() => AnalysisStudy.import({...saved,nodes}));
  }
  assert.throws(() => AnalysisStudy.import({...saved,position:{...start(),board:Array(12).fill(null)}}));
  assert.throws(() => AnalysisStudy.import({...saved,current:999}));
  const replay = AnalysisStudy.import({startState:initialState(),moves:[{action:saved.nodes[0].action}]});
  assert.equal(positionKey(replay.current.state), positionKey(study.current.state));
});

test('analysis uses registry config, reconstructs the full history and validates the complete recommended continuation', async () => {
  const input = { modelId:model.id, position:start(), actions:[{from:5,to:6}], linePlies:3 };
  const before = structuredClone(input), requests = [];
  let closed = 0;
  const analysis = createAnalysis({getModel:() => model,clientFactory:() => ({
    ready:async()=>({}), close:()=>closed++, think:async r => { requests.push(structuredClone(r)); return {action:r.legalActions[0],elapsedMs:1,info:{nodes:2,completedDepth:3,searchMs:1,untrusted:99}}; },
  })});
  const response = await analysis.analyze('a',input);
  assert.equal(response.line.length,3); assert.equal(closed,1);
  assert.deepEqual(input,before);
  let state = applyAction(initialState(),input.actions[0],false);
  assert.equal(response.positionKey,positionKey(state));
  for (const [i,entry] of response.line.entries()) {
    assert.deepEqual(requests[i].state.positions,state.positions);
    assert.deepEqual(requests[i].config,model.config);
    assert.ok(requests[i].budgetMs>0&&requests[i].budgetMs<=60000);
    assert.equal(entry.info.untrusted,undefined);
    state=applyAction(state,entry.action,false);
  }
  analysis.close();
});

test('analysis rejects overrides, illegal history, terminal states and invalid model responses; stops at mate/try', async () => {
  const base = {modelId:model.id,position:start(),linePlies:1};
  let response = {action:{from:0,to:11}};
  const analysis = createAnalysis({getModel:()=>model,clientFactory:()=>({ready:async()=>({}),close(){},think:async()=>response})});
  for (const body of [{...base,config:{}},{...base,linePlies:6},{...base,actions:[{from:0,to:11}]},{...base,position:{...start(),winner:0}}]) {
    await assert.rejects(analysis.analyze('a',body),e=>e.status===422);
  }
  await assert.rejects(analysis.analyze('a',base),e=>e.status===502);
  response={error:'model-timeout'};
  await assert.rejects(analysis.analyze('a',base),e=>e.status===504);
  const board=Array(12).fill(null);board[2]={side:0,kind:'king'};board[11]={side:1,kind:'king'};
  const position={board,hands:[[],[]],turn:0};
  response={action:{from:2,to:3},info:{},elapsedMs:1};
  const win=await analysis.analyze('a',{modelId:model.id,position,linePlies:5});
  assert.equal(win.line.length,1);assert.equal(win.winner,0);assert.equal(win.termination,'try');
  analysis.close();
});

test('analysis concurrency is bounded per guest and globally; abort closes work and frees the slot', async () => {
  const pending=[], clients=[];
  const analysis=createAnalysis({getModel:()=>model,maxConcurrent:2,clientFactory:()=>{
    let resolve;const wait=new Promise(r=>resolve=r);
    const client={ready:async()=>({}),think:()=>{pending.push(resolve);return wait;},close(){resolve({error:'infra-error'});}};
    clients.push(client);return client;
  }});
  const body={modelId:model.id,position:start(),linePlies:1},a=new AbortController(),b=new AbortController();
  const first=analysis.analyze('a',body,{signal:a.signal});const firstDone=assert.rejects(first,e=>e.status===499);
  const second=analysis.analyze('b',body,{signal:b.signal});const secondDone=assert.rejects(second,e=>e.status===499);
  await new Promise(r=>setImmediate(r));
  assert.equal(pending.length,2);
  await assert.rejects(analysis.analyze('a',body),e=>e.status===409);
  await assert.rejects(analysis.analyze('c',body),e=>e.status===429);
  a.abort();b.abort();await Promise.all([firstDone,secondDone]);
  const controller=new AbortController();controller.abort();
  await assert.rejects(analysis.analyze('c',body,{signal:controller.signal}),e=>e.status===499);
  analysis.close();assert.equal(clients.length,2);
});

test('analysis identifies a threefold-terminal history before starting a model', async () => {
  const board=Array(12).fill(null);board[0]={side:0,kind:'king'};board[11]={side:1,kind:'king'};
  const position={board,hands:[[],[]],turn:0};createPosition(position);
  const cycle=[{from:0,to:1},{from:11,to:10},{from:1,to:0},{from:10,to:11}];
  const analysis=createAnalysis({getModel:()=>model,clientFactory:()=>{throw new Error('Must not start');}});
  await assert.rejects(analysis.analyze('a',{modelId:model.id,position,actions:[...cycle,...cycle]}),e=>e.status===422&&/반복/.test(e.message));
  analysis.close();
});
