import { createPosition, initialState, applyAction, isLegalAction } from './engine.js';

export const STUDY_FORMAT = 'twelve-janggi-analysis-v1';
const sameAction = (a, b) => a.to === b.to && a.from === b.from && a.drop === b.drop;
export class AnalysisStudy {
  constructor(position = initialState()) {
    const state = createPosition(position);
    this.position = { board: structuredClone(state.board), hands: structuredClone(state.hands), turn: state.turn };
    this.root = { id: 0, parent: null, children: [], preferred: null, state, action: null };
    this.current = this.root;
    this.nodes = new Map([[0, this.root]]);
    this.nextId = 1;
  }
  play(action) {
    if (!isLegalAction(this.current.state, action)) throw new Error('둘 수 없는 수입니다.');
    let node = this.current.children.find(n => sameAction(n.action, action));
    if (!node) {
      if (this.nodes.size >= 513) throw new Error('한 분석에는 최대 512수를 저장할 수 있습니다. 현재 국면으로 새 분석을 시작하세요.');
      const clean = action.drop ? { drop: action.drop, to: action.to } : { from: action.from, to: action.to };
      node = { id: this.nextId++, parent: this.current, children: [], preferred: null, action: clean, state: applyAction(this.current.state, clean) };
      this.current.children.push(node);
      this.nodes.set(node.id, node);
    }
    this.current.preferred = node;
    this.current = node;
    return node;
  }
  select(id) {
    const node = this.nodes.get(id);
    if (!node) throw new Error('수순을 찾을 수 없습니다.');
    for (let n = node; n.parent; n = n.parent) n.parent.preferred = n;
    this.current = node;
    return node;
  }
  path(node = this.current) {
    const out = [];
    for (let n = node; n.parent; n = n.parent) out.unshift(n);
    return out;
  }
  export() {
    return { format: STUDY_FORMAT, position: this.position, current: this.current.id,
      nodes: [...this.nodes.values()].filter(n => n.parent).map(n => ({ id: n.id, parent: n.parent.id, action: n.action })) };
  }
  static import(value) {
    if (!value || typeof value !== 'object') throw new Error('분석 JSON 형식이 올바르지 않습니다.');
    // Also accept a referee replay's starting state + move list.
    if (value.format !== STUDY_FORMAT) {
      const base = value.startState || value.position || value;
      const study = new AnalysisStudy(base);
      const actions = value.moves || value.actions || [];
      if (!Array.isArray(actions) || actions.length > 512) throw new Error('최대 512수까지 가져올 수 있습니다.');
      for (const move of actions) study.play(move.action || move);
      return study;
    }
    if (!Array.isArray(value.nodes) || value.nodes.length > 512) throw new Error('분석 수순 형식이 올바르지 않습니다.');
    const study = new AnalysisStudy(value.position), ids = new Map([[0, 0]]);
    for (const n of value.nodes) {
      if (!n || !Number.isSafeInteger(n.id) || n.id <= 0 || ids.has(n.id) || !ids.has(n.parent)) throw new Error('변형 수순이 올바르지 않습니다.');
      study.select(ids.get(n.parent));
      ids.set(n.id, study.play(n.action).id);
    }
    study.select(ids.get(value.current ?? 0));
    return study;
  }
}
