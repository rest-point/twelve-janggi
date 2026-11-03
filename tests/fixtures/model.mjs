export function think({ legalActions, config }) {
  if (config.mode === 'loop') { for (;;) {} }
  if (config.mode === 'throw') throw new Error('Expected model failure');
  if (config.mode === 'exit') process.exit(2);
  if (config.mode === 'invalid') return { action: { from: 5, to: 6, extra: true } };
  if (config.mode === 'illegal') return { action: { from: 0, to: 11 } };
  return { action: legalActions[0] };
}
