import { FastPosition, actionCode, decodeAction } from './pvs-aspiration-rules-v1.mjs';
import { searchBatch } from './packed-puct-search-v2.mjs';
import { probeTablebase } from './strict-tablebase-v1.mjs';

export { MAGIC, KEY_SIZE, RECORD_SIZE, NO_MOVE, loadTablebase, probeTablebase } from './strict-tablebase-v1.mjs';

export function searchWithTablebase(request, evaluate, table) {
  if (!table || request.state.winner !== null || !request.legalActions?.length) return searchBatch(request, evaluate);
  const started = performance.now(), position = new FastPosition(request.state);
  const actions = request.legalActions.map(actionCode);
  const budget = request.budgetMs ?? 60000;
  if (budget <= 10 || position.winner(actions) !== null) return searchBatch(request, evaluate);
  let nodes = 1;
  function win(move, distance) {
    return { action: decodeAction(move), root: { actions, visits: [], values: [], chosen: move, proven: 1 },
      info: { nodes, searchMs: performance.now() - started }, tablebase: { distance, direct: true } };
  }
  const root = probeTablebase(table, position);
  if (root?.value === 1 && actions.includes(root.move)) return win(root.move, root.distance);
  const safe = [];
  let refuted = 0;
  for (let i = 0; i < actions.length; i++) {
    const move = actions[i], undo = position.make(move);
    let child;
    try {
      nodes++;
      child = probeTablebase(table, position);
      if (child) {
        const winner = position.winner();
        if (winner === request.state.turn) return win(move, 1);
        if (winner !== null) child = null;
      }
    } finally { position.unmake(undo); }
    if (child?.value === -1) return win(move, child.distance + 1);
    if (child?.value === 1) refuted++;
    else safe.push(request.legalActions[i]);
  }
  const elapsed = performance.now() - started;
  const maxTimeMs = Math.max(0, (request.config?.maxTimeMs ?? 1000) - Math.ceil(elapsed));
  const result = searchBatch({ ...request, budgetMs: Math.max(0, budget - elapsed),
    config: { ...request.config, maxTimeMs }, legalActions: refuted && safe.length ? safe : request.legalActions }, evaluate);
  result.info = { ...result.info, nodes: result.info.nodes + nodes, searchMs: performance.now() - started };
  if (refuted && safe.length) result.tablebase = { filtered: refuted };
  return result;
}
