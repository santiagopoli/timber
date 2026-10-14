import {createModels,type Provider} from '@earendil-works/pi-ai/models';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import {classifyFailure} from '../../../packages/runtime/src/normalize';
import type {AssistantMessageEventStream,SimpleStreamOptions,TranscriptContext} from '@earendil-works/pi-ai';
import {createAI} from 'agents/models/pi-ai';
import type {ModelCatalog,ModelSettings} from '@botspace/contracts';
import {createModelSettings} from '../../../packages/runtime/src/model-settings';
import {createChatGPTProvider} from '../../../packages/runtime/src/chatgpt';
import {createOpenAIProvider} from '../../../packages/runtime/src/openai-api';
import {createOpenRouterProvider,withQuotaFallback} from '../../../packages/runtime/src/model-routing';
import {fetchInference,inferenceIdleMs,workingContextModel} from '../../../packages/runtime/src/inference-policy';
import {modelCatalog,openRouterRequest} from './model-catalog';
import {openAIRequest} from './openai-api';
import type {Env} from './env';

/** Same paid/subscription routing as native Pi, with a durable admitted model. */
export function createDeviceInference(env:Env,storage:DurableObjectStorage) {
  const ai=createAI({binding:env.AI});
  const chatgpt=env.CHATGPT?{models:async()=>{
    const connection=env.CHATGPT!.get(env.CHATGPT!.idFromName('owner'));
    const response=await connection.fetch(new Request('https://chatgpt/models'));
    if(!response.ok)throw new Error('The connected model catalogue is unavailable. Retry shortly.');return response.json<ModelCatalog>();
  },fetch:async(request:Request)=>{
    if(request.url!=='https://api.openai.com/v1/responses'||request.method!=='POST')throw new Error('Unsupported ChatGPT inference route');
    return env.CHATGPT!.get(env.CHATGPT!.idFromName('owner')).fetch(new Request('https://chatgpt/responses',{method:'POST',headers:{'content-type':'application/json'},body:request.body,signal:request.signal}));
  }}:undefined;
  const settings=createModelSettings(storage,chatgpt,id=>ai(id),()=>modelCatalog(env));
  storage.sql.exec('CREATE TABLE IF NOT EXISTS timber_device_inference(operation_id TEXT PRIMARY KEY,model_id TEXT NOT NULL,settings TEXT NOT NULL)');
  storage.sql.exec('CREATE TABLE IF NOT EXISTS timber_device_inference_scope(id INTEGER PRIMARY KEY,scope TEXT NOT NULL)');
  storage.sql.exec('INSERT OR IGNORE INTO timber_device_inference_scope(id,scope) VALUES(1,?)',crypto.randomUUID());
  const scope=storage.sql.exec<{scope:string}>('SELECT scope FROM timber_device_inference_scope WHERE id=1').one().scope;
  const monitor=(transport:{fetch(request:Request):Promise<Response>}|undefined)=>transport?{fetch:async(request:Request)=>{
    const payload=await request.clone().json<{model?:string;input?:unknown;messages?:unknown;reasoning?:{effort?:string}}>();
    const tokens=Math.ceil(JSON.stringify(payload.input??payload.messages??[]).length/4);
    return fetchInference(value=>transport.fetch(value),request,inferenceIdleMs(payload,tokens));
  }}:undefined;
  const subscription=createChatGPTProvider(monitor(chatgpt),settings.models,async()=>scope);
  const openai=createOpenAIProvider(monitor(env.OPENAI_API_KEY?{fetch:request=>openAIRequest(env,request)}:undefined),settings.models,async()=>scope);
  const router=createOpenRouterProvider(monitor(env.OPENROUTER_API_KEY?{fetch:request=>openRouterRequest(env,request)}:undefined),settings.models);
  const providers=new Map<string,Provider>([['chatgpt',subscription],['openai-api',openai],['openrouter',router]]);
  const models=createModels();
  for(const provider of [ai.provider,withQuotaFallback(subscription,providers),withQuotaFallback(openai,providers),withQuotaFallback(router,providers)])models.setProvider(provider);
  return {
    async snapshot(operationId:string,input:ModelSettings):Promise<void>{
      const saved=storage.sql.exec<{settings:string}>('SELECT settings FROM timber_device_inference WHERE operation_id=?',operationId).toArray()[0];
      if(saved){if(saved.settings!==JSON.stringify(input))throw new Error('operation_conflict');return;}
      const selection=await settings.configure(input);
      const concurrent=storage.sql.exec<{settings:string}>('SELECT settings FROM timber_device_inference WHERE operation_id=?',operationId).toArray()[0];
      if(concurrent){if(concurrent.settings!==JSON.stringify(input))throw new Error('operation_conflict');return;}
      storage.sql.exec('INSERT INTO timber_device_inference(operation_id,model_id,settings) VALUES(?,?,?)',operationId,selection.model.id,JSON.stringify(input));
    },
    stream(operationId:string,context:TranscriptContext,options:SimpleStreamOptions={},signal?:AbortSignal):AssistantMessageEventStream{
      const pinned=storage.sql.exec<{model_id:string}>('SELECT model_id FROM timber_device_inference WHERE operation_id=?',operationId).toArray()[0];
      if(!pinned)throw new Error('Local inference input has not been admitted');
      // Device-supplied credentials/headers/fetch/route/model are never forwarded.
      const maxTokens=typeof options.maxTokens==='number'&&Number.isFinite(options.maxTokens)&&options.maxTokens>0?Math.min(Math.floor(options.maxTokens),32_768):undefined;
      const model=workingContextModel(settings.resolve(pinned.model_id));
      const upstream=models.streamSimple(model,context,{...(signal?{signal}:{}),...(maxTokens?{maxTokens}:{}),sessionId:'owned-device-root'}),output=createAssistantMessageEventStream();
      void(async()=>{try{for await(const event of upstream){if(event.type==='error'){const failure=classifyFailure(event.reason,event.error.errorMessage);output.push({...event,error:{...event.error,errorMessage:`${failure.errorCode}: ${failure.publicMessage}`}});}else output.push(event);}}catch(error){
        const reason=signal?.aborted?'aborted':'error',failure=classifyFailure(reason,error instanceof Error?error.message:'');
        output.push({type:'error',reason,error:{role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[],stopReason:reason,timestamp:Date.now(),errorMessage:`${failure.errorCode}: ${failure.publicMessage}`,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}}});
      }finally{output.end();}})();
      return output;
    },
  };
}
