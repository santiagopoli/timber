import { env, exports } from "cloudflare:workers";
import { abortAllDurableObjects, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Bot, Message, Run, RunStatus } from "@botspace/contracts";
import type { AgentRuntime } from "../packages/runtime/src/types";
import type { Env } from "../apps/api/src/env";
import { ModelConfigurationError } from "../packages/runtime/src/model-settings";

const bindings=env as unknown as Env;
const api=(path:string,input?:unknown)=>exports.default.fetch(`https://timber.test${path}`,{
  method:input===undefined?"GET":"POST",headers:{authorization:"Bearer test-only-botspace-owner-token-000000","content-type":"application/json"},
  ...(input===undefined?{}:{body:JSON.stringify(input)}),
});
const stubFor=(bot:Bot)=>bindings.BOT.get(bindings.BOT.idFromName(`owner:${bot.id}`));
type Internals={runtime:AgentRuntime;admit(id:string):Promise<void>;createRun(input:{text:string;operationId:string},metadata?:{role:"system";parentRunId:string}):Promise<Run>};
async function setup() {
  const {bot}=await (await api("/v1/bots",{name:"Bounded inbox"})).json<{bot:Bot}>();
  await api(`/v1/bots/${bot.id}/messages`);
  return bot;
}
async function send(bot:Bot,text:string,operationId=crypto.randomUUID()) {
  const response=await api(`/v1/bots/${bot.id}/messages`,{text,operationId});
  expect(response.status).toBe(202);
  return (await response.json<{run:Run}>()).run;
}
async function current(bot:Bot,run:Run) {return (await (await api(`/v1/bots/${bot.id}/runs/${run.id}`)).json<{run:Run}>()).run;}
async function until(bot:Bot,run:Run,status:RunStatus) {
  for(let i=0;i<200;i++) {if((await current(bot,run)).status===status) return;await new Promise(resolve=>setTimeout(resolve,5));}
  expect((await current(bot,run)).status).toBe(status);
}
async function messages(bot:Bot) {return (await (await api(`/v1/bots/${bot.id}/messages`)).json<{messages:Message[]}>()).messages;}
async function seed(bot:Bot,count:number,status:RunStatus="waiting_approval") {
  const runs:Run[]=Array.from({length:count},()=>({id:crypto.randomUUID(),botId:bot.id,operationId:crypto.randomUUID(),status,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}));
  await runInDurableObject(stubFor(bot),(_instance,state)=>{
    for(const run of runs) state.storage.sql.exec("INSERT INTO runs(id,operation_id,fingerprint,native_operation_id,data) VALUES(?,?,?,?,?)",run.id,run.operationId,"seed",run.operationId,JSON.stringify(run));
  });
  return runs;
}
async function holdNativeQueue(bot:Bot) {
  let held=true;
  await runInDurableObject(stubFor(bot),instance=>{
    const target=instance as unknown as Internals,original=target.runtime;
    target.runtime={...original,pending:async()=>held?Array.from({length:16},(_,i)=>({operationId:`held-native-${i}`,status:"queued" as const})):original.pending()};
  });
  return ()=>{held=false;};
}

it("accepts and processes the 17th message while sixteen real approval waits remain intact",async()=>{
  const bot=await setup(),waiting:Run[]=[];
  for(let i=0;i<16;i++) {const run=await send(bot,"fixture:approval");await until(bot,run,"waiting_approval");waiting.push(run);}
  const text="A new request must not cancel old approval waits",run=await send(bot,text);
  await until(bot,run,"completed");
  expect((await send(bot,text,run.operationId)).id).toBe(run.id);
  for(const old of waiting) expect((await current(bot,old)).status).toBe("waiting_approval");
  const transcript=await messages(bot);
  expect(transcript.filter(message=>message.runId===run.id && message.role==="user")).toHaveLength(1);
  expect(transcript.filter(message=>message.runId===run.id && message.role==="assistant")).toHaveLength(1);
});

it("does not confuse sixteen running input receipts with sixteen independent workers",async()=>{
  const bot=await setup(),old=await seed(bot,16,"running");
  await runInDurableObject(stubFor(bot),instance=>{
    const target=instance as unknown as Internals,original=target.runtime;
    target.runtime={...original,pending:async()=>old.map(run=>({operationId:run.operationId,status:"running" as const}))};
  });
  const run=await send(bot,"Steer an existing root turn");
  await until(bot,run,"completed");
  for(const previous of old) expect((await current(bot,previous)).status).toBe("running");
});

