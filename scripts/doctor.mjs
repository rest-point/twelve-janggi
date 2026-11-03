import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, loadRegistry } from '../bench/common.mjs';
import { RULESET } from '../src/engine.js';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../server/config.mjs';
import { WebSocketServer } from 'ws';
if (typeof DatabaseSync !== 'function') throw new Error('Node.js >=24.7 required (built-in SQLite)');
const args = process.argv.slice(2);
if (args.length > 1 || (args.length && args[0] !== '--prepare')) throw new Error('Usage: node scripts/doctor.mjs [--prepare]');
for (const file of ['README.md', 'src/engine.js', 'src/board-view.js', 'models/registry.json', 'bench/run.mjs', 'scripts/verify-replays.mjs']) await access(path.join(ROOT, file));
const registry = await loadRegistry();
if(typeof WebSocketServer!=='function')throw new Error('Run npm ci to install the locked WebSocket dependency');
console.log(`Project: ${ROOT}\nNode: ${process.version}\nRuleset: ${RULESET}\nModels: ${registry.map(m => m.id).join(', ')}\nNative SQLite and WebSocket server available; guest sessions, no passwords.`);
try { const config = loadConfig(); console.log(`Arena config valid: ${config.profile}; ${config.origin}. Actual DB readiness: /health/ready after npm start.`); }
catch (error) { console.log(`Arena configuration needed: ${error.message}. Follow README; setup does not overwrite .env or create a DB.`); }
if (args[0] === '--prepare') {
  await mkdir(path.join(ROOT, 'artifacts'), { recursive: true });
  console.log('기반 준비 완료. 게스트 방·온라인 전적/기보·WebSocket·100국 모델 대전: .env 설정 후 npm start / 과거 파일 기보: npm run dev / 전체 검증: npm run team:check. stdio는 후속 단계.');
}
