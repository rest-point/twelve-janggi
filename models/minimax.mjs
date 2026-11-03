import { chooseAI } from '../src/engine.js';
export function think({ state, config }) {
  if (!['easy', 'normal', 'hard'].includes(config.difficulty)) throw new Error('Invalid difficulty');
  return { action: chooseAI(state, config.difficulty) };
}
