import type {Api, Model} from '@earendil-works/pi-ai';
import {resolveModelSettings, type ModelCatalog, type ModelOption, type ModelSettings} from '@botspace/contracts';
import {chatgptModel, type ConfiguredModel} from './chatgpt.js';
import type {PiRuntimeOptions} from './types.js';

const configurationFailures = {
  chatgpt_not_connected: {message:'Connect ChatGPT, then retry this message.',retryable:false},
  model_catalog_unavailable: {message:'The connected account’s model catalogue is temporarily unavailable. Retry this message shortly.',retryable:true},
  model_unavailable: {message:'This model is not available in the connected account. Choose an available model, then retry this message.',retryable:false},
  reasoning_unsupported: {message:'This reasoning level is not supported by the selected model. Update the model settings, then retry this message.',retryable:false},
  fast_unsupported: {message:'Fast mode is not supported by the selected model. Update the model settings, then retry this message.',retryable:false},
  model_image_unsupported: {message:'This model does not accept images. Choose an image-capable model, then retry this message.',retryable:false},
  model_provider_settings_unsupported: {message:'ChatGPT reasoning and Fast settings require an OpenAI model. Update the model settings, then retry this message.',retryable:false},
} as const;
/** Safe errors raised before native admission. They never expose provider bodies. */
export class ModelConfigurationError extends Error {
  readonly retryable:boolean;
  constructor(readonly code:keyof typeof configurationFailures) {
    super(configurationFailures[code].message);this.name='ModelConfigurationError';this.retryable=configurationFailures[code].retryable;
  }
}

/** Native model references include immutable settings, so recovery and concurrent
 * compaction cannot accidentally use another request's reasoning or speed. */
export function createModelSettings(storage:DurableObjectStorage,transport:PiRuntimeOptions<object>['chatgpt'],cloud:(id:string)=>Model<Api>) {
  storage.sql.exec('CREATE TABLE IF NOT EXISTS timber_model_configs (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  const known=new Map<string,ConfiguredModel>([[chatgptModel.id,chatgptModel]]);
  for(const row of storage.sql.exec<{id:string;data:string}>('SELECT id,data FROM timber_model_configs').toArray())known.set(row.id,JSON.parse(row.data));
  const models=()=>[...known.values()];
  const resolve=(id:string):Model<Api>=>{
    if(id.startsWith('@cf/'))return cloud(id);
    const value=known.get(id);if(!value)throw new Error('Model configuration unavailable. Select an available model.');return value;
  };
  const catalog=async():Promise<ModelCatalog>=>{
    if(transport?.models)return transport.models();
    // Non-production embedders may supply an inference-only adapter. Production
    // always supplies the authenticated account catalogue; this is never its UI.
    return {connected:!!transport,defaultModel:chatgptModel.id,models:[{id:chatgptModel.id,name:chatgptModel.name,provider:'openai',reasoningEfforts:['low','medium','high','xhigh','max'],defaultReasoningEffort:'medium',supportsFast:false,contextWindow:chatgptModel.contextWindow,inputModalities:['text','image']}]};
  };
  const configure=async(input:ModelSettings):Promise<{settings:ModelSettings;model:Model<Api>}>=>{
    if(input.model.startsWith('@cf/')){if(input.fast||input.reasoningEffort)throw new ModelConfigurationError('model_provider_settings_unsupported');return {settings:{model:input.model,fast:false},model:resolve(input.model)};}
    let account:ModelCatalog;
    try {account=await catalog();}catch {throw new ModelConfigurationError('model_catalog_unavailable');}
    if(!account.connected)throw new ModelConfigurationError('chatgpt_not_connected');
    if(account.error)throw new ModelConfigurationError('model_catalog_unavailable');
    const capability=account.models.find(item=>item.id===input.model);
    if(!capability)throw new ModelConfigurationError('model_unavailable');
    if(input.reasoningEffort!==undefined&&!capability.reasoningEfforts.includes(input.reasoningEffort))throw new ModelConfigurationError('reasoning_unsupported');
    if(input.fast&&!capability.supportsFast)throw new ModelConfigurationError('fast_unsupported');
    const settings=resolveModelSettings(input,account.models);
    const id=`${settings.model}~timber~${btoa(JSON.stringify(settings))}`;
    const value:ConfiguredModel={...chatgptModel,id,name:capability.name,
      contextWindow:capability.contextWindow??128_000,maxTokens:capability.maxOutputTokens??32_768,
      input:capability.inputModalities??['text'],reasoning:capability.reasoningEfforts.length>0,
      timberSettings:settings,timberCapability:capability};
    storage.sql.exec('INSERT OR REPLACE INTO timber_model_configs(id,data) VALUES(?,?)',id,JSON.stringify(value));known.set(id,value);
    return {settings,model:value};
  };
  const settingsFor=(id:string):ModelSettings=>(known.get(id)?.timberSettings??{model:id});
  return {models,resolve,catalog,configure,settingsFor};
}
