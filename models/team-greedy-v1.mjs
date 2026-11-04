import { applyAction } from '../src/engine.js';
import { prepare,evaluate,terminalScore,ordered,TIME_UP } from './team-search-common.mjs';

export function think(request) {
  const ctx=prepare(request),actions=ordered(ctx.state,ctx.actions);
  let action=actions[0],best=-Infinity,nodes=0,completed=true;
  try {
    for(const candidate of actions) {
      ctx.check();
      const next=applyAction(ctx.state,candidate,false);
      nodes++;
      const score=next.winner===null?evaluate(next,ctx.side):terminalScore(next,ctx.side,ctx.state.ply);
      if(score>best){best=score;action=candidate;}
    }
  }catch(error){if(error!==TIME_UP)throw error;completed=false;}
  return {action,info:ctx.info(nodes,completed?1:0)};
}
