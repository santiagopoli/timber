/** Human PTY grants are bot-scoped, one-use and never carry an account credential. */
export const SHELL_PROTOCOL = "timber-shell.v1";
const LEASE = 60_000;
const FRAME = 16 * 1024;
const WINDOW = 256 * 1024;
const OUTPUT = 16 * 1024 * 1024;
const encoder = new TextEncoder();
export interface ShellSession {id:string;botId:string;ticketHash:string;used:boolean;closing?:boolean;expires:number;deadline:number;}
export class ShellError extends Error {
  constructor(readonly code:string,readonly status:number,message:string){super(message);}
}
const denied = () => new ShellError("shell_session_expired",401,"The shell session expired. Open a new shell.");
const unavailable = () => new ShellError("shell_unavailable",503,"The shell connection is unavailable. Its shutdown must be confirmed before opening a new shell.");
async function hash(value:string):Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256",encoder.encode(value)))].map(v=>v.toString(16).padStart(2,"0")).join("");
}
export class ShellSessions {
  private sockets = new Map<string,()=>void>();
  private releases = new Map<string,Promise<void>>();
  constructor(private storage:DurableObjectStorage,private wait:(promise:Promise<unknown>)=>void,
    private stop:(session:ShellSession)=>Promise<void>,private renewed:(session:ShellSession)=>Promise<void>,private ended:()=>Promise<void>){}
  async active():Promise<boolean> {
    // A passive control query must not dispatch cleanup or lose its fail-closed
    // answer on a transient shutdown failure. Maintenance owns expiry cleanup.
    return (await this.storage.list<ShellSession>({prefix:"shell:"})).size>0;
  }
  async sweep():Promise<void> {
    for(const s of (await this.storage.list<ShellSession>({prefix:"shell:"})).values()) {
      if(s.closing || s.expires<=Date.now() || s.deadline<=Date.now()) await this.release(s.botId,s.id);
    }
  }
  async create(botId:string):Promise<{sessionId:string;protocols:string[];expiresAt:string}> {
    await this.sweep();
    const ticket = crypto.randomUUID()+crypto.randomUUID(),ticketHash=await hash(ticket);
    const session=await this.storage.transaction(async tx=>{
      if((await tx.list({prefix:"shell:"})).size) throw new ShellError("shell_session_limit",409,"Another shell is open. Close it before opening a new one.");
      const s:ShellSession={id:crypto.randomUUID(),botId,ticketHash,used:false,expires:Date.now()+LEASE,deadline:Date.now()+3_600_000};
      await tx.put(`shell:${s.id}`,s);return s;
    });
    return {sessionId:session.id,protocols:[SHELL_PROTOCOL,`timber-shell-ticket.${ticket}`],expiresAt:new Date(session.expires).toISOString()};
  }
  async renew(botId:string,id:string):Promise<{expiresAt:string}> {
    const s=await this.storage.transaction(async tx=>{
      const s=await tx.get<ShellSession>(`shell:${id}`);
      if(!s || s.botId!==botId || s.closing || s.expires<=Date.now() || s.deadline<=Date.now()) throw denied();
      s.expires=Math.min(Date.now()+LEASE,s.deadline);await tx.put(`shell:${id}`,s);return s;
    });
    // A failed renewal closes the PTY; it cannot silently leave a longer lease.
    if(s.used) try {await this.renewed(s);} catch {await this.release(botId,id);throw unavailable();}
    return {expiresAt:new Date(s.expires).toISOString()};
  }
  async release(botId:string,id:string):Promise<void> {
    const existing=this.releases.get(id);if(existing) return existing;
    const work=(async()=>{
      const s=await this.storage.get<ShellSession>(`shell:${id}`);
      if(!s) return;
      if(s.botId!==botId) throw denied();
      s.closing=true;await this.storage.put(`shell:${id}`,s);
      this.sockets.get(id)?.();this.sockets.delete(id);
      // Keep a closing record if cleanup is unconfirmed: checkpoint and new
      // grants remain fenced, and the maintenance alarm retries only cleanup.
      // Fence even an unused ticket: its upgrade may be concurrently in flight.
      await this.stop(s);
      await this.storage.delete(`shell:${id}`);
      await this.ended();
    })().finally(()=>this.releases.delete(id));
    this.releases.set(id,work);return work;
  }
  async closeAll():Promise<void> {
    for(const s of (await this.storage.list<ShellSession>({prefix:"shell:"})).values()) await this.release(s.botId,s.id);
  }
  async connect(botId:string,request:Request,upstream:(session:ShellSession)=>Promise<Response>,beforeStart:()=>Promise<void>,touch:()=>Promise<void>):Promise<Response> {
    const protocols=(request.headers.get("sec-websocket-protocol")??"").split(",").map(s=>s.trim());
    const tickets=protocols.filter(s=>s.startsWith("timber-shell-ticket."));
    if(request.method!=="GET" || request.headers.get("upgrade")?.toLowerCase()!=="websocket" || protocols.length!==2 || !protocols.includes(SHELL_PROTOCOL) || tickets.length!==1 || !/^timber-shell-ticket\.[a-f0-9-]{72}$/.test(tickets[0])) throw denied();
    const digest=await hash(tickets[0].slice("timber-shell-ticket.".length));
    const session=await this.storage.transaction(async tx=>{
      const s=[...(await tx.list<ShellSession>({prefix:"shell:"})).values()].find(s=>s.botId===botId && s.ticketHash===digest && !s.used && !s.closing && s.expires>Date.now() && s.deadline>Date.now());
      if(!s) throw denied();
      s.used=true;await tx.put(`shell:${s.id}`,s);return s;
    });
    let remote:WebSocket;
    try {
      // Persist save intent BEFORE the shell can modify the filesystem.
      await beforeStart();
      const response=await upstream(session);
      if(response.status!==101 || !response.webSocket) throw unavailable();
      remote=response.webSocket;
    } catch {
      await this.release(botId,session.id);throw unavailable();
    }
    const stillValid=await this.storage.get<ShellSession>(`shell:${session.id}`);
    if(!stillValid || stillValid.closing || stillValid.expires<=Date.now()) {remote.accept();remote.close(1000,"Session ended");await this.release(botId,session.id);throw denied();}
    const pair=new WebSocketPair(),client=pair[0],server=pair[1];server.accept();
    let closed=false,timer:ReturnType<typeof setInterval>|undefined;
    const closeSockets=()=>{
      if(closed)return;closed=true;clearInterval(timer);
      for(const socket of [server,remote])try {socket.close(1000,"Shell disconnected");}catch{}
    };
    const close=()=>{closeSockets();this.wait(this.release(botId,session.id).catch(()=>{}));};
    this.sockets.set(session.id,closeSockets);
    let inputs:Promise<void>=Promise.resolve(),queued=0,totalOutput=0,sequence=0,acked=0,outstanding=0;
    const pending=new Map<number,number>();
    let inputWindowAt=Date.now(),inputBytes=0,totalInput=0;
    server.addEventListener("message",event=>{
      if(closed)return;
      if(typeof event.data!=="string" || encoder.encode(event.data).length>FRAME || ++queued>32){close();return;}
      const data=event.data;
      inputs=inputs.then(async()=>{
        if(closed)return;
        const s=await this.storage.get<ShellSession>(`shell:${session.id}`);
        if(!s || s.closing || s.expires<=Date.now() || s.deadline<=Date.now()){close();return;}
        const input=JSON.parse(data) as {type?:unknown;data?:unknown;cols?:unknown;rows?:unknown;seq?:unknown};
        if(input.type==="ack") {
          if(!Number.isSafeInteger(input.seq) || (input.seq as number)<acked || (input.seq as number)>sequence) {close();return;}
          acked=input.seq as number;
          for(const [seq,bytes] of pending) if(seq<=acked){outstanding-=bytes;pending.delete(seq);}
          return;
        }
        if(Date.now()-inputWindowAt>=1000){inputWindowAt=Date.now();inputBytes=0;}
        const bytes=encoder.encode(data).length;inputBytes+=bytes;totalInput+=bytes;
        if(inputBytes>64*1024 || totalInput>16*1024*1024){close();return;}
        if(input.type==="input" && typeof input.data==="string") remote.send(JSON.stringify({type:"input",data:input.data}));
        else if(input.type==="resize" && Number.isInteger(input.cols) && Number.isInteger(input.rows) && (input.cols as number)>=1 && (input.cols as number)<=500 && (input.rows as number)>=1 && (input.rows as number)<=200) remote.send(JSON.stringify({type:"resize",cols:input.cols,rows:input.rows}));
        else close();
      }).catch(close).finally(()=>{queued--;});
      this.wait(inputs);
    });
    remote.addEventListener("message",event=>{
      if(closed)return;
      try {
        if(typeof event.data!=="string" || encoder.encode(event.data).length>FRAME){close();return;}
        const message=JSON.parse(event.data) as {type?:unknown;data?:unknown;exitCode?:unknown;code?:unknown};
        if(message.type==="output" && typeof message.data==="string") {
          const bytes=encoder.encode(message.data).length;
          totalOutput+=bytes;outstanding+=bytes;
          if(totalOutput>OUTPUT || outstanding>WINDOW || pending.size>=1024){close();return;}
          pending.set(++sequence,bytes);
          server.send(JSON.stringify({type:"output",data:message.data,seq:sequence}));
        } else if(message.type==="exit" && (message.exitCode===null || Number.isInteger(message.exitCode))) server.send(JSON.stringify({type:"exit",exitCode:message.exitCode}));
        else if(message.type==="error") {server.send(JSON.stringify({type:"error",code:"shell_closed"}));close();}
        else close();
      } catch {close();}
    });
    for(const socket of [server,remote]) {socket.addEventListener("close",close);socket.addEventListener("error",close);}
    remote.accept();
    timer=setInterval(()=>{this.wait((async()=>{const s=await this.storage.get<ShellSession>(`shell:${session.id}`);if(!s || s.closing || s.expires<=Date.now() || s.deadline<=Date.now())close();})().catch(close));},1000);
    try {await touch();} catch {close();throw unavailable();}
    return new Response(null,{status:101,webSocket:client,headers:{"sec-websocket-protocol":SHELL_PROTOCOL,"cache-control":"no-store"}});
  }
}
