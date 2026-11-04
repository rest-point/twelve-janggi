import { applyAction,legalActions,positionKey } from '../src/engine.js';
import { prepare,evaluate,terminalScore,ordered,historyKey,remember,option,WIN,TIME_UP } from './team-search-common.mjs';

export function analyze(request) {
  const ctx=prepare(request),depth=option(request.config,'depth',5,1,12);
  if(!Number.isInteger(depth))throw new Error('depth must be an integer');
  let action=ordered(ctx.state,ctx.actions)[0],score=evaluate(ctx.state,ctx.side),nodes=0,cutoffs=0,completedDepth=0;
  const table=new Map(),evaluations=new Map(),moves=new Map();
  function visit(state,remaining,alpha,beta) {
    ctx.check();nodes++;
    if(state.winner!==null)return terminalScore(state,ctx.side,ctx.state.ply);
    const position=positionKey(state);
    if(remaining===0) {
      if(evaluations.has(position))return evaluations.get(position);
      const value=evaluate(state,ctx.side);remember(evaluations,position,value);return value;
    }
    const key=remaining+'|'+historyKey(state),originalAlpha=alpha,originalBeta=beta;
    const entry=table.get(key);
    if(entry) {
      if(entry.bound==='exact')return entry.score;
      if(entry.bound==='lower')alpha=Math.max(alpha,entry.score);else beta=Math.min(beta,entry.score);
      if(alpha>=beta){cutoffs++;return entry.score;}
    }
    const max=state.turn===ctx.side;
    let value=max?-Infinity:Infinity,best;
    for(const candidate of ordered(state,legalActions(state),moves.get(position))) {
      const score=visit(applyAction(state,candidate,false),remaining-1,alpha,beta);
      if(best===undefined||(max?score>value:score<value)){best=candidate;value=score;}
      if(max)alpha=Math.max(alpha,value);else beta=Math.min(beta,value);
      if(alpha>=beta){cutoffs++;break;}
    }
    remember(table,key,{score:value,bound:value<=originalAlpha?'upper':value>=originalBeta?'lower':'exact'});
    remember(moves,position,best);
    return value;
  }
  for(let horizon=1;horizon<=depth;horizon++) {
    let nextAction=action,nextScore=-Infinity,alpha=-Infinity;
    try {
      ctx.check();nodes++;
      for(const candidate of ordered(ctx.state,ctx.actions,action)) {
        const value=visit(applyAction(ctx.state,candidate,false),horizon-1,alpha,Infinity);
        if(value>nextScore){nextScore=value;nextAction=candidate;}
        alpha=Math.max(alpha,nextScore);
      }
    }catch(error){if(error!==TIME_UP)throw error;break;}
    action=nextAction;score=nextScore;completedDepth=horizon;
    if(Math.abs(score)>WIN-10000)break;
  }
  return {action,info:ctx.info(nodes,completedDepth),score,cutoffs};
}

export function think(request){const {action,info}=analyze(request);return {action,info};}
