import type { AvatarJob, AvatarSelection, AvatarSettings, AvatarTheme, Bot, BotAvatar } from '@botspace/contracts';
import { avatarThemePrompt, builtinAvatarThemes } from '@botspace/contracts';
import type { Env } from './env';
import { ApiError, json } from './errors';
import { body, operationId, string, UUID } from './validation';
import { avatarModelCatalog, generateImageAvatar, generateVectorAvatar } from './avatar-provider';
import { sanitizeAvatarSvg } from './avatar-svg';
import { decodeAvatarPng, validateAvatarPng, validateAvatarPngBytes, AVATAR_PNG_MAX_BYTES } from './avatar-png';

interface StoredJob extends Record<string, SqlStorageValue> {
  data: string;
  theme: string;
  bot: string;
  output: string | null;
  artifact_id: string;
  attempts: number;
  next_at: number;
}
const now = () => new Date().toISOString();
const imageUnavailable = () => new ApiError(422, 'avatar_image_unavailable', 'Image avatar generation is unavailable. Configure the server OPENAI_API_KEY Worker secret and choose an image model from the configured catalogue. Images use separately billed OpenAI API access, not the ChatGPT plan. Do not enter API keys in chat. No alternative provider or billing fallback will be used.');
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new ApiError(400, 'invalid_request', 'Unknown avatar setting. A bot cannot override the owner theme.');
}
function id(value: unknown, name: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ApiError(400, 'invalid_request', `${name} must be a UUID.`);
  return value;
}

/** Owner-local SQL journals. Inference is not replayed after an uncertain restart;
 * a journaled validated SVG/PNG can safely finish its immutable R2 publication. */
