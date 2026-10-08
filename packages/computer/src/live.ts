/** Short-lived, bot-bound desktop grants. The account credential never reaches VNC. */
export type DesktopMode = "view" | "control";
type Session = {id:string;botId:string;mode:DesktopMode;ticketHash:string;used:boolean;expires:number;deadline:number};
const LEASE=60_000;
export class DesktopError extends Error {
  constructor(readonly code:string,readonly status:number,message:string){super(message);}
}
const denied=()=>new DesktopError("desktop_session_expired",401,"The desktop session expired. Connect again.");
async function hash(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value))),v=>v.toString(16).padStart(2,"0")).join("");}
export class DesktopSessions {
  private sockets=new Map<string,()=>void>();
  constructor(private storage:DurableObjectStorage,private wait:(promise:Promise<unknown>)=>void){}
  private async sessions(){
    const rows=await this.storage.list<Session>({prefix:"desktop:"});
    const live:Session[]=[];
    for(const [key,s] of rows) {
      if(s.expires<=Date.now()){this.sockets.get(s.id)?.();await this.storage.delete(key);}
      else live.push(s);
    }
    return live;
  }
  async controlled(){return (await this.sessions()).some(s=>s.mode==="control");}
  async create(botId:string,mode:DesktopMode,replaces?:string){
    const sessions=await this.sessions();
    const previous=replaces?sessions.find(s=>s.id===replaces && s.botId===botId && s.mode==="view"):undefined;
    if(replaces && (mode!=="control" || !previous)) throw denied();
    // A control transfer reserves its existing viewer slot while its old Watch
    // socket stays live. It cannot bypass exclusive control or borrow another bot.
    if(sessions.length-(previous?1:0)>=4) throw new DesktopError("desktop_session_limit",429,"Disconnect another desktop viewer before connecting.");
    if(mode==="control" && sessions.some(s=>s.mode==="control")) throw new DesktopError("computer_controlled",409,"Another session has control. Release it or wait for its lease to expire.");
    const ticket=crypto.randomUUID()+crypto.randomUUID(),id=crypto.randomUUID();
    const session:Session={id,botId,mode,ticketHash:await hash(ticket),used:false,expires:Date.now()+LEASE,deadline:Date.now()+3_600_000};
    await this.storage.put(`desktop:${id}`,session);
    return {sessionId:id,protocols:["binary",`timber-ticket.${ticket}`],expiresAt:new Date(session.expires).toISOString()};
  }
  async renew(botId:string,id:string){
    return this.storage.transaction(async tx=>{
      const s=await tx.get<Session>(`desktop:${id}`);
      if(!s || s.botId!==botId || s.expires<=Date.now() || s.deadline<=Date.now()) throw denied();
      s.expires=Math.min(Date.now()+LEASE,s.deadline);
      await tx.put(`desktop:${id}`,s);
      return {expiresAt:new Date(s.expires).toISOString()};
    });
  }
  async release(id:string){this.sockets.get(id)?.();this.sockets.delete(id);await this.storage.delete(`desktop:${id}`);}
  async closeAll(){for(const s of await this.sessions()) await this.release(s.id);}
  async connect(botId:string,request:Request,upstream:(port:number)=>Promise<Response>,touch:()=>Promise<void>):Promise<Response>{
    const protocols=(request.headers.get("sec-websocket-protocol")??"").split(",").map(s=>s.trim());
    const tickets=protocols.filter(s=>s.startsWith("timber-ticket."));
    if(request.method!=="GET" || request.headers.get("upgrade")?.toLowerCase()!=="websocket" || tickets.length!==1 || !/^timber-ticket\.[a-f0-9-]{72}$/.test(tickets[0]) || !protocols.includes("binary")) throw denied();
    const digest=await hash(tickets[0].slice(14));
    // The storage transaction consumes the ticket once, even with simultaneous upgrades.
    const session=await this.storage.transaction(async tx=>{
      const rows=await tx.list<Session>({prefix:"desktop:"});
      const s=[...rows.values()].find(s=>s.botId===botId && s.ticketHash===digest && !s.used && s.expires>Date.now());
      if(!s) throw denied();
      s.used=true;await tx.put(`desktop:${s.id}`,s);return s;
    });
    let remote:WebSocket;
    try {
      const response=await upstream(session.mode==="view"?6080:6081);
      if(response.status!==101 || !response.webSocket) throw new Error("Unavailable");
      remote=response.webSocket;remote.binaryType="arraybuffer";remote.accept();
    } catch {await this.release(session.id);throw new DesktopError("desktop_unavailable",503,"The live desktop is unavailable. Connect again after the computer starts.");}
    const stillValid=await this.storage.get<Session>(`desktop:${session.id}`);
    if(!stillValid || stillValid.expires<=Date.now()){remote.close(1000,"Session ended");throw denied();}
    const pair=new WebSocketPair(),client=pair[0],server=pair[1];server.binaryType="arraybuffer";server.accept();
    let closed=false,timer:ReturnType<typeof setInterval>;
    const close=()=>{
      if(closed) return;closed=true;clearInterval(timer);this.sockets.delete(session.id);
      try{server.close(1000,"Desktop disconnected");}catch{}try{remote.close(1000,"Desktop disconnected");}catch{}
      this.wait(this.storage.delete(`desktop:${session.id}`));
    };
    this.sockets.set(session.id,close);
    // Bound traffic and check the control lease on every input; expiry never grants
    // another browser a window to inject stale input while it takes control.
    let inputs:Promise<unknown>=Promise.resolve();
    server.addEventListener("message",event=>{inputs=inputs.then(async()=>{
      const s=await this.storage.get<Session>(`desktop:${session.id}`);
      if(closed || !s || s.expires<=Date.now()){close();return;}
      if(typeof event.data==="string" || event.data.byteLength>1024*1024){close();return;}
      try{remote.send(event.data);}catch{close();}
    }).catch(close);this.wait(inputs);});
    remote.addEventListener("message",event=>{try{server.send(event.data);}catch{close();}});
    for(const socket of [server,remote]){socket.addEventListener("close",close);socket.addEventListener("error",close);}
    timer=setInterval(()=>{this.wait((async()=>{const s=await this.storage.get<Session>(`desktop:${session.id}`);if(!s || s.expires<=Date.now())close();})());},5000);
    try{await touch();}catch{close();throw new DesktopError("desktop_unavailable",503,"The desktop lifetime could not be renewed. Connect again.");}
    return new Response(null,{status:101,webSocket:client,headers:{"sec-websocket-protocol":"binary","cache-control":"no-store"}});
  }
}
