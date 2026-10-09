import type {AgentRuntime} from '@botspace/runtime';
import type {MemoryCategory,MemorySaveInput} from '@botspace/contracts';
import {MemoryError} from '@botspace/memory';
import {MaintenanceError} from '../../../packages/runtime/src/maintenance';
import {ApiError,json} from './errors';
import {body,operationId,string} from './validation';

function revision(value:unknown,name='expectedRevision'):number {
  if(!Number.isSafeInteger(value)||Number(value)<1) throw new ApiError(400,'invalid_request',`${name} must be a positive integer.`);
  return Number(value);
}
function note(input:Record<string,unknown>,id?:string):MemorySaveInput {
  if(!['preference','fact','decision','procedure'].includes(String(input.category))) throw new ApiError(400,'invalid_request','Choose a valid memory category.');
  if(input.pinned!==undefined&&typeof input.pinned!=='boolean') throw new ApiError(400,'invalid_request','pinned must be a boolean.');
  // Scope, actor, provenance and suggestion state are always assigned by Timber.
  if(['scope','actor','sources','state','replacesId','replacesRevision'].some(key=>key in input)) throw new ApiError(400,'invalid_request','Memory provenance and scope are assigned by Timber.');
  return {operationId:operationId(input.operationId),category:input.category as MemoryCategory,title:string(input.title,'title',100),content:string(input.content,'content',1200),
    ...(input.pinned===undefined?{}:{pinned:input.pinned as boolean}),...(id?{id,expectedRevision:revision(input.expectedRevision)}:{})};
}

/** The outer bot router has already authenticated ownership and membership. */
export async function maintenanceRequest(request:Request,path:string,runtime:AgentRuntime):Promise<Response> {
  try {
    if(path==='/context'&&request.method==='GET') return json({context:await runtime.contextStatus()});
    if(path==='/context/compact'&&request.method==='POST') {
      const input=await body(request);
      const id=operationId(input.operationId);
      const instructions=input.instructions===undefined?undefined:string(input.instructions,'instructions',2000,0);
      return json({compaction:await runtime.compact({operationId:id,...(instructions===undefined?{}:{instructions})})},202);
    }
    if(path==='/memory'&&request.method==='GET') return json({memory:await runtime.memory()});
    if(path==='/memory'&&request.method==='PUT') {
      throw new ApiError(409,'memory_upgrade_required','Memory now uses individual notes. Refresh Timber to edit or add a note; your existing notes are preserved.');
    }
    if(path==='/memory/search'&&request.method==='GET') {
      const parameters=new URL(request.url).searchParams,query=string(parameters.get('q')??'','q',200,0),rawLimit=parameters.get('limit');
      if(rawLimit!==null&&(!/^\d+$/.test(rawLimit)||Number(rawLimit)<1||Number(rawLimit)>50)) throw new ApiError(400,'invalid_request','limit must be an integer from 1 to 50.');
      return json({results:await runtime.searchMemory(query,rawLimit===null?undefined:Number(rawLimit))});
    }
    if(path==='/memory/review'&&request.method==='POST') {
      const input=await body(request);
      return json({review:await runtime.reviewMemory({operationId:operationId(input.operationId)})},202);
    }
    if(path==='/memory/entries'&&request.method==='POST') return json({result:await runtime.saveMemory(note(await body(request)))},201);
    const entry=/^\/memory\/entries\/([A-Za-z0-9_-]{1,128})(?:\/(history|accept))?$/.exec(path);
    if(entry) {
      const [,id,action]=entry;
      if(action==='history'&&request.method==='GET') return json({history:await runtime.memoryHistory(id)});
      if(action==='accept'&&request.method==='POST') {
        const input=await body(request);
        return json({result:await runtime.acceptMemory({id,operationId:operationId(input.operationId),expectedRevision:revision(input.expectedRevision),...(input.replacesRevision===undefined?{}:{replacesRevision:revision(input.replacesRevision,'replacesRevision')})})});
      }
      if(!action&&request.method==='GET') return json({entry:await runtime.memoryEntry(id)});
      if(!action&&request.method==='PATCH') return json({result:await runtime.saveMemory(note(await body(request),id))});
      if(!action&&request.method==='DELETE') {
        const input=await body(request);
        return json({result:await runtime.forgetMemory({id,operationId:operationId(input.operationId),expectedRevision:revision(input.expectedRevision)})});
      }
    }
    throw new ApiError(405,'method_not_allowed','Method not allowed.');
  } catch(error) {
    if(error instanceof MemoryError) {
      const status=error.code==='memory_not_found'?404:error.code==='invalid_memory'?400:error.code==='memory_limit'?422:409;
      throw new ApiError(status,error.code,error.message);
    }
    if(error instanceof MaintenanceError) throw new ApiError(error.code==='invalid_memory'?400:409,error.code,error.message);
    throw error;
  }
}
