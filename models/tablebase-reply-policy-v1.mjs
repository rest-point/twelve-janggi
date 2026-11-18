import { evaluatePosition } from './pvs-aspiration-v1.mjs';
import { FEATURES, features } from './tbrl-core.mjs';

export const INPUTS = FEATURES + 7;
export const HIDDEN = [64, 32];

export function replyFeatures(position, move, outcome, raw, replies, capture, repeat) {
  const us = position.turn ^ 1;
  const row = new Float32Array(INPUTS);
  features(position, us, { repeat, ply: 0, replies, check: position.inCheck(), capture,
    drop: move >= 144, first: false }, row);
  row[FEATURES] = Math.tanh(-evaluatePosition(position) / 400);
  row[FEATURES + 1] = Number(outcome === us);
  row[FEATURES + 2] = Number(outcome === position.turn);
  row[FEATURES + 3] = Number(outcome === 'draw');
  row[FEATURES + 4] = Math.sign(raw) * Math.min(1, Math.max(0, Math.abs(raw) - 256) / 36);
  row[FEATURES + 5] = Number(raw >= 256);
  row[FEATURES + 6] = Number(raw <= -256);
  return row;
}
