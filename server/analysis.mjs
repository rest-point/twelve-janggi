import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createPosition, applyAction, legalActions, isLegalAction, positionKey } from '../src/engine.js';
import { ModelProcess } from './model-process.mjs';
import { HttpError, requireThat } from './security.mjs';

// Analysis has no games, clock, match statistics or DB writes. Each request gets
// a fresh permission-restricted model process and a bounded, cancellable lifetime.
export function createAnalysis({ getModel, clientFactory = model => new ModelProcess(model), maxConcurrent = 2, budgetMs = 60000 } = {}) {
  const active = new Map();
  let closed = false;
  return {
    async analyze(guestId, body, { signal } = {}) {
      requireThat(!closed, 503, '분석 엔진이 종료 중입니다.');
      requireThat(Object.keys(body).every(k => ['modelId', 'position', 'actions', 'linePlies'].includes(k)), 422, '지원하지 않는 분석 설정입니다.');
      requireThat(typeof body.modelId === 'string', 422, '분석 모델을 선택하세요.');
      const model = getModel(body.modelId);
      const maxPly = ['azero-v1', 'azero-v2'].includes(model.registryId || model.id) ? 256 : Infinity;
      const linePlies = body.linePlies ?? 3;
      requireThat(Number.isInteger(linePlies) && linePlies >= 1 && linePlies <= 5, 422, '분석 수는 1~5수여야 합니다.');
      const actions = body.actions ?? [];
      requireThat(Array.isArray(actions) && actions.length <= 512, 422, '분석 수순은 최대 512수입니다.');
      let state;
      try {
        requireThat(body.position && Object.keys(body.position).every(k => ['board', 'hands', 'turn'].includes(k)), 422, '국면 형식이 올바르지 않습니다.');
        state = createPosition(body.position);
        for (const action of actions) state = applyAction(state, action, false);
      } catch (error) { throw new HttpError(422, error.message); }
      requireThat(state.winner === null, 422, state.reason || '이미 끝난 국면입니다.');
      requireThat(state.ply < maxPly, 422, `${model.registryId || model.id}은 256수 이상 국면을 지원하지 않습니다. 현재 국면으로 새 분석을 시작하세요.`);
      requireThat(!active.has(guestId), 409, '이전 분석이 실행 중입니다. 잠시 후 다시 시도하세요.');
      requireThat(active.size < maxConcurrent, 429, '다른 국면을 분석 중입니다. 잠시 후 다시 시도하세요.');
      requireThat(!signal?.aborted, 499, '분석이 취소되었습니다.');
      const slot = { client: null };
      active.set(guestId, slot);
      const started = performance.now(), deadline = started + budgetMs;
      const cancel = () => slot.client?.close();
      signal?.addEventListener('abort', cancel, { once: true });
      const remaining = () => Math.max(1, deadline - performance.now());
      const check = () => {
        requireThat(!signal?.aborted && !closed, 499, '분석이 취소되었습니다.');
        requireThat(performance.now() < deadline, 504, '분석 시간이 초과되었습니다.');
      };
      const checkResponse = response => {
        check();
        if (response.error) throw new HttpError(response.error === 'model-timeout' ? 504 : response.error === 'infra-error' ? 503 : 502,
          response.error === 'model-timeout' ? '모델의 분석 시간이 초과되었습니다.' : '모델이 이 국면의 분석에 실패했습니다. 다른 모델을 선택해 보세요.');
      };
      const rootKey = positionKey(state), line = [];
      try {
        check();
        slot.client = clientFactory(model);
        checkResponse(await slot.client.ready());
        for (let index = 0; index < linePlies && state.winner === null; index++) {
          check();
          const response = await slot.client.think({ protocol: 'js-v1', ruleset: state.ruleset, requestId: `analysis_${randomUUID()}`,
            state, legalActions: legalActions(state), config: model.config, budgetMs: remaining(), seed: 20261106 }, remaining());
          checkResponse(response);
          requireThat(isLegalAction(state, response.action), 502, '모델이 합법적이지 않은 추천 수를 반환했습니다.');
          const action = response.action.drop ? { drop: response.action.drop, to: response.action.to } : { from: response.action.from, to: response.action.to };
          const info = {};
          for (const key of ['nodes', 'completedDepth', 'searchMs']) if (Number.isFinite(response.info?.[key]) && response.info[key] >= 0) info[key] = response.info[key];
          line.push({ action, side: state.turn, elapsedMs: response.elapsedMs, info });
          state = applyAction(state, action, false);
          // Preserve the valid prefix for models with an absolute ply horizon.
          if (state.ply >= maxPly) break;
        }
        return { modelId: model.id, positionKey: rootKey, action: line[0].action, line, elapsedMs: performance.now() - started,
          winner: state.winner, termination: state.termination, reason: state.reason };
      } finally {
        signal?.removeEventListener('abort', cancel);
        slot.client?.close();
        active.delete(guestId);
      }
    },
    close() { closed = true; for (const slot of active.values()) slot.client?.close(); },
  };
}
