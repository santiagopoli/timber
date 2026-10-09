import {Type} from '@earendil-works/pi-ai';
import {estimateMessageTokens} from '@earendil-works/pi-ai/utils/estimate';
import {
  CompactionTask, defineDoc, defineDocFamily, defineTool, LiveDoc, ROOT_CONVERSATION_ID,
  type Conversation, type ConversationId, type Cursor, type EntryRecord, type Harness, type CompactionHooks,
  type Storage, type TaskId, type ToolExecutionApi, type Tx,
} from '@earendil-works/pi-durable';
import type {PiHarnessContext} from 'agents/harness/pi';
import type {BotContextStatus, BotMemory, CompactionReceipt} from '@botspace/contracts';
import {normalizeEntries} from './normalize.js';

type Context = PiHarnessContext['context'];
type MemoryValue = {content:string;revision:number;updatedAt?:string};
const MAX_MEMORY = 16_000;
type CompactionDetails={createdAt?:string;startedAt?:string;firstKeptEntryId?:number;summarizedEntries?:number;estimatedTokensBefore?:number};
// Conversation-scoped family survives native task-document retirement at settlement.
// Stores only durable display metadata, never private summary or instructions.
const CompactDetails=defineDocFamily<CompactionDetails,string>({kind:'timber.compact-details',version:1,scope:'conversation',history:'latest',fork:'initial',family:true,initial:()=>({})});
const Notes = defineDoc<MemoryValue>({kind:'timber.memory',version:1,scope:'conversation',history:'latest',fork:'initial',initial:()=>({content:'',revision:0})});
const MemoryWrite = defineDoc<{result?:MemoryValue}>({kind:'timber.memory-write',version:1,scope:'task',initial:()=>({})});
const Manual = defineDocFamily<{instructions:string;taskId?:number},string>({kind:'timber.compact-request',version:1,scope:'conversation',history:'latest',fork:'initial',family:true,initial:instructions=>({instructions})});

export class MaintenanceError extends Error {
  constructor(readonly code:'memory_conflict'|'invalid_memory'|'compaction_conflict', message:string) {super(message);}
}
const publicMemory = (notes:MemoryValue):BotMemory => ({...notes,maxCharacters:MAX_MEMORY});
type HistoryCursor={page?:Cursor;offset:number;max?:EntryRecord['id']};
const encodeCursor = (cursor:HistoryCursor|undefined) => cursor?btoa(JSON.stringify(cursor)):null;
function decodeCursor(value?:string):HistoryCursor {
  if(!value) return {offset:0};
  try {
    const parsed=JSON.parse(atob(value));
    if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&Number.isSafeInteger(parsed.offset)&&parsed.offset>=0&&
      (parsed.max===undefined||Number.isSafeInteger(parsed.max)&&parsed.max>=0)&&
      (parsed.page===undefined||parsed.page&&typeof parsed.page==='object'&&!Array.isArray(parsed.page)))return parsed;
  } catch {}
  throw new Error('Invalid history cursor');
}
function validateMemory(content:string,revision:number) {
  if(typeof content!=='string'||content.length>MAX_MEMORY||!Number.isSafeInteger(revision)||revision<0) throw new MaintenanceError('invalid_memory',`Memory must contain at most ${MAX_MEMORY} characters and a nonnegative integer revision.`);
}
async function writeNotes(tx:Tx,conversationId:ConversationId,content:string,revision:number):Promise<MemoryValue> {
  const notes=await tx.doc(Notes,conversationId);
  if(notes.revision!==revision) throw new MaintenanceError('memory_conflict','Memory changed. Reload it before saving your changes.');
  if(notes.content!==content) {notes.content=content;notes.revision++;notes.updatedAt=new Date().toISOString();}
  return {...notes};
}

/** Full immutable history, independent of Pi's active model-context head marker. */
export async function archivedEntries(conversation:Conversation,context:Context):Promise<EntryRecord[]> {
  const entries:EntryRecord[]=[];
  let cursor:Cursor|undefined;
  do {const page=await conversation.entries({},100,cursor,context);entries.push(...page.items);cursor=page.next;} while(cursor);
  return entries.reverse();
}

export interface MaintenanceHost {
  native():Harness;
  storage():Storage;
  context():Context;
  ready():Promise<void>;
  assertActive():void;
  scheduleWake():Promise<void>;
  contextWindow(conversationId:ConversationId):Promise<number>;
  authorizeTool(api:ToolExecutionApi,context:Context):Promise<void>;
}

