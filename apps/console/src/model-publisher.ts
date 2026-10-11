type CatalogIdentity = {
  id:string;publisher?:string;provider?:string;
  routes?:{modelId:string;publisher?:string}[];
};

const labels:Record<string,string>={
  openai:'OpenAI',anthropic:'Anthropic',google:'Google',meta:'Meta','meta-llama':'Meta',
  mistralai:'Mistral AI',mistral:'Mistral AI','x-ai':'xAI',moonshotai:'Moonshot AI',
  deepseek:'DeepSeek',qwen:'Alibaba',alibaba:'Alibaba','z-ai':'Z.ai',cohere:'Cohere',
  amazon:'Amazon',nvidia:'NVIDIA',nousresearch:'Nous Research','arcee-ai':'Arcee AI',
  allenai:'Allen Institute for AI',bytedance:'ByteDance','bytedance-seed':'ByteDance',
  minimax:'MiniMax',ai21:'AI21 Labs',perplexity:'Perplexity',writer:'Writer',
  inception:'Inception',tencent:'Tencent',baidu:'Baidu',xiaomi:'Xiaomi',microsoft:'Microsoft',
  'ibm-granite':'IBM',
};
const transports=new Set(['openrouter','chatgpt','cloudflare','workers-ai']);
const namespace=(id:string)=>{
  const parts=id.replace(/^@cf\//,'').split('/');
  return parts.length>1&&parts[0]?parts[0]:undefined;
};

/** Use discovery metadata; ID/route namespaces support older cached catalogues. */
export function modelPublisherLabel(model:CatalogIdentity):string {
  const publisher=model.publisher||model.routes?.find(route=>route.publisher)?.publisher
    ||namespace(model.id)||model.routes?.map(route=>namespace(route.modelId)).find(Boolean)
    ||(model.provider&&!transports.has(model.provider.toLowerCase())?model.provider:undefined);
  if(!publisher||transports.has(publisher.toLowerCase()))return 'Other providers';
  return labels[publisher.toLowerCase()]||publisher;
}
