/// <reference path="./assets.d.ts" />
import workspaceAppsSkill from "../../../skills/workspace-apps/SKILL.md";
export { workspaceAppsSkill };
import githubDevelopmentSkill from "../../../skills/github-development/SKILL.md";
export { githubDevelopmentSkill };
import type { HostToolDefinition } from '@botspace/runtime';
import { ApiError } from './errors';

const text = {type:'string'};
function tool(name:string,description:string,properties:Record<string,unknown>,required:string[]):HostToolDefinition {
  return {name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}};
}
export const hostTools:HostToolDefinition[] = [
  tool('load_skill','Load reusable task instructions. Skills do not grant permissions.',{name:{type:'string',enum:['github-development','workspace-apps']}},['name']),
  tool('github_connect','Ensure this bot has GitHub access for the requested repository. Use write for a task that includes pushing a branch or opening a PR; read for inspection only.',{repository:text,permission:{type:'string',enum:['read','write']}},['repository','permission']),
  tool('github_clone','Clone a GitHub repository into this bot workspace. Missing access displays an inline connection request; never ask for a token in chat.',{repository:text,path:text,branch:text},['repository','path']),
  tool('github_push','Push one local branch to its authorized GitHub repository, without force. Credentials are supplied by the host.',{repository:text,path:text,branch:text},['repository','path','branch']),
  tool('github_create_pull_request','Create a pull request for an already pushed branch in the authorized repository.',{repository:text,title:text,body:text,head:text,base:text,draft:{type:'boolean'}},['repository','title','body','head','base']),
  tool('github_list_pull_requests','Find existing pull requests in an authorized repository.',{repository:text,head:text},['repository']),
  tool('publish_app','Register a named app served by this workspace. Many apps can coexist. Returns its public preview base path; configure the app for that base before declaring it ready.',{name:text,port:{type:'integer',minimum:1024,maximum:65535}},['name','port']),
  tool('list_apps','List this workspace’s apps and check whether their servers are responding.',{},[]),
  tool('remove_app','Remove one app preview and revoke its browser access. Does not stop its server or delete files.',{appId:text},['appId']),
];

export function validateHostArguments(name:string,args:Record<string,unknown>):void {
  const definition=hostTools.find(item=>item.name===name);
  if(!definition) throw new ApiError(400,'unknown_tool','The host does not provide this tool. Use list_tools.');
  const schema=definition.inputSchema,properties=schema.properties as Record<string,{type:string;enum?:unknown[];minimum?:number;maximum?:number}>;
  for(const key of schema.required as string[]) if(args[key]===undefined) throw new ApiError(400,'invalid_tool_arguments',`Missing ${key}.`);
  for(const [key,value] of Object.entries(args)) {
    const rule=properties[key];
    if(!rule || (rule.type==='integer'?(!Number.isInteger(value) || Number(value)<rule.minimum! || Number(value)>rule.maximum!):typeof value!==rule.type) || (rule.enum&&!rule.enum.includes(value))) throw new ApiError(400,'invalid_tool_arguments',`Invalid ${key}.`);
    if(typeof value==='string' && value.length>20_000) throw new ApiError(400,'invalid_tool_arguments',`${key} is too long.`);
  }
}

// The source skill is deliberately host-owned and independent of the engine.



