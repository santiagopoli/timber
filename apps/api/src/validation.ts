import type { ComputerAction, ComputerApprovalMode } from "@botspace/contracts";
import { ApiError } from "./errors";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function invalid(message:string):never {throw new ApiError(400,"invalid_request",message);}
export function object(value:unknown):Record<string,unknown> {
  if (!value || typeof value!=="object" || Array.isArray(value)) invalid("Expected a JSON object.");
  return value as Record<string,unknown>;
}
export function string(value:unknown,name:string,max:number,min=1):string {
  if(typeof value!=="string" || value.length<min || value.length>max) invalid(`${name} must contain ${min} to ${max} characters.`);
  return value as string;
}
export async function body(request:Request):Promise<Record<string,unknown>> {
  const declared = request.headers.get("content-length");
  if(declared && Number(declared)>300_000) throw new ApiError(413,"body_too_large","Request body too large.");
  const chunks:Uint8Array[]=[];
  let size=0;
  const reader=request.body?.getReader();
  if(reader) {
    while(true) {
      const part=await reader.read();
      if(part.done) break;
      size+=part.value.byteLength;
      if(size>300_000) {await reader.cancel();throw new ApiError(413,"body_too_large","Request body too large.");}
      chunks.push(part.value);
    }
  }
  const bytes=new Uint8Array(size);
  let offset=0;
  for(const chunk of chunks) {bytes.set(chunk,offset);offset+=chunk.byteLength;}
  const text=new TextDecoder().decode(bytes);
  try {return object(JSON.parse(text));} catch(error) {if(error instanceof ApiError) throw error;invalid("Invalid JSON body.");}
}
export function operationId(value:unknown):string {
  if(typeof value!=="string" || !OPERATION_ID.test(value)) invalid("operationId must be 1 to 128 letters, numbers, dots, colons, hyphens or underscores.");
  return value as string;
}
export function parseMessage(value:unknown):{text:string;operationId:string;mentions?:string[];attachments?:string[]} {
  const data=object(value);
    const text=string(data.text,"text",32_000,0);
  const attachments=data.attachments;
  if(attachments!==undefined && (!Array.isArray(attachments) || attachments.length>4 || attachments.some(id=>typeof id!=="string" || !UUID.test(id)) || new Set(attachments).size!==attachments.length)) invalid("attachments must contain up to four distinct image IDs.");
  const ids=attachments as string[]|undefined;
  if(!text.trim() && !ids?.length) invalid("A message or image is required.");
  if(data.mentions!==undefined && (!Array.isArray(data.mentions) || data.mentions.length>8 || data.mentions.some(id=>typeof id!=="string" || !UUID.test(id)) || new Set(data.mentions).size!==data.mentions.length)) invalid("mentions must contain at most eight unique bot IDs.");
  return {text,operationId:operationId(data.operationId),...(ids?.length?{attachments:ids}:{}),...(data.mentions===undefined?{}:{mentions:data.mentions as string[]})};

}
export function parseBotInput(value:unknown,patch=false):{name?:string;instructions?:string;model?:string;reasoningEffort?:string;fast?:boolean;computerApprovalMode?:ComputerApprovalMode;allowNamedAgents?:boolean} {
  const data=object(value);
  if(["themeId","avatarThemeId","avatarTheme","avatar"].some(key=>data[key]!==undefined)) invalid("Avatar themes belong to the owner and cannot be overridden by a bot.");
  if(data.runtime!==undefined && data.runtime!=="pi") invalid("runtime must be pi.");
  const output:{name?:string;instructions?:string;model?:string;reasoningEffort?:string;fast?:boolean;computerApprovalMode?:ComputerApprovalMode;allowNamedAgents?:boolean}={};
  if(data.name!==undefined || !patch) {
    output.name=string(data.name,"name",80).trim();
    if(!output.name) invalid("name cannot be blank.");
  }
  if(data.instructions!==undefined) output.instructions=string(data.instructions,"instructions",16_000,0);
  if(data.model!==undefined) {
    output.model=string(data.model,"model",180);
    if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(output.model) && !/^@cf\/[A-Za-z0-9._/-]+$/.test(output.model)) invalid("model must be an account model identifier or an explicit Workers AI @cf/ model identifier.");
  }
  if(data.reasoningEffort!==undefined) {
    output.reasoningEffort=string(data.reasoningEffort,"reasoningEffort",128);
    if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(output.reasoningEffort)) invalid("reasoningEffort must be a supported reasoning option.");
  }
  if(data.fast!==undefined) {if(typeof data.fast!=="boolean")invalid("fast must be a boolean.");output.fast=data.fast;}
  if(data.computerApprovalMode!==undefined) {
    if(data.computerApprovalMode!=="ask" && data.computerApprovalMode!=="automatic") invalid("computerApprovalMode must be ask or automatic.");
    output.computerApprovalMode=data.computerApprovalMode;
  }
  if(data.allowNamedAgents!==undefined) {
    if(typeof data.allowNamedAgents!=="boolean") invalid("allowNamedAgents must be a boolean.");
    output.allowNamedAgents=data.allowNamedAgents;
  }
  if(patch && !Object.keys(output).length) invalid("Provide name, instructions, model, reasoningEffort, fast, computerApprovalMode or allowNamedAgents.");
  return output;
}
function finite(value:unknown,name:string,min:number,max:number):number {
  if(typeof value!=="number" || !Number.isFinite(value) || value<min || value>max) invalid(`${name} is out of range.`);
  return value as number;
}
function coordinate(value:unknown,name:string,max:number):number {
  if(!Number.isInteger(value)) invalid("Mouse coordinates must be integers.");
  return finite(value,name,0,max);
}
function milliseconds(value:unknown,name:string,min:number,max=Number.MAX_SAFE_INTEGER):number {
  if(!Number.isSafeInteger(value)) invalid(`${name} must be a safe integer.`);
  return finite(value,name,min,max);
}
function processId(value:unknown):string {
  if(typeof value!=="string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) invalid("Invalid processId.");
  return value as string;
}
function mouseButton(value:unknown):"left"|"right"|"middle"|undefined {
  if(value===undefined || value==="left" || value==="right" || value==="middle") return value;
  invalid("Invalid mouse button.");
}
function path(value:unknown):string {
  const p=string(value,"path",1024);
  if(p.includes("\0") || p.startsWith("/") || p.split("/").some(x=>x==="..")) invalid("path must be relative to /workspace.");
  return p;
}
export function parseAction(value:unknown):ComputerAction {
  const data=object(value);
  switch(data.type) {
    case "exec": return {type:"exec",command:string(data.command,"command",16_000),...(data.timeoutMs===undefined?{}:{timeoutMs:milliseconds(data.timeoutMs,"timeoutMs",1)}),...(data.yieldMs===undefined?{}:{yieldMs:milliseconds(data.yieldMs,"yieldMs",0,30_000)})};
    case "execPoll": return {type:"execPoll",processId:processId(data.processId),...(data.yieldMs===undefined?{}:{yieldMs:milliseconds(data.yieldMs,"yieldMs",0,30_000)})};
    case "execCancel": return {type:"execCancel",processId:processId(data.processId)};
    case "readFile": return {type:"readFile",path:path(data.path)};
    case "writeFile": return {type:"writeFile",path:path(data.path),content:string(data.content,"content",200_000,0)};
    case "listFiles": return {type:"listFiles",...(data.path===undefined?{}:{path:path(data.path)})};
    case "gitClone":
    case "gitPush": {
      const repository=string(data.repository,"repository",140);
      if(!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(repository) || [".",".."].includes(repository.split("/")[1])) invalid("repository must be a GitHub owner/repository name.");
      const workspacePath=path(data.path);
      if(workspacePath==="." || !workspacePath.split("/").some(part=>part && part!==".")) invalid("A repository subdirectory is required.");
      const branch=data.branch===undefined?undefined:string(data.branch,"branch",200);
      if(branch!==undefined && (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes("..") || branch.includes("//") || /[/.]$/.test(branch) || branch.split("/").some(part=>part.startsWith(".") || part.endsWith(".lock")))) invalid("Invalid Git branch.");
      if(data.type==="gitPush") {
        if(!branch) invalid("branch is required for Git push.");
        return {type:"gitPush",repository,path:workspacePath,branch};
      }
      return {type:"gitClone",repository,path:workspacePath,...(branch===undefined?{}:{branch})};
    }
    case "screenshot": return {type:"screenshot"};
    case "move": return {type:"move",x:coordinate(data.x,"x",1279),y:coordinate(data.y,"y",799)};
    case "click":
    case "doubleClick": {
      const button=mouseButton(data.button);
      return {type:data.type,x:coordinate(data.x,"x",1279),y:coordinate(data.y,"y",799),...(button?{button}:{})};
    }
    case "drag": {
      const button=mouseButton(data.button);
      if(data.durationMs!==undefined && !Number.isInteger(data.durationMs)) invalid("durationMs must be an integer.");
      return {type:"drag",fromX:coordinate(data.fromX,"fromX",1279),fromY:coordinate(data.fromY,"fromY",799),toX:coordinate(data.toX,"toX",1279),toY:coordinate(data.toY,"toY",799),...(button?{button}:{}),...(data.durationMs===undefined?{}:{durationMs:finite(data.durationMs,"durationMs",100,2000)})};
    }
    case "type": return {type:"type",text:string(data.text,"text",10_000,0)};
    case "key": return {type:"key",key:string(data.key,"key",100)};
    case "scroll": {
      if(data.direction!=="up" && data.direction!=="down") invalid("direction must be up or down.");
      return {type:"scroll",direction:data.direction as "up"|"down",...(data.amount===undefined?{}:{amount:finite(data.amount,"amount",1,30)})};
    }
    case "navigate": {
      const url=string(data.url,"url",4096);
      try {const parsed=new URL(url); if(!["http:","https:"].includes(parsed.protocol) || parsed.username || parsed.password) invalid("Only HTTP(S) URLs without credentials are allowed.");}
      catch(error) {if(error instanceof ApiError) throw error;invalid("Invalid URL.");}
      return {type:"navigate",url};
    }
    case "checkpoint": return {type:"checkpoint"};
    default: invalid("Unsupported computer action.");
  }
}
export async function fingerprint(value:unknown):Promise<string> {
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,"0")).join("");
}
