const states=new Set(['verified','connected_unverified','reauthorization_required','disconnected']);
const runStates=new Set(['queued','running','waiting_approval','waiting_connection']);
const runErrors=new Set(['model_catalog_unavailable','chatgpt_not_connected','model_unavailable','reasoning_unsupported','fast_unsupported','model_image_unsupported','model_provider_settings_unsupported','model_provider_unavailable','model_rate_limited','model_timeout','model_connection_interrupted','chatgpt_allowance_exhausted','chatgpt_usage_unavailable','model_access_denied']);
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const failures=new Map([
  ['Using cached ChatGPT model catalogue while discovery is unavailable.','model_catalog_transport_failed'],
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
  const diagnostic=catalog?.error||catalog?.warning;
  const upstream=typeof diagnostic==='string'?diagnostic.match(/^(?:ChatGPT model catalogue unavailable|Using cached ChatGPT model catalogue) \(HTTP ([1-5]\d{2}); ([a-z_]{1,64})\)\./):null;
  return {connection:states.has(status?.status)?status.status:'unknown',connected:catalog?.connected===true,
    models:Array.isArray(catalog?.models)?catalog.models.length:0,
    failure:diagnostic?upstream?.[2]||failures.get(diagnostic)||'catalog_failure_unclassified':null,
    ...(catalog?.warning?{cached:true}:{}),
    ...(upstream?{upstreamStatus:Number(upstream[1])}:{})};
}

export function queueProjection(botId,summary,page,slot) {
  const failed=(Array.isArray(page?.runs)?page.runs:[]).filter(run=>run.status==='failed').slice(0,5);
  const errorCode=run=>run.errorCode?runErrors.has(run.errorCode)?run.errorCode:'other':null;
  const waiting=run=>run.error==='Message saved. Waiting for this bot’s shared computer.'?'computer':run.error==='Message saved. Waiting for space in the agent inbox.'?'inbox':run.admissionRetryable===true?'admission_retry':run.error?'other':null;
  return {bot:botId.slice(0,8),activeProcesses:count(summary?.activeProcesses),pendingCancellations:count(summary?.pendingCancellations),
    lease:!slot?.holder?'none':slot.holder==='@bot'?'bot':slot.holder.startsWith('@direct:')?'owner_action':'task',
    runs:(Array.isArray(page?.activeRuns)?page.activeRuns:[]).slice(0,10).map(run=>({status:runStates.has(run.status)?run.status:'unknown',
      error:errorCode(run),coordinator:run.coordinatorMode===true,
      ...(waiting(run)?{waiting:waiting(run)}:{}),...(run.admissionRetryable===true?{admissionRetryable:true}:{})})),
    ...(failed.length?{recentFailures:failed.map(run=>({error:errorCode(run)}))}:{})};
}

export default {
  async fetch(request,env) {
    const token=request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if(!token||!env.PROBE_TOKEN_SHA256)return new Response(null,{status:401});
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),byte=>byte.toString(16).padStart(2,'0')).join('');
    if(digest!==env.PROBE_TOKEN_SHA256)return new Response(null,{status:401});
    const path=new URL(request.url).pathname;
    const verify=path==='/verify'&&request.method==='POST',diagnostics=['/authentication','/renew-authentication'].includes(path)&&request.method==='POST';
    if(!verify&&!diagnostics&&(request.method!=='GET'||!['/catalog','/queue','/transport'].includes(path)))return new Response(null,{status:404});
    try {
      if(diagnostics) {
        const account=env.CHATGPT.get(env.CHATGPT.idFromName('owner'));
        const response=await account.fetch('https://chatgpt/diagnostics',{method:'POST',headers:{'x-timber-internal':'model-diagnostics',...(path==='/renew-authentication'?{'x-timber-diagnostics-renew':'1'}:{})}});
        if(!response.ok)return Response.json({failure:'authentication_probe_unavailable'},{status:502,headers:{'cache-control':'no-store'}});
        const value=await response.json();
        const credential={};
        for(const field of ['accessBytes','expiresInSeconds','renewalBlockedForSeconds'])if(Number.isSafeInteger(value.credential?.[field]))credential[field]=value.credential[field];
        for(const field of ['expiryMatches','audienceMatches','issuerMatches','subjectMatches','clientMatches','scopesMatch','renewalRequested','renewed','renewalAlreadyPerformed'])credential[field]=value.credential?.[field]===true;
        const checks=(Array.isArray(value.checks)?value.checks:[]).slice(0,4).map(check=>({
          variant:['timber','minimal','json','unauthenticated'].includes(check.variant)?check.variant:'unknown',
          ...(Number.isInteger(check.status)&&check.status>=100&&check.status<=599?{status:check.status}:{}),
          format:['json','html','text','other'].includes(check.format)?check.format:'other',
          bodyKind:['challenge','origin_disallowed','cloudflare_error','api_error','other'].includes(check.bodyKind)?check.bodyKind:'other',
          failure:check.failure===null?null:runErrors.has(check.failure)?check.failure:'other',
          requestIdPresent:check.requestIdPresent===true,rayPresent:check.rayPresent===true,
          ...(typeof check.rayColo==='string'&&/^[A-Z]{3}$/.test(check.rayColo)?{rayColo:check.rayColo}:{}),
          ...(['origin','cloudflare','ssl'].includes(check.edgeCategory)?{edgeCategory:check.edgeCategory}:{}),
        }));
        return Response.json({credential,checks},{headers:{'cache-control':'no-store'}});
      }
      if(path==='/transport') {
        const checks=await Promise.all(['models','responses'].map(async endpoint=>{
          try {
            const response=await fetch(`https://api.openai.com/v1/${endpoint}`,{method:endpoint==='responses'?'POST':'GET',
              headers:{'User-Agent':'Timber/0.1.0','content-type':'application/json'},...(endpoint==='responses'?{body:'{}'}:{}),
              redirect:'manual',signal:AbortSignal.timeout(15_000)});
            await response.body?.cancel().catch(()=>{});
            return {endpoint,status:response.status};
          }catch{return {endpoint,failure:'transport_failed'};}
        }));
        return Response.json({unauthenticatedTransport:checks},{headers:{'cache-control':'no-store'}});
      }
      if(verify) {
        const account=env.CHATGPT.get(env.CHATGPT.idFromName('owner'));
        const response=await account.fetch('https://chatgpt/verify',{method:'POST'});
        const result=await response.json();
        const code=result?.error?.code;
        return Response.json({ok:response.ok&&result.ok===true,status:response.status,failure:response.ok?null:typeof code==='string'&&/^(?:chatgpt|model)_[a-z_]{1,64}$/.test(code)?code:'model_verify_failed'},{headers:{'cache-control':'no-store'}});
      }
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
            if(bot.name==='Polibot')value.matchesScreenshotBot=true;
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