it("durably queues at native inbox capacity without consuming retry attempts, then delivers exactly once",async()=>{
  const bot=await setup(),release=await holdNativeQueue(bot);
  const text="Save at inbox capacity",run=await send(bot,text);
  expect(run).toMatchObject({status:"queued",error:"Message saved. Waiting for space in the agent inbox."});
  await runInDurableObject(stubFor(bot),async(instance,state)=>{
    const target=instance as unknown as Internals;
    for(let i=0;i<6;i++) await target.admit(run.operationId);
    expect(state.storage.sql.exec("SELECT * FROM admission_retries WHERE operation_id=?",run.operationId).toArray()).toHaveLength(0);
    expect(state.storage.sql.exec<{admitted:number}>("SELECT admitted FROM submissions WHERE operation_id=?",run.operationId).toArray()[0].admitted).toBe(0);
    expect(await state.storage.get(`fixture-admission-retry:${run.operationId}`)).toMatchObject({operationId:run.operationId,delayMs:1000});
  });
  expect((await send(bot,text,run.operationId)).id).toBe(run.id);
  release();
  await runInDurableObject(stubFor(bot),instance=>(instance as unknown as Internals).admit(run.operationId));
  await until(bot,run,"completed");
  expect((await current(bot,run)).error).toBeUndefined();
  const own=(await messages(bot)).filter(message=>message.runId===run.id);
  expect(own.filter(message=>message.role==="user")).toHaveLength(1);
  expect(own.filter(message=>message.role==="assistant")).toHaveLength(1);
});

it("reserves a bounded user backlog independently of collaborator continuations and deduplicates at the limit",async()=>{
  const bot=await setup(),[parent]=await seed(bot,1),release=await holdNativeQueue(bot);
  await runInDurableObject(stubFor(bot),async instance=>{
    const target=instance as unknown as Internals;
    for(let i=0;i<16;i++) await target.createRun({text:"Collaborator result",operationId:`agent-result:${crypto.randomUUID()}`},{role:"system",parentRunId:parent.id});
    await expect(target.createRun({text:"Excess result",operationId:`agent-result:${crypto.randomUUID()}`},{role:"system",parentRunId:parent.id})).rejects.toMatchObject({status:429,code:"inbox_full"});
  });
  const inputs=Array.from({length:33},(_,i)=>({text:`Queued user ${i}`,operationId:crypto.randomUUID()}));
  const responses=await Promise.all(inputs.map(input=>api(`/v1/bots/${bot.id}/messages`,input)));
  expect(responses.filter(response=>response.status===202)).toHaveLength(32);
  expect(responses.filter(response=>response.status===429)).toHaveLength(1);
  const accepted:Run[]=[];
  for(const response of responses) {
    if(response.status===202) accepted.push((await response.json<{run:Run}>()).run);
    else expect(await response.json()).toMatchObject({error:{code:"inbox_full"}});
  }
  const first=accepted[0],input=inputs.find(input=>input.operationId===first.operationId)!;
  expect((await send(bot,input.text,input.operationId)).id).toBe(first.id);
  const other=await setup();await until(other,await send(other,"Other bot stays isolated"),"completed");
  expect((await messages(bot)).filter(message=>message.role==="user")).toHaveLength(32);
  release();
});

it("preserves capacity-waited messages across eviction and never delivers cancelled backlog entries",async()=>{
  const bot=await setup(),release=await holdNativeQueue(bot);
  const cancelled=await send(bot,"Stop this queued input"),saved=await send(bot,"Recover this queued input");
  expect((await api(`/v1/bots/${bot.id}/runs/${cancelled.id}/cancel`,{})).status).toBe(200);
  release();
  await abortAllDurableObjects();
  await until(bot,saved,"completed");
  expect((await send(bot,"Stop this queued input",cancelled.operationId)).status).toBe("cancelled");
  const transcript=await messages(bot);
  expect(transcript.filter(message=>message.role==="assistant" && message.runId===cancelled.id)).toHaveLength(0);
  expect(transcript.filter(message=>message.role==="user" && message.runId===saved.id)).toHaveLength(1);
  expect(transcript.filter(message=>message.role==="assistant" && message.runId===saved.id)).toHaveLength(1);
});

