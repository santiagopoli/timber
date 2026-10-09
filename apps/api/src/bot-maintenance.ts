import type {AgentRuntime} from '@botspace/runtime';
import {MaintenanceError} from '../../../packages/runtime/src/maintenance';
import {ApiError,json} from './errors';
import {body,operationId,string} from './validation';

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
      const input=await body(request),content=string(input.content,'content',16_000,0);
      if(!Number.isSafeInteger(input.revision)||Number(input.revision)<0) throw new ApiError(400,'invalid_request','revision must be a nonnegative integer.');
      return json({memory:await runtime.updateMemory(content,Number(input.revision))});
    }
    throw new ApiError(405,'method_not_allowed','Method not allowed.');
  } catch(error) {
    if(error instanceof MaintenanceError) throw new ApiError(error.code==='invalid_memory'?400:409,error.code,error.message);
    throw error;
  }
}
