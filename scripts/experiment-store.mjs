import { readFile, readdir, realpath } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';

const runPattern = /^\d{4}-\d{2}-\d{2}T[\dTZ.-]+-[a-f0-9]{8}$/;
export class RecordError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function createExperimentStore(artifacts) {
  async function runFile(id, name) {
    if (!runPattern.test(id)) throw new RecordError('올바르지 않은 실험 ID입니다.');
    try {
      const base = await realpath(artifacts);
      const file = await realpath(path.join(base, id, name));
      if (!file.startsWith(path.join(base, id) + path.sep)) throw new RecordError('허용하지 않는 기록 경로입니다.', 403);
      return file;
    } catch (error) {
      if (error.code === 'ENOENT') throw new RecordError('기록을 찾을 수 없습니다.', 404);
      throw error;
    }
  }
  async function json(id, name, optional = false) {
    try { return JSON.parse(await readFile(await runFile(id, name), 'utf8')); }
    catch (error) {
      if (optional && error.status === 404) return null;
      if (error instanceof SyntaxError) throw new RecordError('손상된 실험 메타데이터입니다.', 422);
      throw error;
    }
  }
  async function records(id) {
    const file = await runFile(id, 'games.jsonl');
    const games = [], indices = new Set();
    let lineNumber = 0;
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    for await (const line of lines) {
      lineNumber++;
      if (!line.trim()) continue;
      let game;
      try { game = JSON.parse(line); }
      catch { throw new RecordError(`${lineNumber}번째 줄의 기보가 손상되었거나 기록 중입니다. 잠시 후 새로고침하세요.`, 422); }
      if (game.runId !== id || !Number.isSafeInteger(game.index) || game.index < 0 || indices.has(game.index) || !Array.isArray(game.moves) || !Array.isArray(game.opening) || !game.startState) throw new RecordError('대국 ID 또는 기보 형식이 올바르지 않습니다.', 422);
      indices.add(game.index); games.push(game);
    }
    return games.sort((a, b) => a.index - b.index);
  }
  async function metadata(id) {
    const config = await json(id, 'config.json');
    if (config.runId !== id || !config.options || !Number.isSafeInteger(config.options.games) || config.options.games < 1) throw new RecordError('실험 설정과 ID가 일치하지 않습니다.', 422);
    const summary = await json(id, 'summary.json', true);
    if (summary && (summary.runId !== id || summary.configHash !== config.configHash)) throw new RecordError('실험 요약과 설정이 일치하지 않습니다.', 422);
    return { id, createdAt: config.createdAt, models: { a: config.options.a, b: config.options.b }, expectedGames: config.options.games,
      recordedGames: summary?.games ?? null, status: summary ? 'completed' : 'incomplete', summary, config };
  }
  return {
    async list() {
      let entries;
      try { entries = await readdir(artifacts, { withFileTypes: true }); }
      catch (error) { if (error.code === 'ENOENT') return []; throw error; }
      const results = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !runPattern.test(entry.name)) continue;
        try {
          const { config, ...item } = await metadata(entry.name);
          results.push(item);
        } catch (error) { results.push({ id: entry.name, status: 'error', error: error.message }); }
      }
      return results.sort((a, b) => b.id.localeCompare(a.id));
    },
    async detail(id) {
      const meta = await metadata(id);
      let games;
      try { games = await records(id); }
      catch (error) { if (error.status === 404 && !meta.summary) games = []; else throw error; }
      if (meta.summary && games.length !== meta.expectedGames) throw new RecordError('완료 표시와 실제 기보 건수가 일치하지 않습니다.', 422);
      if(meta.summary?.participants){
        const sum=[0,0],count=[0,0];
        for(const game of games)for(const move of game.moves){const slot=move.side===game.aSide?0:1;sum[slot]+=move.elapsedMs;count[slot]++;}
        meta.summary={...meta.summary,participants:meta.summary.participants.map((p,i)=>({...p,timing:{...p.timing,meanMs:count[i]?sum[i]/count[i]:null}}))};
      }
      return { ...meta, recordedGames: games.length, games: games.map(game => ({ index: game.index, first: game.first, aSide: game.aSide,
        winner: game.winner, termination: game.termination, plies: game.moves.length, openingPlies: game.opening.length,
        elapsedMs: game.moves.reduce((sum, move) => sum + move.elapsedMs, 0) })) };
    },
    async game(id, index) {
      if (!Number.isSafeInteger(index) || index < 0) throw new RecordError('올바르지 않은 대국 번호입니다.');
      await metadata(id);
      const game = (await records(id)).find(game => game.index === index);
      if (!game) throw new RecordError('대국을 찾을 수 없습니다.', 404);
      return game;
    },
  };
}
