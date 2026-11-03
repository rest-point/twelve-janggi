// Trusted team models only. A supervisor remains responsive while a Worker
// computes, so timeouts and parent disconnects terminate even an infinite loop.
import { Worker } from 'node:worker_threads';
let worker,pending,timer,loaded=false;
function stop(){clearTimeout(timer);void worker?.terminate();}
function reply(message){if(process.connected)process.send(message);}
process.on('disconnect',()=>{stop();process.exit(0);});
process.on('message',message=>{
  if(message.type==='load'&&!worker){
    worker=new Worker(new URL('../bench/model-worker.mjs',import.meta.url),{workerData:{entryPath:message.entryPath},env:{},resourceLimits:{maxOldGenerationSizeMb:128}});
    timer=setTimeout(()=>{reply({error:'model-timeout'});stop();},10000);
    worker.on('message',r=>{
      if(r.ready){loaded=true;clearTimeout(timer);reply({ready:true});return;}
      if(!loaded||pending===r.requestId){clearTimeout(timer);pending=null;reply(r);}
    });
    worker.on('error',()=>{clearTimeout(timer);reply({error:'infra-error'});});
    worker.on('exit',()=>{if(!loaded||pending)reply({error:'infra-error'});});
  }else if(message.type==='think'&&loaded&&!pending){
    pending=message.request.requestId;
    timer=setTimeout(()=>{reply({requestId:pending,error:'model-timeout'});pending=null;stop();},message.timeoutMs);
    worker.postMessage(message.request);
  }
});
