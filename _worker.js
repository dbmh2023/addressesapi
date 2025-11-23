// snippet-only-vless-ws.js
import { connect } from 'cloudflare:sockets';

// Snippet-only: no use of env, defaults embedded
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
let proxyIP = ''; // optional override in code
const DEBUG = false;

const byteToHex=[];for(let i=0;i<256;++i)byteToHex.push((i+256).toString(16).slice(1));
function unsafeStringify(a,o=0){return(byteToHex[a[o+0]]+byteToHex[a[o+1]]+byteToHex[a[o+2]]+byteToHex[a[o+3]]+"-"+byteToHex[a[o+4]]+byteToHex[a[o+5]]+"-"+byteToHex[a[o+6]]+byteToHex[a[o+7]]+"-"+byteToHex[a[o+8]]+byteToHex[a[o+9]]+"-"+byteToHex[a[o+10]]+byteToHex[a[o+11]]+byteToHex[a[o+12]]+byteToHex[a[o+13]]+byteToHex[a[o+14]]+byteToHex[a[o+15]]).toLowerCase();}
function isValidUUID(u){return/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(u);}
function tryStringify(arr){try{const s=unsafeStringify(arr);return isValidUUID(s)?s:null;}catch{return null;}}
function base64ToArrayBuffer(b){if(!b)return{error:null};try{b=b.replace(/-/g,'+').replace(/_/g,'/');const d=atob(b);const u=Uint8Array.from(d,c=>c.charCodeAt(0));return{earlyData:u.buffer,error:null}}catch(e){return{error:e}}}
const WS_OPEN=1,WS_CLOSING=2;
function safeCloseWebSocket(s){try{if(!s)return; if(s.readyState===WS_OPEN||s.readyState===WS_CLOSING) s.close();}catch(e){console.error('safeCloseWebSocket',e)}}
function cleanupAll(ws,rs){try{if(rs?.value)rs.value.close()}catch{};try{safeCloseWebSocket(ws)}catch{}}

// parse vless header safely
function processVlessHeader(buf, expectedUserID){
  if(buf.byteLength<24) return {hasError:true,message:'invalid data'};
  const version=new Uint8Array(buf.slice(0,1));
  const uuid=tryStringify(new Uint8Array(buf.slice(1,17)));
  if(!uuid) return {hasError:true,message:'invalid user'};
  if(uuid!==expectedUserID) return {hasError:true,message:'invalid user'};
  const optLength=new Uint8Array(buf.slice(17,18))[0];
  const cmd=new Uint8Array(buf.slice(18+optLength,18+optLength+1))[0];
  let isUDP=false;
  if(cmd===1){}else if(cmd===2)isUDP=true;else return {hasError:true,message:`command ${cmd} not support`};
  const portIndex=18+optLength+1;
  const portRemote=new DataView(buf.slice(portIndex,portIndex+2)).getUint16(0);
  let addressIndex=portIndex+2;
  const addressType=new Uint8Array(buf.slice(addressIndex,addressIndex+1))[0];
  let addressLength=0,addressValueIndex=addressIndex+1,addressValue='';
  if(addressType===1){addressLength=4;addressValue=new Uint8Array(buf.slice(addressValueIndex,addressValueIndex+4)).join('.')}
  else if(addressType===2){addressLength=new Uint8Array(buf.slice(addressValueIndex,addressValueIndex+1))[0];addressValueIndex+=1;addressValue=new TextDecoder().decode(buf.slice(addressValueIndex,addressValueIndex+addressLength))}
  else if(addressType===3){addressLength=16;const dv=new DataView(buf.slice(addressValueIndex,addressValueIndex+16));const ip6=[];for(let i=0;i<8;i++)ip6.push(dv.getUint16(i*2).toString(16));addressValue=ip6.join(':')}
  else return {hasError:true,message:`invalid addressType ${addressType}`};
  if(!addressValue) return {hasError:true,message:'addressValue is empty'};
  return {hasError:false,addressRemote:addressValue,addressType,portRemote,rawDataIndex:addressValueIndex+addressLength,vlessVersion:version,isUDP};
}

