import { parentPort, workerData } from 'node:worker_threads';
import { playGame } from './referee.mjs';
parentPort.on('message', async job => {
  try {
    const game = await playGame(job, workerData.models, workerData.options);
    parentPort.postMessage({ game });
  } catch (error) {
    parentPort.postMessage({ infraError: String(error.message).slice(0, 300) });
  }
});