it("fails visibly at the protective unresolved ceiling without silently terminating historical tasks",async()=>{
  const bot=await setup(),old=await seed(bot,128);
  const response=await api(`/v1/bots/${bot.id}/messages`,{text:"Do not accept unbounded unresolved work",operationId:crypto.randomUUID()});
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({error:{code:"run_lifecycle_overloaded"}});
  await runInDurableObject(stubFor(bot),(_instance,state)=>{
    expect(state.storage.sql.exec("SELECT id FROM runs").toArray()).toHaveLength(128);
    expect(state.storage.sql.exec("SELECT id FROM messages").toArray()).toHaveLength(0);
    expect(state.storage.sql.exec("SELECT id FROM events WHERE source_key='run-lifecycle-overloaded'").toArray()).toHaveLength(1);
  });
  for(const previous of old.slice(0,2)) expect((await current(bot,previous)).status).toBe("waiting_approval");
});

it("serializes concurrent admissions at the last native inbox slot",async()=>{
  const bot=await setup(),native=new Set<string>();
  let release!:()=>void,maximum=15;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  await runInDurableObject(stubFor(bot),instance=>{
    const target=instance as unknown as Internals,original=target.runtime;
    target.runtime={...original,
      pending:async()=>[...Array.from({length:15},(_,index)=>({operationId:`occupied-${index}`,status:"queued" as const})),...Array.from(native,operationId=>({operationId,status:"queued" as const}))],
      submit:async(text,input)=>{
        await new Promise(resolve=>setTimeout(resolve,10)); // Expose check/submit races.
        native.add(input.operationId);maximum=Math.max(maximum,15+native.size);
        return original.submit(text,input);
      },
      wait:async operationId=>{await gate;try {return await original.wait(operationId);}finally {native.delete(operationId);}},
    };
  });
  try {
    const runs=await Promise.all([send(bot,"First slot contender"),send(bot,"Second slot contender")]);
    expect(maximum).toBe(16);
    await runInDurableObject(stubFor(bot),(_instance,state)=>{
      expect(state.storage.sql.exec<{admitted:number}>("SELECT admitted FROM submissions ORDER BY rowid").toArray().map(row=>row.admitted).sort()).toEqual([0,1]);
    });
    const placed=runs.find(run=>native.has(run.operationId))!,queued=runs.find(run=>run.id!==placed.id)!;
    release();
    await until(bot,placed,"completed");
    await runInDurableObject(stubFor(bot),instance=>(instance as unknown as Internals).admit(queued.operationId));
    await until(bot,queued,"completed");
    expect(maximum).toBe(16);
    for(const run of runs) {
      const own=(await messages(bot)).filter(message=>message.runId===run.id);
      expect(own.filter(message=>message.role==="user")).toHaveLength(1);
      expect(own.filter(message=>message.role==="assistant")).toHaveLength(1);
    }
  } finally {release();}
});


it.each([false,true])("holds the last slot for an unconfirmed submit without blocking receipts, and releases it after failure (Stop: %s)",async(stop)=>{
  const bot=await setup(),firstId=crypto.randomUUID();
  let reject!: (error:Error)=>void,starts=0;
  const receipt=new Promise<never>((_resolve,fail)=>{reject=fail;});
  await runInDurableObject(stubFor(bot),(instance,state)=>{
    const target=instance as unknown as Internals,original=target.runtime;
    target.runtime={...original,
      pending:async()=>Array.from({length:15},(_,index)=>({operationId:`occupied-${index}`,status:"queued" as const})),
      submit:(text,input)=>{starts++;return input.operationId===firstId?receipt:original.submit(text,input);},
    };
    state.waitUntil(target.createRun({text:"Unconfirmed last slot",operationId:firstId}));
  });
  try {
    for(let i=0;i<100 && starts===0;i++) await new Promise(resolve=>setTimeout(resolve,5));
    expect(starts).toBe(1);
    const duplicate=await send(bot,"Unconfirmed last slot",firstId);
    const second=await send(bot,"Waiting behind the reservation");
    await runInDurableObject(stubFor(bot),async(instance,state)=>{
      await (instance as unknown as Internals).admit(second.operationId);
      expect(state.storage.sql.exec<{admitted:number}>("SELECT admitted FROM submissions ORDER BY rowid").toArray().map(row=>row.admitted)).toEqual([0,0]);
      expect(state.storage.sql.exec("SELECT * FROM admission_retries").toArray()).toHaveLength(0);
    });
    expect(starts).toBe(1);
    if(stop) expect((await api(`/v1/bots/${bot.id}/runs/${duplicate.id}/cancel`,{})).status).toBe(200);
    reject(new Error("Original submit receipt failed"));
    await new Promise(resolve=>setTimeout(resolve,20));
    await runInDurableObject(stubFor(bot),instance=>(instance as unknown as Internals).admit(second.operationId));
    await until(bot,second,"completed");
    expect(starts).toBe(2);
    expect((await current(bot,duplicate)).status).toBe(stop?"cancelled":"queued");
    const transcript=await messages(bot);
    expect(transcript.filter(message=>message.runId===duplicate.id && message.role==="user")).toHaveLength(1);
    expect(transcript.filter(message=>message.runId===duplicate.id && message.role==="assistant")).toHaveLength(0);
    expect(transcript.filter(message=>message.runId===second.id && message.role==="assistant")).toHaveLength(1);
  } finally {reject(new Error("test cleanup"));}
});

