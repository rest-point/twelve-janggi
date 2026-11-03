import { BOARD_ORDER,viewSquare } from './board-view.js';
import { legalActions,isInCheck,NAMES } from './engine.js';
import { createLiveClient } from './live.js';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sideName=side=>side===0?'청':'홍';
export async function mountOnlineHome({main,piece,icon}) {
  const slot=main.querySelector('#online-lobby-slot');let initial;
  try{const res=await fetch('/api/me');if(!res.ok)throw Error();initial=await res.json();}
  catch{slot.textContent='대전 서버에 연결할 수 없습니다. 잠시 후 새로고침해 주세요.';return;}
  if(!initial.guestMode){slot.textContent='모델 대전 기보는 상단 메뉴에서 확인할 수 있어요.';return;}
  const root=document.createElement('section');root.className='online-home';root.id='online-home';slot.replaceWith(root);
  let guest=initial.guest,csrf=initial.csrfToken,room=null,game=null,rooms=[],activeId=null;
  let selected=null,busy=false,polling=false,pending=null,message='',offset=0,epoch=0,liveDirty=false,lastPoll=0;
  const live=createLiveClient({onChange(){if(busy||polling){liveDirty=true;return;}void sync();},onExpired(){guest=csrf=null;selected=null;render();flash('게스트 세션이 만료되었습니다. 로비에서 다시 입장해 주세요.');}});
  live.start(!!guest);
  const ownSeat=()=>room?.seats.find(s=>s.id===guest?.id);
  async function api(url,method='GET',body){
    const res=await fetch(url,{method,credentials:'same-origin',headers:method==='POST'?{'Content-Type':'application/json','X-CSRF-Token':csrf||''}:{},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    const data=await res.json();if(!res.ok){const e=new Error(data.error);e.status=res.status;throw e;}return data;
  }
  function nameField(){return `<label class="online-label">게스트 이름 <span>선택</span><input name="guestName" maxlength="20" autocomplete="nickname" placeholder="비워 두면 이름을 정해 드려요" value="${escape(guest?.name||'')}" ${guest?'readonly':''}></label>`;}
  function flash(text){message=text;const p=root.querySelector('#online-message');if(p)p.textContent=text;}
  function clock(){const el=root.querySelector('#online-clock');if(el)el.textContent=game?.infrastructureError?'계산 중단':game?.deadlineAt?`${Math.max(0,Math.ceil((game.deadlineAt-Date.now()-offset)/1000))}초`:'대국 종료';}
  function render(){
    const focused=document.activeElement?.dataset?.online,focusIndex=document.activeElement?.dataset?.index;
    const field=document.activeElement?.name,values=Object.fromEntries([...root.querySelectorAll('input[name]')].map(e=>[e.name,e.value]));
    root.innerHTML=`<p id="online-message" class="online-message" role="status" aria-live="polite">${escape(message)}</p>${room?stage():lobby()}${pending?`<button class="online-secondary online-retry" data-online="retry" ${busy?'disabled':''}>같은 요청 다시 보내기</button>`:''}`;
    for(const input of root.querySelectorAll('input[name]'))if(!input.readOnly&&Object.hasOwn(values,input.name))input.value=values[input.name];
    if(['guestName','title'].includes(field))root.querySelector(`input[name="${field}"]`)?.focus({preventScroll:true});
    if(pending)root.querySelectorAll('button').forEach(b=>{if(!['retry','home','refresh'].includes(b.dataset.online))b.disabled=true;});
    if(focused==='cell')root.querySelector(`[data-online="cell"][data-index="${Number(focusIndex)}"]`)?.focus({preventScroll:true});clock();
    live.watch(game?'game':room?'room':'lobby',game?.id||room?.id);
  }
  function lobby(){return `<div class="online-intro"><span class="online-pill">${icon('users',15)} 게스트 대전</span><p>방을 만들거나, 아래 목록에서 친구의 방에 참가하세요.</p></div>
    <form id="online-create" class="online-card online-create-card"><span class="eyebrow">CREATE A ROOM</span><h3>새로운 한 판을 열어요</h3>${nameField()}<label class="online-label">방 이름 <span>선택</span><input name="title" maxlength="40" placeholder="함께 두는 십이장기"></label><button class="primary online-primary" type="submit" ${busy?'disabled':''}>방 만들기 ${icon('arrow',18)}</button></form>
    <section class="online-rooms"><div class="online-section-heading"><h3>함께 둘 방</h3><button class="text-button" data-online="refresh" ${busy?'disabled':''}>새로고침 ↻</button></div>${activeId?`<button class="online-resume" data-online="open" data-room="${activeId}">참가 중인 방으로 돌아가기 ${icon('arrow',17)}</button>`:''}<div class="online-room-list">${rooms.length?rooms.map(r=>`<article class="online-room-card"><div><span class="online-pill ${r.status==='waiting'?'':'quiet'}">${r.status==='waiting'?'대기 중':'대국 중'}</span><h4>${escape(r.title)}</h4><p>${r.seats.map(s=>escape(s.name)).join(' · ')} <span>${r.seats.length}/2명</span></p></div><button class="online-secondary" data-online="${r.status==='waiting'&&r.seats.length<2&&!r.seats.some(s=>s.id===guest?.id)?'join':'open'}" data-room="${r.id}" ${busy?'disabled':''}>${r.seats.some(s=>s.id===guest?.id)?'내 방으로':r.status==='waiting'&&r.seats.length<2?'참가하기':'관전하기'} ${icon('arrow',16)}</button></article>`).join(''):'<div class="online-empty">아직 열린 방이 없어요.<br><strong>첫 번째 대국을 열어 보세요.</strong></div>'}</div></section>`;}
  function stage(){
    const own=ownSeat(),waiting=room.status==='waiting',ended=game?.state.winner!==null;
    return `<div class="online-room-heading"><div><span class="eyebrow">${waiting?'WAITING FOR THE NEXT MOVE':'PLAY TOGETHER'}</span><h2>${escape(room.title)}</h2></div><button class="online-secondary" data-online="home" ${busy?'disabled':''}>로비로</button></div>
    <div class="online-seats">${[0,1].map(side=>{const s=room.seats.find(p=>p.side===side);return `<div class="online-seat ${side===1?'red':''}"><span class="online-avatar">${sideName(side)}</span><div><strong>${s?s.modelVersionId?escape(s.name):`<a href="/records?player=${encodeURIComponent(s.id)}">${escape(s.name)}</a>`:'친구를 기다리는 중'}${s?.id===guest?.id?' <small>나</small>':''}</strong><p>${s?waiting?(s.ready?'준비 완료':'준비 전'):'참가자':'목록에서 이 방에 참가할 수 있어요'}</p></div>${s&&waiting?`<span class="online-ready-badge ${s.ready?'ready':''}">${s.ready?'✓':'·'}</span>`:''}</div>`;}).join('')}</div>
    ${waiting?`<div class="online-waiting online-card"><h3>${room.seats.length<2?'친구가 들어오면 준비해 주세요.':'두 분 모두 준비되었나요?'}</h3><p>선공은 무작위로 정하고, 매 턴 60초가 주어집니다.</p>${!guest?nameField():''}<div class="online-actions">${own?`<button class="${own.ready?'online-secondary':'primary'}" data-online="ready" ${busy?'disabled':''}>${own.ready?'준비 취소':'준비하기'}</button><button class="text-button" data-online="leave" ${busy?'disabled':''}>방 나가기</button>`:room.seats.length<2?`<button class="primary" data-online="join" data-room="${room.id}" ${busy?'disabled':''}>이 방에 참가하기 ${icon('arrow',18)}</button>`:'<p>두 참가자가 준비하고 있어요.</p>'}</div><small>두 참가자가 준비하면 자동으로 시작합니다.</small></div>`:game?boardView(own):''}
    ${game&&ended?'<p class="online-footnote">대국과 기보는 저장되었고, 종료된 방은 정리되었습니다.</p>':''}`;
  }
  function boardView(own) {
    const s=game.state,ended=s.winner!==null,turn=game.participants[s.turn],actions=own?.side===s.turn&&!ended&&!game.infrastructureError&&!busy&&!pending?legalActions(s):[];
    const targets=selected?actions.filter(a=>selected.drop?a.drop===selected.drop:a.from===selected.from):[];
    const status=ended?(s.winner==='draw'?'무승부':`${escape(game.participants[s.winner]?.username)} 승리`):`${escape(turn.username)}의 차례${own?.side===s.turn?' · 나의 차례':''}`;
    return `<div class="match-layout online-match"><div class="board-section"><div class="turn-banner ${s.turn===1?'coral-turn':''}"><span class="turn-count">${ended?s.ply+'수':s.ply+1+'번째 수'}</span><strong role="status">${status}</strong><span id="online-clock"></span></div><div class="board-wrap"><div class="board" role="group" aria-label="온라인 십이장기 3×4 게임판">${BOARD_ORDER.map(i=>{const p=s.board[i],legal=targets.some(a=>a.to===i);return `<button class="cell ${i%4===0?'camp-a':i%4===3?'camp-b':''} ${selected?.from===i?'picked':''} ${legal?'legal':''} ${s.last?.to===i?'last-move':''}" data-online="cell" data-index="${i}" aria-label="${viewSquare(i)}${p?' '+sideName(p.side)+' '+NAMES[p.kind]:''}${legal?' 이동 가능':''}" ${!actions.length?'disabled':''}><span class="cell-coord">${viewSquare(i)}</span>${p?piece(p):'<span class="cell-center">+</span>'}${legal?'<span class="legal-dot"></span>':''}</button>`;}).join('')}</div></div><p class="selection-hint">${game.infrastructureError?'계산 환경 오류로 대국이 미완료 상태입니다.':ended?escape(s.reason):!own?'관전 중입니다.':own.side!==s.turn?'상대의 다음 수를 기다리고 있어요.':isInCheck(s)?'장군입니다. 왕을 안전하게 지키세요.':'내 말 또는 포로를 누르고, 표시된 칸을 선택하세요.'}</p><div class="hands">${[0,1].map(side=>`<section class="hand ${side===s.turn?'active':''}"><div class="hand-heading"><span>${sideName(side)} 포로</span><small>${s.hands[side].length}개</small></div><div class="hand-pieces">${s.hands[side].length?s.hands[side].map(kind=>`<button data-online="hand" data-kind="${kind}" ${!actions.length||own?.side!==side?'disabled':''} aria-label="${sideName(side)} 포로 ${NAMES[kind]} 투입">${piece({side,kind},true)}</button>`).join(''):'<span class="empty-hand">잡은 말이 이곳에 모여요</span>'}</div></section>`).join('')}</div>${own&&!ended?'<button class="text-button online-resign" data-online="resign">이번 대국 기권하기</button>':''}</div>
      <aside class="match-sidebar"><section class="history-card"><div class="sidebar-label">대국 기록 <span>${game.moves.length}수</span></div><div class="move-history">${game.moves.length?game.moves.map((m,i)=>`<div class="history-row"><span>${i+1}</span><i class="side-dot side-${m.side}"></i><strong>${sideName(m.side)}</strong><p>${m.action.drop?NAMES[m.action.drop]+' 투입':viewSquare(m.action.from)+' →'} ${viewSquare(m.action.to)}</p><em>${(m.elapsedMs/1000).toFixed(2)}초</em></div>`).join(''):`<div class="history-empty"><p>${ended?'착수 없이 종료된 대국입니다.':'첫 번째 한 수를<br>기다리고 있어요.'}</p></div>`}</div></section><a class="online-secondary" href="/records?game=${game.id}">기보 재생</a><p class="online-footnote">매 턴 60초 · 연결이 끊겨도 시간은 흐릅니다.<br>같은 브라우저에서 돌아오면 이어서 둘 수 있어요.</p></aside></div>`;
  }

  async function ensureGuest(name){if(guest)return;const me=await api('/api/me');guest=me.guest;csrf=me.csrfToken;if(!guest){const data=await api('/api/guest/session','POST',{name:name||''});guest=data.guest;csrf=data.csrfToken;}live.start(true);}
  function useGame(g){
    const old=room;game=g;offset=g.serverNow-Date.now();room={id:old?.id||null,title:old?.title||(g.mode==='pvai'?'AI와, 한 판.':'함께 두는 십이장기'),status:g.state.winner===null&&!g.infrastructureError?'playing':'finished',gameId:g.id,seats:g.participants.map(p=>({side:p.side,id:p.id,name:p.username,modelVersionId:p.modelVersionId,ready:true}))};
    history.replaceState(null,'',`?game=${g.id}`);
  }
  async function refresh(){
    const ticket=epoch,current=room;
    if(current?.gameId){const g=await api(`/api/games/${current.gameId}/record`);if(ticket!==epoch)return;
      const changed=g.revision!==game?.revision||g.infrastructureError!==game?.infrastructureError;useGame(g);if(changed){selected=null;render();}else clock();return;}
    if(current){
      let r;try{r=await api(`/api/rooms/${current.id}`);}catch(e){if(e.status!==404)throw e;if(ticket!==epoch)return;room=game=null;history.replaceState(null,'',location.pathname);flash('방이 종료되었습니다. 새로운 방에 참가해 주세요.');await refresh();render();return;}
      const g=r.gameId?await api(`/api/games/${r.gameId}/record`):null;if(ticket!==epoch)return;
      const changed=JSON.stringify(r)!==JSON.stringify(room);room=r;if(g)useGame(g);if(changed||g){selected=null;render();if(g)root.querySelector('.online-match')?.scrollIntoView({behavior:'smooth',block:'start'});}return;
    }
    const data=await api('/api/rooms');if(ticket!==epoch)return;const changed=JSON.stringify(data.rooms)!==JSON.stringify(rooms)||data.activeRoomId!==activeId;
    rooms=data.rooms;activeId=data.activeRoomId;if(changed)render();
  }
  async function open(id){const r=await api(`/api/rooms/${id}`);epoch++;room=r;game=selected=null;history.replaceState(null,'',`?room=${id}`);await refresh();render();root.scrollIntoView({behavior:'smooth',block:'start'});}
  async function openGame(id){const g=await api(`/api/games/${id}/record`);epoch++;room=null;selected=null;useGame(g);render();root.scrollIntoView({behavior:'smooth',block:'start'});}
  async function command(route,body){pending=pending||{route,body};const data=await api(pending.route,'POST',pending.body);pending=null;return data;}
  async function perform(work){
    if(busy)return;busy=true;flash('');root.querySelectorAll('button').forEach(b=>b.disabled=true);
    try{await work();}catch(e){if(e.status&&e.status<500)pending=null;message=e.message;if(!e.status||e.status>=500)message='연결을 확인하고 같은 요청을 다시 보내 주세요.';
      if(e.status===401){guest=csrf=null;pending=null;message='게스트 세션이 만료되었습니다. 로비에서 다시 입장해 주세요.';}await refresh().catch(()=>{});
    }finally{busy=false;render();if(liveDirty){liveDirty=false;void sync();}}
  }
  root.addEventListener('submit',event=>{if(event.target.id!=='online-create')return;event.preventDefault();const data=new FormData(event.target);
    void perform(async()=>{await ensureGuest(data.get('guestName'));const r=await command('/api/rooms',{title:data.get('title')});await open(r.id);});});
  root.addEventListener('click',event=>{
    const el=event.target.closest('[data-online]');if(!el||el.disabled)return;const action=el.dataset.online,name=root.querySelector('[name="guestName"]')?.value;
    if(action==='cell'){const s=game.state,index=Number(el.dataset.index),actions=legalActions(s);const move=selected?actions.find(a=>a.to===index&&(selected.drop?a.drop===selected.drop:a.from===selected.from)):null;
      if(move)void perform(async()=>{await command(`/api/games/${game.id}/actions`,{requestId:crypto.randomUUID(),expectedRevision:game.revision,action:move});await refresh();});else{selected=s.board[index]?.side===ownSeat()?.side?{from:index}:null;render();}return;}
    if(action==='hand'){selected={drop:el.dataset.kind};render();return;}
    void perform(async()=>{
      if(action==='home'){epoch++;room=game=selected=null;pending=null;history.replaceState(null,'',location.pathname);await refresh();}
      if(action==='open')await open(el.dataset.room);
      if(action==='join'){await ensureGuest(name);await command(`/api/rooms/${el.dataset.room}/join`,{});await open(el.dataset.room);}
      if(action==='ready'){room=await command(`/api/rooms/${room.id}/ready`,{ready:!ownSeat().ready,expectedRevision:room.revision});await refresh();}
      if(action==='leave'){await command(`/api/rooms/${room.id}/leave`,{});epoch++;room=game=null;history.replaceState(null,'',location.pathname);await refresh();}
      if(action==='refresh')await refresh();
      if(action==='retry'){const data=await command();if(data.state&&data.participants)await openGame(data.id);else if(data.gameId)await openGame(data.gameId);else if(data.id&&data.status!=='closed')await open(data.id);else await refresh();}
      if(action==='resign'&&confirm('이번 대국을 기권할까요? 대화상자를 열어도 시간은 흐릅니다.')){await command(`/api/games/${game.id}/resign`,{requestId:crypto.randomUUID(),expectedRevision:game.revision});await refresh();}
    });
  });
  document.querySelector('[data-action="home"]').addEventListener('click',()=>{if(!busy)void perform(async()=>{epoch++;room=game=null;history.replaceState(null,'',location.pathname);await refresh();});});
  const chooser=document.createElement('section');chooser.className='mode-selector';chooser.setAttribute('aria-label','대전 모드');
  chooser.innerHTML=`<div class="mode-cards"><button class="mode-card selected" data-mode="pvp">${icon('users',25)}<strong>플레이어 vs 플레이어</strong><small>방을 만들고 친구와 대전</small></button><button class="mode-card" data-mode="pvai">${icon('bot',25)}<strong>플레이어 vs AI</strong><small>모델을 골라 직접 도전</small></button><a class="mode-card" href="/experiments">${icon('eye',25)}<strong>AI vs AI</strong><small>100국씩 실행하고 결과 누적</small></a></div><form id="ai-setup" class="mode-config" hidden><label>게스트 이름 <input name="aiGuestName" maxlength="20" placeholder="선택 · 자동 이름 사용 가능"></label><label>상대 모델<select name="model" id="human-ai-model" aria-label="상대 모델"></select></label><span>양쪽 모두 매 턴 60초</span><button class="primary" type="submit">AI와 대국 시작</button></form>`;
  main.querySelector('.hero').after(chooser);
  chooser.addEventListener('click',event=>{const button=event.target.closest('[data-mode]');if(!button)return;chooser.querySelectorAll('[data-mode]').forEach(b=>b.classList.toggle('selected',b===button));chooser.querySelector('#ai-setup').hidden=button.dataset.mode!=='pvai';if(button.dataset.mode==='pvp')root.scrollIntoView({behavior:'smooth',block:'start'});});
  chooser.querySelector('#ai-setup').addEventListener('submit',event=>{event.preventDefault();const data=new FormData(event.target);void perform(async()=>{
    await ensureGuest(data.get('aiGuestName'));let r=await command('/api/rooms',{mode:'pvai',modelVersionId:data.get('model'),title:'AI와, 한 판.'});r=await command(`/api/rooms/${r.id}/ready`,{ready:true,expectedRevision:r.revision});await openGame(r.gameId);
  });});
  try{const data=await api('/api/models');chooser.querySelector('#human-ai-model').innerHTML=data.models.map(m=>`<option value="${escape(m.id)}">${escape(m.name)} · ${escape(m.registryId||m.id)}</option>`).join('');}catch(e){flash(e.message);}
  render();const params=new URL(location.href).searchParams;
  try{await refresh();if(params.get('game'))await openGame(params.get('game'));else if(params.get('room'))await open(params.get('room'));else if(activeId)await open(activeId);}catch(e){flash(e.message);}
  async function sync(){if(busy||polling)return;polling=true;lastPoll=Date.now();try{await refresh();}catch{flash('재연결 중입니다. 대국 시계는 계속 흐릅니다.');}finally{polling=false;if(liveDirty){liveDirty=false;queueMicrotask(()=>void sync());}}}
  setInterval(clock,200);setInterval(()=>{if(Date.now()-lastPoll>=(live.connected?15000:1500))void sync();},500);
  window.addEventListener('pagehide',()=>live.start(false));window.addEventListener('pageshow',()=>live.start(!!guest));
}