// DoH udp handler with reassembly
async function handleUDPOutBound(webSocket,vlessResponseHeader,log){
  let isVlessHeaderSent=false;
  let pending=new Uint8Array(0);
  const tr=new TransformStream({
    transform(chunk,controller){
      const cb=new Uint8Array(pending.length+chunk.byteLength);cb.set(pending,0);cb.set(new Uint8Array(chunk),pending.length);
      let off=0;
      while(cb.length-off>=2){const len=new DataView(cb.buffer,off,2).getUint16(0); if(cb.length-off-2<len)break; const udp=cb.slice(off+2,off+2+len);controller.enqueue(udp); off+=2+len}
      pending=cb.slice(off);
    }
  });
  tr.readable.pipeTo(new WritableStream({
    async write(chunk){
      const resp=await fetch('https://1.1.1.1/dns-query',{method:'POST',headers:{'content-type':'application/dns-message'},body:chunk});
      const dns=await resp.arrayBuffer(); const l=dns.byteLength; const sizeBuf=new Uint8Array([(l>>8)&0xff,l&0xff]);
      if(webSocket.readyState===WS_OPEN){
        if(isVlessHeaderSent) webSocket.send(await new Blob([sizeBuf,dns]).arrayBuffer());
        else { webSocket.send(await new Blob([vlessResponseHeader,sizeBuf,dns]).arrayBuffer()); isVlessHeaderSent=true; }
      }
    }
  })).catch(e=>log('dns udp error '+e));
  const writer=tr.writable.getWriter();
  return {write(chunk){writer.write(chunk)}};
}

// stream helper
function makeReadableWebSocketStream(ws,earlyDataHeader,log){
  let cancelled=false;
  return new ReadableStream({
    start(controller){
      ws.addEventListener('message',e=>{ if(cancelled) return; controller.enqueue(e.data); });
      ws.addEventListener('close',()=>{ safeCloseWebSocket(ws); if(cancelled) return; controller.close(); });
      ws.addEventListener('error',err=>controller.error(err));
      const {earlyData,error}=base64ToArrayBuffer(earlyDataHeader);
      if(error) controller.error(error);
      else if(earlyData) controller.enqueue(earlyData);
    },
    cancel(r){ cancelled=true; safeCloseWebSocket(ws); }
  });
}

async function remoteSocketToWS(remoteSocket,webSocket,vlessResponseHeader,retry,log){
  let vlessHeader=vlessResponseHeader; let hasIncoming=false;
  await remoteSocket.readable.pipeTo(new WritableStream({
    async write(chunk){ hasIncoming=true; if(webSocket.readyState!==WS_OPEN) throw new Error('websocket not open'); if(vlessHeader){ webSocket.send(await new Blob([vlessHeader,chunk]).arrayBuffer()); vlessHeader=null } else webSocket.send(chunk) },
    close(){ log('remote readable close hasIncoming='+hasIncoming) },
    abort(reason){ console.error('remote abort',reason) }
  })).catch(e=>{ console.error('remoteSocketToWS exc',e); safeCloseWebSocket(webSocket) });
  if(!hasIncoming && retry) { log('retry'); retry(); }
}

async function handleTCPOutBound(remoteSocket,addressRemote,portRemote,rawClientData,webSocket,vlessResponseHeader,log){
  async function connectAndWrite(addr,port){
    const tcpSocket=connect({hostname:addr,port:port});
    remoteSocket.value=tcpSocket; log('connected '+addr+':'+port);
    const w=tcpSocket.writable.getWriter(); await w.write(rawClientData); w.releaseLock();
    return tcpSocket;
  }
  async function retry(){
    try{ if(remoteSocket.value){ try{remoteSocket.value.close()}catch{} remoteSocket.value=null } const tcp=await connectAndWrite(proxyIP||addressRemote,portRemote); tcp.closed.catch(e=>console.log('retry closed',e)).finally(()=>safeCloseWebSocket(webSocket)); remoteSocketToWS(tcp,webSocket,vlessResponseHeader,null,log) }catch(e){ log('retry fail '+e); cleanupAll(webSocket,remoteSocket) }
  }
  try{ const tcp=await connectAndWrite(addressRemote,portRemote); remoteSocketToWS(tcp,webSocket,vlessResponseHeader,retry,log) }catch(e){ log('connect failed '+e); retry() }
}

