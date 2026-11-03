import { fork } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './config.mjs';

export class ModelProcess {
  constructor(model){
    const reads=[path.join(ROOT,'package.json'),path.join(ROOT,'src/engine.js'),path.join(ROOT,'bench/model-worker.mjs'),
      model.entryPath,...Object.keys(model.digests||{}).map(f=>path.resolve(ROOT,'models',f))];
    this.child=fork(fileURLToPath(new URL('./model-host.mjs',import.meta.url)),[],{
      cwd:path.join(ROOT,'models'),env:process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{},windowsHide:true,
      execArgv:['--permission','--allow-worker',...reads.map(f=>'--allow-fs-read='+f)],stdio:['ignore','ignore','ignore','ipc'],
    });
    this.closed=false;this.dead=null;this.pending=null;
    this.child.on('message',r=>{
      if(!this.pending)return;
      if(this.pending.id===null ? r.ready||r.error : r.requestId===this.pending.id||r.error==='infra-error')this.pending.finish(r);
    });
    this.child.on('error',()=>{this.dead='infra-error';this.pending?.finish({error:this.dead});});
    this.child.on('exit',()=>{this.dead='infra-error';this.pending?.finish({error:this.dead});});
    this.startup=this.wait(null,11000,()=>this.child.send({type:'load',entryPath:model.entryPath}));
  }
  wait(id,timeoutMs,send){
    if(this.dead)return Promise.resolve({error:this.dead,elapsedMs:0});
    const at=performance.now();
    return new Promise(resolve=>{
      const finish=r=>{if(!this.pending)return;clearTimeout(timer);this.pending=null;const elapsedMs=performance.now()-at;
        resolve({...r,error:elapsedMs>=timeoutMs?'model-timeout':r.error,elapsedMs});};
      const timer=setTimeout(()=>{finish({error:'model-timeout'});this.close();},timeoutMs);
      this.pending={id,finish};try{send();}catch{finish({error:'infra-error'});}
    });
  }
  ready(){return this.startup;}
  think(request,timeoutMs){return this.wait(request.requestId,Math.max(1,timeoutMs),()=>this.child.send({type:'think',request,timeoutMs}));}
  close(){if(this.closed)return;this.closed=true;this.pending?.finish({error:'infra-error'});if(this.child.connected)this.child.disconnect();this.child.kill();}
}
