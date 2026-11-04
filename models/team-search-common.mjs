// Shared evaluation and limits for the team's three strict-v2 search agents.
import { adjudicateState, directions, isInCheck, positionKey } from '../src/engine.js';

export const WIN = 1_000_000;
export const TIME_UP = Symbol('team-model-time-up');
export const VALUES = Object.freeze({king:0,rook:500,bishop:350,pawn:100,hen:600});

export function option(config,name,fallback,low,high) {
  const value=config?.[name] ?? fallback;
  if(!Number.isFinite(value)||value<low||value>high)throw new Error(`Invalid ${name}`);
  return value;
}

export function prepare({state,legalActions,budgetMs,config={}}) {
  if(adjudicateState(state).winner!==null||!Array.isArray(legalActions)||!legalActions.length)throw new Error('No live legal actions');
  if(!Number.isFinite(budgetMs)||budgetMs<=0)throw new Error('Invalid budgetMs');
  const started=performance.now();
  const thinkMs=option(config,'thinkMs',500,1,55000);
  // Leave host scheduling/IPC headroom even when the caller gives a tiny budget.
  const usable=Math.max(0,Math.min(thinkMs,budgetMs-Math.max(10,Math.min(250,budgetMs*0.1))));
  const deadline=started+usable;
  return {state,actions:[...legalActions],side:state.turn,started,deadline,
    check(){if(performance.now()>=deadline)throw TIME_UP;},
    info(nodes,completedDepth){return {nodes,completedDepth,searchMs:performance.now()-started};}};
}

export function terminalScore(state,perspective,rootPly) {
  if(state.winner===null)throw new Error('Not a terminal position');
  if(state.winner==='draw')return 0;
  return (state.winner===perspective?1:-1)*(WIN-(state.ply-rootPly));
}

export function evaluate(state,perspective) {
  const scores=[0,0];
  state.board.forEach((piece,from)=>{
    if(!piece)return;
    const advance=piece.side===0?from%4:3-from%4;
    let mobility=0;
    for(const [dx,dy] of directions(piece.kind,piece.side)) {
      const x=from%4+dx,y=Math.floor(from/4)+dy;
      if(x>=0&&x<4&&y>=0&&y<3&&state.board[y*4+x]?.side!==piece.side)mobility++;
    }
    scores[piece.side]+=VALUES[piece.kind]+5*mobility+(piece.kind==='pawn'?15*advance:piece.kind==='king'?12*advance:0);
  });
  for(let side=0;side<2;side++) {
    for(const kind of state.hands[side])scores[side]+=VALUES[kind];
    if(isInCheck(state,side))scores[side]-=2000;
  }
  return scores[perspective]-scores[1-perspective];
}

export function actionKey(action){return action.drop?`${action.drop}@${action.to}`:`${action.from}>${action.to}`;}
export function ordered(state,actions,preferred) {
  const priority=a=>{
    if(preferred&&actionKey(a)===actionKey(preferred))return WIN*2;
    if(a.drop)return 0;
    const piece=state.board[a.from],capture=state.board[a.to];
    return (capture?VALUES[capture.kind]*10:0)
      +(piece.kind==='pawn'&&a.to%4===(piece.side===0?3:0)?VALUES.hen-VALUES.pawn:0)
      +(piece.kind==='king'&&a.to%4===(piece.side===0?3:0)?WIN:0);
  };
  return [...actions].sort((a,b)=>priority(b)-priority(a));
}

export function historyKey(state) {
  const counts=new Map();
  for(const key of state.positions)counts.set(key,(counts.get(key)||0)+1);
  return JSON.stringify([positionKey(state),state.ply,[...counts].sort(([a],[b])=>a.localeCompare(b))]);
}

export function seeded(seed=0) {
  let value=seed>>>0;
  return ()=>{value=(Math.imul(value,1664525)+1013904223)>>>0;return value/4294967296;};
}

export function remember(table,key,value,limit=1000) {
  if(!table.has(key)&&table.size>=limit)table.delete(table.keys().next().value);
  table.set(key,value);
}
