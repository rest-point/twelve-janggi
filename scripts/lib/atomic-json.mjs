import { writeFile, rename } from 'node:fs/promises';

// Windows indexers/sync clients can briefly hold the destination open.
// Preserve the old checkpoint until the complete replacement can be renamed.
export async function writeJsonAtomic(filename, value) {
  const temporary = filename + '.' + process.pid + '.tmp';
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n');
  for (let attempt = 0; ; attempt++) {
    try { await rename(temporary, filename); return; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 12) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, 50 * 2 ** attempt)));
    }
  }
}
