// AlphaZero-style core: fast rules (checked against src/engine.js in tests/azero.test.js), MLP, PUCT MCTS.
// Square index = y*4+x. Piece code: 0 empty, 1..5 side 0 K R B P H, 6..10 side 1.
// Action: from*12+to (0..143), or 144+handKind*12+to (rook 0, bishop 1, pawn 2).
const KING = 1, ROOK = 2, PAWN = 4, HEN = 5;
const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]], DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const NAMES = [null, 'king', 'rook', 'bishop', 'pawn', 'hen'];
const HAND_NAMES = ['rook', 'bishop', 'pawn'];
const dirs = (kind, side) => {
  const f = side === 0 ? 1 : -1;
  return kind === KING ? [...ORTH, ...DIAG] : kind === ROOK ? ORTH : kind === 3 ? DIAG : kind === PAWN ? [[f, 0]] : [...ORTH, [f, 1], [f, -1]];
};
const MOVES = [[]], MASK = [[]];
for (let c = 1; c <= 10; c++) {
  const side = c > 5 ? 1 : 0, kind = c - side * 5;
  MOVES[c] = []; MASK[c] = [];
  for (let from = 0; from < 12; from++) {
    const list = dirs(kind, side).map(([dx, dy]) => [from % 4 + dx, (from >> 2) + dy]).filter(([x, y]) => x >= 0 && x < 4 && y >= 0 && y < 3).map(([x, y]) => y * 4 + x);
    MOVES[c][from] = list;
    MASK[c][from] = list.reduce((m, to) => m | (1 << to), 0);
  }
}
const sideOf = c => (c > 5 ? 1 : 0);
const enemyCamp = side => (side === 0 ? 3 : 0);
function attacked(b, sq, bySide) {
  const lo = bySide * 5 + 1, hi = lo + 4;
  for (let i = 0; i < 12; i++) if (b[i] >= lo && b[i] <= hi && (MASK[b[i]][i] >> sq) & 1) return true;
  return false;
}
const kingSq = (b, side) => b.indexOf(side * 5 + KING);
// The key is exact: 11^12 boards * 3^6 hands * 2 turns < 2^53.
function keyOf(b, h, t) {
  let k = t;
  for (let i = 0; i < 6; i++) k = k * 3 + h[i];
  for (let i = 0; i < 12; i++) k = k * 11 + b[i];
  return k;
}
export function initial(first = 0) {
  const b = new Int8Array(12), h = new Int8Array(6);
  b[0] = 3; b[4] = KING; b[8] = ROOK; b[5] = PAWN; b[3] = 7; b[7] = 6; b[11] = 8; b[6] = 9;
  return { b, h, t: first, ply: 0, key: keyOf(b, h, first) };
}
export function legal(s) {
  const { b, h, t } = s, out = [], king = kingSq(b, t), opp = 1 - t;
  for (let from = 0; from < 12; from++) {
    const c = b[from];
    if (!c || sideOf(c) !== t) continue;
    for (const to of MOVES[c][from]) {
      const x = b[to];
      if ((x && sideOf(x) === t) || x === KING || x === 6) continue;
      b[from] = 0; b[to] = c;
      const safe = !attacked(b, from === king ? to : king, opp);
      b[from] = c; b[to] = x;
      if (safe) out.push(from * 12 + to);
    }
  }
  for (let k = 0; k < 3; k++) {
    if (!h[t * 3 + k]) continue;
    for (let to = 0; to < 12; to++) {
      if (b[to] || to % 4 === enemyCamp(t)) continue;
      b[to] = t * 5 + 2 + k;
      const safe = !attacked(b, king, opp);
      b[to] = 0;
      if (safe) out.push(144 + k * 12 + to);
    }
  }
  return out;
}
export function step(s, a) {
  const b = s.b.slice(), h = s.h.slice(), t = s.t;
  if (a >= 144) {
    const k = (a - 144) / 12 | 0, to = (a - 144) % 12;
    h[t * 3 + k]--; b[to] = t * 5 + 2 + k;
  } else {
    const from = a / 12 | 0, to = a % 12;
    let c = b[from];
    const x = b[to];
    if (x) { const kind = x > 5 ? x - 5 : x; h[t * 3 + (kind === HEN ? 2 : kind - 2)]++; }
    if (c - t * 5 === PAWN && to % 4 === enemyCamp(t)) c++;
    b[from] = 0; b[to] = c;
  }
  const n = 1 - t;
  return { b, h, t: n, ply: s.ply + 1, key: keyOf(b, h, n) };
}
// Result for the side to move: 1 win, -1 loss, 0 draw, null running. `acts` is the legal list.
export function verdict(s, acts, seen, maxPly = 256) {
  for (let side = 0; side < 2; side++) {
    const k = kingSq(s.b, side);
    if (k % 4 === enemyCamp(side) && !attacked(s.b, k, 1 - side)) return side === s.t ? 1 : -1;
  }
  if (!acts.length) return -1;
  if (seen >= 3 || s.ply >= maxPly) return 0;
  return null;
}
export function fromEngine(state) {
  const b = new Int8Array(12), h = new Int8Array(6);
  state.board.forEach((p, i) => { if (p) b[i] = p.side * 5 + NAMES.indexOf(p.kind); });
  state.hands.forEach((list, side) => { for (const k of list) h[side * 3 + HAND_NAMES.indexOf(k)]++; });
  return { b, h, t: state.turn, ply: state.ply, key: keyOf(b, h, state.turn) };
}
export function historyFromEngine(state) {
  const seen = new Map();
  for (const text of state.positions) {
    const [, turn, board, h0, h1] = text.split('|');
    const b = new Int8Array(12), h = new Int8Array(6);
    board.split(',').forEach((p, i) => { if (p !== '-') b[i] = Number(p[0]) * 5 + NAMES.indexOf(p.slice(1)); });
    [h0, h1].forEach((list, side) => { for (const k of list ? list.split(',') : []) h[side * 3 + HAND_NAMES.indexOf(k)]++; });
    const key = keyOf(b, h, Number(turn));
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  return seen;
}
export function toEngineAction(a) {
  return a >= 144 ? { drop: HAND_NAMES[(a - 144) / 12 | 0], to: (a - 144) % 12 } : { from: a / 12 | 0, to: a % 12 };
}
export function fromEngineAction(x) {
  return x.drop ? 144 + HAND_NAMES.indexOf(x.drop) * 12 + x.to : x.from * 12 + x.to;
}

// Network input is canonical: the side to move always plays toward +x.
export const N_IN = 134, N_POLICY = 180, H = 256, VH = 64;
export function features(s, seen = 1) {
  const f = [], t = s.t;
  for (let i = 0; i < 12; i++) {
    const c = s.b[i];
    if (!c) continue;
    const own = sideOf(c) === t, kind = c - sideOf(c) * 5 - 1;
    f.push((t ? 11 - i : i) * 10 + (own ? kind : 5 + kind));
  }
  for (let side = 0; side < 2; side++) for (let k = 0; k < 3; k++) {
    const n = s.h[side * 3 + k];
    if (n) f.push(120 + (side === t ? 0 : 6) + k * 2 + n - 1);
  }
  if (seen > 1) f.push(132 + Math.min(seen, 3) - 2);
  return f;
}
export const canonAction = (a, t) => {
  if (!t) return a;
  return a >= 144 ? 144 + ((a - 144) / 12 | 0) * 12 + 11 - (a - 144) % 12 : (11 - (a / 12 | 0)) * 12 + 11 - a % 12;
};

const O = (() => {
  let n = 0;
  const take = size => { const at = n; n += size; return at; };
  return { w1: take(N_IN * H), b1: take(H), w2: take(H * H), b2: take(H), w3: take(H * H), b3: take(H), p: take(N_POLICY * H), pb: take(N_POLICY), v1: take(H * VH), vb1: take(VH), v2: take(VH), vb2: take(1), size: n };
})();
export const LAYOUT = O;
export function initWeights(random = Math.random) {
  const w = new Float32Array(O.size);
  const fill = (at, count, scale) => { for (let i = 0; i < count; i++) w[at + i] = (random() * 2 - 1) * scale; };
  fill(O.w1, N_IN * H, 0.15); fill(O.w2, H * H, 0.06); fill(O.w3, H * H, 0.06); fill(O.p, N_POLICY * H, 0.02); fill(O.v1, H * VH, 0.06); fill(O.v2, VH, 0.05);
  return w;
}
export const net = { h1: new Float64Array(H), h2: new Float64Array(H), h3: new Float64Array(H), m2: new Float64Array(H), m3: new Float64Array(H), hv: new Float64Array(VH) };
// Runs the shared body, fills logits[i] for canonical `acts[i]`, returns the raw value logit.
export function forward(w, feats, acts, logits) {
  const { h1, h2, h3, m2, m3, hv } = net;
  for (let j = 0; j < H; j++) h1[j] = w[O.b1 + j];
  for (const f of feats) { const at = O.w1 + f * H; for (let j = 0; j < H; j++) h1[j] += w[at + j]; }
  for (let j = 0; j < H; j++) if (h1[j] < 0) h1[j] = 0;
  for (let i = 0; i < H; i++) {
    const at = O.w2 + i * H;
    let u = w[O.b2 + i];
    for (let j = 0; j < H; j++) u += w[at + j] * h1[j];
    m2[i] = u > 0 ? u : 0; h2[i] = h1[i] + m2[i];
  }
  for (let i = 0; i < H; i++) {
    const at = O.w3 + i * H;
    let u = w[O.b3 + i];
    for (let j = 0; j < H; j++) u += w[at + j] * h2[j];
    m3[i] = u > 0 ? u : 0; h3[i] = h2[i] + m3[i];
  }
  for (let k = 0; k < acts.length; k++) {
    const at = O.p + acts[k] * H;
    let u = w[O.pb + acts[k]];
    for (let j = 0; j < H; j++) u += w[at + j] * h3[j];
    logits[k] = u;
  }
  let out = w[O.vb2];
  for (let i = 0; i < VH; i++) {
    const at = O.v1 + i * H;
    let u = w[O.vb1 + i];
    for (let j = 0; j < H; j++) u += w[at + j] * h3[j];
    hv[i] = u > 0 ? u : 0;
    out += w[O.v2 + i] * hv[i];
  }
  return out;
}

const logitBuffer = new Float64Array(N_POLICY);
function makeNode(s, seen, w, maxPly) {
  const acts = legal(s), term = verdict(s, acts, seen, maxPly);
  if (term !== null) return { term, n: 0, sum: 0 };
  const canon = acts.map(a => canonAction(a, s.t));
  const raw = forward(w, features(s, seen), canon, logitBuffer);
  let top = -Infinity, total = 0;
  for (let i = 0; i < acts.length; i++) if (logitBuffer[i] > top) top = logitBuffer[i];
  const P = new Float32Array(acts.length);
  for (let i = 0; i < acts.length; i++) total += P[i] = Math.exp(logitBuffer[i] - top);
  for (let i = 0; i < acts.length; i++) P[i] /= total;
  return { term: null, s, acts, P, N: new Int32Array(acts.length), W: new Float32Array(acts.length), kids: new Array(acts.length), v: Math.tanh(raw), n: 0, sum: 0 };
}
// Tree is per path, so repetition counts along `seen` stay exact (no transpositions).
export function search(root, seen, w, { sims = 400, cpuct = 1.5, maxPly = 256, noise = null } = {}) {
  seen.set(root.key, seen.get(root.key) || 1);
  const top = makeNode(root, seen.get(root.key), w, maxPly);
  if (top.term !== null) return top;
  if (noise) for (let i = 0; i < top.P.length; i++) top.P[i] = (1 - noise.eps) * top.P[i] + noise.eps * noise.sample[i];
  const path = [], taken = [];
  for (let sim = 0; sim < sims; sim++) {
    let node = top, value;
    path.length = taken.length = 0;
    for (;;) {
      const explore = cpuct * Math.sqrt(node.n + 1), fpu = (node.n ? node.sum / node.n : node.v) - 0.2;
      let best = 0, bestU = -Infinity;
      for (let i = 0; i < node.acts.length; i++) {
        const u = (node.N[i] ? node.W[i] / node.N[i] : fpu) + explore * node.P[i] / (1 + node.N[i]);
        if (u > bestU) { bestU = u; best = i; }
      }
      path.push(node); taken.push(best);
      let kid = node.kids[best];
      if (!kid) {
        const s = step(node.s, node.acts[best]), count = (seen.get(s.key) || 0) + 1;
        seen.set(s.key, count);
        kid = node.kids[best] = makeNode(s, count, w, maxPly);
        kid.key = s.key;
      } else seen.set(kid.key, seen.get(kid.key) + 1);
      if (kid.term !== null || kid.n === 0) {
        value = kid.term !== null ? kid.term : kid.v;
        kid.n++; kid.sum += value;
        seen.set(kid.key, seen.get(kid.key) - 1);
        break;
      }
      node = kid;
    }
    // value is for the side to move at the leaf; each step up flips perspective.
    for (let d = path.length - 1; d >= 0; d--) {
      value = -value;
      const up = path[d], i = taken[d];
      up.N[i]++; up.W[i] += value; up.n++; up.sum += value;
      if (d > 0) seen.set(up.key, seen.get(up.key) - 1);
    }
  }
  return top;
}
