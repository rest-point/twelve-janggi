import { WebSocketServer } from 'ws';
import { checkTransport,checkOrigin,requireThat } from './security.mjs';

// Read-only snapshots. Every mutation still passes through the HTTP referee,
// guest/CSRF checks and its durable requestId/revision transaction.
export function createLive(server,{config,guests,games,rooms,models,isReady}){
  const wss=new WebSocketServer({noServer:true,maxPayload:4096,perMessageDeflate:false});let closed=false;
  function send(ws,value){
    if(ws.readyState!==1)return;
    if(ws.bufferedAmount>1024*1024){ws.close(1013,'slow connection');return;}
    ws.send(JSON.stringify(value));
  }
  function push(ws){
    if(ws.readyState!==1)return;
    const session=guests.session(ws.request);if(!session){ws.close(4401,'session expired');return;}
    const {scope,id}=ws.watch;
    try{
      let value,revision;
      if(scope==='game'){
        requireThat(!models.gameDeleted(id),404,'대국을 찾을 수 없습니다.');value=games.get(id);revision=value.revision;
      }else if(scope==='room'){value=rooms.get(id);revision=value.revision;}
      else {value=rooms.list(session.guest.id);revision=ws.sequence+1;}
      const stable={...value};delete stable.serverNow;const key=JSON.stringify(stable);
      if(key!==ws.snapshotKey){ws.snapshotKey=key;ws.sequence++;send(ws,{type:'snapshot',scope,id:id||null,revision,value});}
    }catch(error){
      const status=error.status||503,key=`error:${status}`;
      if(ws.snapshotKey!==key){ws.snapshotKey=key;send(ws,{type:'unavailable',scope,id:id||null,status});}
    }
  }
  server.on('upgrade',(req,socket,head)=>{
    socket.on('error',()=>{});
    try{
      checkTransport(req,config);checkOrigin(req,config);guests.required(req);
      requireThat(req.method==='GET'&&req.url==='/ws',404,'소켓을 찾을 수 없습니다.');
      requireThat(!closed&&isReady(),503,'서버 준비 중입니다.');
      wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
    }catch(error){socket.end(`HTTP/1.1 ${error.status||500} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);}
  });
  wss.on('connection',(ws,req)=>{
    ws.request=req;ws.watch={scope:'lobby'};ws.snapshotKey=null;ws.sequence=0;ws.alive=true;
    ws.on('error',()=>{});ws.on('pong',()=>{ws.alive=true;});
    ws.on('message',(data,binary)=>{
      try{
        requireThat(!binary,400,'텍스트 요청이 필요합니다.');const body=JSON.parse(data);
        requireThat(body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).every(k=>['type','scope','id'].includes(k)),400,'잘못된 구독입니다.');
        requireThat(body.type==='subscribe'&&['lobby','room','game'].includes(body.scope),400,'읽기 전용 구독만 가능합니다.');
        requireThat(body.scope==='lobby'?body.id===undefined:typeof body.id==='string'&&/^[a-f0-9-]{36}$/.test(body.id),400,'잘못된 구독 ID입니다.');
        ws.watch={scope:body.scope,id:body.id};ws.snapshotKey=null;push(ws);
      }catch{ws.close(1008,'invalid subscription');}
    });
    push(ws);
  });
  const heartbeat=setInterval(()=>{for(const ws of wss.clients){if(!ws.alive){ws.terminate();continue;}ws.alive=false;ws.ping();}},30000);heartbeat.unref();
  function close(){if(closed)return;closed=true;clearInterval(heartbeat);for(const ws of wss.clients)ws.terminate();wss.close();}
  const originalClose=server.close.bind(server);
  server.close=(...args)=>{close();return originalClose(...args);};
  return {tick(){if(!closed&&isReady())for(const ws of wss.clients)push(ws);},close,clients:wss.clients};
}
