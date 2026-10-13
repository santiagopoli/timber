import {env,exports} from 'cloudflare:workers';
import {runInDurableObject} from 'cloudflare:test';
import {expect,it} from 'vitest';
import type {Env} from '../apps/api/src/env';
import type {ComputerAction,ComputerResult,Run} from '@botspace/contracts';
const bindings=env as unknown as Env;
const headers={authorization:'Bearer test-only-botspace-owner-token-000000','content-type':'application/json'};
it('reconciles a lost host receipt without replay, freezes recovery identity, and cannot clear a newer uncertain action',async()=>{
 const created=await exports.default.fetch('https://test/v1/bots',{method:'POST',headers,body:JSON.stringify({name:'Browser receipt recovery'})});
 const {bot}=await created.json<any>();
 const initialized=await exports.default.fetch(`https://test/v1/bots/${bot.id}/messages`,{headers});await initialized.text();
 const stub=bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
 await runInDurableObject(stub,async(instance,state)=>{
  const host=instance as unknown as {computer:{exec:(botId:string,op:string,action:ComputerAction)=>Promise<ComputerResult>};dispatchComputer:(op:string,action:ComputerAction,run?:Run)=>Promise<ComputerResult>};
  const at=new Date().toISOString(),run:Run={id:crypto.randomUUID(),botId:bot.id,operationId:'native-browser',model:bot.model,status:'running',createdAt:at,updatedAt:at};
  const dispatch=(op:string,action:ComputerAction)=>host.dispatchComputer(op,action,run);
  const saved=host.computer.exec,requests:Array<{op:string;action:ComputerAction}>=[];
  host.computer.exec=async(_,op,action)=>{
   requests.push({op,action});
   if(action.type==='click')throw new Error('private-transport-canary');
   if(op==='pending')return {operationId:op,status:'completed',output:JSON.stringify({state:'pending'})};
   if(op==='unavailable')throw new Error('private-provider-canary');
   return {operationId:op,status:'completed',output:JSON.stringify({state:'settled'})};
  };
  try {
   const result=await dispatch('first',{type:'click',x:1,y:2});expect(result.status).toBe('interrupted');expect(JSON.stringify(result)).not.toContain('private-transport-canary');
   await expect(dispatch('blocked',{type:'click',x:2,y:3})).rejects.toThrow('No new action was executed');expect(requests).toHaveLength(1);
   await dispatch('pending',{type:'browserRecover'});expect(await state.storage.get('unconfirmedBrowserAction')).toEqual({operationId:'first'});
   expect((await dispatch('unavailable',{type:'browserRecover'})).status).toBe('failed');expect(await state.storage.get('unconfirmedBrowserAction')).toEqual({operationId:'first'});
   await dispatch('recover-first',{type:'browserRecover'});expect(await state.storage.get('unconfirmedBrowserAction')).toBeUndefined();
   await dispatch('second',{type:'click',x:2,y:3});expect(await state.storage.get('unconfirmedBrowserAction')).toEqual({operationId:'second'});
   await dispatch('recover-first',{type:'browserRecover'});
   expect(requests.filter(r=>r.op==='recover-first').map(r=>r.action)).toEqual([{type:'browserRecover',previousOperationId:'first'},{type:'browserRecover',previousOperationId:'first'}]);
   expect(await state.storage.get('unconfirmedBrowserAction')).toEqual({operationId:'second'});
   expect(requests.filter(r=>r.action.type==='click')).toHaveLength(2);
  } finally {host.computer.exec=saved;}
 });
});
