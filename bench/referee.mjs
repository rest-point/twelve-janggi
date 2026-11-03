import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';
import { legalActions, isLegalAction, applyAction, positionKey } from '../src/engine.js';
import { seedOf } from './common.mjs';

export class ModelClient {
  constructor(model) {
    this.worker = new Worker(new URL('./model-worker.mjs', import.meta.url), {
      workerData: { entryPath: model.entryPath }, resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    this.pending = null; this.dead = null;
    this.worker.on('message', message => {
      if (message.error && !message.requestId) { this.dead = 'model-error'; this.pending?.finish({ error: this.dead }); return; }
      if (!this.pending) return;
      if (this.pending.requestId === null ? message.ready : message.requestId === this.pending.requestId) this.pending.finish(message);
    });
    this.worker.on('error', () => { this.dead = 'model-error'; this.pending?.finish({ error: this.dead }); });
    this.worker.on('exit', () => { this.dead = 'model-error'; this.pending?.finish({ error: this.dead }); });
  }
  wait(requestId, timeoutMs, send) {
    const started = performance.now();
    if (this.dead) return Promise.resolve({ error: this.dead, elapsedMs: 0 });
    return new Promise(resolve => {
      const finish = message => {
        if (!this.pending) return;
        clearTimeout(timer); this.pending = null;
        const elapsedMs = performance.now() - started;
        resolve({ ...message, error: elapsedMs >= timeoutMs ? 'model-timeout' : message.error, elapsedMs });
      };
      const timer = setTimeout(() => { this.dead = 'model-timeout'; finish({ error: 'model-timeout' }); void this.worker.terminate(); }, timeoutMs);
      this.pending = { requestId, finish };
      try { send?.(); } catch { finish({ error: 'model-error' }); }
    });
  }
  ready() { return this.wait(null, 10000); }
  think(request, timeoutMs) { return this.wait(request.requestId, timeoutMs, () => this.worker.postMessage(request)); }
  close() { return this.worker.terminate(); }
}

export async function playGame(job, models, options) {
  let state = structuredClone(job.startState);
  const moves = [], attempts = [], startups = [], clients = [];
  const result = { ...job, openingKey: positionKey(state), moves, attempts, startups, winner: null, termination: null };
  const finish = (winner, termination) => ({ ...result, winner, termination, finalKey: positionKey(state), finalPly: state.ply });
  try {
    for (let side = 0; side < 2; side++) {
      const model = models[side === job.aSide ? 0 : 1];
      const client = new ModelClient(model); clients.push(client);
      const ready = await client.ready();
      startups.push({ side, elapsedMs: ready.elapsedMs, error: ready.error || null });
      if (ready.error) return finish(1 - side, 'model-error');
    }
    for (let count = 0; count < options.maxPlies && state.winner === null; count++) {
      const side = state.turn, model = models[side === job.aSide ? 0 : 1];
      const request = { protocol: 'js-v1', requestId: `game-${job.index}:ply-${state.ply}`, ruleset: state.ruleset,
        state, legalActions: legalActions(state), budgetMs: options.moveMs,
        seed: seedOf(options.seed, job.pairId, model.id, state.ply), config: model.config };
      const response = await clients[side].think(request, options.moveMs);
      let failure = response.error;
      if (!failure && !response.action) failure = 'invalid-response';
      if (!failure && !isLegalAction(state, response.action)) failure = 'illegal-action';
      attempts.push({ side, ply: state.ply + 1, elapsedMs: response.elapsedMs, accepted: !failure, error: failure || null });
      if (failure) return finish(1 - side, failure);
      const action = response.action;
      state = applyAction(state, action, false);
      moves.push({ ply: state.ply, side, action, elapsedMs: response.elapsedMs, info: response.info, positionKey: positionKey(state) });
    }
    return state.winner === null ? finish('draw', 'max-plies') : finish(state.winner, state.termination);
  } finally {
    await Promise.all(clients.map(client => client.close()));
  }
}
