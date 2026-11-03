import { parentPort, workerData } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';

try {
  const { think } = await import(pathToFileURL(workerData.entryPath));
  if (typeof think !== 'function') throw new Error('Model must export think(request)');
  parentPort.on('message', async request => {
    try {
      const result = await think(request);
      // Whitelist bounded plain output before passing it to the referee.
      const raw = result?.action;
      let action = null;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const keys = Object.keys(raw);
        if (keys.length <= 2 && keys.every(k => ['from', 'to', 'drop'].includes(k)) && keys.includes('to') && Number.isInteger(raw.to)) {
          if (keys.includes('from') && Number.isInteger(raw.from)) action = { from: raw.from, to: raw.to };
          if (keys.includes('drop') && typeof raw.drop === 'string' && raw.drop.length <= 12) action = { drop: raw.drop, to: raw.to };
        }
      }
      const info = {};
      for (const key of ['nodes', 'completedDepth', 'searchMs']) if (Number.isFinite(result?.info?.[key]) && result.info[key] >= 0) info[key] = result.info[key];
      parentPort.postMessage({ requestId: request.requestId, action, info });
    } catch {
      parentPort.postMessage({ requestId: request.requestId, error: 'model-error' });
    }
  });
  parentPort.postMessage({ ready: true });
} catch {
  parentPort.postMessage({ error: 'model-error' });
}
