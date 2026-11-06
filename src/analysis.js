import { AnalysisStudy } from './analysis-state.js';
import { initialState, createPosition, legalActions, positionKey, NAMES, SYMBOLS, directions } from './engine.js';
import { BOARD_ORDER, viewSquare, viewDirection } from './board-view.js';
import { escapeHTML as esc, moveNotation } from './replay-view.js';

const $ = id => document.getElementById(id);
const sideName = side => side === 0 ? '청' : '홍';
const handKinds = ['rook', 'bishop', 'pawn'];
const storageKey = 'twelve-analysis-v1';
let study = new AnalysisStudy(), models = [], result = null, selection = null, flipped = false;
let editing = false, draft = null, tool = { move: true }, drag = null, busy = false, token = 0, controller = null, debounce;
let csrf = '', sessionPromise = null;
try { const saved = JSON.parse(localStorage.getItem(storageKey)); if (saved) study = AnalysisStudy.import(saved); } catch { /* Start a fresh study if local data is unavailable. */ }
const state = () => study.current.state;
const boardOrder = () => flipped ? [...BOARD_ORDER].reverse() : BOARD_ORDER;
function notify(message = '', error = false) { $('notice').textContent = message; $('notice').hidden = !message; $('notice').classList.toggle('error', error); }
function save() { try { localStorage.setItem(storageKey, JSON.stringify(study.export())); } catch { /* Export remains available without browser storage. */ } }
function cancel() { clearTimeout(debounce); token++; controller?.abort(); controller = null; busy = false; }
function changed(auto = true) {
  cancel(); result = null; selection = null; save(); notify(); render();
  if (auto && !editing && $('auto-analysis').checked && state().winner === null) debounce = setTimeout(() => void analyze(), 250);
}
async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || '요청에 실패했습니다.'); error.status = response.status; throw error; }
  return data;
}
async function ensureSession() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    const me = await api('/api/me');
    if (me.csrfToken) { csrf = me.csrfToken; return; }
    const entered = await api('/api/guest/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    csrf = entered.csrfToken;
  })();
  try { await sessionPromise; } catch (error) { sessionPromise = null; throw error; }
}
function pieceMarkup(piece, draggable = true) {
  const dir = directions(piece.kind, piece.side).map(viewDirection).map(([x, y]) => piece.side ? [-x, -y] : [x, y]);
  return `<span class="analysis-piece ${piece.side ? 'red-piece' : 'blue-piece'}" draggable="${draggable}" aria-hidden="true">${SYMBOLS[piece.kind]}${dir.map(([x,y]) => `<i class="piece-direction" style="--dx:${x};--dy:${y}"></i>`).join('')}</span>`;
}
function renderHand(side, s) {
  const current = !editing && s.turn === side && s.winner === null;
  return `<div class="side-name"><i class="side-dot ${side ? 'red' : ''}"></i>${sideName(side)}${s.turn === side ? '<span class="turn-tag">둘 차례</span>' : ''}</div><div class="captured-hand" aria-label="${sideName(side)} 포로">${handKinds.filter(k => s.hands[side].includes(k)).map(kind => `<button data-hand="${kind}" data-side="${side}" class="${side ? 'red-piece' : 'blue-piece'} ${selection?.drop === kind && current ? 'chosen' : ''} ${result?.action.drop === kind && current ? 'recommended-hand' : ''}" ${current ? '' : 'disabled'} aria-label="${sideName(side)} ${NAMES[kind]} 포로 선택">${SYMBOLS[kind]}<small>${s.hands[side].filter(k => k === kind).length}</small></button>`).join('') || '<span class="empty-hand">포로 없음</span>'}</div>`;
}
function paintBoard() {
  const s = editing ? draft : state();
  const moves = !editing && selection ? legalActions(s).filter(a => selection.drop ? a.drop === selection.drop : a.from === selection.from) : [];
  $('analysis-board').innerHTML = boardOrder().map(index => {
    const p = s.board[index], selected = selection?.from === index;
    const recommended = !editing && result && $('show-arrow').checked && result.action.to === index;
    return `<button class="analysis-square ${index % 4 === 0 ? 'camp-blue' : index % 4 === 3 ? 'camp-red' : ''} ${selected ? 'selected-square' : ''} ${moves.some(a => a.to === index) ? 'legal-square' : ''} ${!editing && study.current.action?.to === index ? 'last-square' : ''} ${recommended ? 'recommended-square' : ''}" data-cell="${index}" aria-label="${viewSquare(index)} ${p ? sideName(p.side) + ' ' + NAMES[p.kind] : '빈칸'}"><small>${viewSquare(index)}</small>${p ? pieceMarkup(p) : ''}${recommended && result.action.drop ? `<span class="drop-label">${NAMES[result.action.drop]} 투입</span>` : ''}</button>`;
  }).join('');
  $('top-player').innerHTML = renderHand(flipped ? 0 : 1, s);
  $('bottom-player').innerHTML = renderHand(flipped ? 1 : 0, s);
  paintArrow();
}
function point(index) { const at = boardOrder().indexOf(index); return { x: at % 3 * 100 + 50, y: Math.floor(at / 3) * 100 + 50 }; }
function paintArrow() {
  const svg = $('suggestion'); svg.replaceChildren();
  if (editing || !result || !$('show-arrow').checked) return;
  const a = result.action, end = point(a.to);
  const start = a.drop ? { x: 282, y: (state().turn === 0) !== flipped ? 422 : -22 } : point(a.from);
  const length = Math.hypot(end.x - start.x, end.y - start.y), dx = (end.x - start.x) / length, dy = (end.y - start.y) / length;
  svg.innerHTML = `<defs><marker id="best-arrow-head" markerUnits="userSpaceOnUse" markerWidth="27" markerHeight="27" refX="21" refY="13.5" orient="auto"><path d="M1 2 L23 13.5 L1 25 L7 13.5 Z" fill="#d39a2f"/></marker></defs><line data-recommendation-arrow x1="${start.x + dx * (a.drop ? 4 : 20)}" y1="${start.y + dy * (a.drop ? 4 : 20)}" x2="${end.x - dx * 14}" y2="${end.y - dy * 14}" stroke="#d39a2f" stroke-width="8" stroke-linecap="round" opacity=".88" marker-end="url(#best-arrow-head)" ${a.drop ? 'stroke-dasharray="10 5"' : ''}/><circle cx="${end.x}" cy="${end.y}" r="44" fill="none" stroke="#d39a2f" stroke-width="2" opacity=".55"/>`;
}
function paintResult() {
  const s = state(), panel = $('analysis-result');
  $('engine-status').textContent = editing ? '국면 편집' : busy ? '분석 중' : result ? '분석 완료' : s.winner !== null ? '분석 종료' : '분석 준비';
  $('engine-status').classList.toggle('running', busy);
  $('analyze').disabled = editing || !models.length || s.winner !== null;
  $('analyze').textContent = busy ? '■ 분석 중지' : '✦ 이 국면 분석하기';
  $('play-best').hidden = !result || editing || busy;
  if (busy) { panel.innerHTML = '<p class="busy-note">다음 한 수를 읽고 있습니다.<br>국면을 바꾸면 진행 중인 분석이 취소됩니다.</p>'; return; }
  if (s.winner !== null) { panel.innerHTML = `<p class="terminal-note">${esc(s.reason || '대국이 끝난 국면입니다.')}<br><span class="muted">이전 수로 돌아가 다른 변형을 살펴보세요.</span></p>`; return; }
  if (!result) { panel.innerHTML = `<div class="result-empty"><span aria-hidden="true">↗</span><strong>${editing ? '어떤 국면이든, 새롭게' : '다음 한 수의 가능성'}</strong><p>${editing ? '기물을 배치하고 국면을 적용하면<br>모델로 다음 수를 분석할 수 있습니다.' : '모델을 선택하고 분석하면<br>추천 수가 보드 위에 나타납니다.'}</p></div>`; return; }
  const first = result.line[0], info = first.info;
  const format = n => Number.isFinite(n) ? n.toLocaleString('ko-KR') : '—';
  panel.innerHTML = `<div class="result-heading"><span>✦ ${sideName(first.side)}의 추천 수</span><span>${(result.elapsedMs / 1000).toFixed(2)}초</span></div><p class="recommendation">${esc(moveNotation(first.action))}${first.action.drop ? '' : `<small>${NAMES[s.board[first.action.from].kind]}</small>`}</p><p class="line-label">선택 모델로 이어 본 ${result.line.length}수</p><div class="variation-line">${result.line.map((item, i) => `<button data-line="${i}" title="${i + 1}수까지 보드에 적용"><small>${i + 1}.</small>${esc(moveNotation(item.action))}</button>`).join('')}</div><div class="metrics"><div>탐색 깊이<strong>${format(info.completedDepth)}</strong></div><div>탐색 노드<strong>${format(info.nodes)}</strong></div><div>첫 수 분석<strong>${Number.isFinite(first.elapsedMs) ? (first.elapsedMs / 1000).toFixed(2) + '초' : '—'}</strong></div></div>${result.reason ? `<p class="muted" style="margin-top:12px">${esc(result.reason)}</p>` : ''}`;
}
function paintMoves() {
  const list = [];
  function visit(node, variation = false) {
    if (node.parent) list.push(`<button data-node="${node.id}" aria-current="${node === study.current}" class="${variation ? 'variation' : ''}"><span class="move-number">${node.state.ply}.</span><i class="side-dot ${node.parent.state.turn ? 'red' : ''}"></i><span>${esc(moveNotation(node.action))}</span>${variation ? '<span class="branch-mark">변형</span>' : ''}</button>`);
    node.children.forEach((child, i) => visit(child, variation || i > 0));
  }
  visit(study.root);
  $('study-moves').innerHTML = list.length ? `<button data-node="0" aria-current="${study.current === study.root}"><span class="move-number">0.</span>초기 국면</button>${list.join('')}` : '<p class="study-empty">첫 수를 두면 분석 수순이 여기에 남습니다.</p>';
  $('move-count').textContent = `${study.nodes.size - 1}수${study.nodes.size > study.path().length + 1 ? ' · 변형 포함' : ''}`;
}
function render() {
  document.body.classList.toggle('editor-active', editing);
  $('editor').hidden = !editing;
  $('play-mode').setAttribute('aria-pressed', String(!editing)); $('edit-mode').setAttribute('aria-pressed', String(editing));
  $('analysis-model').disabled = !models.length || editing;
  $('line-plies').disabled = editing;
  $('position-label').textContent = editing ? '국면 편집 중' : `${state().ply ? state().ply + '수' : '초기 국면'} · ${sideName(state().turn)} 차례`;
  $('go-first').disabled = $('go-prev').disabled = editing || !study.current.parent;
  $('go-next').disabled = $('go-last').disabled = editing || !study.current.children.length;
  $('rebase').disabled = editing; $('reset-board').disabled = editing;
  paintBoard(); paintResult(); paintMoves();
}
function play(action) { try { study.play(action); changed(); } catch (error) { notify(error.message, true); } }
function selectNode(id) { study.select(id); changed(); }
function clickSquare(index) {
  if (editing) {
    if (tool.erase) draft.board[index] = null;
    else if (tool.kind) draft.board[index] = { side: tool.side, kind: tool.kind };
    else if (selection && selection.from !== index) { draft.board[index] = draft.board[selection.from]; draft.board[selection.from] = null; selection = null; }
    else selection = draft.board[index] && selection?.from !== index ? { from: index } : null;
    $('position-error').textContent = ''; paintBoard(); return;
  }
  const s = state();
  const action = selection && legalActions(s).find(a => a.to === index && (selection.drop ? a.drop === selection.drop : a.from === selection.from));
  if (action) { play(action); return; }
  selection = s.board[index]?.side === s.turn && s.winner === null && selection?.from !== index ? { from: index } : null;
  paintBoard();
}
function paintEditor() {
  $('piece-palette').innerHTML = [0, 1].map(side => ['king','rook','bishop','pawn','hen'].map(kind => `<button data-palette="${kind}" data-side="${side}" class="${side ? 'red-piece' : ''}" draggable="true" aria-label="${sideName(side)} ${NAMES[kind]} 배치" aria-pressed="${tool.kind === kind && tool.side === side}">${SYMBOLS[kind]}</button>`).join('')).join('');
  $('edit-turn').value = draft.turn;
  $('eraser').setAttribute('aria-pressed', String(!!tool.erase)); $('move-tool').setAttribute('aria-pressed', String(!!tool.move));
  $('edit-hands').innerHTML = [0,1].map(side => `<div class="hand-editor-row"><strong>${sideName(side)} 포로</strong>${handKinds.map(kind => `<div class="hand-counter"><button data-count="-1" data-side="${side}" data-kind="${kind}" aria-label="${sideName(side)} ${NAMES[kind]} 포로 빼기">−</button><span>${SYMBOLS[kind]} ${draft.hands[side].filter(k => k === kind).length}</span><button data-count="1" data-side="${side}" data-kind="${kind}" aria-label="${sideName(side)} ${NAMES[kind]} 포로 더하기">+</button></div>`).join('')}</div>`).join('');
}
function edit() { if (editing) return; cancel(); result = selection = null; editing = true; draft = structuredClone({ board: state().board, hands: state().hands, turn: state().turn }); tool = { move: true }; $('position-error').textContent = ''; paintEditor(); render(); }
function endEdit(apply) {
  if (apply) {
    try { study = new AnalysisStudy(createPosition(draft)); }
    catch (error) { $('position-error').textContent = error.message; return; }
  }
  editing = false; draft = null; changed(apply);
}
async function analyze() {
  if (busy) { cancel(); render(); return; }
  if (editing || !models.length || state().winner !== null) return;
  cancel(); const current = token; busy = true; result = null; controller = new AbortController();
  const signal = controller.signal, expectedKey = positionKey(state()), modelId = $('analysis-model').value;
  const body = { modelId, position: study.position, actions: study.path().map(n => n.action), linePlies: Number($('line-plies').value) };
  notify(); render();
  try {
    await ensureSession();
    if (current !== token) return;
    let data;
    try { data = await api('/api/analysis', { method: 'POST', signal, headers: { 'Content-Type':'application/json', 'X-CSRF-Token':csrf }, body: JSON.stringify(body) }); }
    catch (error) { if (error.status === 401) { sessionPromise = null; csrf = ''; } throw error; }
    if (current !== token || data.positionKey !== expectedKey || data.modelId !== modelId) return;
    result = data;
  } catch (error) { if (current === token && error.name !== 'AbortError') notify(error.message, true); }
  finally { if (current === token) { busy = false; controller = null; render(); } }
}

