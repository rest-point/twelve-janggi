import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { openDatabase } from '../../server/database.mjs';
import { createApplication } from '../../server/app.mjs';
import { loadConfig,ROOT } from '../../server/config.mjs';

export async function fixture(work,desktop=false,options={}) {
  const root=await mkdtemp(path.join(os.tmpdir(),'twelve-guest-http-')),filename=path.join(root,'test.sqlite');
  const base=loadConfig({root,env:{SESSION_SECRET:randomBytes(32).toString('base64url'),...(desktop?{APP_PROFILE:'desktop',APP_ORIGIN:'https://river-stone-forest.trycloudflare.com'}:{})}});
  const config={...base,root:ROOT,dbPath:filename},db=openDatabase(filename),app=createApplication(config,db,{...options,modelOptions:{batchSize:1,...options.modelOptions}});
  await app.ready;
  app.server.listen(0,'127.0.0.1');await once(app.server,'listening');
  const port=app.server.address().port,url=`http://127.0.0.1:${port}`;
  if(!desktop)config.origin=url;
  function client() {
    const c={cookie:'',csrf:''};
    c.call=async(route,method='GET',body,headers={})=>{
      const payload=body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body);
      const result=await new Promise((resolve,reject)=>{
        const req=http.request(url+route,{method,headers:{Host:new URL(config.origin).host,...(desktop?{'x-forwarded-proto':'https'}:{}),...(c.cookie?{Cookie:c.cookie}:{}),...(method==='POST'?{Origin:config.origin,'Content-Type':'application/json','X-CSRF-Token':c.csrf}:{}),...(payload?{'Content-Length':Buffer.byteLength(payload)}:{}),...headers}},res=>{
          const chunks=[];res.on('data',d=>chunks.push(d));res.on('end',()=>resolve({status:res.statusCode,headers:new Headers(Object.entries(res.headers).map(([k,v])=>[k,Array.isArray(v)?v.join(','):v])),text:Buffer.concat(chunks).toString()}));
        });req.on('error',reject);req.end(payload);
      });
      let data;try{data=JSON.parse(result.text);}catch{data=result.text;}
      if(result.headers.get('set-cookie'))c.cookie=result.headers.get('set-cookie').split(';')[0];
      if(data?.csrfToken)c.csrf=data.csrfToken;
      return {...result,data};
    };
    c.enter=async name=>{const r=await c.call('/api/guest/session','POST',name===undefined?{}:{name});assert.equal(r.status,200,JSON.stringify(r.data));return r;};
    return c;
  }
  try{await work({root,db,config,app,url,port,client});}
  finally{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));db.close();assert.equal(path.dirname(root),os.tmpdir());await rm(root,{recursive:true,force:true});}
}
export async function startMatch(a,b) {
  let room=(await a.call('/api/rooms','POST',{title:'테스트 대국'})).data;
  room=(await b.call(`/api/rooms/${room.id}/join`,'POST',{})).data;
  room=(await a.call(`/api/rooms/${room.id}/ready`,'POST',{ready:true,expectedRevision:room.revision})).data;
  room=(await b.call(`/api/rooms/${room.id}/ready`,'POST',{ready:true,expectedRevision:room.revision})).data;
  assert.equal(room.status,'playing');const game=(await a.call(`/api/games/${room.gameId}`)).data;
  return {room,game,actor:game.state.turn===0?a:b};
}
