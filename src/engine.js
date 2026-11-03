export const RULESET = 'twelve-janggi-strict-v2';
export const NAMES = { king:'왕', rook:'장', bishop:'상', pawn:'자', hen:'후' };
export const SYMBOLS = { king:'王', rook:'將', bishop:'相', pawn:'子', hen:'侯' };
const ORTH = [[1,0],[-1,0],[0,1],[0,-1]];
const DIAG = [[1,1],[1,-1],[-1,1],[-1,-1]];
const HAND_KINDS = ['rook','bishop','pawn'];
export function directions(kind, side) {
  const f = side === 0 ? 1 : -1;
  return kind === 'king' ? [...ORTH,...DIAG] : kind === 'rook' ? ORTH : kind === 'bishop' ? DIAG : kind === 'pawn' ? [[f,0]] : kind === 'hen' ? [...ORTH,[f,1],[f,-1]] : [];
}
const onBoard = i => Number.isInteger(i) && i >= 0 && i < 12;
const enemyCamp = side => side === 0 ? 3 : 0;

// Attack geometry never calls legal move generation. Pinned pieces still defend
// squares against kings; opposing kings always defend their adjacent squares.
export function isSquareAttacked(state, square, bySide) {
  if (!onBoard(square) || ![0,1].includes(bySide)) return false;
  const x=square%4, y=Math.floor(square/4);
  return state.board.some((p,from) => p?.side===bySide && directions(p.kind,p.side).some(([dx,dy]) => from%4+dx===x && Math.floor(from/4)+dy===y));
}
function kingSquare(state, side) {
  const square=state.board.findIndex(p=>p?.side===side && p.kind==='king');
  if(square<0) throw new Error('각 플레이어의 왕이 하나씩 있어야 합니다.');
  return square;
}
export function isInCheck(state, side=state.turn) {
  return isSquareAttacked(state,kingSquare(state,side),1-side);
}
export function validatePosition(state) {
  if(!state||typeof state!=='object')throw new Error('올바르지 않은 국면입니다.');
  if(state.ruleset!==RULESET) throw new Error('지원하지 않는 규칙 버전입니다.');
  if(!Array.isArray(state.board)||state.board.length!==12||![0,1].includes(state.turn)) throw new Error('올바르지 않은 보드 또는 차례입니다.');
  if(!Array.isArray(state.hands)||state.hands.length!==2||![0,1].every(side=>Array.isArray(state.hands[side])&&[...state.hands[side]].every(k=>HAND_KINDS.includes(k)))) throw new Error('올바르지 않은 포로 구성입니다.');
  if(![null,0,1,'draw'].includes(state.winner)||!Number.isSafeInteger(state.ply)||state.ply<0||!Array.isArray(state.log)||!Array.isArray(state.positions)||[...state.positions].some(k=>typeof k!=='string'||!k.startsWith(RULESET+'|')))throw new Error('올바르지 않은 대국 상태 또는 국면 이력입니다.');
  const kings=[0,0], material={rook:0,bishop:0,pawn:0};
  for(const p of state.board) {
    if(p===null)continue;
    if(!p||![0,1].includes(p.side)||!Object.hasOwn(NAMES,p.kind))throw new Error('올바르지 않은 말입니다.');
    if(p.kind==='king')kings[p.side]++;else material[p.kind==='hen'?'pawn':p.kind]++;
  }
  for(const h of state.hands)for(const k of h)material[k]++;
  if(kings.some(n=>n!==1))throw new Error('각 플레이어의 왕이 하나씩 있어야 합니다.');
  if(Object.values(material).some(n=>n>2))throw new Error('말의 총수가 원래 구성보다 많습니다.');
  if([0,1].every(side=>kingSquare(state,side)%4===enemyCamp(side)))throw new Error('양쪽 왕이 모두 상대 끝줄에 있는 불법 국면입니다.');
  // Only the side to move may be in check in a valid position.
  if(isInCheck(state,1-state.turn))throw new Error('직전 플레이어의 왕이 공격받는 불법 국면입니다.');
  return true;
}
export function positionKey(s) {
  return `${RULESET}|${s.turn}|${s.board.map(p=>p ? `${p.side}${p.kind}` : '-').join(',')}|${s.hands.map(h=>[...h].sort().join(',')).join('|')}`;
}
export function createPosition({board,hands=[[],[]],turn=0}={}) {
  const state={ruleset:RULESET,board:structuredClone(board),hands:structuredClone(hands),turn,ply:0,winner:null,termination:null,reason:'',last:null,log:[],positions:[]};
  validatePosition(state);
  state.positions.push(positionKey(state));
  return adjudicateState(state);
}
export function initialState(first=0) {
  const board=Array(12).fill(null);
  for(const [i,side,kind] of [[0,0,'bishop'],[4,0,'king'],[8,0,'rook'],[5,0,'pawn'],[3,1,'rook'],[7,1,'king'],[11,1,'bishop'],[6,1,'pawn']])board[i]={side,kind};
  return createPosition({board,turn:first});
}
function pseudoMoves(state,from) {
  const p=state.board[from];
  if(!onBoard(from)||!p||p.side!==state.turn)return [];
  const x=from%4,y=Math.floor(from/4);
  return directions(p.kind,p.side).map(([dx,dy])=>[x+dx,y+dy]).filter(([a,b])=>a>=0&&a<4&&b>=0&&b<3).map(([a,b])=>b*4+a).filter(i=>state.board[i]?.side!==p.side && state.board[i]?.kind!=='king');
}
// This transition does not adjudicate, avoiding recursion during move generation.
function transition(state,{from,to,drop}) {
  const side=state.turn, board=state.board.map(p=>p?{...p}:null), hands=state.hands.map(h=>[...h]);
  const captured=board[to];
  let piece;
  if(drop){piece={side,kind:drop};hands[side].splice(hands[side].indexOf(drop),1);}
  else {piece=board[from];board[from]=null;}
  if(captured)hands[side].push(captured.kind==='hen'?'pawn':captured.kind);
  if(!drop && piece.kind==='pawn' && to%4===enemyCamp(side))piece.kind='hen';
  board[to]=piece;
  return {...state,board,hands,turn:1-side};
}
function kingSafeAfter(state,action) {
  return !isInCheck(transition(state,action),state.turn);
}
function legalDrop(state,drop,to) {
  return HAND_KINDS.includes(drop)&&onBoard(to)&&to%4!==enemyCamp(state.turn)&&!state.board[to]&&state.hands[state.turn].includes(drop)&&kingSafeAfter(state,{drop,to});
}
export function movesFor(state,from) {
  if(state.winner!==null)return [];
  return pseudoMoves(state,from).filter(to=>kingSafeAfter(state,{from,to}));
}
export function legalActions(state) {
  if(state.winner!==null)return [];
  const actions=[];
  state.board.forEach((p,from)=>{if(p?.side===state.turn)for(const to of movesFor(state,from))actions.push({from,to});});
  // Fixed piece order makes identical positions generate identical action lists.
  for(const drop of HAND_KINDS)if(state.hands[state.turn].includes(drop))state.board.forEach((_,to)=>{
    if(legalDrop(state,drop,to))actions.push({drop,to});
  });
  return actions;
}
export function isLegalAction(state,action) {
  if(state.winner!==null||!action||typeof action!=='object'||Array.isArray(action)||!Object.hasOwn(action,'to')||!onBoard(action.to))return false;
  if(Object.hasOwn(action,'drop')) {
    if(Object.hasOwn(action,'from')||Object.keys(action).some(k=>!['drop','to'].includes(k)))return false;
    return legalDrop(state,action.drop,action.to);
  }
  return Object.hasOwn(action,'from')&&!('drop' in action)&&Object.keys(action).every(k=>['from','to'].includes(k))&&onBoard(action.from)&&movesFor(state,action.from).includes(action.to);
}
function end(state,winner,termination,reason) {return {...state,winner,termination,reason};}
export function adjudicateState(state) {
  validatePosition(state);
  if(state.winner!==null)return state;
  // Safe entry is unanswerable under king-safety rules, so it wins immediately.
  for(let side=0;side<2;side++)if(kingSquare(state,side)%4===enemyCamp(side)&&!isInCheck(state,side))return end(state,side,'try','왕이 상대 진영에 안전하게 진입했습니다');
  if(legalActions(state).length===0)return isInCheck(state)
    ? end(state,1-state.turn,'checkmate','체크메이트: 왕을 지킬 수 있는 수가 없습니다')
    : end(state,1-state.turn,'no-legal-actions','착수 불가: 둘 수 있는 합법적인 수가 없습니다');
  const key=positionKey(state);
  if(state.positions.filter(k=>k===key).length>=3)return end(state,'draw','repetition','같은 국면이 세 번 반복되었습니다');
  return state;
}
export function applyAction(state,action,record=true) {
  // Raw/imported states must be adjudicated before accepting another move.
  if(adjudicateState(state).winner!==null)throw new Error(state.winner!==null?'이미 끝난 대국입니다.':'이미 종국 조건이 성립한 국면입니다.');
  if(!isLegalAction(state,action))throw new Error(action&&Object.hasOwn(action,'drop')&&onBoard(action.to)&&action.to%4===enemyCamp(state.turn)?'불법 착수입니다. 상대 진영에는 포로를 투입할 수 없습니다.':'불법 착수입니다. 이동 규칙과 왕의 안전을 지켜야 합니다.');
  const {from,to,drop}=action,side=state.turn,captured=state.board[to];
  const moved=transition(state,action);
  const next={...moved,ply:state.ply+1,last:{...action},log:[...state.log],positions:[...state.positions]};
  if(record)next.log.push({side,kind:drop||state.board[from].kind,from,to,drop:!!drop,captured:captured?.kind,promoted:!drop&&state.board[from].kind==='pawn'&&moved.board[to].kind==='hen'});
  next.positions.push(positionKey(next));
  return adjudicateState(next);
}
const VALUES={king:15000,rook:30,bishop:25,pawn:10,hen:45};
function score(s,side,rootPly) {
  if(s.winner!==null)return s.winner==='draw'?0:(s.winner===side?1:-1)*(100000-(s.ply-rootPly));
  let n=0;
  for(let i=0;i<12;i++){const p=s.board[i];if(!p)continue;const advance=p.side===0?i%4:3-i%4;n+=(p.side===side?1:-1)*(VALUES[p.kind]+advance*(p.kind==='king'?8:2));}
  for(let t=0;t<2;t++)n+=(t===side?1:-1)*s.hands[t].reduce((v,k)=>v+VALUES[k]*.8,0);
  return n;
}
export function chooseAI(state,difficulty='normal') {
  state=adjudicateState(state);
  const actions=legalActions(state);
  if(!actions.length)return null;
  const side=state.turn,depth=difficulty==='hard'?4:difficulty==='easy'?1:3;
  let nodes=0;
  function search(s,d,alpha,beta) {
    if(!d||s.winner!==null||++nodes>22000)return score(s,side,state.ply);
    const maximizing=s.turn===side;
    let best=maximizing?-Infinity:Infinity;
    const aa=legalActions(s).sort((a,b)=>(VALUES[s.board[b.to]?.kind]||0)-(VALUES[s.board[a.to]?.kind]||0));
    for(const a of aa){const v=search(applyAction(s,a,false),d-1,alpha,beta);best=maximizing?Math.max(best,v):Math.min(best,v);if(maximizing)alpha=Math.max(alpha,best);else beta=Math.min(beta,best);if(beta<=alpha)break;}
    return best;
  }
  let best=-Infinity,chosen=actions[0];
  for(const a of actions){const value=search(applyAction(state,a,false),depth-1,-Infinity,Infinity);if(value>best){best=value;chosen=a;}}
  return chosen;
}
