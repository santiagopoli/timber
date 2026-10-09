import {createAssistantMessageEventStream,type AssistantMessage,type Model,type SimpleStreamOptions,type TranscriptContext} from '@earendil-works/pi-ai';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-responses';
import { createProvider } from '@earendil-works/pi-ai/models';
import {classifyModelFailure,type ModelOption,type ModelSettings} from '@botspace/contracts';
import type { PiRuntimeOptions } from './types.js';

export const CHATGPT_MODEL = 'gpt-6.1-sol';
export const RESPONSES_URL = 'https://api.openai.com/v1/responses';
export const TOOL_NAMESPACE = 'timber_computer';
export const MAX_OUTPUT_CHARACTERS = 65_536;

export const chatgptModel: Model<'openai-responses'> = {
  id: CHATGPT_MODEL, name: 'GPT-6.1 Sol (ChatGPT)', api: 'openai-responses',
  provider: 'openai', baseUrl: 'https://api.openai.com/v1',
  input: ['text', 'image'], reasoning: true, contextWindow: 1_050_000, maxTokens: 128_000,
  thinkingLevelMap: { off: 'none', minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
  // Subscription allowance is not API-token billing; do not invent a dollar cost.
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: { supportsDeveloperRole: true, supportsAdditionalTools: false, supportsMaxOutputTokens: false, supportsLongCacheRetention: false },
};

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('chatgpt_invalid_protocol');
  return value as JsonObject;
}

/** Count generated text and arguments, never opaque encrypted reasoning state. */
function outputSize(item:JsonObject):number {
  if(item.type==='function_call')return typeof item.arguments==='string'?item.arguments.length:0;
  const textSize=(parts:unknown)=>Array.isArray(parts)?parts.reduce((total:number,part:unknown)=>{
    if(!part||typeof part!=='object')return total;
    const value=part as JsonObject;
    return total+(typeof value.text==='string'?value.text.length:typeof value.refusal==='string'?value.refusal.length:0);
  },0):0;
  if(item.type==='message')return textSize(item.content);
  if(item.type==='reasoning')return textSize(item.summary)+textSize(item.content);
  return 0;
}
const OUTPUT_DELTAS=new Set(['response.output_text.delta','response.refusal.delta','response.function_call_arguments.delta','response.reasoning_summary_text.delta','response.reasoning_text.delta']);
const callKey=(id:unknown,name:unknown)=>JSON.stringify([id,name]);
function callOrigins(messages:TranscriptContext['messages']) {
  const origins=new Map<string,{namespace?:string}>();
  for(const message of messages) {
    if(message.role!=='assistant'||['error','aborted'].includes(message.stopReason))continue;
    for(const call of message.content) {
      if(call.type!=='toolCall')continue;
      if(call.namespace!==undefined&&call.namespace!==TOOL_NAMESPACE)throw new Error('chatgpt_invalid_tool_namespace');
      const id=call.id.split('|')[0]!;
      // Pi's Responses serializer normalizes call IDs when switching models.
      const normalized=id.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,64).replace(/_+$/,'');
      for(const value of new Set([id,normalized]))origins.set(callKey(value,call.name),{namespace:call.namespace});
    }
  }
  return origins;
}

/** Rebuild the allowed request shape; future SDK defaults cannot add paid-API-only fields. */
export function chatgptPayload(value: unknown, settings: ModelSettings = {model:CHATGPT_MODEL}, capability?: ModelOption,originalMessages:TranscriptContext['messages']=[]): JsonObject {
  const payload = object(value);
  if (!Array.isArray(payload.input)) throw new Error('chatgpt_invalid_protocol');
  const functions = Array.isArray(payload.tools) ? payload.tools.map(value => {
    const tool = object(value);
    if (tool.type !== 'function') throw new Error('chatgpt_unsupported_tool');
    return tool;
  }) : [];
  const names=new Set(functions.map(tool=>tool.name));
  const origins=callOrigins(originalMessages);
  const input = payload.input.map(value => {
    const item = object(value);
    if (item.type === 'function_call') {
      // Pi drops namespaces across models. Recover from the original call's
      // provenance, including retired tools whose completed results stay in
      // history. This never adds that tool to the current executable tool set.
      const origin=origins.get(callKey(item.call_id,item.name));
      if(item.namespace===undefined&&origin&&(origin.namespace===TOOL_NAMESPACE||origin.namespace===undefined&&names.has(item.name)))return {...item,namespace:TOOL_NAMESPACE};
      if(item.namespace!==TOOL_NAMESPACE)throw new Error('chatgpt_invalid_tool_namespace');
    }
    return item.role === 'system' ? { ...item, role: 'developer' } : item;
  });
  return {
    model: settings.model, input, store: false, stream: true,
    ...(settings.reasoningEffort ? {reasoning:{effort:settings.reasoningEffort,...(capability?.supportsReasoningSummary!==false?{summary:'auto'}:{})}} : {}),
    include: ['reasoning.encrypted_content'],
    ...(settings.fast?{service_tier:capability?.fastServiceTier??'fast'}:{}),
    ...(functions.length ? { tools: [{ type: 'namespace', name: TOOL_NAMESPACE, description: 'Tools for this bot’s reusable computer, connected services, skills and apps, subject to host policy.', tools: functions }] } : {}),
  };
}