async function vlessOverWSHandler(request){
  const wp=new WebSocketPair(); const [client,ws]=Object.values(wp); ws.accept();
  let address=''; let portRandom=''; const log=(m)=>{ if(DEBUG)console.log(`[${address}:${portRandom}] ${m}`) };
  const earlyDataHeader=request.headers.get('sec-websocket-protocol')||'';
  const readable=makeReadableWebSocketStream(ws,earlyDataHeader,log);
  let remoteSocket={value:null}; let udpWrite=null; let isDns=false;
  let headerParsed=false; let pendingHeader=new Uint8Array(0); let vlessVersion=new Uint8Array([0]);
  readable.pipeTo(new WritableStream({
    async write(chunk){
      try{
        const nb=new Uint8Array(chunk);
        if(!headerParsed){
          const c=new Uint8Array(pendingHeader.length+nb.length); c.set(pendingHeader,0); c.set(nb,pendingHeader.length); pendingHeader=c;
          if(pendingHeader.byteLength<24) return;
          const parsed=processVlessHeader(pendingHeader.buffer,userID);
          if(parsed.hasError){ cleanupAll(ws,remoteSocket); throw new Error(parsed.message) }
          headerParsed=true; vlessVersion=parsed.vlessVersion; address=parsed.addressRemote; portRandom=`${parsed.portRemote}--${Math.random()} ${parsed.isUDP?'udp':'tcp'}`;
          if(parsed.isUDP){ if(parsed.portRemote===53) isDns=true; else { cleanupAll(ws,remoteSocket); throw new Error('UDP proxy only enable for DNS which is port 53') } }
          const rawClientData=pendingHeader.slice(parsed.rawDataIndex); pendingHeader=new Uint8Array(0);
          const vlessResp=new Uint8Array([vlessVersion[0]||0,0]);
          if(isDns){ const {write}=await handleUDPOutBound(ws,vlessResp,log); udpWrite=write; if(rawClientData&&rawClientData.length) udpWrite(rawClientData); return; }
          handleTCPOutBound(remoteSocket,address,parsed.portRemote,rawClientData,ws,vlessResp,log); return;
        } else {
          if(isDns&&udpWrite){ return udpWrite(nb) }
          if(remoteSocket.value){ const w=remoteSocket.value.writable.getWriter(); await w.write(nb); w.releaseLock(); return }
          // small buffer if remote not ready
          const b=new Uint8Array(pendingHeader.length+nb.length); b.set(pendingHeader,0); b.set(nb,pendingHeader.length); pendingHeader=b;
          return;
        }
      }catch(e){ console.error('ws write err',e); cleanupAll(ws,remoteSocket); throw e; }
    },
    close(){ log('readable close') },
    abort(r){ console.log('readable abort',r) }
  })).catch(e=>console.error('pipeTo err',e));
  return new Response(null,{status:101,webSocket:client});
}

export default { async fetch(request){
  try{
    const up=request.headers.get('Upgrade');
    if(!up || up.toLowerCase()!=='websocket'){
      const url=new URL(request.url);
      if(url.pathname==='/') return new Response(JSON.stringify(request.cf||{}),{status:200});
      if(url.pathname==='/'+userID){ const v=getVLESSConfig(userID,request.headers.get('Host')); return new Response(v,{status:200,headers:{"Content-Type":"text/plain;charset=utf-8"}}) }
      return new Response('Not found',{status:404});
    } else {
      return await vlessOverWSHandler(request);
    }
  }catch(e){ console.error('fetch err',e); return new Response(String(e||'error'),{status:500}); }
}};

function getVLESSConfig(userID,hostName){
  const protocol='vless';
  const vlessMain=`${protocol}://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2048#${hostName}`;
  return `################################################################
v2ray
---------------------------------------------------------------
${vlessMain}
---------------------------------------------------------------
################################################################
clash-meta
---------------------------------------------------------------
- type: vless
  name: ${hostName}
  server: ${hostName}
  port: 443
  uuid: ${userID}
  network: ws
  tls: true
  udp: false
  sni: ${hostName}
  client-fingerprint: chrome
  ws-opts:
    path: "/?ed=2048"
    headers:
      host: ${hostName}
---------------------------------------------------------------
################################################################
`;
}
