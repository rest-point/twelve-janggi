import { FastPosition, actionCode } from './pvs-aspiration-rules-v1.mjs';
import { evaluatePosition } from './pvs-aspiration-v1.mjs';

export const FEATURES = ['terminalDraw', 'replyCount', 'winningReplyShare', 'captureWeightedWins',
  'evaluationWeightedWins', 'meanWinDistance', 'capture', 'drop', 'promotion', 'check', 'positionScore',
  'opponentKingAdvance', 'repetitionCount'];

export function certifiedWin(position, table, raw = table.probe(position)) {
  if (Math.abs(raw) < 256) return false;
  const distance = Math.abs(raw) - 256;
  for (const [key, count] of position.counts) {
    if (count < 2) continue;
    const earlier = Math.abs(table.probeKey(key));
    if (earlier >= 256 && earlier - 256 < distance) return false;
  }
  return true;
}

// The learned scorer can only compare moves that preserve an actual draw or
// the closed-graph nonloss value. Every other decision goes to the baseline.
export function drawOptions(state, legalActions, table, deadline = Infinity) {
  const position = new FastPosition(state);
  if (table.probe(position) !== 1) return [];
  const choices = [];
  function withMove(move, evaluate) {
    const undo = position.make(move);
    try { return evaluate(); } finally { position.unmake(undo); }
  }
  for (const action of legalActions) {
    if (performance.now() >= deadline) return [];
    const capture = Number(Boolean(position.board[action.to]));
    const promotion = Number(!action.drop && (position.board[action.from] & 7) === 4 && action.to % 4 === (state.turn ? 0 : 3));
    const choice = withMove(actionCode(action), () => {
      const replies = position.actions(), winner = position.winner(replies);
      if (winner !== 'draw' && (winner !== null || table.probe(position) !== 1)) return null;
      const checking = Number(position.inCheck());
      const score = -evaluatePosition(position) / 500;
      const advance = (state.turn ? position.kings[position.turn] % 4 : 3 - position.kings[position.turn] % 4) / 3;
      const repeats = (position.counts.get(position.key()) ?? 1) / 3;
      if (winner === 'draw') return { action, features: [1, 0, 0, 0, 0, 0, capture, Number(Boolean(action.drop)),
        promotion, checking, score, advance, repeats] };
      let wins = 0, distance = 0, captures = 0, winningCaptures = 0, weighted = 0, winningWeighted = 0;
      for (const reply of replies) {
        if (performance.now() >= deadline) return false;
        const weight = position.board[reply % 12] ? 3 : 1;
        captures += weight;
        withMove(reply, () => {
          const terminal = position.winner();
          const raw = terminal === null ? table.probe(position) : 0;
          const won = terminal === state.turn || raw >= 256 && certifiedWin(position, table, raw);
          const preference = Math.exp(Math.max(-4, Math.min(4, -evaluatePosition(position) / 350)));
          weighted += preference;
          if (won) {
            wins++;
            distance += raw ? raw - 256 : 0;
            winningCaptures += weight;
            winningWeighted += preference;
          }
        });
      }
      return { action, features: [0, Math.log1p(replies.length), wins / replies.length, winningCaptures / captures,
        winningWeighted / weighted, wins ? Math.log1p(distance / wins) : 0, capture, Number(Boolean(action.drop)),
        promotion, checking, score, advance, repeats] };
    });
    if (choice === false) return [];
    if (choice) choices.push(choice);
  }
  return choices;
}

export function createPracticalRanker(checkpoint, table, baseline) {
  const { features, mean, scale, hidden, bias, output } = checkpoint;
  const vector = (values, n) => Array.isArray(values) && values.length === n && values.every(Number.isFinite);
  if (checkpoint.format !== 'strict-v2-draw-ranker-v1' || JSON.stringify(features) !== JSON.stringify(FEATURES)
    || !vector(mean, FEATURES.length) || !vector(scale, FEATURES.length) || scale.some(v => v <= 0)
    || !Array.isArray(hidden) || hidden.length < 1 || hidden.length > 128 || hidden.some(row => !vector(row, FEATURES.length))
    || !vector(bias, hidden.length) || !vector(output, hidden.length)) throw new Error('Invalid draw ranking checkpoint');
  return request => {
    const started = performance.now();
    const budget = Number.isFinite(request.budgetMs) ? request.budgetMs : 60000;
    const maxTime = request.config?.maxTimeMs ?? 360;
    const deadline = started + Math.max(0, Math.min(32, budget - 10, maxTime));
    const candidates = drawOptions(request.state, request.legalActions, table, deadline);
    if (!candidates.length) {
      const elapsed = performance.now() - started;
      return baseline({ ...request, budgetMs: Math.max(0, budget - elapsed),
        config: { ...request.config, maxTimeMs: Math.max(0, maxTime - elapsed) } });
    }
    let best = candidates[0], bestScore = -Infinity;
    for (const candidate of candidates) {
      const x = candidate.features.map((value, i) => (value - mean[i]) / scale[i]);
      const score = hidden.reduce((total, row, i) => total + output[i] * Math.max(0,
        row.reduce((sum, weight, j) => sum + weight * x[j], bias[i])), 0);
      if (score > bestScore) { best = candidate; bestScore = score; }
    }
    return { action: best.action, info: { searchMs: performance.now() - started } };
  };
}
