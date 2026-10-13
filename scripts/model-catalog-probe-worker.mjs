const states=new Set(['verified','connected_unverified','reauthorization_required','disconnected']);
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
  return {connection:states.has(status?.status)?status.status:'unknown',connected:catalog?.connected===true,
    models:Array.isArray(catalog?.models)?catalog.models.length:0,
    failure:catalog?.error?failures.get(catalog.error)||'catalog_failure_unclassified':null};
}

export default {
  async fetch(request,env) {
    const token=request.headers.get('authorization')?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
    if(!token||!env.PROBE_TOKEN_SHA256)return new Response(null,{status:401});
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),byte=>byte.toString(16).padStart(2,'0')).join('');
    if(digest!==env.PROBE_TOKEN_SHA256)return new Response(null,{status:401});
    if(request.method!=='GET'||new URL(request.url).pathname!=='/catalog')return new Response(null,{status:404});
    try {
      const account=env.CHATGPT.get(env.CHATGPT.idFromName('owner'));
      const status=await (await account.fetch('https://chatgpt/')).json();
      const catalog=await (await account.fetch('https://chatgpt/models')).json();
      return Response.json(projection(status,catalog),{headers:{'cache-control':'no-store'}});
    } catch {return Response.json({failure:'catalog_probe_failed'},{status:502,headers:{'cache-control':'no-store'}});}
  },
};