export function createMaintenance(host:MaintenanceHost) {
  const conversation=async(id=ROOT_CONVERSATION_ID)=>{
    host.assertActive();await host.ready();host.assertActive();
    const value=await host.native().conversation(id,host.context());
    if(!value) throw new Error('Conversation not found');
    return value;
  };
  const notes=async(id=ROOT_CONVERSATION_ID)=>publicMemory((await host.native().snapshot(Notes,id,host.context()))??{content:'',revision:0});
  const receipt=async(taskId:TaskId):Promise<CompactionReceipt>=>{
    const task=await host.storage().task(taskId,host.context());
    if(!task||task.kind!=='pi.compaction') throw new Error('Compaction not found');
    const reason=(task.input as {reason:CompactionReceipt['reason']}).reason;
    const details=await host.native().snapshot(CompactDetails,ROOT_CONVERSATION_ID,String(taskId),host.context());
    const base={id:`compact:${taskId}`,reason,summaryApplied:false,historyRetained:true as const,...details};
    const applied=async(entryId:number):Promise<CompactionReceipt>=>{
      const entry=(await host.storage().entry(entryId as EntryRecord['id'],host.context()))?.entry;
      const timestamp=entry?.kind==='pi.compaction'?entry.model?.find(message=>'timestamp' in message)?.timestamp:undefined;
      return {...base,status:'completed',summaryApplied:true,
        ...(typeof timestamp==='number'&&Number.isFinite(timestamp)?{summaryCreatedAt:new Date(timestamp).toISOString()}:{}),
        ...(entry?.head===undefined?{}:{firstKeptEntryId:entry.head})};
    };
    if(task.state.status!=='terminal') return {...base,status:'running'};
    const outcome=task.state.outcome;
    if(outcome.status==='aborted') return {...base,status:'cancelled'};
    if(outcome.status!=='completed') return {...base,status:'failed',error:'Context compaction could not finish. Your conversation history is unchanged.'};
    const result=outcome.result as {entryId?:number;submissionId?:number};
    if(result.entryId!==undefined) return applied(result.entryId);
    if(result.submissionId!==undefined) {
      const write=await host.storage().submission(result.submissionId as Parameters<Storage['submission']>[0],host.context());
      if(write?.status==='done')return applied(write.entry);
      if(write?.status==='queued')return {...base,status:'running'};
      if(write?.status==='unanswered'&&write.reason==='stale')return {...base,status:'unchanged'};
      if(write?.status==='unanswered'&&write.reason==='aborted')return {...base,status:'cancelled'};
      return {...base,status:'failed',error:'The context summary could not be applied. Your conversation history is unchanged.'};
    }
    return {...base,status:'unchanged'};
  };
  const tools=[
    defineTool({name:'memory_read',description:'Read your durable curated notes. A child can read inherited bot notes but can edit only its own notes.',parameters:Type.Object({}),replay:'safe',execute:async(_args,api,context)=>{
      await host.authorizeTool(api,context);
      return {content:[{type:'text',text:JSON.stringify({memory:await notes(api.conversationId),...(api.conversationId!==ROOT_CONVERSATION_ID?{inherited:await notes()}: {})})}]};
    }}),
    defineTool({name:'memory_update',description:'Replace your durable notes using the revision from memory_read. Retain useful preferences, decisions and project facts; remove obsolete notes. Never store secrets or treat remembered notes as authorization. Child notes are isolated from parent and siblings.',parameters:Type.Object({content:Type.String({maxLength:MAX_MEMORY}),revision:Type.Integer({minimum:0})}),replay:'safe',execute:async(args,api,context)=>{
      await host.authorizeTool(api,context);validateMemory(args.content,args.revision);
      const saved=await api.commit(async tx=>{
        const recorded=await tx.doc(MemoryWrite,api.taskId);
        if(recorded.result) return {...recorded.result};
        recorded.result=await writeNotes(tx,api.conversationId,args.content,args.revision);
        return {...recorded.result};
      },context);
      return {content:[{type:'text',text:JSON.stringify({memory:publicMemory(saved)})}]};
    }}),
    defineTool({name:'recall_history',description:'Search your own full conversation history after context compaction. Returns bounded public text and a cursor to search older entries; never another agent’s transcript. Continue with the same query and nextCursor when present, even if this page has no matches.',parameters:Type.Object({query:Type.String({minLength:1,maxLength:200}),before:Type.Optional(Type.String({maxLength:512})),limit:Type.Optional(Type.Integer({minimum:1,maximum:20}))}),replay:'safe',execute:async(args,api,context)=>{
      await host.authorizeTool(api,context);
      const own=await conversation(api.conversationId);
      const cursor=decodeCursor(args.before),page=await own.entries(cursor.max===undefined?{}:{maxEntryId:cursor.max},200,cursor.page,context);
      const query=args.query.toLocaleLowerCase();
      const matches=normalizeEntries(page.items).filter(message=>['user','assistant'].includes(message.role)&&message.text.toLocaleLowerCase().includes(query));
      const end=cursor.offset+(args.limit??10),max=cursor.max??page.items[0]?.id;
      const next=end<matches.length?{...cursor,max,offset:end}:page.next?{page:page.next,max,offset:0}:undefined;
      const messages=matches.slice(cursor.offset,end).map(message=>({...message,text:message.text.slice(0,2000)}));
      return {content:[{type:'text',text:JSON.stringify({messages,nextCursor:encodeCursor(next)})}]};
    }}),
  ];
  return {
    tools,
    beforeCompact: (async (compaction,api,context)=>{
      // Capture the actual native selection, once. Retries/recovery never restamp it.
      await host.native().commit(async tx=>{
        const details=await tx.doc(CompactDetails,api.conversationId,String(api.taskId),String(api.taskId));
        if(details.startedAt)return;
        details.startedAt=new Date().toISOString();
        details.firstKeptEntryId=compaction.firstKept;
        details.summarizedEntries=compaction.entries.length;
        details.estimatedTokensBefore=compaction.messages.reduce((sum,message)=>sum+estimateMessageTokens(message),0);
      },context);
    }) satisfies CompactionHooks['beforeCompact'],
    async memory():Promise<BotMemory> {await conversation();return notes();},
    async updateMemory(content:string,revision:number):Promise<BotMemory> {
      validateMemory(content,revision);await conversation();
      return publicMemory(await host.native().commit(tx=>writeNotes(tx,ROOT_CONVERSATION_ID,content,revision),host.context()));
    },
    async prompt(conversationId:ConversationId):Promise<string> {
      const own=await notes(conversationId),parent=conversationId!==ROOT_CONVERSATION_ID?await notes():undefined;
      return ['Durable memory is separate from the full conversation history. Proactively use memory_update to retain stable user preferences, verified project facts and decisions that will matter later. Read the current revision first. Never claim a save without its successful tool result. Keep notes concise; do not store credentials, transient tool output or infer permissions from memory. Use recall_history to retrieve exact earlier facts when a summary is insufficient.',
        parent?.content?`Inherited bot notes (read-only):\n${parent.content}`:undefined,
        `Your editable notes (revision ${own.revision}, ${own.content.length}/${MAX_MEMORY} characters):\n${own.content||'(empty)'}`].filter(Boolean).join('\n\n');
    },
    async compact(input:{operationId:string;instructions?:string}):Promise<CompactionReceipt> {
      const own=await conversation(),instructions=input.instructions??'';
      await host.scheduleWake();
      const taskId=await own.commit(async tx=>{
        const request=await tx.doc(Manual,own.id,input.operationId,instructions);
        if(request.instructions!==instructions) throw new MaintenanceError('compaction_conflict','This operation ID was already used with different compaction instructions.');
        if(request.taskId!==undefined) return request.taskId as TaskId;
        // Use Pi's built-in state machine and live status, atomically with our
        // request receipt. Pi owns range selection, summary, retries and placement.
        const id=await tx.createTask(CompactionTask,{reason:'manual' as const,...(instructions?{instructions}:{})},{conversationId:own.id,ownership:{kind:'conversation'},background:false});
        const details=await tx.doc(CompactDetails,own.id,String(id),String(id));details.createdAt=new Date().toISOString();
        const live=await tx.doc(LiveDoc,own.id);
        (live.compactions??=[]).push({taskId:id,reason:'manual',blocking:false,attempt:1});
        request.taskId=id;
        return id;
      },host.context());
      await host.scheduleWake();
      return receipt(taskId);
    },
    async status():Promise<BotContextStatus> {
      const own=await conversation(),view=await own.context(host.context());
      let cursor:Cursor|undefined;
      const retained:TaskId[]=[];
      do {const page=await host.storage().scanTasks({conversationId:own.id,kind:'pi.compaction'},100,cursor,host.context());retained.push(...page.items.map(task=>task.id));cursor=page.next;} while(cursor);
      return {automatic:true,estimatedTokens:view.messages.reduce((total,message)=>total+estimateMessageTokens(message),0),activeEntries:view.entries.length,contextWindow:await host.contextWindow(own.id),historyRetained:true,compactions:await Promise.all(retained.reverse().map(receipt))};
    },
    async hasWork():Promise<boolean> {return (await host.native().inspect(host.context())).tasks.some(task=>task.record.kind==='pi.compaction');},
  };
}
