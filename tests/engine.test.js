import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULESET, initialState, createPosition, validatePosition, isSquareAttacked, isInCheck, movesFor, legalActions, isLegalAction, applyAction, adjudicateState, chooseAI, positionKey } from '../src/engine.js';

function fixture(pieces,turn=0,hands=[[],[]]) {
  const board=Array(12).fill(null);
  for(const [i,side,kind] of pieces)board[i]={side,kind};
  return createPosition({board,turn,hands});
}
const safeKings=[[0,0,'king'],[11,1,'king']];
const matingPosition=()=>fixture([[0,0,'king'],[5,0,'bishop'],[6,0,'rook'],[10,0,'bishop'],[3,1,'king']]);

test('original opening has eight pieces, valid kings, and legal pawn captures for both starters',()=>{
  for(const turn of [0,1]){const s=initialState(turn);assert.equal(s.ruleset,RULESET);assert.equal(s.board.filter(Boolean).length,8);assert.equal(s.winner,null);assert.equal(isInCheck(s,0),false);assert.equal(isInCheck(s,1),false);assert.deepEqual(movesFor(s,turn===0?5:6),[turn===0?6:5]);}
});
test('geometry respects borders, occupancy, turn, and one-step movement',()=>{
  const s=initialState();assert.deepEqual(movesFor(s,0),[]);assert.deepEqual(movesFor(s,8),[9]);assert.equal(movesFor(s,4).includes(5),false);assert.deepEqual(movesFor(s,7),[]);
  for(const action of [{from:0,to:11},{from:8,to:20},{from:8,to:8},{from:8,to:9.5},{from:8.5,to:9},{from:3,to:2}])assert.throws(()=>applyAction(s,action));
});
test('attack detection is independent of turn and includes kings, pawns, promoted pawns, diagonals',()=>{
  for(const [kind,side,hits,misses] of [
    ['king',0,[0,1,2,4,6,8,9,10],[3,7,11]],['rook',0,[1,4,6,9],[0,2,8,10]],
    ['bishop',0,[0,2,8,10],[1,4,6,9]],['pawn',0,[6],[4,1,9]],['pawn',1,[4],[6,1,9]],
    ['hen',0,[1,2,4,6,9,10],[0,8]],['hen',1,[0,1,4,6,8,9],[2,10]]
  ]){const board=Array(12).fill(null);board[5]={side,kind};for(const i of hits)assert.equal(isSquareAttacked({board,turn:1-side},i,side),true,kind+' attacks '+i);for(const i of misses)assert.equal(isSquareAttacked({board,turn:side},i,side),false,kind+' does not attack '+i);}
});
test('king cannot enter an attacked square, even if the opponent might overlook it',()=>{
  const s=fixture([[4,0,'king'],[6,1,'rook'],[11,1,'king']]);const before=JSON.stringify(s);
  assert.equal(movesFor(s,4).includes(5),false);assert.equal(isLegalAction(s,{from:4,to:5}),false);assert.throws(()=>applyAction(s,{from:4,to:5}),/불법 착수/);assert.equal(JSON.stringify(s),before);
});
test('king cannot capture a defended attacker; removing the captured piece is part of safety evaluation',()=>{
  const defended=fixture([[4,0,'king'],[5,1,'rook'],[2,1,'bishop'],[11,1,'king']]);
  assert.equal(isInCheck(defended),true);assert.equal(isLegalAction(defended,{from:4,to:5}),false);
  const unguarded=fixture([[4,0,'king'],[5,1,'rook'],[11,1,'king']]);
  assert.equal(isLegalAction(unguarded,{from:4,to:5}),true);const next=applyAction(unguarded,{from:4,to:5});assert.equal(isInCheck(next,0),false);assert.deepEqual(next.hands[0],['rook']);
});
test('opposing kings cannot become adjacent',()=>{
  const s=fixture([[4,0,'king'],[6,1,'king']]);assert.equal(isLegalAction(s,{from:4,to:5}),false);assert.throws(()=>applyAction(s,{from:4,to:5}));
});
test('check must be answered; unrelated moves and every prisoner drop are rejected',()=>{
  const s=fixture([[4,0,'king'],[0,0,'bishop'],[8,0,'pawn'],[5,1,'rook'],[11,1,'king']],0,[['pawn'],[]]);
  assert.equal(isInCheck(s),true);assert.equal(isLegalAction(s,{from:8,to:9}),false);assert.equal(isLegalAction(s,{drop:'pawn',to:2}),false);assert.equal(legalActions(s).some(a=>a.drop),false);
  assert.throws(()=>applyAction(s,{from:8,to:9}));assert.throws(()=>applyAction(s,{drop:'pawn',to:2}));
  const next=applyAction(s,{from:0,to:5});assert.equal(isInCheck(next,0),false);assert.equal(next.turn,1);
});
test('prisoners use only empty cells, consume a turn, and cannot include kings or combine move/drop',()=>{
  const s=fixture(safeKings,0,[['rook'],[]]);const next=applyAction(s,{drop:'rook',to:1});assert.equal(next.board[1].kind,'rook');assert.equal(next.turn,1);assert.equal(next.hands[0].length,0);assert.equal(s.hands[0].length,1);
  for(const action of [{drop:'rook',to:0},{drop:'bishop',to:1},{drop:'king',to:1},{drop:'rook',from:0,to:1},{drop:undefined,from:0,to:1}])assert.equal(isLegalAction(s,action),false);
});
test('promotion, captured-hen demotion, and non-promotion of legal pawn drops',()=>{
  const s=fixture([[4,0,'king'],[11,1,'king'],[2,0,'pawn'],[7,1,'rook']]);const a=applyAction(s,{from:2,to:3});assert.equal(a.board[3].kind,'hen');assert.equal(a.log[0].promoted,true);
  const b=applyAction(a,{from:7,to:3});assert.deepEqual(b.hands[1],['pawn']);
  const dropped=applyAction(fixture(safeKings,0,[['pawn'],[]]),{drop:'pawn',to:1});assert.equal(dropped.board[1].kind,'pawn');assert.equal(dropped.winner,null);
});
test('every prisoner kind is barred from the opposing end row for both players',()=>{
  for(const turn of [0,1])for(const drop of ['rook','bishop','pawn']){
    const hands=[[],[]];hands[turn]=[drop];const s=fixture(safeKings,turn,hands),before=JSON.stringify(s);
    const drops=legalActions(s).filter(a=>a.drop===drop).map(a=>a.to);
    const expected=s.board.flatMap((p,i)=>!p&&i%4!==(turn===0?3:0)?[i]:[]);
    assert.deepEqual(drops,expected);
    for(let to=0;to<12;to++){
      if(s.board[to])continue;
      const action={drop,to};
      if(to%4===(turn===0?3:0)){
        assert.equal(isLegalAction(s,action),false);assert.throws(()=>applyAction(s,action),/상대 진영/);
      }else{assert.equal(isLegalAction(s,action),true);assert.equal(applyAction(s,action).board[to].kind,drop);}
    }
    assert.equal(JSON.stringify(s),before);
  }
});
test('malformed and inherited action fields cannot bypass move validation',()=>{
  const s=initialState(),before=JSON.stringify(s);
  const inheritedDrop=Object.assign(Object.create({drop:'rook'}),{from:5,to:6});
  const inheritedFrom=Object.assign(Object.create({from:5}),{to:6});
  const inheritedTo=Object.assign(Object.create({to:6}),{from:5});
  for(const action of [null,[],Object.assign([],{from:5,to:6}),inheritedDrop,inheritedFrom,inheritedTo,{from:5,to:6,extra:true},{drop:'pawn',from:5,to:6}]){
    assert.equal(isLegalAction(s,action),false);assert.throws(()=>applyAction(s,action));
  }
  assert.equal(JSON.stringify(s),before);
});
test('safe king entry ends immediately for either side; attacked entry is illegal',()=>{
  for(const [pieces,turn,from,to] of [
    [[[2,0,'king'],[11,1,'king']],0,2,3],[[[0,0,'king'],[9,1,'king']],1,9,8]
  ]){const next=applyAction(fixture(pieces,turn),{from,to});assert.equal(next.winner,turn);assert.equal(next.termination,'try');assert.equal(next.ply,1);assert.equal(legalActions(next).length,0);assert.throws(()=>applyAction(next,{from:to,to:from}));}
  const unsafe=fixture([[2,0,'king'],[7,1,'rook'],[11,1,'king']]);assert.equal(isLegalAction(unsafe,{from:2,to:3}),false);
});
test('checkmate ends on the mating move without capturing or waiting for the other king',()=>{
  const s=matingPosition();const next=applyAction(s,{from:6,to:7});assert.equal(next.winner,0);assert.equal(next.termination,'checkmate');assert.equal(next.turn,1);assert.equal(next.ply,1);assert.equal(next.board.filter(p=>p?.kind==='king').length,2);assert.equal(isInCheck(next,1),true);assert.equal(chooseAI(next),null);assert.throws(()=>applyAction(next,{from:3,to:2}));
});
test('imported mate and non-check no-action positions are adjudicated immediately; both are losses',()=>{
  const mate=fixture([[0,0,'king'],[4,1,'rook'],[6,1,'king'],[9,1,'bishop']]);assert.equal(mate.winner,1);assert.equal(mate.termination,'checkmate');assert.equal(isInCheck(mate),true);
  const stalled=fixture([[0,0,'king'],[6,1,'king'],[9,1,'bishop']]);assert.equal(isInCheck(stalled),false);assert.equal(stalled.winner,1);assert.equal(stalled.termination,'no-legal-actions');assert.equal(chooseAI(stalled),null);
});
test('threefold repetition includes the initial position and preserves earlier states',()=>{
  let s=fixture(safeKings);const original=structuredClone(s);const cycle=[{from:0,to:1},{from:11,to:10},{from:1,to:0},{from:10,to:11}];
  for(let i=0;i<2;i++)for(const a of cycle)s=applyAction(s,a);assert.equal(s.winner,'draw');assert.equal(s.termination,'repetition');assert.equal(s.positions.filter(k=>k===positionKey(original)).length,3);assert.equal(original.positions.length,1);assert.equal(original.winner,null);
});
test('mate takes precedence over repetition in a raw terminal position',()=>{
  const s=fixture([[0,0,'king'],[4,1,'rook'],[6,1,'king'],[9,1,'bishop']]);s.winner=null;s.termination=null;s.positions=Array(3).fill(positionKey(s));assert.equal(adjudicateState(s).termination,'checkmate');assert.throws(()=>applyAction(s,{from:0,to:1}),/종국 조건/);
});
test('position keys include the ruleset, turn, board, and prisoner counts but ignore hand order',()=>{
  const a=fixture(safeKings,0,[['pawn','rook'],[]]);const b=fixture(safeKings,0,[['rook','pawn'],[]]);assert.equal(positionKey(a),positionKey(b));assert.ok(positionKey(a).startsWith(RULESET+'|'));assert.notEqual(positionKey(a),positionKey({...a,turn:1}));assert.notEqual(positionKey(a),positionKey({...a,hands:[['rook'],[]]}));
});
test('analysis inputs reject missing/duplicate/adjacent kings, impossible material, and old rulesets',()=>{
  const s=initialState();
  const missing=structuredClone(s);missing.board[4]=null;assert.throws(()=>validatePosition(missing),/왕/);
  const duplicate=structuredClone(s);duplicate.board[1]={side:0,kind:'king'};assert.throws(()=>validatePosition(duplicate),/왕/);
  const excess=structuredClone(s);excess.hands[0]=['rook'];assert.throws(()=>validatePosition(excess),/총수/);
  assert.throws(()=>validatePosition({...s,ruleset:'old'}),/버전/);
  assert.throws(()=>fixture([[4,0,'king'],[5,1,'king']]),/불법 국면/);
  assert.throws(()=>fixture([[4,0,'king'],[5,0,'rook'],[6,1,'king']]),/불법 국면/);
  assert.throws(()=>fixture([[3,0,'king'],[8,1,'king']]),/불법 국면/);
});
test('malformed history, status, and sparse hands fail validation instead of failing inside search',()=>{
  const s=initialState();
  for(const changed of [
    {positions:undefined},{positions:[RULESET+'|ok',undefined]},{positions:['twelve-janggi-strict-v1|old']},
    {positions:Array(1)},{ply:-1},{ply:1.5},{log:null},{winner:undefined},{winner:2},
    {hands:Array(2)},{hands:[Array(1),[]]},
  ])assert.throws(()=>validatePosition({...s,...changed}));
  assert.throws(()=>validatePosition(null));assert.throws(()=>createPosition());
});
test('AI obeys the prisoner deployment zone for both colors at every difficulty',()=>{
  for(const turn of [0,1])for(const difficulty of ['easy','normal','hard']){
    const hands=[[],[]];hands[turn]=['rook','pawn'];const s=fixture(safeKings,turn,hands),action=chooseAI(s,difficulty);
    assert.equal(isLegalAction(s,action),true);if(action.drop)assert.notEqual(action.to%4,turn===0?3:0);
    assert.deepEqual(chooseAI(s,difficulty),action);
  }
});
test('all AI difficulties are deterministic and select a legal immediate win',()=>{
  const s=matingPosition();
  for(const difficulty of ['easy','normal','hard']){const a=chooseAI(s,difficulty);assert.equal(isLegalAction(s,a),true);assert.equal(applyAction(s,a).winner,0);assert.deepEqual(chooseAI(s,difficulty),a);}
});
test('generated moves preserve both kings, conserve material, and leave the mover safe over complete games',()=>{
  for(let run=0;run<12;run++){
    let s=initialState(run%2);
    for(let ply=0;ply<90&&s.winner===null;ply++){
      const actions=legalActions(s);assert.ok(actions.length>0);const action=actions[(run*17+ply*7)%actions.length];const before=JSON.stringify(s);const mover=s.turn;
      assert.equal(isLegalAction(s,action),true);const next=applyAction(s,action);assert.equal(isInCheck(next,mover),false);assert.equal(next.board.filter(p=>p?.kind==='king').length,2);assert.equal(next.board.filter(Boolean).length+next.hands.flat().length,8);assert.equal(JSON.stringify(s),before);assert.equal(validatePosition(next),true);s=next;
    }
  }
});
test('seeded full-game audit checks action consistency, rotated symmetry, and deployment zones',()=>{
  let seed=0x1234abcd,visited=0,dropped=0;
  const random=n=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return (seed>>>0)%n;};
  const sorted=actions=>actions.map(a=>JSON.stringify(a)).sort();
  for(let run=0;run<160;run++){
    let s=initialState(run%2);
    for(let ply=0;ply<160&&s.winner===null;ply++){
      visited++;const actions=legalActions(s),candidates=[];
      for(let from=0;from<12;from++)for(let to=0;to<12;to++)if(isLegalAction(s,{from,to}))candidates.push({from,to});
      for(const drop of ['rook','bishop','pawn'])for(let to=0;to<12;to++)if(isLegalAction(s,{drop,to}))candidates.push({drop,to});
      assert.deepEqual(sorted(actions),sorted(candidates));
      const mirrored=createPosition({board:[...s.board].reverse().map(p=>p?{side:1-p.side,kind:p.kind}:null),hands:[s.hands[1],s.hands[0]],turn:1-s.turn});
      assert.deepEqual(sorted(legalActions(mirrored)),sorted(actions.map(a=>a.drop?{drop:a.drop,to:11-a.to}:{from:11-a.from,to:11-a.to})));
      const action=actions[random(actions.length)],mover=s.turn;
      if(action.drop){dropped++;assert.notEqual(action.to%4,mover===0?3:0);}
      s=applyAction(s,action);assert.equal(isInCheck(s,mover),false);assert.equal(s.board.filter(Boolean).length+s.hands.flat().length,8);assert.equal(s.board.filter(p=>p?.kind==='king').length,2);
    }
  }
  assert.ok(visited>1000);assert.ok(dropped>50);
});
