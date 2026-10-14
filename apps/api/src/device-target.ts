import type {Device,ExecutionTarget} from '@botspace/contracts';
import type {Env} from './env';
import {routeDevices} from './devices';
import {ApiError} from './errors';

/** Selection records location, never grants access or silently chooses another host. */
export async function validateDeviceTarget(env:Env,target:ExecutionTarget,botId?:string,requireAccess=false):Promise<void>{
  if(target.kind==='cloud')return;
  const response=await routeDevices(new Request('https://devices/v1/devices'),env,'owner');
  if(!response?.ok)throw new ApiError(503,'devices_unavailable','The machine registry is unavailable.');
  const {devices}=await response.json<{devices:Device[]}>();
  const device=devices.find(device=>device.id===target.deviceId);
  if(!device||device.status==='revoked')throw new ApiError(403,'device_unavailable','Choose an active registered machine.');
  if(!device.workspaces.some(workspace=>workspace.id===target.workspaceId))throw new ApiError(403,'workspace_unavailable','Choose a registered workspace on that machine.');
  if(requireAccess){
    const grant=device.grants.find(grant=>grant.botId===botId&&grant.workspaceIds.includes(target.workspaceId));
    if(!grant||!grant.permissions.length||target.agentMode==='local'&&!grant.permissions.includes('agent.run'))throw new ApiError(403,'device_access_denied','The owner has not granted this bot access to that machine and execution mode.');
  }
}
