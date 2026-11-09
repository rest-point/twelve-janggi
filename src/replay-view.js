import { BOARD_ORDER,viewSquare } from './board-view.js';
import { NAMES,SYMBOLS } from './engine.js';
export const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const formatMs=value=>Number.isFinite(value)?`${value.toFixed(2)} ms`:'—';
export const moveNotation=action=>action?action.drop?`${NAMES[action.drop]} 투입 → ${viewSquare(action.to)}`:`${viewSquare(action.from)} → ${viewSquare(action.to)}`:'';
export const terminationNames={checkmate:'체크메이트',try:'왕 진입',repetition:'동일 국면 반복','no-legal-actions':'착수 불가','max-plies':'최대 수 도달',timeout:'시간 초과',resignation:'기권','model-timeout':'모델 시간 초과','model-error':'모델 오류','invalid-response':'응답 규격 오류','illegal-action':'불법수'};
export function paintReplayBoard(container,frame){
  container.innerHTML=BOARD_ORDER.map(index=>{
    const piece=frame.state.board[index];
    return `<div class="square ${frame.action?.to===index?'last-move':''}"><small>${viewSquare(index)}</small>${piece?`<span class="piece ${piece.side===0?'blue':'red'}" aria-label="${piece.side===0?'청':'홍'} ${NAMES[piece.kind]}">${SYMBOLS[piece.kind]}</span>`:''}</div>`;
  }).join('');
}
