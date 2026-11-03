import { initialState,directions,NAMES,SYMBOLS } from './engine.js';
import { BOARD_ORDER,viewDirection } from './board-view.js';
import { mountOnlineHome } from './online.js';
const main=document.querySelector('main'),modal=document.querySelector('#modal');
let focusReturn=null;
const icon=(name,size=20)=>{
  const paths={arrow:'<path d="M5 12h14m-6-6 6 6-6 6"/>',book:'<path d="M12 5v15M3 4h5a4 4 0 0 1 4 3 4 4 0 0 1 4-3h5v15h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3Z"/>',users:'<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m2 4a5 5 0 0 1 3 4v2"/>',bot:'<rect x="4" y="7" width="16" height="14" rx="4"/><path d="M12 3v4m-4 6v2m8-2v2M1 13h3m16 0h3m-13 4h4"/><circle cx="12" cy="2" r="1"/>',eye:'<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',check:'<path d="m5 12 4 4L19 6"/>',close:'<path d="m6 6 12 12M6 18 18 6"/>',flag:'<path d="M5 22V3c5-4 9 4 15 0v11c-6 4-10-4-15 0"/>',spark:'<path d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z"/>',trophy:'<path d="M8 3h8v7a4 4 0 0 1-8 0Zm0 2H4v3a4 4 0 0 0 4 4m8-7h4v3a4 4 0 0 1-4 4m-4 2v7m-4 0h8"/>'};
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]||paths.spark}</svg>`;
};
function piece(p,small=false) {
  const dir=directions(p.kind,p.side).map(viewDirection);
  return `<span class="piece ${p.side===0?'teal':'coral'} ${small?'small':''}" aria-hidden="true"><span class="piece-letter">${SYMBOLS[p.kind]}</span>${dir.map(([x,y])=>`<i class="move-mark" style="--dx:${x};--dy:${y}"></i>`).join('')}</span>`;
}
function miniBoard() {
  const board=initialState().board;
  return `<div class="hero-art" aria-label="세로 십이장기 보드 일러스트" role="img"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><span class="art-caption">A LITTLE BOARD.<br>A BIG NEXT MOVE.</span><div class="mini-board">${BOARD_ORDER.map(i=>`<div class="mini-cell ${i%4===0?'camp-a':i%4===3?'camp-b':''}">${board[i]?piece(board[i],true):'<span class="crosshair">+</span>'}</div>`).join('')}</div><span class="floating-tag">${icon('spark',15)} 열두 칸의 가능성</span><span class="art-corner">03 × 04</span></div>`;
}

main.innerHTML=`<section class="hero"><div class="hero-copy"><div class="eyebrow"><span></span> THE ART OF A SMALL MOVE</div><h1>열두 칸,<br>그 이상의 <span>한 수.</span></h1><p>단순한 규칙 속 깊어지는 생각.<br>나만의 전략으로 십이장기를 시작해 보세요.</p><div class="hero-meta"><span>${icon('users',16)} 2명</span><i></i><span>${icon('clock',16)} 5–15분</span><i></i><span>무한한 수읽기</span></div></div>${miniBoard()}</section>
  <div class="setup-heading"><div><span class="eyebrow">LET’S PLAY</span><h2>친구와, 한 판.</h2></div><button class="text-button" data-action="guide">처음 플레이하시나요? ${icon('book',17)}</button></div>
<section id="online-lobby-slot"><p>대전 서버에 연결하는 중입니다.</p></section>
<section class="bottom-note"><span>${icon('book',22)}</span><div><h3>작은 판이지만, 전략은 작지 않아요.</h3><p>말을 잡고, 포로를 활용하고, 상대의 다음 수를 읽어 보세요.</p></div><button class="text-button" data-action="guide">게임 방법 살펴보기 ${icon('arrow',17)}</button></section>`;
function openModal(html,label='게임 안내'){
  focusReturn=document.activeElement;
  modal.innerHTML=`<button class="modal-close" data-action="close-modal" aria-label="닫기">${icon('close')}</button>${html}`;
  modal.setAttribute('aria-label',label);if(!modal.open)modal.showModal();
}
function closeModal(){if(modal.open)modal.close();}
modal.addEventListener('close',()=>{if(focusReturn?.isConnected)focusReturn.focus({preventScroll:true});else main.focus({preventScroll:true});});
modal.addEventListener('click',e=>{if(e.target===modal){const r=modal.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeModal();}});
function guide() {
  openModal(`<span class="eyebrow">A SMALL GUIDE TO A GREAT GAME</span><h2>열두 칸이면 충분해요.</h2><p class="modal-intro">왕을 안전하게 지키며 체크메이트하거나,<br>내 왕이 상대 끝줄에 안전하게 진입하면 즉시 승리합니다.</p><div class="guide-pieces">${[['king','모든 방향 한 칸'],['rook','가로·세로 한 칸'],['bishop','대각선 한 칸'],['pawn','앞으로 한 칸']].map(([k,txt])=>`<div>${piece({kind:k,side:0},true)}<strong>${NAMES[k]}</strong><small>${txt}</small></div>`).join('')}</div><div class="guide-section"><span>01</span><div><h3>선택하고, 한 칸 움직이세요</h3><p>청은 위쪽, 홍은 아래쪽이 앞입니다. 내 말을 누르면 이동 가능한 칸이 표시됩니다. 상대 말이 있는 칸으로 움직이면 잡을 수 있어요.</p></div></div><div class="guide-section"><span>02</span><div><h3>잡은 말은 나의 새로운 전략</h3><p>잡은 말은 내 포로가 됩니다. 다음 차례부터 포로 하나를 상대 진영(상대 맨 끝줄)을 제외한 빈칸에 내 말로 투입할 수 있어요. 포로 투입도 한 차례를 사용합니다.</p></div></div><div class="guide-section"><span>03</span><div><h3>작은 자가 강한 후로</h3><p>자가 이동해서 상대 끝줄에 도착하면 후로 승격합니다. 후는 뒤쪽 대각선을 제외한 여섯 방향으로 움직입니다. 잡힌 후는 자로 돌아갑니다.</p></div></div><div class="guide-section"><span>04</span><div><h3>왕의 안전은 필수입니다</h3><p>공격받는 칸으로 왕을 옮기거나 장군을 방치하는 수는 금지됩니다. 왕을 직접 잡지 않고, 장군을 피할 합법수가 없으면 즉시 체크메이트입니다. 안전한 끝줄 진입도 즉시 승리합니다. 장군이 아닌 착수 불가는 패배, 동일 국면 3회는 무승부입니다.</p></div></div><div class="guide-callout">${icon('spark',19)} 게임판은 세로 3×4칸으로 고정됩니다. 오리지널 배치에서 선공은 매 대국 무작위로 정하며, 차례마다 60초가 주어집니다. 모든 대국에 왕 보호 규칙을 적용합니다.</div><button class="primary full" data-action="close-modal">이제, 한 수 두러 가기 ${icon('arrow',18)}</button>`,'십이장기 게임 방법');
}

document.addEventListener('click',event=>{const action=event.target.closest('[data-action]')?.dataset.action;if(action==='guide')guide();else if(action==='close-modal')closeModal();});
void mountOnlineHome({main,piece,icon});
