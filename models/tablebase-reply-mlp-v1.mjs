import { readFileSync } from 'node:fs';
import { FastPosition } from './pvs-aspiration-rules-v1.mjs';
import { classify, createMlp, openTable, rng, safeCandidates } from './tbrl-core.mjs';
import { HIDDEN, INPUTS, replyFeatures } from './tablebase-reply-policy-v1.mjs';

export const DEFAULT_CONFIG = Object.freeze({ maxTimeMs: 25, avoidRepeat: true, replyWeight: 0.75 });

const table = openTable();
const weights = readFileSync(new URL('./tablebase-reply-policy-v1.bin', import.meta.url));
const replyLogit = createMlp(new Float32Array(weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength)), HIDDEN, INPUTS);
const valueBytes = readFileSync(new URL('./tbrl-v2.bin', import.meta.url));
const conversion = createMlp(new Float32Array(valueBytes.buffer.slice(valueBytes.byteOffset, valueBytes.byteOffset + valueBytes.byteLength)), [128, 64]);

export function think({ state, legalActions, budgetMs = 60000, seed, config = DEFAULT_CONFIG }) {
  if (state.winner !== null || !legalActions?.length) throw new Error('No legal actions');
  const started = performance.now();
  const deadline = started + Math.min(config.maxTimeMs ?? 18, Math.max(0, budgetMs - 10));
  const children = classify(state, legalActions, table);
  const useProfile = state.ply >= (config.profileFromPly ?? 0);
  const { tier, eligible } = safeCandidates(children, { avoidRepeat: !useProfile || (config.avoidRepeat ?? false) });
  const random = rng(seed);
  const temperature = config.temperature ?? 1.1, uniformMix = config.uniformMix ?? 0.2;
  const continuation = config.continuation ?? 0.35;
  const replyWeight = useProfile ? config.replyWeight ?? 1 : 0;
  let nodes = legalActions.length, chosen = eligible[0];
  const ranked = eligible.length > 1 ? eligible.map(child => ({ child, score: conversion(child.features) + 1e-6 * random() })) : [];
  if (ranked.length && replyWeight < 1) chosen = ranked.reduce((a, b) => a.score >= b.score ? a : b).child;
  const position = ranked.length && tier === 0 && replyWeight > 0 ? new FastPosition(state) : null;

  function profile() {
    const replies = position.actions();
    let total = 0, win = 0, draw = 0, repeat = 0, countWin = 0, longest = 0;
    for (const move of replies) {
      if (performance.now() >= deadline) return null;
      const undo = position.make(move);
      try {
        nodes++;
        const answers = position.actions(), outcome = position.winner(answers);
        const raw = outcome === null ? table.probe(position) : 0;
        const count = position.counts.get(undo.key);
        const row = replyFeatures(position, move, outcome, raw, answers.length, !!undo.captured, count);
        const weight = Math.exp(Math.min(8, Math.max(-8, replyLogit(row) / temperature)));
        const winning = outcome === state.turn || raw >= 256;
        total += weight;
        if (winning) { win += weight; countWin++; longest = Math.max(longest, raw - 256); }
        if (outcome === 'draw') draw += weight;
        if (count > 1 && outcome === null && raw === 1) repeat += weight;
      } finally { position.unmake(undo); }
    }
    const probability = (1 - uniformMix) * win / total + uniformMix * countWin / replies.length;
    return probability + 0.025 * Math.min(1, longest / 30) - continuation * draw / total - (config.novelty ?? 0.07) * repeat / total;
  }

  if (position) {
    const scored = [];
    const bestValue = Math.max(...ranked.map(row => row.score));
    for (const { child: candidate, score: value } of ranked) {
      if (candidate.terminal) { scored.push(-1); continue; }
      const baseScore = value - bestValue;
      if (baseScore * (1 - replyWeight) < -1.5 * replyWeight) { scored.push(-Infinity); continue; }
      const undo = position.make(candidate.move);
      let score;
      try { score = profile(); } finally { position.unmake(undo); }
      if (score === null) break;
      scored.push((1 - replyWeight) * baseScore
        + replyWeight * (score - 0.12 * candidate.oppRepeat - 0.055 * (candidate.repeat - 1)) + 1e-7 * random());
    }
    if (scored.length === eligible.length) {
      let best = 0;
      for (let i = 1; i < scored.length; i++) if (scored[i] > scored[best]) best = i;
      chosen = eligible[best];
    } else if (replyWeight === 1) {
      // A partial profile must not favor whichever candidates were scanned first.
      chosen = safeCandidates(eligible).eligible[0];
    }
  }
  return { action: chosen.action, info: { nodes, searchMs: performance.now() - started } };
}