export class AvatarCoordinator {
  private active: Promise<void> | undefined;
  private activeBotId: string | undefined;
  private generating: {botId:string;controller:AbortController} | undefined;
  constructor(private ctx: DurableObjectState, private env: Env, private rearm: () => Promise<void>) {
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS avatar_themes (id TEXT PRIMARY KEY,data TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS avatar_selection (singleton INTEGER PRIMARY KEY CHECK(singleton=1),data TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS bot_avatars (bot_id TEXT PRIMARY KEY,data TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS avatar_receipts (operation_id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,data TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS avatar_jobs (id TEXT PRIMARY KEY,bot_id TEXT NOT NULL,data TEXT NOT NULL,theme TEXT NOT NULL,bot TEXT NOT NULL,output TEXT,artifact_id TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL)');
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS avatar_jobs_bot ON avatar_jobs(bot_id)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS avatar_gc (key TEXT PRIMARY KEY,bot_id TEXT NOT NULL,next_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0)');
    ctx.storage.sql.exec('CREATE INDEX IF NOT EXISTS avatar_gc_pending ON avatar_gc(next_at)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS avatar_candidates (key TEXT PRIMARY KEY,bot_id TEXT NOT NULL,job_id TEXT NOT NULL)');
    ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS avatar_jobs_pending ON avatar_jobs(json_extract(data,'$.status'),next_at)");
    // Add the collection to both new and existing workspaces. Stable identities
    // preserve custom/legacy themes, selection, revision and already-paid jobs.
    // Neither startup nor selection schedules inference.
    const presets = builtinAvatarThemes(env.BOTSPACE_DEFAULT_MODEL?.startsWith('@cf/') ? 'gpt-6.1-sol' : env.BOTSPACE_DEFAULT_MODEL ?? 'gpt-6.1-sol');
    ctx.storage.transactionSync(() => {
      for (const theme of presets) ctx.storage.sql.exec('INSERT OR IGNORE INTO avatar_themes(id,data) VALUES(?,?)', theme.id, JSON.stringify(theme));
      ctx.storage.sql.exec('INSERT OR IGNORE INTO avatar_selection(singleton,data) VALUES(1,?)', JSON.stringify({ themeId: presets[0].id, revision: 1 }));
    });
    // Restart after provider dispatch: never silently run a possibly paid call again.
    for (const row of ctx.storage.sql.exec<{id:string;data:string;output:string|null}>("SELECT id,data,output FROM avatar_jobs WHERE json_extract(data,'$.status')='running'").toArray()) {
      if (!row.output) {
        const job: AvatarJob = JSON.parse(row.data);
        job.status = 'interrupted'; job.updatedAt = now();
        job.error = { code: 'avatar_generation_interrupted', message: 'Generation was interrupted; its outcome is unconfirmed. Explicitly regenerate to start a new operation.' };
        this.update(job);
      }
    }
  }
  selection(): AvatarSelection | null {
    const row = this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM avatar_selection WHERE singleton=1').toArray()[0];
    return row ? JSON.parse(row.data) : null;
  }
  settings(): AvatarSettings {
    const read = <T>(table:string, order='rowid') => this.ctx.storage.sql.exec<{data:string}>(`SELECT data FROM ${table} ORDER BY ${order}`).toArray().map(row => JSON.parse(row.data) as T);
    return { themes: read<AvatarTheme>('avatar_themes'), selection: this.selection(), avatars: read<BotAvatar>('bot_avatars'), jobs: read<AvatarJob>('avatar_jobs', 'rowid DESC LIMIT 100') };
  }
  nextAlarm(): number | undefined {
    const row = this.ctx.storage.sql.exec<{next_at:number}>("SELECT next_at FROM avatar_jobs WHERE json_extract(data,'$.status') IN ('queued','running') ORDER BY next_at LIMIT 1").toArray()[0];
    const garbage=this.ctx.storage.sql.exec<{next_at:number}>('SELECT next_at FROM avatar_gc ORDER BY next_at LIMIT 1').toArray()[0];
    const next=Math.min(row?.next_at??Infinity,garbage?.next_at??Infinity);
    return Number.isFinite(next)?next:undefined;
  }
  private receipt(operation:string, fingerprint:string): unknown | undefined {
    const row = this.ctx.storage.sql.exec<{fingerprint:string;data:string}>('SELECT fingerprint,data FROM avatar_receipts WHERE operation_id=?', operation).toArray()[0];
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint) throw new ApiError(409, 'operation_conflict', 'This operationId was already used with different avatar arguments.');
    return JSON.parse(row.data);
  }
  private saveReceipt(operation:string, fingerprint:string, result:unknown): void {
    this.ctx.storage.sql.exec('INSERT INTO avatar_receipts(operation_id,fingerprint,data) VALUES(?,?,?)', operation, fingerprint, JSON.stringify(result));
  }
  private theme(themeId:string): AvatarTheme {
    const row = this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM avatar_themes WHERE id=?', themeId).toArray()[0];
    if (!row) throw new ApiError(404, 'avatar_theme_not_found', 'Avatar theme not found.');
    return JSON.parse(row.data);
  }
  private async validateReasoning(kind:AvatarTheme['kind'], modelId:string, effort:string): Promise<void> {
    if(kind!=='vector')throw new ApiError(400,'invalid_request','Reasoning is only available for SVG themes.');
    const catalog=await avatarModelCatalog(this.env);
    if(catalog.error)throw new ApiError(503,'avatar_model_catalog_unavailable',catalog.error);
    if(!catalog.connected)throw new ApiError(409,'chatgpt_not_connected','Connect OpenAI before choosing avatar reasoning.');
    const model=catalog.vectorModels.find(model=>model.id===modelId);
    if(!model)throw new ApiError(422,'avatar_model_unavailable','The theme’s text model is not available to the connected OpenAI account.');
    if(!model.reasoningEfforts.includes(effort))throw new ApiError(422,'avatar_reasoning_unavailable','This reasoning level is not supported by the theme’s model. Refresh the model catalogue.');
  }
  private job(jobId:string): StoredJob | undefined {
    return this.ctx.storage.sql.exec<StoredJob>('SELECT data,theme,bot,output,artifact_id,attempts,next_at FROM avatar_jobs WHERE id=?', jobId).toArray()[0];
  }
  private current(job:AvatarJob): boolean {
    const selection = this.selection();
    if (selection?.revision !== job.revision || selection.themeId !== job.themeId || !this.ctx.storage.sql.exec('SELECT id FROM bots WHERE id=?',job.botId).toArray().length) return false;
    // Within a revision, a late earlier regeneration must not replace a newer one.
    return this.ctx.storage.sql.exec<{id:string}>('SELECT id FROM avatar_jobs WHERE bot_id=? ORDER BY rowid DESC LIMIT 1',job.botId).toArray()[0]?.id === job.id;
  }
  private update(job:AvatarJob, output:string|null=null, nextAt=0): void {
    job.updatedAt = now();
    const terminal=!['queued','running'].includes(job.status);
    this.ctx.storage.sql.exec('UPDATE avatar_jobs SET data=?,output=?,next_at=? WHERE id=?',JSON.stringify(job),terminal?null:output,terminal?0:nextAt,job.id);
    if(terminal){
      this.ctx.storage.sql.exec("UPDATE avatar_jobs SET bot='{}',theme='{}' WHERE id=?",job.id);
      if(job.status!=='completed'){const row=this.job(job.id);if(row)this.garbage(`bots/${job.botId}/avatars/${row.artifact_id}`,job.botId);}
    }
  }
  forgetBot(botId:string): void {
    // Fence publication before deletion drains the bot R2 prefix.
    if(this.generating?.botId===botId)this.generating.controller.abort();
    this.ctx.storage.sql.exec('DELETE FROM bot_avatars WHERE bot_id=?',botId);
    for (const row of this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM avatar_jobs WHERE bot_id=?',botId).toArray()) {
      const job:AvatarJob=JSON.parse(row.data);job.status='obsolete';delete job.error;
      this.update(job);
    }
    // Remove private bot identity/instructions from durable snapshots.
    this.ctx.storage.sql.exec("UPDATE avatar_jobs SET bot='{}',output=NULL WHERE bot_id=?",botId);
  }
  async drainBot(botId:string): Promise<void> {
    // Deletion waits for any in-flight upload before deleting its prefix. It
    // cannot race an uploader that has not yet resumed after its await.
    if (this.active && this.activeBotId===botId) await this.active;
    this.ctx.storage.sql.exec('DELETE FROM avatar_jobs WHERE bot_id=?',botId);
    this.ctx.storage.sql.exec('DELETE FROM avatar_gc WHERE bot_id=?',botId);
    this.ctx.storage.sql.exec('DELETE FROM avatar_candidates WHERE bot_id=?',botId);
  }
  async fetch(request:Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/avatar-models' && request.method === 'GET') return json(await avatarModelCatalog(this.env));
    if (path === '/avatar-settings' && request.method === 'GET') return json(this.settings());
    if (path === '/avatar-themes' && request.method === 'POST') {
      const input=await body(request); keys(input,['name','kind','prompt','style','subject','model','reasoningEffort','operationId']);
      const operation=operationId(input.operationId), name=string(input.name,'name',80).trim(), model=string(input.model,'model',180).trim();
      if (input.style !== undefined && input.prompt !== undefined || input.subject !== undefined && input.style === undefined) throw new ApiError(400,'invalid_request','Use style with an optional subject, or a legacy prompt.');
      const style=input.style===undefined?undefined:string(input.style,'style',4000).trim();
      const subject=input.subject===undefined?undefined:string(input.subject,'subject',160,0).trim()||undefined;
      const prompt=style===undefined?string(input.prompt,'prompt',8000).trim():avatarThemePrompt(style,subject);
      if (!name || !prompt || style==='' || !model || !['vector','image'].includes(input.kind as string)) throw new ApiError(400,'invalid_request','A name, style, model and vector/image kind are required.');
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model)) throw new ApiError(400,'invalid_request','Avatar models must be identifiers from the existing OpenAI connection.');
      const reasoningEffort=input.reasoningEffort===undefined?undefined:string(input.reasoningEffort,'reasoningEffort',128).trim();
      if(reasoningEffort==='')throw new ApiError(400,'invalid_request','Omit reasoningEffort to use the model default.');
      const fingerprint=JSON.stringify({type:'theme',name,kind:input.kind,prompt,model,...(style===undefined?{}:{style,subject}),...(reasoningEffort===undefined?{}:{reasoningEffort})});
      const replay=this.receipt(operation,fingerprint) as {themeId?:string;theme?:AvatarTheme}|undefined;
      if(replay) return json({theme:replay.themeId?this.theme(replay.themeId):replay.theme},201);
      if(reasoningEffort!==undefined){
        await this.validateReasoning(input.kind as AvatarTheme['kind'],model,reasoningEffort);
        const concurrent=this.receipt(operation,fingerprint) as {themeId:string}|undefined;
        if(concurrent)return json({theme:this.theme(concurrent.themeId)},201);
      }
      const theme:AvatarTheme={id:crypto.randomUUID(),name,kind:input.kind as AvatarTheme['kind'],prompt,model,createdAt:now(),...(style===undefined?{}:{style,subject,framing:'circle' as const}),...(reasoningEffort===undefined?{}:{reasoningEffort})};
      this.ctx.storage.transactionSync(()=>{
        this.ctx.storage.sql.exec('INSERT INTO avatar_themes(id,data) VALUES(?,?)',theme.id,JSON.stringify(theme));
        this.saveReceipt(operation,fingerprint,{themeId:theme.id});
      });
      return json({theme},201);
    }
    if (path === '/avatar-themes' && request.method === 'PATCH') {
      const input=await body(request);keys(input,['themeId','reasoningEffort','expectedReasoningEffort','operationId']);
      const themeId=id(input.themeId,'themeId'),operation=operationId(input.operationId);
      const effort=(value:unknown)=>value===null?null:string(value,'reasoningEffort',128).trim();
      const reasoningEffort=effort(input.reasoningEffort),expectedReasoningEffort=effort(input.expectedReasoningEffort);
      if(reasoningEffort===''||expectedReasoningEffort==='')throw new ApiError(400,'invalid_request','Use null for the model default.');
      const fingerprint=JSON.stringify({type:'theme-reasoning',themeId,reasoningEffort,expectedReasoningEffort});
      if(this.receipt(operation,fingerprint))return json({theme:this.theme(themeId)});
      const selected=this.theme(themeId);
      if(selected.kind!=='vector')throw new ApiError(400,'invalid_request','Reasoning is only available for SVG themes.');
      if((selected.reasoningEffort??null)!==expectedReasoningEffort)throw new ApiError(409,'avatar_theme_changed','The theme reasoning changed. Refresh before saving.');
      if(reasoningEffort!==null)await this.validateReasoning(selected.kind,selected.model,reasoningEffort);
      // Discovery can yield to another settings request. Recheck the receipt
      // and preference before writing; retries never overwrite a later edit.
      if(this.receipt(operation,fingerprint))return json({theme:this.theme(themeId)});
      const theme=this.theme(themeId);
      if((theme.reasoningEffort??null)!==expectedReasoningEffort)throw new ApiError(409,'avatar_theme_changed','The theme reasoning changed. Refresh before saving.');
      if(reasoningEffort===null)delete theme.reasoningEffort;else theme.reasoningEffort=reasoningEffort;
      this.ctx.storage.transactionSync(()=>{
        this.ctx.storage.sql.exec('UPDATE avatar_themes SET data=? WHERE id=?',JSON.stringify(theme),themeId);
        this.saveReceipt(operation,fingerprint,{themeId});
      });
      return json({theme});
    }
    if (path === '/avatar-settings' && request.method === 'PUT') {
      const input=await body(request);keys(input,['themeId','operationId']);
      const themeId=id(input.themeId,'themeId'),operation=operationId(input.operationId),fingerprint=JSON.stringify({type:'selection',themeId});
      const replay=this.receipt(operation,fingerprint);if(replay)return json(this.settings());
      this.theme(themeId);
      const switched=this.selection()?.themeId!==themeId;
      this.ctx.storage.transactionSync(()=>{
        const previous=this.selection();
        if (previous?.themeId !== themeId) {
          const selection:AvatarSelection={themeId,revision:(previous?.revision??0)+1};
          this.ctx.storage.sql.exec('INSERT OR REPLACE INTO avatar_selection(singleton,data) VALUES(1,?)',JSON.stringify(selection));
          for (const row of this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM bot_avatars').toArray()) {
            const avatar:BotAvatar=JSON.parse(row.data);avatar.status='obsolete';
            this.ctx.storage.sql.exec('UPDATE bot_avatars SET data=? WHERE bot_id=?',JSON.stringify(avatar),avatar.botId);
          }
          for (const row of this.ctx.storage.sql.exec<{data:string}>("SELECT data FROM avatar_jobs WHERE json_extract(data,'$.status') IN ('queued','running')").toArray()) {
            const job:AvatarJob=JSON.parse(row.data);job.status='obsolete';this.update(job);
          }
        }
        this.saveReceipt(operation,fingerprint,{selection:this.selection()});
      });
      if(switched)this.generating?.controller.abort();
      await this.rearm();return json(this.settings());
    }
    if (path === '/avatar-generations' && request.method === 'POST') {
      const input=await body(request);keys(input,['operationId','botId','expectedThemeId','expectedRevision','confirmedCount','acknowledgeApiBilling']);
      const operation=operationId(input.operationId),botId=input.botId===undefined?undefined:id(input.botId,'botId');
      const fingerprint=JSON.stringify({type:'generate',botId:botId??null,...(input.expectedThemeId===undefined?{}:{expectedThemeId:input.expectedThemeId}),...(input.expectedRevision===undefined?{}:{expectedRevision:input.expectedRevision}),...(input.confirmedCount===undefined?{}:{confirmedCount:input.confirmedCount}),...(input.acknowledgeApiBilling===undefined?{}:{acknowledgeApiBilling:input.acknowledgeApiBilling})});
      const replay=this.receipt(operation,fingerprint) as {jobIds:string[]}|undefined;
      if(replay) return json({jobs:replay.jobIds.flatMap(jobId=>{const row=this.job(jobId);return row?[JSON.parse(row.data)]:[];})},202);
      const selection=this.selection();if(!selection)throw new ApiError(409,'avatar_theme_required','Select a global avatar theme first.');
      // Consent binds the owner-global selection, never a per-bot model override.
      // Replay above wins even after a switch. Without a receipt, reject stale
      // confirmation BEFORE catalogue discovery, jobs or any inference dispatch.
      const expectedThemeId=input.expectedThemeId===undefined?undefined:id(input.expectedThemeId,'expectedThemeId');
      if(input.expectedRevision!==undefined && (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number)<1))throw new ApiError(400,'invalid_request','expectedRevision must be a positive safe integer.');
      const expectedRevision=input.expectedRevision;
      const theme=this.theme(selection.themeId);
      if(theme.kind==='image' || expectedThemeId!==undefined || expectedRevision!==undefined){
        if(expectedThemeId===undefined || expectedRevision===undefined)throw new ApiError(409,'avatar_theme_confirmation_required','Confirm the current global theme and revision before generating.');
        if(expectedThemeId!==selection.themeId || expectedRevision!==selection.revision)throw new ApiError(409,'avatar_theme_changed','The global theme changed since confirmation. Refresh and confirm the theme, count and billing again.');
      }
      const rows=this.ctx.storage.sql.exec<{data:string}>(botId?'SELECT data FROM bots WHERE id=?':'SELECT data FROM bots ORDER BY rowid',...(botId?[botId]:[])).toArray();
      if(botId && !rows.length)throw new ApiError(404,'not_found','Bot not found.');
      // Missing Image API configuration is definitive; don't wake or query the
      // unrelated SIWC transport merely to reject an image admission.
      const imageKey=this.env.OPENAI_API_KEY;
      if(theme.kind==='image' && (typeof imageKey!=='string' || !imageKey.length || imageKey.length>4096 || /[^\x21-\x7e]/.test(imageKey)))throw imageUnavailable();
      const catalog=await avatarModelCatalog(this.env);
      // Discovery yielded. A concurrently admitted identical operation wins even
      // if the connection, selection or membership changed while we waited.
      const repeated=this.receipt(operation,fingerprint) as {jobIds:string[]}|undefined;
      if(repeated)return json({jobs:repeated.jobIds.flatMap(jobId=>{const row=this.job(jobId);return row?[JSON.parse(row.data)]:[];})},202);
      // Discovery yielded. Receipt replay above still wins; otherwise consent
      // must remain current before any provider/configuration validation.
      const latest=this.selection();if(latest?.revision!==selection.revision || latest.themeId!==selection.themeId)throw new ApiError(409,'avatar_theme_changed','The global theme changed since confirmation. Refresh and confirm the theme, count and billing again.');
      if(theme.kind==='image'){
        if(!catalog.imageAvailable)throw imageUnavailable();
        if(!catalog.imageModels.some(model=>model.id===theme.model))throw new ApiError(422,'avatar_model_unavailable','The theme’s image model is not available in the configured OpenAI Image API catalogue. Create a theme with an available model.');
      }else{
        if(catalog.error)throw new ApiError(503,'avatar_model_catalog_unavailable',catalog.error);
        if(!catalog.connected)throw new ApiError(409,'chatgpt_not_connected','Connect OpenAI before generating avatars.');
        if(!catalog.vectorModels.some(model=>model.id===theme.model))throw new ApiError(422,'avatar_model_unavailable','The theme’s text model is not available to the connected OpenAI account. Create a theme with an available model.');
        if(theme.reasoningEffort!==undefined&&!catalog.vectorModels.find(model=>model.id===theme.model)!.reasoningEfforts.includes(theme.reasoningEffort))throw new ApiError(422,'avatar_reasoning_unavailable','The theme’s reasoning level is no longer supported. Update the theme reasoning before generating.');
      }
      // Recheck bot membership after discovery as well.
      const admittedRows=this.ctx.storage.sql.exec<{data:string}>(botId?'SELECT data FROM bots WHERE id=?':'SELECT data FROM bots ORDER BY rowid',...(botId?[botId]:[])).toArray();
      const bots=admittedRows.map(row=>JSON.parse(row.data) as Bot);
      if(botId && !bots.length)throw new ApiError(404,'not_found','Bot not found.');
      if(input.confirmedCount!==undefined && (!Number.isSafeInteger(input.confirmedCount) || (input.confirmedCount as number)<0))throw new ApiError(400,'invalid_request','confirmedCount must be a non-negative safe integer.');
      if(input.acknowledgeApiBilling!==undefined && input.acknowledgeApiBilling!==true)throw new ApiError(400,'invalid_request','acknowledgeApiBilling must be true when supplied.');
      if(theme.kind==='image'){
        if(input.acknowledgeApiBilling!==true)throw new ApiError(409,'avatar_api_billing_confirmation_required','Image generation is billed separately through OpenAI API, not the ChatGPT plan. Timber does not know the price. Explicitly acknowledge API billing before generating.');
        if(input.confirmedCount!==bots.length)throw new ApiError(409,'avatar_batch_confirmation_required',`Confirm the current batch of ${bots.length} image avatar${bots.length===1?'':'s'} before generating. Refresh if the bot count changed.`);
      }
      const pending=this.ctx.storage.sql.exec<{n:number}>("SELECT count(*) AS n FROM avatar_jobs WHERE json_extract(data,'$.status') IN ('queued','running')").one().n;
      if(pending+bots.length>100)throw new ApiError(429,'avatar_queue_full','At most 100 avatar generations may be pending. Wait before generating more.');
      const jobs:AvatarJob[]=bots.map(bot=>({id:crypto.randomUUID(),operationId:operation,botId:bot.id,...selection,status:'queued',createdAt:now(),updatedAt:now()}));
      this.ctx.storage.transactionSync(()=>{
        jobs.forEach((job,index)=>this.ctx.storage.sql.exec('INSERT INTO avatar_jobs(id,bot_id,data,theme,bot,artifact_id,next_at) VALUES(?,?,?,?,?,?,?)',job.id,job.botId,JSON.stringify(job),JSON.stringify(theme),JSON.stringify(bots[index]),crypto.randomUUID(),Date.now()));
        this.saveReceipt(operation,fingerprint,{jobIds:jobs.map(job=>job.id)});
      });
      await this.rearm();return json({jobs},202);
    }
    const avatar=/^\/avatar\/([^/]+)$/.exec(path);
    if (avatar && request.method === 'GET') {
      const botId=id(avatar[1],'botId');
      if(!this.ctx.storage.sql.exec('SELECT id FROM bots WHERE id=?',botId).toArray().length)throw new ApiError(404,'not_found','Bot not found.');
      const row=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM bot_avatars WHERE bot_id=?',botId).toArray()[0];
      const stored:BotAvatar|undefined=row?JSON.parse(row.data):undefined;
      if(!stored)throw new ApiError(404,'avatar_not_ready','No validated avatar exists for this bot.');
      // Theme switches intentionally retain the last validated image until a
      // replacement publishes. Fence reads on owner-local membership + pointer,
      // not current theme/revision or display status (ready/obsolete).
      const assertPointer=()=>{
        const latest=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM bot_avatars WHERE bot_id=?',botId).toArray()[0];
        const pointer:BotAvatar|undefined=latest?JSON.parse(latest.data):undefined;
        if(!this.ctx.storage.sql.exec('SELECT id FROM bots WHERE id=?',botId).toArray().length || pointer?.artifactId!==stored.artifactId || pointer.mimeType!==stored.mimeType)
          throw new ApiError(404,'avatar_not_ready','The avatar changed or this bot is no longer available.');
      };
      const object=await this.env.FILES.get(`bots/${botId}/avatars/${stored.artifactId}`);
      assertPointer();
      if(!object)throw new ApiError(404,'avatar_not_ready','No validated avatar exists for this bot.');
      let content:string|Uint8Array;
      if(stored.mimeType==='image/svg+xml') {
        if(object.size>100_000)throw new ApiError(502,'avatar_invalid_svg','The stored avatar exceeds the safe size limit.');
        const raw=await object.text();assertPointer();content=sanitizeAvatarSvg(raw);
      } else if(stored.mimeType==='image/png') {
        if(object.size>AVATAR_PNG_MAX_BYTES)throw new ApiError(502,'avatar_png_invalid','The stored avatar exceeds the safe size limit.');
        const raw=await object.arrayBuffer();assertPointer();content=await validateAvatarPngBytes(new Uint8Array(raw));assertPointer();
      } else throw new ApiError(502,'avatar_format_invalid','The stored avatar format is unsupported.');
      assertPointer();
      const etag=`"avatar-${stored.artifactId}"`;
      const headers={
        'content-type':stored.mimeType,
        'content-disposition':`attachment; filename="avatar-${stored.artifactId}.${stored.mimeType==='image/png'?'png':'svg'}"`,
        'cache-control':'private, max-age=0, must-revalidate',etag,
        vary:'Authorization, Cookie','x-content-type-options':'nosniff',
        'content-security-policy':"sandbox; default-src 'none'; style-src 'none'",
        'cross-origin-resource-policy':'same-origin',
        // No server-side resize is implemented: all clients receive original bytes.
        'x-timber-avatar-variant':'original',
      };
      const conditional=request.headers.get('if-none-match');
      if(conditional?.split(',').some(value=>value.trim()==='*' || value.trim().replace(/^W\//,'')===etag))return new Response(null,{status:304,headers});
      return new Response(content,{headers});
    }
    throw new ApiError(405,'method_not_allowed','Method not allowed.');
  }
  alarm(): Promise<void> {
    if(this.active)return this.active;
    const work=this.work().finally(()=>{this.active=undefined;this.activeBotId=undefined;});this.active=work;return work;
  }
  private garbage(key:string,botId:string): void {
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO avatar_gc(key,bot_id,next_at) VALUES(?,?,?)',key,botId,Date.now());
  }
  private async collectGarbage(): Promise<void> {
    for(const row of this.ctx.storage.sql.exec<{key:string;attempts:number}>('SELECT key,attempts FROM avatar_gc WHERE next_at<=? ORDER BY next_at LIMIT 8',Date.now()).toArray()) {
      try {await this.env.FILES.delete(row.key);this.ctx.storage.sql.exec('DELETE FROM avatar_gc WHERE key=?',row.key);this.ctx.storage.sql.exec('DELETE FROM avatar_candidates WHERE key=?',row.key);}
      catch {this.ctx.storage.sql.exec('UPDATE avatar_gc SET attempts=?,next_at=? WHERE key=?',row.attempts+1,Date.now()+Math.min(60_000,1000*2**Math.min(row.attempts+1,6)),row.key);}
    }
  }
  private async work(): Promise<void> {
    await this.collectGarbage();
    const row=this.ctx.storage.sql.exec<{id:string}>("SELECT id FROM avatar_jobs WHERE json_extract(data,'$.status') IN ('queued','running') AND next_at<=? ORDER BY rowid LIMIT 1",Date.now()).toArray()[0];
    if(!row)return;
    const stored=this.job(row.id)!;const job:AvatarJob=JSON.parse(stored.data);
    this.activeBotId=job.botId;
    if(!this.current(job)){job.status='obsolete';this.update(job);return;}
    // Even within a live instance, a running marker without journaled output is
    // an uncertain paid dispatch (e.g. output persistence failed). Never replay.
    if(job.status==='running' && !stored.output){
      job.status='interrupted';job.error={code:'avatar_generation_interrupted',message:'Generation was interrupted; its outcome is unconfirmed. Explicitly regenerate to start a new operation.'};this.update(job);return;
    }
    const theme:AvatarTheme=JSON.parse(stored.theme);
    const mimeType=theme.kind==='image'?'image/png':'image/svg+xml';
    let output=stored.output;
    let png:Uint8Array|undefined;
    const validate=async(candidate:string):Promise<string>=>{
      if(theme.kind==='image'){const canonical=await validateAvatarPng(candidate);png=await decodeAvatarPng(canonical);return canonical;}
      return sanitizeAvatarSvg(candidate);
    };
    try {
      if(output){const candidate=output;output=null;output=await validate(candidate);}
      if(!output) {
        job.status='running';this.update(job,null,Date.now()+35*60_000);
        await this.rearm();
        if(!this.current(job) || (JSON.parse(this.job(job.id)!.data) as AvatarJob).status!=='running'){job.status='obsolete';this.update(job);return;}
        const bot:Bot=JSON.parse(stored.bot);
        // Durable running marker precedes dispatch. Recovery never reissues it.
        const controller=new AbortController();this.generating={botId:job.botId,controller};
        try {
          const input={model:theme.model,reasoningEffort:theme.reasoningEffort,prompt:theme.prompt,botName:bot.name,botInstructions:bot.instructions,transparentBackground:theme.framing==='circle'};
          output=await validate(await (theme.kind==='image'?generateImageAvatar(this.env,input,controller.signal):generateVectorAvatar(this.env,input,controller.signal)));
        }
        finally {this.generating=undefined;}
        if(!this.current(job) || (JSON.parse(this.job(job.id)!.data) as AvatarJob).status!=='running'){job.status='obsolete';this.update(job);return;}
        // Save output before R2. A restart from here can publish without inference.
        this.update(job,output,Date.now());
        await this.rearm();
      }
      if(!this.current(job)){job.status='obsolete';this.update(job);return;}
      const key=`bots/${job.botId}/avatars/${stored.artifact_id}`;
      // Candidate identity is durable BEFORE PUT, including a write whose remote
      // result is lost. Every terminal obsolete/failure path schedules its GC.
      this.ctx.storage.sql.exec('INSERT OR IGNORE INTO avatar_candidates(key,bot_id,job_id) VALUES(?,?,?)',key,job.botId,job.id);
      // Deterministic immutable candidate: duplicate publication has same bytes.
      await this.env.FILES.put(key,png??output,{httpMetadata:{contentType:mimeType}});
      if(!this.current(job) || (JSON.parse(this.job(job.id)!.data) as AvatarJob).status!=='running') {
        this.garbage(key,job.botId);job.status='obsolete';this.update(job);return;
      }
      const previous=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM bot_avatars WHERE bot_id=?',job.botId).toArray()[0];
      const avatar:BotAvatar={botId:job.botId,themeId:job.themeId,revision:job.revision,status:'ready',artifactId:stored.artifact_id,mimeType,updatedAt:now()};
      this.ctx.storage.transactionSync(()=>{
        this.ctx.storage.sql.exec('INSERT OR REPLACE INTO bot_avatars(bot_id,data) VALUES(?,?)',job.botId,JSON.stringify(avatar));
        job.status='completed';delete job.error;this.update(job);
        this.ctx.storage.sql.exec('DELETE FROM avatar_candidates WHERE key=?',key);
        if(previous){const old:BotAvatar=JSON.parse(previous.data);if(old.artifactId!==avatar.artifactId)this.garbage(`bots/${job.botId}/avatars/${old.artifactId}`,job.botId);}
      });
    } catch(error) {
      // Do not overwrite a switch/deletion fence with a late provider error.
      if(!this.current(job)){job.status='obsolete';this.update(job);return;}
      if(output) {
        const attempts=stored.attempts+1;
        this.ctx.storage.sql.exec('UPDATE avatar_jobs SET attempts=? WHERE id=?',attempts,job.id);
        if(attempts<5){this.update(job,output,Date.now()+Math.min(60_000,1000*2**attempts));return;}
        job.error={code:'avatar_storage_failed',message:'The avatar could not be saved. Explicitly regenerate to start a new operation.'};
      } else {
        job.error=error instanceof ApiError?{code:error.code,message:error.message}:{code:'avatar_generation_failed',message:'Avatar generation failed. No other provider or billed fallback was used.'};
      }
      job.status='failed';this.update(job);
    } finally {await this.rearm();}
  }
}