it("does not count sixteen native approval pauses with pending submit receipts as inbox reservations",async()=>{
  const bot=await setup(),firstId=crypto.randomUUID();
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  await runInDurableObject(stubFor(bot),(instance,state)=>{
    const target=instance as unknown as Internals,original=target.runtime;
    target.runtime={...original,submit:async(text,input)=>{
      const receipt=await original.submit(text,input);
      if(text==="fixture:approval") {
        // This deterministic adapter starts execution only when wait is called;
        // model Pi placing/pausing the input before its submit receipt arrives.
        await original.wait(input.operationId);
        await gate;
      }
      return receipt;
    }};
    state.waitUntil(target.createRun({text:"fixture:approval",operationId:firstId}));
  });
  try {
    const waiting:Run[]=[];
    let first:Run|undefined;
    for(let i=0;i<100 && !first;i++) {
      first=await runInDurableObject(stubFor(bot),(_instance,state)=>{
        const row=state.storage.sql.exec<{data:string}>("SELECT data FROM runs WHERE operation_id=?",firstId).toArray()[0];
        return row?JSON.parse(row.data) as Run:undefined;
      });
      if(!first) await new Promise(resolve=>setTimeout(resolve,5));
    }
    expect(first).toBeDefined();
    await until(bot,first!,"waiting_approval");waiting.push(first!);
    for(let i=1;i<16;i++) {const run=await send(bot,"fixture:approval");await until(bot,run,"waiting_approval");waiting.push(run);}
    const fresh=await send(bot,"New input while old submit receipts remain pending");
    await until(bot,fresh,"completed");
    for(const old of waiting) expect((await current(bot,old)).status).toBe("waiting_approval");
    const transcript=await messages(bot);
    expect(transcript.filter(message=>message.runId===fresh.id && message.role==="user")).toHaveLength(1);
    expect(transcript.filter(message=>message.runId===fresh.id && message.role==="assistant")).toHaveLength(1);
  } finally {release();}
});

it.each(["configuration","legacy"])("bounds explicit reopening of historical %s admission failures without duplicating messages",async(kind)=>{
  const bot=await setup(),runs:Run[]=[];
  await runInDurableObject(stubFor(bot),async(instance,state)=>{
    const target=instance as unknown as Internals,original=target.runtime;
    target.runtime={...original,submit:async()=>{throw new ModelConfigurationError("model_unavailable");}};
    for(let i=0;i<33;i++) {
      const run=await target.createRun({text:"Historical saved input",operationId:crypto.randomUUID()});
      expect(run.status).toBe("failed");runs.push(run);
      if(kind==="legacy") {
        state.storage.sql.exec("DELETE FROM configuration_admissions WHERE operation_id=?",run.operationId);
        state.storage.sql.exec("UPDATE runs SET data=? WHERE id=?",JSON.stringify({...run,error:"The agent runtime could not accept this run."}),run.id);
      }
    }
  });
  await holdNativeQueue(bot);
  for(const run of runs.slice(0,32)) expect((await send(bot,"Historical saved input",run.operationId)).id).toBe(run.id);
  const response=await api(`/v1/bots/${bot.id}/messages`,{text:"Historical saved input",operationId:runs[32].operationId});
  expect(response.status).toBe(429);expect(await response.json()).toMatchObject({error:{code:"inbox_full"}});
  expect((await current(bot,runs[32])).status).toBe("failed");
  expect((await messages(bot)).filter(message=>message.role==="user")).toHaveLength(33);
  await runInDurableObject(stubFor(bot),(_instance,state)=>{
    expect(state.storage.sql.exec("SELECT id FROM runs WHERE json_extract(data,'$.status')='queued'").toArray()).toHaveLength(32);
  });
},30_000);
