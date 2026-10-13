const states=new Set(['verified','connected_unverified','reauthorization_required','disconnected']);
const runStates=new Set(['queued','running','waiting_approval','waiting_connection']);
const runErrors=new Set(['model_catalog_unavailable','chatgpt_not_connected','model_unavailable','reasoning_unsupported','fast_unsupported','model_image_unsupported','model_provider_settings_unsupported']);
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const failures=new Map([
  ['The model catalogue rejected this ChatGPT connection. Reconnect ChatGPT.','chatgpt_catalog_authorization_rejected'],
  ['ChatGPT token renewal failed. The connection was retained; try again later.','chatgpt_refresh_failed'],
  ['OpenAI has not allowed token renewal yet. Try again shortly.','chatgpt_refresh_pending'],
  ['The connected account returned an unreadable model catalogue.','model_catalog_unreadable'],
  ['The connected account returned an unsupported model catalogue.','model_catalog_unsupported'],
  ['The connected account\'s model catalogue could not be loaded. Refresh and try again.','model_catalog_transport_failed'],
  ['The connected account\'s model catalogue is unavailable. Refresh and try again.','model_catalog_http_failed'],
  ['The ChatGPT session expired or was revoked. Sign in again.','chatgpt_reauthorization_required'],
  ['OpenAI identity validation failed. Complete a fresh ChatGPT sign-in.','chatgpt_invalid_identity'],
  ['The refreshed ChatGPT identity did not match.','chatgpt_invalid_identity'],
  ['The server\'s ChatGPT credential key has not been configured.','chatgpt_not_configured'],
]);

export function projection(status,catalog) {
  const upstream=typeof catalog?.error==='string'?catalog.error.match(/^ChatGPT model catalogue unavailable \(HTTP ([1-5]\d{2}); ([a-z_]{1,64})\)\. /):null;
  return {connection:states.has(status?.status)?status.status:'unknown',connected:catalog?.connected===true,
    models:Array.isArray(catalog?.models)?catalog.models.length:0,
    failure:catalog?.error?upstream?.[2]||failures.get(catalog.error)||'catalog_failure_unclassified':null,
    ...(upstream?{upstreamStatus:Number(upstream[1])}:{})};
}

export function queueProjection(botId,summary,page,slot) {
  return {bot:botId.slice(0,8),activeProcesses:count(summary?.activeProcesses),pendingCancellations:count(summary?.pendingCancellations),
    lease:!slot?.holder?'none':slot.holder==='@bot'?'bot':slot.holder.startsWith('@direct:')?'owner_action':'task',
    runs:(Array.isArray(page?.activeRuns)?page.activeRuns:[]).slice(0,10).map(run=>({status:runStates.has(run.status)?run.status:'unknown',
      error:run.errorCode?runErrors.has(run.errorCode)?run.errorCode:'other':null,coordinator:run.coordinatorMode===true}))};
}

export default {
  async fetch(request,env) {
    const token=request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if(!token||!env.PROBE_TOKEN_SHA256)return new Response(null,{status:401});
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),byte=>byte.toString(16).padStart(2,'0')).join('');
    if(digest!==env.PROBE_TOKEN_SHA256)return new Response(null,{status:401});
    const path=new URL(request.url).pathname;
    if(request.method!=='GET'||!['/catalog','/queue'].includes(path))return new Response(null,{status:404});
    try {
      if(path==='/queue') {
        const workspace=env.WORKSPACE.get(env.WORKSPACE.idFromName('owner'));
        const {bots}=await (await workspace.fetch('https://workspace/')).json();
        if(!Array.isArray(bots))throw new Error('invalid state');
        const values=await Promise.all(bots.slice(0,20).map(async bot=>{
          if(!/^[a-f0-9-]{36}$/.test(bot.id))throw new Error('invalid bot');
          try {
            const account=env.BOT.get(env.BOT.idFromName(`owner:${bot.id}`));
            const headers={'x-botspace-config':encodeURIComponent(JSON.stringify(bot)),'x-timber-internal':'scheduler'};
            const [s,r,l]=await Promise.all([
              account.fetch(new Request('https://bot/summary',{headers})),
              account.fetch(new Request('https://bot/runs',{headers})),
              workspace.fetch(`https://workspace/tasks/bot-slot/${bot.id}`),
            ]);
            if(!s.ok||!r.ok||!l.ok)throw new Error('invalid state');
            const [{summary},runs,slot]=await Promise.all([s.json(),r.json(),l.json()]);
            const value=queueProjection(bot.id,summary,runs,slot);
            if(value.lease==='task'&&/^[a-f0-9-]{36}$/.test(slot.holder)) {
              const receipt=await workspace.fetch(`https://workspace/tasks/${slot.holder}`);
              const {task}=await receipt.json();
              if(!receipt.ok||task?.botId!==bot.id)throw new Error('invalid task holder');
              const holder=env.BOT.get(env.BOT.idFromName(`owner:task:${task.id}`));
              const taskHeaders={...headers,'x-timber-task-id':task.id};
              const [taskSummary,taskRuns]=await Promise.all([holder.fetch(new Request('https://task/summary',{headers:taskHeaders})),holder.fetch(new Request('https://task/runs',{headers:taskHeaders}))]);
              if(!taskSummary.ok||!taskRuns.ok)throw new Error('invalid task state');
              const [{summary:state},page]=await Promise.all([taskSummary.json(),taskRuns.json()]);
              const projected=queueProjection(bot.id,state,page,{});
              const taskStates=new Set([...runStates,'completed','failed','cancelled','cancelling']);
              value.holdingTask={status:taskStates.has(task.status)?task.status:'unknown',computer:task.computerMode==='isolated'?'isolated':'shared',activeProcesses:projected.activeProcesses,pendingCancellations:projected.pendingCancellations,runs:projected.runs};
              value.coordinatorEnabled=bot.allowTaskCreation===true;
            }
            return value;
          } catch {return {bot:bot.id.slice(0,8),failure:'bot_state_unavailable'};}
        }));
        return Response.json({bots:values},{headers:{'cache-control':'no-store'}});
      }
      const account=env.CHATGPT.get(env.CHATGPT.idFromName('owner'));
      const status=await (await account.fetch('https://chatgpt/')).json();
      const catalog=await (await account.fetch('https://chatgpt/models')).json();
      return Response.json(projection(status,catalog),{headers:{'cache-control':'no-store'}});
    } catch {return Response.json({failure:'catalog_probe_failed'},{status:502,headers:{'cache-control':'no-store'}});}
  },
};
