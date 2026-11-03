// Manual, temporary connection test on this computer. The original .env and
// development/production databases are never rewritten by this launcher.
import {spawn,fork,execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,appendFileSync,mkdirSync,existsSync} from 'node:fs';
import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {loadConfig,ROOT} from '../server/config.mjs';

const statePath=path.join(ROOT,'data/quick-tunnel-session.json'),controlPath=path.join(ROOT,'data/quick-tunnel-control.json');
const args=process.argv.slice(2);
if(args.length){
  if(args.length!==1||!['--stop','--close'].includes(args[0]))throw Error('Usage: node scripts/quick-tunnel.mjs [--close|--stop]');
  const state=JSON.parse(readFileSync(statePath,'utf8'));
  try{process.kill(state.pid,0);}catch{throw Error('Quick Tunnel launcher is not running.');}
  writeFileSync(controlPath,JSON.stringify({instance:state.instance,id:randomUUID(),action:args[0]==='--close'?'tunnel-only':'all'}));
  console.log(args[0]==='--close'?'Tunnel close requested; local app/batches stay running.':'Tunnel and app shutdown requested.');
}else await start();

async function start(){
  const base=loadConfig();
  await new Promise((resolve,reject)=>{const probe=createServer();probe.once('error',()=>reject(Error('Port 3000 is busy. Stop the existing app normally before npm run tunnel.')));probe.listen(3000,'127.0.0.1',()=>probe.close(resolve));});
  mkdirSync(path.dirname(statePath),{recursive:true});
  const localBinary=path.join(ROOT,'artifacts/tools/cloudflared.exe');
  const binary=process.env.CLOUDFLARED_BIN||(existsSync(localBinary)?localBinary:'cloudflared');
  const state={instance:randomUUID(),pid:process.pid,status:'starting',origin:null,dbPath:'data/quick-tunnel-test.sqlite',startedAt:new Date().toISOString(),node:process.version,os:os.version()};
  state.cloudflared=execFileSync(binary,['--version'],{encoding:'utf8',windowsHide:true,timeout:5000}).trim();
  state.logPath='artifacts/quick-tunnel-'+state.instance+'.log';
  let tunnel,app,stopping=false,tunnelClosed=false,startingApp=false,lastControl=null,tail='';
  const save=()=>writeFileSync(statePath,JSON.stringify(state,null,2)+'\n');save();
  let control;
  async function shutdown(){
    if(stopping)return;stopping=true;clearInterval(control);tunnelClosed=true;
    if(tunnel&&tunnel.exitCode===null)tunnel.kill();
    if(app&&app.exitCode===null){
      if(app.connected)app.send('shutdown');
      await new Promise(resolve=>{const timer=setTimeout(()=>{app.kill();resolve();},7000);app.once('exit',()=>{clearTimeout(timer);resolve();});});
    }
    state.status='stopped';save();console.log('Tunnel and local test app stopped. Test database preserved.');
  }
  const fail=error=>{console.error(error.message);process.exitCode=1;void shutdown();};
  process.once('SIGINT',()=>void shutdown());process.once('SIGTERM',()=>void shutdown());
  control=setInterval(()=>{
    try{
      const request=JSON.parse(readFileSync(controlPath,'utf8'));
      if(request.instance!==state.instance||request.id===lastControl)return;lastControl=request.id;
      if(request.action==='all')void shutdown();
      else if(request.action==='tunnel-only'){
        tunnelClosed=true;tunnel?.kill();state.status=app?'local-only':'closed';save();
        console.log('Public tunnel closed. Local app/batches continue; npm run tunnel:stop ends the app.');
      }
    }catch{/* No control request, or an incomplete atomic filesystem write. */}
  },500);
  tunnel=spawn(binary,['--no-autoupdate','tunnel','--url','http://127.0.0.1:3000'],{cwd:ROOT,windowsHide:true,stdio:['ignore','pipe','pipe']});
  state.tunnelPid=tunnel.pid;save();
  tunnel.once('error',()=>fail(Error('cloudflared could not start. Install the official executable or set CLOUDFLARED_BIN.')));
  tunnel.once('exit',code=>{
    if(stopping)return;
    if(!app){fail(Error('cloudflared ended before app startup ('+code+'). '+tail.slice(-500)));return;}
    state.status='local-only';save();if(!tunnelClosed)console.error('Tunnel disconnected. Local app/batches remain running. '+tail.slice(-300));
  });
  const startup=setTimeout(()=>{if(!app)fail(Error('cloudflared did not supply a Quick Tunnel URL within 60 seconds. '+tail.slice(-500)));},60000);startup.unref();
  function output(chunk){
    appendFileSync(path.join(ROOT,state.logPath),chunk);
    tail=(tail+chunk.toString()).slice(-10000);
    const version=tail.match(/Version (\d{4}\.\d+\.\d+)/);if(version)state.cloudflared=version[1];
    const match=tail.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)*\.trycloudflare\.com/);
    if(match&&!startingApp&&!stopping&&!tunnelClosed){startingApp=true;clearTimeout(startup);void launch(match[0]).catch(fail);}
  }
  tunnel.stdout.on('data',output);tunnel.stderr.on('data',output);
  async function launch(origin){
    const env={...process.env,APP_PROFILE:'desktop',APP_ORIGIN:origin,API_HOST:'127.0.0.1',API_PORT:'3000',PUBLIC_ACCESS:'quick-tunnel',SESSION_COOKIE_SECURE:'true',TRUST_PROXY:'loopback',SQLITE_PATH:state.dbPath,SESSION_SECRET:base.secret,MODEL_MOVE_MS:'60000',INTERACTIVE_MOVE_MS:'60000',BATCH_CONCURRENCY:'2'};
    loadConfig({env});state.origin=origin;save();
    app=fork(path.join(ROOT,'server/start.mjs'),[],{cwd:ROOT,env,windowsHide:true,silent:true});state.appPid=app.pid;save();
    app.stdout.on('data',chunk=>process.stdout.write(chunk));app.stderr.on('data',chunk=>process.stderr.write(chunk));
    app.once('error',fail);app.once('exit',code=>{if(!stopping)fail(Error('Test app ended ('+code+').'));});
    let ready=false,lastError='';
    for(let i=0;i<60&&!stopping&&!tunnelClosed;i++){
      try{const response=await fetch(origin+'/health/ready',{signal:AbortSignal.timeout(2500)});if(response.ok&&(await response.json()).ready){ready=true;break;}lastError='HTTP '+response.status;}catch(error){lastError=error.cause?.code||error.message;}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    if(stopping||tunnelClosed)return;
    state.status=ready?'ready':'awaiting-public-check';state.publicHealth=ready;save();
    console.log('\nTemporary HTTPS URL: '+origin+'\nTest SQLite: '+state.dbPath+'\n'+(ready?'Public health check passed.':'Public health check pending: '+lastError)+'\nClose public access only: npm run tunnel:close\nStop tunnel and app: npm run tunnel:stop');
  }
}
