// Transport notifications never adjudicate a move. The caller reloads the
// authoritative HTTP snapshot, including after reconnect and missed revisions.
export function createLiveClient({onChange,onExpired=()=>{},WebSocketImpl=globalThis.WebSocket,location=globalThis.location}={}){
  let socket=null,enabled=false,closed=false,retry=null,delay=500,generation=0;
  let watch={scope:'lobby'},lastRevision=-1,lastValue=null;
  function subscribe(){lastRevision=-1;lastValue=null;if(socket?.readyState===1)socket.send(JSON.stringify({type:'subscribe',...watch}));}
  function connect(){
    if(!enabled||closed||socket&&socket.readyState<2||!WebSocketImpl)return;
    const ticket=++generation,url=new URL('/ws',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';
    try{socket=new WebSocketImpl(url);}catch{schedule();return;}
    socket.onopen=()=>{if(ticket!==generation)return;delay=500;subscribe();};
    socket.onmessage=event=>{
      if(ticket!==generation)return;
      try{
        const message=JSON.parse(event.data);
        if(message.scope!==watch.scope||(message.id||undefined)!==watch.id)return;
        if(message.type==='unavailable'){const key='error:'+message.status;if(lastValue!==key){lastValue=key;onChange(message);}return;}
        if(message.type!=='snapshot'||!Number.isSafeInteger(message.revision)||message.revision<0||message.revision<lastRevision)return;
        const stable={...message.value};delete stable.serverNow;const value=JSON.stringify(stable);
        if(message.revision===lastRevision&&value===lastValue)return;
        lastRevision=message.revision;lastValue=value;onChange(message);
      }catch{/* Malformed/stale notifications cannot change the board. */}
    };
    socket.onerror=()=>{};
    socket.onclose=event=>{if(ticket!==generation)return;socket=null;if(event.code===4401){enabled=false;onExpired();return;}schedule();};
  }
  function schedule(){if(!enabled||closed||retry)return;retry=setTimeout(()=>{retry=null;connect();},delay);delay=Math.min(10000,delay*2);}
  return {
    start(value=true){enabled=value;if(enabled)connect();else{clearTimeout(retry);retry=null;generation++;socket?.close();socket=null;}},
    watch(scope,id){const next={scope,...(id?{id}:{})};if(JSON.stringify(next)===JSON.stringify(watch))return;watch=next;subscribe();},
    get connected(){return socket?.readyState===1;},
    close(){closed=true;enabled=false;generation++;clearTimeout(retry);socket?.close();socket=null;},
  };
}