$('analysis-board').addEventListener('click', event => { const cell = event.target.closest('[data-cell]'); if (cell) clickSquare(Number(cell.dataset.cell)); });
for (const id of ['top-player','bottom-player']) $(id).addEventListener('click', event => { const button = event.target.closest('[data-hand]'); if (button && !button.disabled) { selection = selection?.drop === button.dataset.hand ? null : { drop: button.dataset.hand }; paintBoard(); } });
$('flip-board').addEventListener('click', () => { flipped = !flipped; paintBoard(); });
$('show-arrow').addEventListener('change', paintBoard);
$('go-first').addEventListener('click', () => selectNode(0));
$('go-prev').addEventListener('click', () => { if (study.current.parent) selectNode(study.current.parent.id); });
$('go-next').addEventListener('click', () => { const n = study.current.preferred || study.current.children[0]; if (n) selectNode(n.id); });
$('go-last').addEventListener('click', () => { let n = study.current; while (n.children.length) n = n.preferred || n.children[0]; selectNode(n.id); });
$('study-moves').addEventListener('click', event => { const button = event.target.closest('[data-node]'); if (button && !editing) selectNode(Number(button.dataset.node)); });
$('reset-board').addEventListener('click', () => { study = new AnalysisStudy(); changed(); });
$('rebase').addEventListener('click', () => { study = new AnalysisStudy(state()); changed(); });
$('edit-mode').addEventListener('click', edit); $('play-mode').addEventListener('click', () => { if (editing) endEdit(false); });
$('cancel-edit').addEventListener('click', () => endEdit(false)); $('apply-position').addEventListener('click', () => endEdit(true));
$('clear-board').addEventListener('click', () => { draft.board.fill(null); draft.hands = [[],[]]; selection = null; paintEditor(); paintBoard(); });
$('edit-turn').addEventListener('change', event => { draft.turn = Number(event.target.value); paintBoard(); });
$('piece-palette').addEventListener('click', event => { const button = event.target.closest('[data-palette]'); if (button) { tool = { kind: button.dataset.palette, side: Number(button.dataset.side) }; selection = null; paintEditor(); paintBoard(); } });
for (const [id, value] of [['eraser',{ erase:true }],['move-tool',{ move:true }]]) $(id).addEventListener('click', () => { tool = value; selection = null; paintEditor(); paintBoard(); });
$('edit-hands').addEventListener('click', event => {
  const b = event.target.closest('[data-count]'); if (!b) return;
  const hand = draft.hands[Number(b.dataset.side)], kind = b.dataset.kind;
  if (b.dataset.count === '1' && hand.filter(k => k === kind).length < 2) hand.push(kind);
  else if (b.dataset.count === '-1' && hand.includes(kind)) hand.splice(hand.indexOf(kind), 1);
  paintEditor(); paintBoard();
});
$('analyze').addEventListener('click', () => void analyze());
$('analysis-model').addEventListener('change', () => { describeModel(); changed(); });
$('line-plies').addEventListener('change', () => changed());
$('auto-analysis').addEventListener('change', () => { if ($('auto-analysis').checked) changed(); else clearTimeout(debounce); });
$('play-best').addEventListener('click', () => { if (result) play(result.action); });
$('analysis-result').addEventListener('click', event => {
  const button = event.target.closest('[data-line]'); if (!button || !result) return;
  const actions = result.line.slice(0, Number(button.dataset.line) + 1).map(n => n.action);
  try { for (const a of actions) study.play(a); changed(); } catch (error) { notify(error.message, true); }
});
document.addEventListener('keydown', event => {
  if (['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName) || $('import-dialog').open || editing) return;
  if (event.key === 'ArrowLeft' && study.current.parent) { event.preventDefault(); selectNode(study.current.parent.id); }
  if (event.key === 'ArrowRight' && study.current.children.length) { event.preventDefault(); selectNode((study.current.preferred || study.current.children[0]).id); }
});
document.addEventListener('dragstart', event => {
  const cell = event.target.closest('[data-cell]'), palette = event.target.closest('[data-palette]');
  if (cell) { const from = Number(cell.dataset.cell), s = editing ? draft : state(); if (!s.board[from] || !editing && s.board[from].side !== s.turn) { event.preventDefault(); return; } drag = { from }; }
  else if (palette && editing) drag = { kind: palette.dataset.palette, side: Number(palette.dataset.side) };
  else return;
  event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', 'twelve-piece');
});
$('analysis-board').addEventListener('dragover', event => { if (drag) event.preventDefault(); });
$('analysis-board').addEventListener('drop', event => {
  event.preventDefault(); const cell = event.target.closest('[data-cell]'); if (!drag || !cell) return;
  const to = Number(cell.dataset.cell);
  if (editing) { if (drag.kind) draft.board[to] = { kind: drag.kind, side: drag.side }; else if (drag.from !== to) { draft.board[to] = draft.board[drag.from]; draft.board[drag.from] = null; } selection = null; paintBoard(); }
  else { const a = legalActions(state()).find(a => a.from === drag.from && a.to === to); if (a) play(a); }
  drag = null;
});
document.addEventListener('dragend', () => { drag = null; });
$('export-study').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([JSON.stringify(study.export(), null, 2)], { type:'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = 'twelve-janggi-analysis.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$('import-study').addEventListener('click', () => { $('import-error').textContent = ''; $('import-dialog').showModal(); });
$('close-import').addEventListener('click', () => $('import-dialog').close());
$('import-file').addEventListener('change', async event => { const file = event.target.files[0]; if (!file) return; if (file.size > 1048576) { $('import-error').textContent = '1MB 이하 JSON 파일을 선택하세요.'; return; } $('import-text').value = await file.text(); });
$('import-form').addEventListener('submit', event => {
  event.preventDefault();
  try { const next = AnalysisStudy.import(JSON.parse($('import-text').value)); study = next; editing = false; draft = null; $('import-dialog').close(); changed(); }
  catch (error) { $('import-error').textContent = error.message; }
});
window.addEventListener('pagehide', cancel);
function describeModel() {
  const m = models.find(m => m.id === $('analysis-model').value);
  $('model-description').textContent = m ? `${m.registryId || m.id} · v${m.version}` : '';
}
render();
try {
  const data = await api('/api/models'); models = data.models;
  $('analysis-model').innerHTML = models.map(m => `<option value="${esc(m.id)}">${esc(m.name)}</option>`).join('');
  const defaultModel = models.find(m => m.registryId === 'stockjang-v1'); if (defaultModel) $('analysis-model').value = defaultModel.id;
  describeModel(); render();
} catch { notify('모델 목록을 불러오지 못했습니다. 앱 서버(npm start)에 연결했는지 확인하고 새로고침하세요.', true); }
