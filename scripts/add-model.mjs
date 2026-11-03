import { readFile, writeFile, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT, loadRegistry } from '../bench/common.mjs';
import { RULESET } from '../src/engine.js';
const args = process.argv.slice(2);
let id, author = 'team-member';
for (let i = 0; i < args.length; i += 2) {
  if (!args[i + 1]) throw new Error('Usage: node scripts/add-model.mjs --id alice-greedy-v1 [--author Alice]');
  if (args[i] === '--id' && !id) id = args[i + 1];
  else if (args[i] === '--author') author = args[i + 1];
  else throw new Error(`Unknown option: ${args[i]}`);
}
if (!id || !/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) throw new Error('id: lowercase letters, digits, hyphen; 1..80 characters');
const lockPath = path.join(ROOT, 'models', '.registry.lock');
const lock = await open(lockPath, 'wx');
const temp = path.join(ROOT, 'models', `.registry-${randomUUID()}.tmp`);
let tempWritten = false;
try {
  const registry = await loadRegistry();
  if (registry.some(m => m.id === id)) throw new Error(`Already registered: ${id}`);
  const manifestPath = path.join(ROOT, 'models', 'registry.json');
  const raw = JSON.parse(await readFile(manifestPath, 'utf8'));
  const entry = `./${id}.mjs`;
  const content = `// Replace this baseline with your search algorithm; never mutate referee state.\nexport function think({ legalActions }) {\n  if (!legalActions.length) throw new Error('No legal actions');\n  return { action: legalActions[0], info: { nodes: 1, completedDepth: 0 } };\n}\n`;
  await writeFile(path.join(ROOT, 'models', `${id}.mjs`), content, { flag: 'wx' });
  raw.push({ id, name: id, version: '1.0.0', protocol: 'js-v1', ruleset: RULESET, entry, config: {}, files: [], author });
  await writeFile(temp, JSON.stringify(raw, null, 2) + '\n', { flag: 'wx' });
  tempWritten = true;
  await rename(temp, manifestPath);
  tempWritten = false;
  console.log(`Created models/${id}.mjs and registered ${id}.\nEdit think(request), then:\nnpm run evaluate -- --a ${id} --b greedy-v1 --games 100 --concurrency 2\nIf a released model changes, create a new ID/version.`);
} finally {
  if (tempWritten) await unlink(temp);
  await lock.close();
  await unlink(lockPath);
}
