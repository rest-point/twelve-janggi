import { NAMES } from './engine.js';
import { paintReplayBoard,moveNotation,terminationNames,escapeHTML as escape,formatMs as ms } from './replay-view.js';
import { replayFrames } from './record-replay.js';

const params=new URLSearchParams(location.search);
const archive=params.get('archive')==='1'||/^\d{4}-/.test(params.get('run')||'')||await fetch('/api/me').then(r=>r.json()).then(m=>m.guestMode===false).catch(()=>false);
const apiRoot=archive?'/api/experiments':'/api/model-matches';
const statusName=value=>({queued:'대기 중',running:'계산 중',completed:'완료',error:'인프라 오류 · 미완료',incomplete:'미완료'}[value]||value);
const $ = id => document.getElementById(id);
const percent = value => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—';
const reasonNames = terminationNames;
let experiments = [], detail = null, game = null, frames = [], ply = 0, timer = null;
let runRequest, gameRequest, listRequest;
function notice(text, error = false) { $('notice').textContent = text; $('notice').hidden = !text; $('notice').classList.toggle('error', error); }
function stop() { clearInterval(timer); timer = null; $('play').textContent = '자동 재생'; }
function result(record) { if(!archive&&(record.status==='error'||detail?.status==='error')&&record.winner===null)return '미완료';if(record.winner===null)return '진행 중';return record.winner === 'draw' ? '무승부' : `${record.winner === record.aSide ? 'A' : 'B'} 승리`; }
const notation=moveNotation;
function updateURL() {
  const url = new URL(location.href);
  url.search = '';if(archive)url.searchParams.set('archive','1');
  if (detail) url.searchParams.set('run', detail.id);
  if (game) { url.searchParams.set('game', game.index); url.searchParams.set('ply', ply); }
  history.replaceState(null, '', url);
}
async function api(path, signal) {
  const response = await fetch(path, { signal });
  const body = await response.json();
  if(!response.ok){const error=new Error(body.error||'기록을 읽지 못했습니다.');error.status=response.status;throw error;}
  return body;
}
function clearReplay() {
  stop(); frames = []; game = null; ply = 0;
  for (const id of ['first', 'prev', 'play', 'next', 'last', 'download', 'ply']) $(id).disabled = true;
  for (const id of ['moves', 'replay-board', 'red-hand', 'blue-hand']) $(id).replaceChildren();
  $('ply-label').textContent = '0 / 0'; $('game-meta').textContent = '대국을 선택하세요.';
}
function renderRuns() {
  $('run-count').textContent = `${experiments.length}${archive?'개':'조합'}`;
  $('runs').innerHTML = experiments.length ? experiments.map(run => `<button class="run-card ${run.id === detail?.id ? 'selected' : ''}" data-run="${escape(run.id)}" ${run.status === 'error'&&archive ? 'disabled' : ''}><span class="badge ${run.status}">${escape(statusName(run.status))}</span><strong>${escape(run.models?.a || run.id)}</strong><span>vs ${escape(run.models?.b || run.error)}</span><small>${run.createdAt ? escape(new Date(run.createdAt).toLocaleString('ko-KR')) : ''} · ${run.recordedGames ?? '?'}/${run.expectedGames ?? '?'}대국</small></button>`).join('') : '<p class="empty">실행한 모델 대전이 없습니다.<br>위에서 두 모델을 선택하고 100국을 실행하세요.</p>';
}
function renderSummary() {
  const { config, summary } = detail;
  const participants = summary?.participants || [];
  for (const value of [detail.recordedGames, detail.expectedGames, config.options.seed, config.options.moveMs, config.options.concurrency, ...(summary ? [summary.uniqueOpenings] : []), ...participants.flatMap(p => [p.wins, p.draws, p.losses])]) {
    if (!Number.isFinite(value)) throw new Error('실험 요약의 숫자 형식이 올바르지 않습니다.');
  }
  $('summary').innerHTML = `<div class="summary-title"><div><h2>${escape(detail.models.a)} <span class="muted">vs</span> ${escape(detail.models.b)}</h2></div><span class="badge ${detail.status}">${escape(statusName(detail.status))} · ${detail.recordedGames}/${detail.expectedGames}대국</span></div>${detail.error?`<p class="muted">${escape(detail.error)}</p>`:""}${participants.length ? `<div class="table-wrap"><table><caption>모델별 비교 결과</caption><thead><tr><th>모델</th><th>승 / 무 / 패</th><th>승률</th><th>평균 착수시간</th></tr></thead><tbody>${participants.map(p => `<tr><td>${escape(p.modelId)}</td><td>${p.wins} / ${p.draws} / ${p.losses}</td><td>${percent(p.wins+p.draws+p.losses?p.wins/(p.wins+p.draws+p.losses):null)}</td><td>${ms(p.timing?.meanMs)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">요약을 확정하지 않은 실험입니다. 기록이 끝난 대국부터 볼 수 있습니다.</p>'}`;
  if(!archive)$('summary').insertAdjacentHTML('beforeend',`<div class="series-actions"><button id="delete-series" class="danger-button" type="button">이 조합 기록 삭제</button><small>누구나 삭제할 수 있습니다. 실행 중인 대전도 함께 중단됩니다.</small></div>`);
  if(!archive&&detail.batches?.length)$('summary').insertAdjacentHTML('beforeend',`<details class="batch-history"><summary>추가 실행 ${detail.batches.length}회 · 누적 ${detail.recordedGames}/${detail.expectedGames}국</summary>${detail.batches.map((b,i)=>`<p>${i+1}차 · ${b.gameCount}국 · ${escape(new Date(b.createdAt).toLocaleString('ko-KR'))}</p>`).join('')}</details>`);
}
function renderGames() {
  const filter = $('result-filter').value;
  const games = (detail?.games || []).filter(record => filter === 'all' || (record.winner===null?false:record.winner === 'draw' ? filter === 'draw' : record.winner === record.aSide ? filter === 'a' : filter === 'b'));
  $('game-count').textContent = `${games.length} / ${detail?.games.length || 0}`;
  $('games').innerHTML = games.length ? games.map(record => `<button class="game-card ${record.index === game?.index ? 'selected' : ''}" data-game="${record.index}"><strong>#${record.index + 1} <span class="${record.winner === 0 ? 'blue-text' : record.winner === 1 ? 'red-text' : ''}">${result(record)}</span></strong><span>${escape(reasonNames[record.termination] || record.termination || (detail.status==='error'?'계산 환경 오류':'계산 중'))}</span><small>모델 ${record.plies}수${record.openingPlies?' · 오프닝 '+record.openingPlies+'수':''} · ${ms(record.elapsedMs)}</small></button>`).join('') : '<p class="empty">해당하는 대국이 없습니다.</p>';
}
function renderMoves() {
  $('moves').innerHTML = frames.map((frame, index) => index ? `<tr data-row="${index}"><td><button data-ply="${index}" aria-label="${index}수로 이동">${index}</button></td><td>${frames[index - 1].state.turn === 0 ? '청' : '홍'}</td><td>${escape(notation(frame.action))}${frame.opening ? ' <small>오프닝</small>' : ''}</td><td>${frame.opening ? '평가 제외' : ms(frame.elapsedMs)}</td></tr>` : '').join('');
}
function showPly(value) {
  if (!frames.length) return;
  ply = Math.max(0, Math.min(frames.length - 1, Number(value) || 0));
  const frame = frames[ply], { state } = frame;
  paintReplayBoard($('replay-board'),frame);
  for (const side of [0, 1]) $(side === 0 ? 'blue-hand' : 'red-hand').textContent = `${side === 0 ? '청' : '홍'} 포로: ${state.hands[side].map(kind => NAMES[kind]).join(' · ') || '없음'}`;
  $('ply').max = frames.length - 1; $('ply').value = ply; $('ply-label').textContent = `${ply} / ${frames.length - 1}`;
  $('first').disabled = $('prev').disabled = ply === 0;
  $('last').disabled = $('next').disabled = ply === frames.length - 1;
  $('play').disabled = frames.length <= 1;
  const ending = ply === frames.length - 1 ? ` · ${result(game)}${game.termination?' / '+(reasonNames[game.termination]||game.termination):''}` : '';
  $('replay-board').setAttribute('aria-label', `${ply}수 국면, ${state.turn === 0 ? '청' : '홍'} 차례${ending}`);
  document.querySelectorAll('[data-row]').forEach(row => row.classList.toggle('current', Number(row.dataset.row) === ply));
  if (ply === frames.length - 1) stop();
  updateURL();
}
async function loadGame(index, initialPly = 0) {
  gameRequest?.abort(); gameRequest = new AbortController();
  const request = gameRequest, run = detail.id;
  clearReplay(); notice('기보를 불러오는 중입니다.');
  try {
    const record = await api(`${apiRoot}/${encodeURIComponent(run)}/games/${index}`, request.signal);
    const replay = replayFrames(record);
    if (request !== gameRequest) return;
    game = record; frames = replay;
    const failed = game.attempts?.find(attempt => !attempt.accepted&&attempt.error&&attempt.error!=='running');
    $('game-meta').textContent = `#${index + 1} · ${result(game)} · A ${game.aSide === 0 ? '청' : '홍'} / B ${game.aSide === 0 ? '홍' : '청'} · ${reasonNames[game.termination] || game.termination || (game.status==='error'?'미완료':'계산 중')}${failed ? ` · 실패 응답 대기 ${ms(failed.elapsedMs)}` : ''}`;
    $('download').disabled = $('ply').disabled = false;
    renderMoves(); renderGames(); showPly(initialPly);
    notice('');
  } catch (error) { if (error.name !== 'AbortError') { notice(error.message, true); renderGames(); } }
}
async function loadRun(id, index, initialPly = 0) {
  runRequest?.abort(); gameRequest?.abort(); runRequest = new AbortController();
  const request = runRequest;
  clearReplay(); detail = null; $('games').replaceChildren(); $('summary').textContent = '실험을 불러오는 중입니다.';
  try {
    const record = await api(`${apiRoot}/${encodeURIComponent(id)}`, request.signal);
    if (request !== runRequest) return;
    detail = record; experiments=experiments.map(run=>run.id===id?{...run,...record}:run); $('result-filter').value = 'all';
    renderRuns(); renderSummary(); renderGames(); updateURL();
    if (record.games.length) await loadGame(index ?? record.legacyGameIndex ?? record.games[0].index, initialPly);
    else notice('아직 기록이 끝난 대국이 없습니다. 잠시 후 기록을 새로고침하세요.');
  } catch (error) { if (error.name !== 'AbortError') { $('summary').textContent = '실험을 열 수 없습니다.'; notice(error.message, true); } }
}
async function loadList() {
  listRequest?.abort(); listRequest = new AbortController();
  const request = listRequest, params = new URLSearchParams(location.search);
  try {
    const response = await api(apiRoot, request.signal);
    if (request !== listRequest) return;
    experiments = response.experiments; renderRuns();
    const requested=params.get('run');const selected=(archive?requested:experiments.some(r=>r.id===requested)?requested:null)||(archive?experiments.find(run=>run.status!=='error')?.id:experiments[0]?.id);
    if (selected) await loadRun(selected, params.has('game') ? Number(params.get('game')) : undefined, params.get('ply'));
    else { clearReplay(); detail = null; $('game-count').textContent='0 / 0';updateURL();$('summary').textContent = '실행한 모델 대전이 없습니다.'; $('games').replaceChildren(); notice(''); }
  } catch (error) { if (error.name !== 'AbortError') notice('기록을 불러오지 못했습니다. 다시 시도해 주세요.', true); }
}
$('runs').addEventListener('click', event => { const button = event.target.closest('[data-run]'); if (button) void loadRun(button.dataset.run); });
$('games').addEventListener('click', event => { const button = event.target.closest('[data-game]'); if (button) void loadGame(Number(button.dataset.game)); });
$('moves').addEventListener('click', event => { const button = event.target.closest('[data-ply]'); if (button) { stop(); showPly(button.dataset.ply); } });
$('refresh').addEventListener('click', () => { stop(); void loadList(); });
$('result-filter').addEventListener('change', renderGames);
for (const [id, next] of [['first', () => 0], ['prev', () => ply - 1], ['next', () => ply + 1], ['last', () => frames.length - 1]]) $(id).addEventListener('click', () => { stop(); showPly(next()); });
$('ply').addEventListener('input', event => { stop(); showPly(event.target.value); });
$('play').addEventListener('click', () => {
  if (timer) { stop(); return; }
  if (ply === frames.length - 1) showPly(0);
  $('play').textContent = '일시정지';
  timer = setInterval(() => showPly(ply + 1), 700);
});
$('download').addEventListener('click', () => {
  if (!game) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(game, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `${detail.id}-game-${game.index + 1}.json`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener('pagehide', stop);

let submitting=false,submission=null,modelCatalog=[],introducedModelId=null;
async function guestSession(){
  let me=await api('/api/me');if(!me.guest){const response=await fetch('/api/guest/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});const body=await response.json();if(!response.ok)throw new Error(body.error);me=body;}return me;
}
async function post(url,body){const me=await guestSession();const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':me.csrfToken},body:JSON.stringify(body)});const value=await response.json();if(!response.ok){const error=new Error(value.error);error.status=response.status;throw error;}return value;}
function renderModelList(){
  $('model-list').innerHTML=modelCatalog.map(model=>`<button type="button" data-introduce="${escape(model.id)}" aria-pressed="${model.id===introducedModelId}" aria-controls="model-introduction">${escape(model.name)}</button>`).join('');
}
function renderModelIntroduction(){
  const model=modelCatalog.find(m=>m.id===introducedModelId);if(!model)return;
  const note=model.description;
  $('model-introduction').innerHTML=`<h3>${escape(model.name)}</h3><p class="model-characteristics" aria-label="모델 특징">${escape(note.characteristics)}</p><details><summary>작성·수정</summary><form data-description="${escape(model.id)}" data-revision="${note.revision}"><label>모델 특징<textarea name="characteristics" maxlength="2000" rows="4">${escape(note.characteristics)}</textarea></label><button type="submit">저장</button><p class="description-status" role="status"></p></form></details>`;
}
$('model-list').addEventListener('click',event=>{
  const button=event.target.closest('[data-introduce]');if(!button||button.dataset.introduce===introducedModelId)return;
  introducedModelId=button.dataset.introduce;for(const item of $('model-list').querySelectorAll('button'))item.setAttribute('aria-pressed',String(item===button));renderModelIntroduction();
});
$('model-introduction').addEventListener('submit',async event=>{
  const form=event.target.closest('[data-description]');if(!form)return;event.preventDefault();
  const model=modelCatalog.find(m=>m.id===form.dataset.description),button=form.querySelector('[type="submit"]'),message=form.querySelector('.description-status');
  if(button.disabled)return;button.disabled=true;message.textContent='저장 중입니다.';message.classList.remove('error');
  try{
    const note=await post('/api/models/'+encodeURIComponent(model.id)+'/description',{
      developer:model.description.developer,characteristics:new FormData(form).get('characteristics'),motivation:model.description.motivation,expectedRevision:Number(form.dataset.revision)
    });
    model.description=note;
    if(introducedModelId===model.id&&form.isConnected){renderModelIntroduction();$('model-introduction').querySelector('.description-status').textContent='저장했습니다.';}
  }catch(error){message.textContent=error.status===409?'다른 사용자가 수정했습니다. 페이지를 새로고침한 뒤 다시 작성하세요.':error.message;message.classList.add('error');}
  finally{button.disabled=false;}
});
$('summary').addEventListener('click',async event=>{
  const button=event.target.closest('#delete-series');if(!button||archive||!detail)return;
  const selected=detail;if(!confirm(selected.models.a+' vs '+selected.models.b+' 기록을 삭제할까요? 누적 결과와 기보를 더 이상 조회할 수 없으며, 실행 중인 대전도 중단됩니다.'))return;
  button.disabled=true;submitting=true;stop();runRequest?.abort();gameRequest?.abort();
  try{await post('/api/model-matches/'+encodeURIComponent(selected.id)+'/delete',{});history.replaceState(null,'',location.pathname);await loadList();notice('조합 기록을 삭제했습니다. 같은 조합을 다시 실행하면 새 기록으로 시작합니다.');}
  catch(error){notice(error.message,true);button.disabled=false;}finally{submitting=false;}
});
async function prepareSubmission(){
  if(archive){$('model-match-form').hidden=true;$('model-introductions').hidden=true;$('list-title').textContent='실험 기록';return;}
  try{const data=await api('/api/models');modelCatalog=data.models;for(const id of ['model-a','model-b'])$(id).innerHTML=data.models.map(m=>`<option value="${escape(m.id)}">${escape(m.name)} · ${escape(m.registryId||m.id)}</option>`).join('');
    $('model-a').value=(data.models.find(m=>(m.registryId||m.id)==='greedy-v1')||data.models[0]).id;
    $('model-b').value=(data.models.find(m=>(m.registryId||m.id)==='random-v1')||data.models.at(-1)).id;renderModelList();
  }catch(e){$('submit-match').disabled=true;notice(e.message,true);}
}
$('model-match-form').addEventListener('submit',async event=>{
  event.preventDefault();if(submitting)return;submitting=true;$('submit-match').disabled=true;
  try{
    const selection={modelA:$('model-a').value,modelB:$('model-b').value};
    if(!submission||submission.modelA!==selection.modelA||submission.modelB!==selection.modelB)submission={...selection,requestId:crypto.randomUUID()};
    const data=await post('/api/model-matches',submission);
    submission=null;history.replaceState(null,'',`?run=${data.id}`);await loadList();
  }catch(e){if(e.status&&e.status<500)submission=null;notice(e.message,true);}finally{submitting=false;$('submit-match').disabled=false;}
});
let polling=false;
setInterval(async()=>{
  if(archive||polling||submitting)return;polling=true;const selected=detail;
  try{const list=await api(apiRoot);experiments=list.experiments;if(detail!==selected)return;
    if(!selected){renderRuns();return;}
    const current=experiments.find(r=>r.id===selected.id);
    if(!current){history.replaceState(null,'',location.pathname);await loadList();notice('이 조합의 기록이 삭제되었습니다.');}
    else if(['queued','running'].includes(selected.status)||current.recordedGames!==selected.recordedGames||current.expectedGames!==selected.expectedGames||current.status!==selected.status)await loadRun(selected.id,game?.index??0,ply);
    else renderRuns();
  }catch(error){notice(error.message,true);}finally{polling=false;}
},1500);
void prepareSubmission();
void loadList();
