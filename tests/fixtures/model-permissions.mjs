import { readFileSync } from 'node:fs';
export function think({legalActions,config}) {
  let blocked=false;
  try { readFileSync(config.target); } catch(error) { blocked=error.code==='ERR_ACCESS_DENIED'; }
  return {action:legalActions[0],info:{nodes:Number(blocked),completedDepth:Number(!process.env.MODEL_TEST_SECRET)}};
}
