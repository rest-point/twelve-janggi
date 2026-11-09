import { replayFrames } from './record-replay.js';
import { NAMES } from './engine.js';
import { paintReplayBoard,escapeHTML as escape,formatMs as ms,moveNotation,terminationNames } from './replay-view.js';
import { createLiveClient } from './live.js';
const $=id=>document.getElementById(id),params=new URLSearchParams(location.search);
const outcomes={win:'승리',draw:'무승부',loss:'패배',unfinished:'진행 중·미완료'};
let me=null,player=params.get('player')||null,profile=null,nextCursor=null;
let listRequest=null,recordRequest=null,record=null,frames=[],ply=0,playTimer=null,loadingRecord=false,lastRecordFetch=0;
const gameId=params.get('game');
const live=createLiveClient({onChange(){if(gameId)void loadRecord(true);},onExpired(){live.start(false);}});
function notice(text,error=false){$('notice').hidden=!text;$('notice').textContent=text;$('notice').classList.toggle('error',error);}
async function api(url,options){const response=await fetch(url,options),body=await response.json();if(!response.ok){const e=new Error(body.error);e.status=response.status;throw e;}return body;}
function urlForProfile(){
  const q=new URLSearchParams();if(player)q.set('player',player);if($('profile-mode').value!=='all')q.set('mode',$('profile-mode').value);
  if($('profile-outcome').value!=='all')q.set('outcome',$('profile-outcome').value);history.replaceState(null,'','/records'+(q.size?'?'+q:''));
}
function renderSummary(){
  const s=profile.summary;$('profile-summary').innerHTML=`<h2>${escape(profile.profile.name)}</h2><div class="record-totals">${[['완료',s.completed],['승리',s.wins],['무승부',s.draws],['패배',s.losses]].map(([name,n])=>`<div><strong>${n}</strong><span>${name}</span></div>`).join('')}<div><strong>${s.winRate===null?'—':(s.winRate*100).toFixed(1)+'%'}</strong><span>승률</span></div></div>${s.unfinished?`<p>진행 중·미완료 ${s.unfinished}국</p>`:''}`;
}
function entry(row){
  const opponent=row.opponentModelId?escape(row.opponentName):`<a href="/records?player=${encodeURIComponent(row.opponentId)}">${escape(row.opponentName)}</a>`;
  return `<article class="history-entry"><div>${opponent}<p>${escape(new Date(row.createdAt).toLocaleString('ko-KR'))} · ${row.mode==='pvp'?'플레이어 대전':'AI 대전'} · ${row.side===0?'청':'홍'} · ${row.plies}수${row.termination?' · '+escape(terminationNames[row.termination]||row.termination):''}</p></div><strong>${outcomes[row.outcome]}</strong><a href="${escape(row.href)}">기보 보기</a></article>`;
}
async function loadProfile(more=false){
  listRequest?.abort();const request=new AbortController();listRequest=request;notice('');$('more').disabled=true;
  try{
    urlForProfile();const query=new URLSearchParams({mode:$('profile-mode').value,outcome:$('profile-outcome').value});
    const id=player||me?.guest?.id;
    if(!id){profile=null;$('profile-summary').innerHTML='<h2>온라인 대전 기록</h2><button id="enter-guest">게스트 입장</button>';$('history-list').textContent='아직 저장된 온라인 대국이 없습니다.';$('more').hidden=true;return;}
    const endpoint=player?'/api/profiles/guests/'+encodeURIComponent(id):'/api/history/me';
    if(more&&nextCursor)query.set('cursor',nextCursor);
    const data=await api(endpoint+'?'+query,{signal:request.signal});if(request!==listRequest)return;
    profile=data;nextCursor=data.nextCursor;renderSummary();
    if(!more)$('history-list').replaceChildren();
    if(data.games.length)$('history-list').insertAdjacentHTML('beforeend',data.games.filter(g=>['pvp','pvai'].includes(g.mode)).map(entry).join(''));
    else if(!more)$('history-list').innerHTML='<p class="empty">해당하는 대국이 없습니다.</p>';
    $('more').hidden=!nextCursor;
  }catch(error){if(error.name!=='AbortError')notice(error.message,true);}finally{$('more').disabled=false;}
}
function stop(){clearInterval(playTimer);playTimer=null;$('play').textContent='자동 재생';}
function draw(value){
  if(!frames.length)return;ply=Math.max(0,Math.min(frames.length-1,Number(value)||0));const frame=frames[ply];paintReplayBoard($('replay-board'),frame);
  for(const side of [0,1])$(side===0?'blue-hand':'red-hand').textContent=(side===0?'청':'홍')+' 포로: '+(frame.state.hands[side].map(k=>NAMES[k]).join(' · ')||'없음');
  $('replay-board').setAttribute('aria-label',`${ply}수 국면, ${frame.state.turn===0?'청':'홍'} 차례`);
  $('ply-label').textContent=`${ply} / ${frames.length-1}`;$('ply').max=frames.length-1;$('ply').value=ply;
  $('first').disabled=$('prev').disabled=ply===0;$('last').disabled=$('next').disabled=ply===frames.length-1;$('play').disabled=frames.length<2;
  document.querySelectorAll('#moves tr').forEach((r,i)=>r.setAttribute('aria-current',String(i+1===ply)));
  const url=new URL(location.href);url.searchParams.set('ply',ply);history.replaceState(null,'',url);if(ply===frames.length-1)stop();
}
async function loadRecord(preserve=false){
  if(loadingRecord&&preserve)return;recordRequest?.abort();const request=new AbortController();recordRequest=request;loadingRecord=true;lastRecordFetch=Date.now();
  try{
    const data=await api('/api/records/'+encodeURIComponent(gameId),{signal:request.signal});if(request!==recordRequest)return;
    if(data.mode==='aivai'){location.replace('/experiments');return;}
    const next=replayFrames(data);
    const follow=preserve&&ply===frames.length-1,desired=preserve?follow?next.length-1:ply:Number(params.get('ply')||0);
    record=data;frames=next;
    $('record-players').innerHTML=data.participants.map(p=>`<a href="${p.kind==='model'?'/experiments':'/records?player='+encodeURIComponent(p.id)}">${p.side===0?'청':'홍'} · ${escape(p.username)}</a>`).join('');
    const ended=data.winner!==null;
    $('record-result').textContent=data.infrastructureError?'미완료':ended?(data.winner==='draw'?'무승부':data.participants[data.winner].username+' 승리')+' · '+(terminationNames[data.termination]||data.termination):'진행 중 · 대국 시계는 계속 흐릅니다.';
    $('moves').innerHTML=frames.map((frame,i)=>i?`<tr><td><button data-ply="${i}" aria-label="${i}수로 이동">${i}</button></td><td>${frames[i-1].state.turn===0?'청':'홍'}</td><td>${escape(moveNotation(frame.action))}</td><td>${frame.opening?'평가 제외':ms(frame.elapsedMs)}</td></tr>`:'').join('');
    $('ply').disabled=$('download').disabled=false;draw(desired);notice('');
  }catch(error){if(error.name!=='AbortError'){
    if([401,403,404].includes(error.status)){stop();record=null;frames=[];ply=0;for(const id of ['replay-board','moves','red-hand','blue-hand','record-players','record-result'])$(id).replaceChildren();$('ply-label').textContent='0 / 0';for(const id of ['first','prev','play','next','last','ply','download'])$(id).disabled=true;}
    notice(error.message,true);
  }}finally{if(request===recordRequest)loadingRecord=false;}
}
$('record-filters').addEventListener('submit',e=>e.preventDefault());
$('record-filters').addEventListener('change',()=>{nextCursor=null;void loadProfile();});
$('profile-summary').addEventListener('click',async e=>{if(e.target.id!=='enter-guest')return;try{const response=await api('/api/guest/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});me={...me,...response};await loadProfile();}catch(error){notice(error.message,true);}});
$('more').addEventListener('click',()=>void loadProfile(true));$('refresh').addEventListener('click',()=>{if(gameId)void loadRecord(true);else void loadProfile();});
for(const [id,step]of [['first',()=>0],['prev',()=>ply-1],['next',()=>ply+1],['last',()=>frames.length-1]])$(id).addEventListener('click',()=>{stop();draw(step());});
$('ply').addEventListener('input',e=>{stop();draw(e.target.value);});$('moves').addEventListener('click',e=>{const b=e.target.closest('[data-ply]');if(b){stop();draw(b.dataset.ply);}});
$('play').addEventListener('click',()=>{if(playTimer){stop();return;}if(ply===frames.length-1)draw(0);$('play').textContent='일시정지';playTimer=setInterval(()=>draw(ply+1),700);});
$('download').addEventListener('click',()=>{if(!record)return;const url=URL.createObjectURL(new Blob([JSON.stringify(record,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download=record.id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
window.addEventListener('pagehide',()=>{stop();live.start(false);});window.addEventListener('pageshow',()=>live.start(!!me?.guest&&!!gameId));
if(params.has('model')&&!gameId)location.replace('/experiments');
else try{
  me=await api('/api/me');
  for(const [param,id]of [['mode','profile-mode'],['outcome','profile-outcome']])if(params.has(param))$(id).value=params.get(param);
  if(gameId){$('profile-section').hidden=true;$('record-section').hidden=false;$('page-title').textContent='기보 재생';live.watch('game',gameId);live.start(!!me.guest);await loadRecord();setInterval(()=>{if(record?.winner===null&&Date.now()-lastRecordFetch>=(live.connected?15000:2000))void loadRecord(true);},500);}
  else await loadProfile();
}catch(error){notice(error.message,true);}