/** The SDK needs a nonempty credential locally. This public sentinel never leaves this adapter. */
const SDK_SENTINEL = 'timber-host-owned-oauth-transport';

export type ConfiguredModel = Model<'openai-responses'> & {timberSettings?:ModelSettings; timberCapability?:ModelOption};

export function createChatGPTProvider(transport: PiRuntimeOptions<object>['chatgpt'], available:()=>readonly ConfiguredModel[]=()=>[chatgptModel]) {
  const run = (model: Model<'openai-responses'>, context: TranscriptContext, options?: SimpleStreamOptions) => {
    const configured=model as ConfiguredModel;
    const settings=configured.timberSettings??{model:model.id};
    const controller = new AbortController();
    const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    const outputSizes=new Map<number,{delta:number;snapshot:number}>();
    const toolNamespaces=new Map<number,{id?:string;callId?:string;name?:string;namespace?:string}>();
    const validateToolItem=(item:JsonObject,index:number,final:boolean)=>{
      if(item.type==='custom_tool_call')throw new Error('chatgpt_unsupported_tool');
      if(item.type!=='function_call')return;
      if(item.namespace!==undefined&&item.namespace!==TOOL_NAMESPACE)throw new Error('chatgpt_invalid_tool_namespace');
      const previous=toolNamespaces.get(index)??{};
      const identity={...(typeof item.id==='string'?{id:item.id}:{}),...(typeof item.call_id==='string'?{callId:item.call_id}:{}),...(typeof item.name==='string'?{name:item.name}:{})};
      for(const key of ['id','callId','name'] as const)if(previous[key]!==undefined&&identity[key]!==undefined&&previous[key]!==identity[key])throw new Error('chatgpt_invalid_tool_namespace');
      const proof={...previous,...identity,...(item.namespace===TOOL_NAMESPACE?{namespace:TOOL_NAMESPACE}:{})};
      if(final&&proof.namespace!==TOOL_NAMESPACE)throw new Error('chatgpt_invalid_tool_namespace');
      toolNamespaces.set(index,proof);
    };
    const observeOutput=(index:number,delta:number,snapshot:number)=>{
      const previous=outputSizes.get(index)??{delta:0,snapshot:0};
      outputSizes.set(index,{delta:previous.delta+delta,snapshot:Math.max(previous.snapshot,snapshot)});
    };
    const upstream=streamSimple({...model,id:settings.model}, context, {
      // Deliberately do not forward apiKey, base URL, headers, env, fetch or payload hooks.
      apiKey: SDK_SENTINEL, signal, timeoutMs: options?.timeoutMs ?? 1_800_000,
      maxRetries: 0, cacheRetention: 'none', env: {},
      onPayload: value=>chatgptPayload(value,settings,configured.timberCapability,context.messages),
      fetch: async (input, init) => {
        const incoming = new Request(input, init);
        if (incoming.url !== RESPONSES_URL || incoming.method !== 'POST') throw new Error('chatgpt_invalid_endpoint');
        if (!transport) return Response.json({ error: { code: 'chatgpt_not_connected', message: 'Connect ChatGPT before running this bot.' } }, { status: 401 });
        // A fresh header allowlist removes the SDK sentinel, ambient auth and SDK telemetry.
        const request = new Request(RESPONSES_URL, {
          method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: await incoming.text(), signal: incoming.signal, redirect: 'manual',
        });
        return transport.fetch(request);
      },
      onProviderStreamEvent(value) {
        const event = object(value);
        if(event.type==='error'||event.type==='response.failed') {
          const parent=event.type==='response.failed'?object(event.response):event;
          const detail=parent.error&&typeof parent.error==='object'?object(parent.error):parent;
          const failure=classifyModelFailure({code:detail.code,param:detail.param,message:detail.message,...(typeof detail.status==='number'?{status:detail.status}:{})});
          throw new Error(`${failure.errorCode}: ${failure.publicMessage}`);
        }
        if (event.type === 'response.incomplete') {
          const response = event.response ? object(event.response) : undefined;
          const details = response?.incomplete_details ? object(response.incomplete_details) : undefined;
          if (details?.reason === 'max_output_tokens') throw new Error('chatgpt_output_limit');
          if (details?.reason === 'content_filter') throw new Error('chatgpt_response_filtered');
          throw new Error('chatgpt_incomplete_response: stream ended without a terminal response');
        }
        const item = event.item ? object(event.item) : undefined;
        const index=typeof event.output_index==='number'?event.output_index:-1;
        if(item)validateToolItem(item,index,event.type!=='response.output_item.added');
        // This endpoint forbids max_output_tokens. Bound generated content locally and abort
        // before Pi can accept unfinished calls. The harness separately enforces a timeout.
        if(OUTPUT_DELTAS.has(String(event.type))&&typeof event.delta==='string')observeOutput(index,event.delta.length,0);
        if(item&&['response.output_item.added','response.output_item.done'].includes(String(event.type)))observeOutput(index,0,outputSize(item));
        if(event.type==='response.completed'&&event.response&&typeof event.response==='object') {
          const completed=(event.response as JsonObject).output;
          if(Array.isArray(completed))completed.forEach((value,index)=>{
            const final=object(value);
            validateToolItem(final,index,true);
            observeOutput(index,0,outputSize(final));
          });
        }
        // A final snapshot may repeat streamed deltas, or be the only copy of an
        // item's text. Count the larger observation once for each output item.
        const outputCharacters=[...outputSizes.values()].reduce((total,size)=>total+Math.max(size.delta,size.snapshot),0);
        if (outputCharacters > MAX_OUTPUT_CHARACTERS) {
          controller.abort();
          throw new Error('chatgpt_output_limit');
        }
      },
    });
    const output=createAssistantMessageEventStream();
    const normalizeAllowance=(message:AssistantMessage):AssistantMessage=>{
      const failure=message.stopReason==='error'?classifyModelFailure({message:message.errorMessage}):undefined;
      return failure?.errorCode==='chatgpt_allowance_exhausted'
        ?{...message,errorMessage:`${failure.errorCode}: ${failure.publicMessage}`}:message;
    };
    void (async()=>{
      let partial:AssistantMessage|undefined,terminal=false;
      try {
        for await(const event of upstream) {
          // OpenAI's SSE decoder throws for `event: error` and top-level
          // `data.error` before onProviderStreamEvent runs. Classify its terminal
          // message too, so a subscription quota is never treated as throttling.
          if(event.type==='error'||event.type==='done')terminal=true;
          else partial=event.partial;
          output.push(event.type==='error'?{...event,error:normalizeAllowance(event.error)}:event);
        }
        if(!terminal)throw new Error('chatgpt_incomplete_response: stream ended without a terminal response');
      } catch(error) {
        const reason=signal.aborted||partial?.stopReason==='aborted'?'aborted':'error';
        const message:AssistantMessage={...(partial??{
          role:'assistant',api:model.api,provider:model.provider,model:settings.model,
          content:[],timestamp:Date.now(),
          usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},
        }),stopReason:reason,errorMessage:error instanceof Error?error.message:typeof error==='string'?error:'ChatGPT response stream failed'};
        output.push({type:'error',reason,error:normalizeAllowance(message)});
      } finally {
        output.end();
      }
    })();
    return output;
  };
  const provider=createProvider<'openai-responses'>({
    id: 'openai', name: 'Sign in with ChatGPT', baseUrl: chatgptModel.baseUrl,
    // Ambient host capability, never an environment API key or Pi credential store.
    auth: { apiKey: { name: 'Host-owned ChatGPT connection', resolve: async () => ({ auth: {}, source: 'ChatGPT transport' }) } },
    models: [chatgptModel], api: {
      stream: (model, context, options) => run(model as Model<'openai-responses'>, context, options),
      streamSimple: (model, context, options) => run(model as Model<'openai-responses'>, context, options),
    },
  });
  return {...provider,getModels:available,getAllModels:available};
}
