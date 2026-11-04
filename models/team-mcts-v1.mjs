import { applyAction,legalActions } from '../src/engine.js';
import { prepare,ordered,option,seeded,TIME_UP } from './team-search-common.mjs';

const mean=node=>node.visits?(node.wins+0.5*node.draws)/node.visits:0.5;
const node=(state,actions,action=null)=>({state,untried:[...actions],action,children:[],visits:0,wins:0,draws:0,losses:0});

export function selectChild(parent,perspective) {
  let best,value=-Infinity;
  for(const child of parent.children) {
    const q=mean(child);
    const uct=child.visits===0?Infinity:(parent.state.turn===perspective?q:1-q)
      +Math.sqrt(2*Math.log(Math.max(1,parent.visits))/child.visits);
    if(best===undefined||uct>value){best=child;value=uct;}
  }
  return best;
}

export function analyze(request) {
  const ctx=prepare(request),random=seeded(request.seed);
  const limit=option(request.config,'maxSimulations',1000,1,100000),rolloutPlies=option(request.config,'rolloutPlies',256,1,512);
  if(!Number.isInteger(limit)||!Number.isInteger(rolloutPlies))throw new Error('MCTS limits must be integers');
  const root=node(ctx.state,ctx.actions),fallback=ordered(ctx.state,ctx.actions)[0];
  let nodes=0,attempts=0,completed=0,discarded=0,maxDepth=0;
  // Check all immediate terminal wins before using noisy rollout estimates.
  let immediate;
  try {
    for(const action of ctx.actions) {
      ctx.check();const next=applyAction(ctx.state,action,false);nodes++;
      if(next.winner===ctx.side){immediate=action;break;}
    }
  }catch(error){if(error!==TIME_UP)throw error;}
  if(immediate)return {action:immediate,info:ctx.info(nodes,1),attempts:0,completed:0,discarded:0,candidates:[]};
  try {
    while(attempts<limit) {
      ctx.check();attempts++;
      let current=root,path=[root];
      while(current.state.winner===null) {
        ctx.check();
        if(current.untried.length) {
          const index=Math.floor(random()*current.untried.length),action=current.untried.splice(index,1)[0];
          const next=applyAction(current.state,action,false);nodes++;
          const child=node(next,next.winner===null?legalActions(next):[],action);
          current.children.push(child);current=child;path.push(current);break;
        }
        current=selectChild(current,ctx.side);path.push(current);
      }
      maxDepth=Math.max(maxDepth,path.length-1);
      let state=current.state,steps=0;
      while(state.winner===null&&steps<rolloutPlies) {
        ctx.check();
        const actions=legalActions(state);
        state=applyAction(state,actions[Math.floor(random()*actions.length)],false);
        nodes++;steps++;
      }
      // A rollout horizon is a compute safeguard, not a referee draw rule.
      if(state.winner===null){discarded++;continue;}
      completed++;
      for(const ancestor of path) {
        ancestor.visits++;
        if(state.winner==='draw')ancestor.draws++;else if(state.winner===ctx.side)ancestor.wins++;else ancestor.losses++;
      }
    }
  }catch(error){if(error!==TIME_UP)throw error;if(attempts>completed+discarded)discarded++;}
  const candidates=root.children.filter(c=>c.visits).map(c=>({action:c.action,visits:c.visits,wins:c.wins,draws:c.draws,losses:c.losses,score:mean(c)}));
  candidates.sort((a,b)=>b.visits-a.visits||b.score-a.score);
  return {action:candidates[0]?.action||fallback,info:ctx.info(nodes,maxDepth),attempts,completed,discarded,candidates};
}

export function think(request){const {action,info}=analyze(request);return {action,info};}
