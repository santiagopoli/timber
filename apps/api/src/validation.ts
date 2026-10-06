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
export function parseMessage(value:unknown):{text:string;operationId:string} {
  const data=object(value);
  const text=string(data.text,"text",32_000);
  if(!text.trim()) invalid("text cannot be blank.");
  return {text,operationId:operationId(data.operationId)};
}
export function parseBotInput(value:unknown,patch=false):{name?:string;instructions?:string;model?:string;computerApprovalMode?:ComputerApprovalMode} {
  const data=object(value);
  const output:{name?:string;instructions?:string;model?:string;computerApprovalMode?:ComputerApprovalMode}={};
  if(data.name!==undefined || !patch) {
    output.name=string(data.name,"name",80).trim();
    if(!output.name) invalid("name cannot be blank.");
  }
  if(data.instructions!==undefined) output.instructions=string(data.instructions,"instructions",16_000,0);
  if(data.model!==undefined) {
    if(patch) invalid("model cannot be changed in this milestone.");
    output.model=string(data.model,"model",180);
    if(output.model!=="gpt-6.1-sol" && !/^@cf\/[A-Za-z0-9._/-]+$/.test(output.model)) invalid("model must be gpt-6.1-sol or an explicit Workers AI @cf/ model identifier.");
  }
  if(data.computerApprovalMode!==undefined) {
    if(data.computerApprovalMode!=="ask" && data.computerApprovalMode!=="automatic") invalid("computerApprovalMode must be ask or automatic.");
    output.computerApprovalMode=data.computerApprovalMode;
  }
  if(patch && !Object.keys(output).length) invalid("Provide name, instructions or computerApprovalMode.");
  return output;
}
function finite(value:unknown,name:string,min:number,max:number):number {
  if(typeof value!=="number" || !Number.isFinite(value) || value<min || value>max) invalid(`${name} is out of range.`);
  return value as number;
}
function path(value:unknown):string {
  const p=string(value,"path",1024);
  if(p.includes("\0") || p.startsWith("/") || p.split("/").some(x=>x==="..")) invalid("path must be relative to /workspace.");
  return p;
}
export function parseAction(value:unknown):ComputerAction {
  const data=object(value);
  switch(data.type) {
    case "exec": return {type:"exec",command:string(data.command,"command",16_000),...(data.timeoutMs===undefined?{}:{timeoutMs:finite(data.timeoutMs,"timeoutMs",1,120_000)})};
    case "readFile": return {type:"readFile",path:path(data.path)};
    case "writeFile": return {type:"writeFile",path:path(data.path),content:string(data.content,"content",200_000,0)};
    case "listFiles": return {type:"listFiles",...(data.path===undefined?{}:{path:path(data.path)})};
    case "screenshot": return {type:"screenshot"};
    case "click": {
      if(!Number.isInteger(data.x) || !Number.isInteger(data.y)) invalid("Mouse coordinates must be integers.");
      const button=data.button;
      if(button!==undefined && !["left","right","middle"].includes(String(button))) invalid("Invalid mouse button.");
      return {type:"click",x:finite(data.x,"x",0,1279),y:finite(data.y,"y",0,799),...(button?{button:button as "left"|"right"|"middle"}:{})};
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
