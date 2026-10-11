import {classifyModelFailure,normalizeOpenAICatalog,type ModelCatalog} from '@botspace/contracts';
import type {Env} from './env';

const API='https://api.openai.com/v1';
const METADATA='https://models.dev/api.json';
const caches=new WeakMap<Env,{key:string;expiresAt:number;catalog?:ModelCatalog;pending?:Promise<ModelCatalog>}>();
let metadata:{expiresAt:number;value?:unknown;pending?:Promise<unknown>}={expiresAt:0};

async function boundedJSON(response:Response,limit:number,requireOK=true):Promise<unknown>{
  if(requireOK&&!response.ok){await response.body?.cancel();throw new Error('upstream');}
  const reader=response.body?.getReader();if(!reader)throw new Error('upstream');
  const decoder=new TextDecoder();let bytes=0,text='';
  try{while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>limit)throw new Error('upstream');text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();return JSON.parse(text);}
  finally{await reader.cancel().catch(()=>{});}
}

async function modelMetadata():Promise<unknown>{
  if(metadata.value&&metadata.expiresAt>Date.now())return metadata.value;
  if(metadata.pending)return metadata.pending;
  const pending=(async()=>{
    const value=await boundedJSON(await fetch(METADATA,{redirect:'manual',signal:AbortSignal.timeout(15_000)}),12_000_000);
    metadata={value,expiresAt:Date.now()+5*60_000};return value;
  })();
  metadata.pending=pending;
  try{return await pending;}finally{if(metadata.pending===pending)metadata.pending=undefined;}
}

export async function openAICatalog(env:Env):Promise<ModelCatalog>{
  const key=env.OPENAI_API_KEY;if(!key)return {connected:false,models:[],defaultModel:''};
  let cache=caches.get(env);if(cache?.key!==key){cache={key,expiresAt:0};caches.set(env,cache);}
  if(cache.catalog&&cache.expiresAt>Date.now())return cache.catalog;
  if(cache.pending)return cache.pending;
  const current=cache;
  const pending=(async()=>{
    try{
      const [account,registry]=await Promise.all([
        fetch(`${API}/models`,{headers:{authorization:`Bearer ${key}`},redirect:'manual',signal:AbortSignal.timeout(15_000)}).then(response=>boundedJSON(response,8_000_000)),modelMetadata(),
      ]);
      const models=normalizeOpenAICatalog(account,registry),catalog={connected:true,models,defaultModel:models[0]?.id??''};
      current.catalog=catalog;current.expiresAt=Date.now()+5*60_000;return catalog;
    }catch{return {connected:true,models:[],defaultModel:'',error:'OpenAI API model discovery is unavailable. Check its server connection and retry.'};}
  })();
  current.pending=pending;
  try{return await pending;}finally{if(current.pending===pending)current.pending=undefined;}
}

function publicError(status:number|undefined,detail:{code?:unknown;param?:unknown;message?:unknown}){
  const failure=classifyModelFailure({...detail,status});
  const code=status===402||failure.errorCode==='chatgpt_allowance_exhausted'?'model_billing_required':status===401||status===403?'model_access_denied':failure.errorCode;
  return {code,message:code};
}

/** SSE decoders can discard error codes before hooks run. Keep fixed diagnostics
 * in both code and message, including named/top-level errors and split frames. */
function sanitizedStream(response:Response):Response{
  if(!response.body||!response.headers.get('content-type')?.includes('text/event-stream'))return response;
  const decoder=new TextDecoder(),encoder=new TextEncoder();let buffer='';
  const frame=(raw:string)=>{
    const lines=raw.split(/\r?\n/),data=lines.filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
    try{
      const value=JSON.parse(data);
      const parent=value?.type==='response.failed'?value.response:value;
      const detail=parent?.error??(value?.type==='error'?parent:undefined);
      if(!detail||typeof detail!=='object')return raw;
      const error=publicError(typeof detail.status==='number'?detail.status:undefined,detail);
      // A failed terminal response can carry output even without earlier deltas.
      // Never retry that generation through another paid provider.
      if(error.code==='model_billing_required'&&Array.isArray(parent.output)&&parent.output.length){error.code='model_connection_interrupted';error.message=error.code;}
      if(parent.error)parent.error=error;else {parent.code=error.code;parent.message=error.message;}
      return [...lines.filter(line=>!line.startsWith('data:')),`data: ${JSON.stringify(value)}`].join('\n');
    }catch{return raw;}
  };
  const drain=(controller:TransformStreamDefaultController<Uint8Array>,final=false)=>{
    let separator:RegExpExecArray|null;
    while((separator=/\r?\n\r?\n/.exec(buffer))){
      const raw=buffer.slice(0,separator.index);buffer=buffer.slice(separator.index+separator[0].length);
      if(raw.length>4_000_000)throw new Error('model_output_limit');
      controller.enqueue(encoder.encode(frame(raw)+'\n\n'));
    }
    if(buffer.length>4_000_000)throw new Error('model_output_limit');
    if(final&&buffer){controller.enqueue(encoder.encode(frame(buffer)+'\n\n'));buffer='';}
  };
  const transform=new TransformStream<Uint8Array,Uint8Array>({
    transform(chunk,controller){buffer+=decoder.decode(chunk,{stream:true});drain(controller);},
    flush(controller){buffer+=decoder.decode();drain(controller,true);},
  });
  return new Response(response.body.pipeThrough(transform),{status:response.status,headers:{'content-type':'text/event-stream','cache-control':'no-store'}});
}

/** Only this host sees the credential. No SDK/owner headers or redirects escape. */
export async function openAIRequest(env:Env,request:Request):Promise<Response>{
  if(request.url!==`${API}/responses`||request.method!=='POST')throw new Error('Unsupported OpenAI API inference route');
  if(!env.OPENAI_API_KEY)return Response.json({error:{code:'model_access_denied',message:'model_access_denied'}},{status:403});
  const response=await fetch(request.url,{method:'POST',headers:{authorization:`Bearer ${env.OPENAI_API_KEY}`,'content-type':'application/json',accept:'text/event-stream'},body:request.body,redirect:'manual',signal:request.signal});
  if(response.ok)return sanitizedStream(response);
  let detail:{code?:unknown;param?:unknown;message?:unknown}={};
  try{const raw=await boundedJSON(response,32_000,false);if(raw&&typeof raw==='object'&&'error' in raw&&raw.error&&typeof raw.error==='object')detail=raw.error as typeof detail;}catch{}
  return Response.json({error:publicError(response.status,detail)},{status:response.status});
}
