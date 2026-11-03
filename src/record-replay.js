import { initialState, applyAction, positionKey } from './engine.js';

// Streaming replay lets CLI verification retain only the current position;
// the browser collects the same validated steps for its timeline.
export function* replaySteps(game) {
  let state = initialState(game.first);
  yield { state, opening: false, action: null, elapsedMs: null };
  for (const action of game.opening) {
    state = applyAction(state, action, false);
    yield { state, opening: true, action, elapsedMs: null };
  }
  if (JSON.stringify(state) !== JSON.stringify(game.startState)) throw new Error('시작 국면 또는 규칙 버전이 기록과 다릅니다.');
  for (const move of game.moves) {
    const side = state.turn;
    state = applyAction(state, move.action, false);
    if (move.side !== side || move.ply !== state.ply || positionKey(state) !== move.positionKey) throw new Error('기보 검증에 실패했습니다.');
    yield { state, opening: false, action: move.action, elapsedMs: move.elapsedMs, side };
  }
  if (positionKey(state) !== game.finalKey || state.ply !== game.finalPly) throw new Error('최종 국면이 기록과 다릅니다.');
  if(game.termination==='timeout'&&(state.winner!==null||game.winner!==1-state.turn))throw new Error('시간 초과 결과가 기록과 다릅니다.');
  if(game.termination==='resignation'&&(state.winner!==null||![0,1].includes(game.winner)))throw new Error('기권 결과가 기록과 다릅니다.');
  const external = ['max-plies', 'model-error', 'model-timeout', 'invalid-response', 'illegal-action', 'timeout', 'resignation'];
  if (!external.includes(game.termination) && (state.winner !== game.winner || state.termination !== game.termination)) throw new Error('종국 결과가 기록과 다릅니다.');
}

export function replayFrames(game) {
  return Array.from(replaySteps(game));
}
