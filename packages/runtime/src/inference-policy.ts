// A working set, separate from the provider's advertised maximum. Native Pi
// compacts the old prefix and retains every original transcript entry.
export const ACTIVE_CONTEXT_TOKENS=96_000;
export function workingContextModel<T extends object>(model:T):T {
  const size=(model as {contextWindow?:number}).contextWindow;
  return typeof size==='number'&&size>0?{...model,contextWindow:Math.min(size,ACTIVE_CONTEXT_TOKENS)}:model;
}

/** Host-scoped cache affinity. No bot name, credential or user text leaves here. */
export async function inferenceCacheKey(scope:string,sessionId?:string):Promise<string|undefined> {
  if(!sessionId)return undefined;
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([scope,sessionId])));
  return Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');
}

export function inferenceIdleMs(payload:{model?:unknown;reasoning?:{effort?:unknown}},estimatedTokens:number):number {
  // Hermes uses 180s for streams, scales large contexts, and protects named
  // reasoning models with a 600s floor. This watches silence, not total work.
  const context=estimatedTokens>100_000?300_000:estimatedTokens>50_000?240_000:180_000;
  const reasoning=/^(?:gpt-(?:5\.6|6)|o[134](?:-|$))/.test(String(payload.model))||['high','xhigh','max','ultra'].includes(String(payload.reasoning?.effort));
  return reasoning?Math.max(context,600_000):context;
}

export type InferenceProgress={phase:'request'|'streaming'|'completed'|'failed'|'cancelled';at:number;bytes:number;httpStatus?:number;idle?:boolean};

/** Cancel a silent inference connection; never apply this deadline to tools.
 * Promise races also cover transports that fail to propagate AbortSignal. */
export async function fetchInference(fetcher:(request:Request)=>Promise<Response>,request:Request,idleMs:number,progress:(value:InferenceProgress)=>void=()=>{}):Promise<Response> {
  const controller=new AbortController(),signal=AbortSignal.any([request.signal,controller.signal]);
  let timer:ReturnType<typeof setTimeout>,finished=false,bytes=0,status:number|undefined,idleExpired=false,removeReaderAbort=()=>{};
  const timeout=()=>{idleExpired=true;controller.abort(new Error('model_timeout: Network timeout waiting for inference progress.'));};
  const touch=()=>{clearTimeout(timer);timer=setTimeout(timeout,idleMs);};
  const finish=(phase:InferenceProgress['phase'])=>{if(finished)return;finished=true;clearTimeout(timer);removeReaderAbort();progress({phase,at:Date.now(),bytes,...(status?{httpStatus:status}:{}),...(idleExpired?{idle:true}:{})});};
  const abortable=<T>(pending:Promise<T>)=>new Promise<T>((resolve,reject)=>{
    const abort=()=>reject(signal.reason);
    signal.addEventListener('abort',abort,{once:true});
    pending.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    if(signal.aborted)abort();
  });
  progress({phase:'request',at:Date.now(),bytes});touch();
  try {
    const pending=fetcher(new Request(request,{signal}));
    void pending.then(response=>{if(signal.aborted)void response.body?.cancel().catch(()=>{});},()=>{});
    const response=await abortable(pending);status=response.status;
    progress({phase:'streaming',at:Date.now(),bytes,httpStatus:status});touch();
    if(!response.body){finish(response.ok?'completed':'failed');return response;}
    const reader=response.body.getReader();
    const abortReader=()=>{void reader.cancel(signal.reason).catch(()=>{});};
    signal.addEventListener('abort',abortReader,{once:true});removeReaderAbort=()=>signal.removeEventListener('abort',abortReader);
    return new Response(new ReadableStream<Uint8Array>({
      async pull(output) {
        try {
          const part=await abortable(reader.read());
          if(signal.aborted)throw signal.reason;
          if(part.done){finish(response.ok?'completed':'failed');output.close();return;}
          bytes+=part.value.byteLength;touch();progress({phase:'streaming',at:Date.now(),bytes,httpStatus:status});output.enqueue(part.value);
        }catch(error){finish(request.signal.aborted?'cancelled':'failed');output.error(error);}
      },
      async cancel(reason){controller.abort(reason);finish('cancelled');await reader.cancel(reason).catch(()=>{});},
    }),{status:response.status,headers:response.headers});
  }catch(error){finish(request.signal.aborted?'cancelled':'failed');throw error;}
}
