// Compact strict-v2 search position. Search callers adjudicate winner(actions)
// before expanding the geometric legal moves returned by actions().
import { directions, RULESET } from '../src/engine.js';

const KINDS = ['', 'king', 'rook', 'bishop', 'pawn', 'hen'];
const CODES = Object.fromEntries(KINDS.map((kind, code) => [kind, code]));
const HANDS = ['rook', 'bishop', 'pawn'];
export const VALUES = Object.freeze([0, 0, 500, 350, 140, 600]);
export const MASKS = Array.from({ length: 16 }, () => new Uint16Array(12));
const TARGETS = Array.from({ length: 16 }, () => Array.from({ length: 12 }, () => []));
for (let side = 0; side < 2; side++) for (let kind = 1; kind <= 5; kind++) {
  const piece = side * 8 + kind;
  for (let from = 0; from < 12; from++) {
    for (const [dx, dy] of directions(KINDS[kind], side)) {
      const x = from % 4 + dx, y = Math.floor(from / 4) + dy;
      if (x >= 0 && x < 4 && y >= 0 && y < 3) {
        const to = y * 4 + x;
        TARGETS[piece][from].push(to);
        MASKS[piece][from] |= 1 << to;
      }
    }
  }
}

export function actionCode(action) {
  return (action.drop ? 12 + HANDS.indexOf(action.drop) : action.from) * 12 + action.to;
}
export function decodeAction(move) {
  const from = Math.floor(move / 12), to = move % 12;
  return from < 12 ? { from, to } : { drop: HANDS[from - 12], to };
}

// The official key is an exact, delimiter-separated serialization. Converting
// every recorded position preserves histories predating this search root.
function historyKey(key) {
  const parts = key.split('|');
  if (parts.length !== 5) return null;
  const [ruleset, turn, pieces, hand0, hand1] = parts;
  if (ruleset !== RULESET || (turn !== '0' && turn !== '1')) return null;
  const tokens = pieces.split(',');
  if (tokens.length !== 12 || tokens.some(piece => piece !== '-' && !/^[01](king|rook|bishop|pawn|hen)$/.test(piece))) return null;
  const board = tokens.map(piece => piece === '-' ? 0 : Number(piece[0]) * 8 + CODES[piece.slice(1)]);
  const hands = Array(6).fill(0);
  for (const [side, text] of [hand0, hand1].entries()) {
    if (!text) continue;
    const kinds = text.split(',');
    // The referee compares the complete original string. A noncanonical hand
    // order must not become equal merely because compact hands store counts.
    if (kinds.join(',') !== [...kinds].sort().join(',')) return null;
    for (const kind of kinds) {
      const index = HANDS.indexOf(kind);
      if (index < 0 || ++hands[side * 3 + index] > 2) return null;
    }
  }
  return String.fromCharCode(...board, ...hands, Number(turn));
}

export class FastPosition {
  constructor(state) {
    this.board = Int8Array.from(state.board, piece => piece ? piece.side * 8 + CODES[piece.kind] : 0);
    this.hands = new Uint8Array(6);
    for (let side = 0; side < 2; side++) for (const kind of state.hands[side]) this.hands[side * 3 + HANDS.indexOf(kind)]++;
    this.kings = [this.board.indexOf(1), this.board.indexOf(9)];
    this.turn = state.turn;
    this.counts = new Map();
    for (const key of state.positions) {
      const compact = historyKey(key);
      // Arbitrary strings with the ruleset prefix pass referee validation, but
      // can never equal a canonical positionKey. Preserve that exact behavior.
      if (compact === null) continue;
      this.counts.set(compact, (this.counts.get(compact) || 0) + 1);
    }
    this._winner = state.winner;
  }

  key() { return String.fromCharCode(...this.board, ...this.hands, this.turn); }

  inCheck(side = this.turn) {
    const target = 1 << this.kings[side], enemy = 1 - side;
    for (let from = 0; from < 12; from++) {
      const piece = this.board[from];
      if (piece && (piece >> 3) === enemy && (MASKS[piece][from] & target)) return true;
    }
    return false;
  }

  actions() {
    if (this._winner !== null) return [];
    const actions = [], side = this.turn, board = this.board;
    const oldKing = this.kings[side], camp = side === 0 ? 3 : 0;
    for (let from = 0; from < 12; from++) {
      const piece = board[from];
      if (!piece || (piece >> 3) !== side) continue;
      for (const to of TARGETS[piece][from]) {
        const captured = board[to];
        if (captured && ((captured >> 3) === side || (captured & 7) === 1)) continue;
        board[from] = 0;
        board[to] = (piece & 7) === 4 && to % 4 === camp ? side * 8 + 5 : piece;
        if ((piece & 7) === 1) this.kings[side] = to;
        if (!this.inCheck(side)) actions.push(from * 12 + to);
        board[from] = piece;
        board[to] = captured;
        this.kings[side] = oldKing;
      }
    }
    for (let kind = 0; kind < 3; kind++) if (this.hands[side * 3 + kind]) {
      for (let to = 0; to < 12; to++) {
        if (board[to] || to % 4 === camp) continue;
        board[to] = side * 8 + kind + 2;
        if (!this.inCheck(side)) actions.push((12 + kind) * 12 + to);
        board[to] = 0;
      }
    }
    return actions;
  }

  make(move) {
    const from = Math.floor(move / 12), to = move % 12, side = this.turn;
    const captured = this.board[to], piece = from < 12 ? this.board[from] : side * 8 + from - 10;
    const undo = { from, to, side, captured, piece, king: this.kings[side], winner: this._winner, hand: -1, drop: from >= 12 };
    if (from >= 12) {
      undo.hand = side * 3 + from - 12;
      this.hands[undo.hand]--;
    } else {
      this.board[from] = 0;
      if (captured) {
        const kind = captured & 7;
        undo.hand = side * 3 + (kind === 5 ? 2 : kind - 2);
        this.hands[undo.hand]++;
      }
    }
    this.board[to] = from < 12 && (piece & 7) === 4 && to % 4 === (side === 0 ? 3 : 0) ? side * 8 + 5 : piece;
    if ((piece & 7) === 1) this.kings[side] = to;
    this.turn = 1 - side;
    this._winner = null;
    undo.key = this.key();
    this.counts.set(undo.key, (this.counts.get(undo.key) || 0) + 1);
    return undo;
  }

  unmake(undo) {
    const count = this.counts.get(undo.key);
    if (count === 1) this.counts.delete(undo.key); else this.counts.set(undo.key, count - 1);
    this.turn = undo.side;
    this._winner = undo.winner;
    this.kings[undo.side] = undo.king;
    this.board[undo.to] = undo.captured;
    if (!undo.drop) this.board[undo.from] = undo.piece;
    if (undo.hand >= 0) this.hands[undo.hand] += undo.drop ? 1 : -1;
  }

  winner(actions = this.actions()) {
    if (this._winner !== null) return this._winner;
    for (let side = 0; side < 2; side++) {
      if (this.kings[side] % 4 === (side === 0 ? 3 : 0) && !this.inCheck(side)) return side;
    }
    if (!actions.length) return 1 - this.turn;
    return (this.counts.get(this.key()) || 0) >= 3 ? 'draw' : null;
  }
}
