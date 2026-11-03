import test from 'node:test';
import assert from 'node:assert/strict';
import { createLiveClient } from '../src/live.js';
const id='11111111-1111-4111-8111-111111111111';
class Socket {
  static all=[];
  constructor(url){this.url=String(url);this.readyState=0;this.sent=[];Socket.all.push(this);}
  open(){this.readyState=1;this.onopen?.();}
  send(value){this.sent.push(JSON.parse(value));}
  message(value){this.onmessage?.({data:typeof value==='string'?value:JSON.stringify(value)});}
  close(code=1000){this.readyState=3;this.onclose?.({code});}
}
test('live client ignores duplicate/stale/other-scope events and resubscribes for a fresh snapshot after reconnect',async()=>{
  Socket.all=[];const changes=[],client=createLiveClient({WebSocketImpl:Socket,location:{href:'http://localhost:3000/',protocol:'http:'},onChange:m=>changes.push(m)});
  try{
    client.watch('game',id);client.start();const first=Socket.all[0];first.open();assert.deepEqual(first.sent,[{type:'subscribe',scope:'game',id}]);
    const event=(revision,value={revision})=>({type:'snapshot',scope:'game',id,revision,value});
    first.message(event(5));first.message(event(5,{revision:5,serverNow:123}));first.message(event(4));first.message({...event(6),id:'other'});first.message('invalid JSON');
    assert.deepEqual(changes.map(m=>m.revision),[5]);first.message(event(8));assert.deepEqual(changes.map(m=>m.revision),[5,8]);
    first.close(1006);await new Promise(r=>setTimeout(r,600));const second=Socket.all[1];assert.ok(second);second.open();assert.deepEqual(second.sent,[{type:'subscribe',scope:'game',id}]);second.message(event(8));
    assert.deepEqual(changes.map(m=>m.revision),[5,8,8]);assert.equal(client.connected,true);
    first.message(event(99));assert.equal(changes.length,3);
  }finally{client.close();}
});
test('live client derives WSS from location and stops reconnecting after session expiry',async()=>{
  Socket.all=[];let expired=0;const client=createLiveClient({WebSocketImpl:Socket,location:{href:'https://forest-river.trycloudflare.com/records?game=hidden',protocol:'https:'},onChange:()=>{},onExpired:()=>expired++});
  try{client.start();const socket=Socket.all[0];assert.equal(socket.url,'wss://forest-river.trycloudflare.com/ws');socket.open();socket.close(4401);await new Promise(r=>setTimeout(r,600));assert.equal(expired,1);assert.equal(Socket.all.length,1);assert.equal(client.connected,false);}
  finally{client.close();}
});
