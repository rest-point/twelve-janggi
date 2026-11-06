import { mkdir, copyFile, cp, rm } from 'node:fs/promises';
import path from 'node:path';

const root=path.resolve('.');
const output=path.resolve(root,'dist');
if(path.dirname(output)!==root||path.basename(output)!=='dist')throw new Error('Invalid build output path');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const name of ['index.html', 'experiments.html', 'analysis.html', 'records.html', 'favicon.svg']) await copyFile(name, path.join(output,name));
await cp('src', path.join(output,'src'), { recursive: true });
console.log('Built twelve-janggi → dist/');
