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
  tool('request_secret','Show a private text input inside the chat. The user only pastes text; YOU prepare its name, optional HTTPS origin and authentication header/prefix. No technical setup for the user. Pauses and resumes this task after submission. Values never enter the model context. The keychain belongs to the user. You can use only entries they permit this bot to access.',{name:text,origin:text,header:text,prefix:text,purpose:text},['name','purpose']),
  tool('configure_secret','Prepare how to use an existing private input reference. Choose a descriptive name, exact public HTTPS origin and authentication header/prefix for the intended service. The user sees a simple Allow use confirmation for that destination, never configuration fields. This pauses and resumes the task after approval. Never request or include the value.',{secretId:text,name:text,origin:text,header:text,prefix:text,purpose:text},['secretId','name','origin','purpose']),
  tool('list_secrets','List only the user’s private input references that this bot has permission to use. Values are never returned. A blank origin means you must prepare its use with configure_secret; configured references support secret_request.',{},[]),
  tool('secret_request','Make an authenticated HTTPS request using a saved secretId. Supply a path on its user-authorized origin. Optional headers are public configuration, such as API version headers; never put credentials in arguments. The host injects the credential, blocks redirects, redacts credentials from output and journals the operation. No automatic retry after an uncertain result. Supports API keys in headers, not browser passwords or shell environment injection.',{secretId:text,path:text,method:{type:'string',enum:['GET','POST','PUT','PATCH','DELETE']},headers:{type:'object',additionalProperties:{type:'string'}},body:text},['secretId','path']),
  tool('list_bots','List the owner’s persistent named bots and their IDs, so you can choose a recipient for send_to_bot.',{},[]),
  tool('create_bot','Create a persistent named bot. Requires this bot’s Allow named agents setting. The new bot starts with computer approval required and named-agent creation disabled. Use a temporary subagent for one-off work.',{name:text,instructions:text},['name']),
  tool('send_to_bot','Send a task or message asynchronously to another named bot. Returns a durable delegation receipt; its result is delivered to this conversation when ready. Use list_bots for IDs. Do not resend while waiting. Delegation paths cannot revisit a bot.',{botId:text,text},['botId','text']),
  tool('create_task','Create a standalone task assigned to this bot. Requires the owner to enable Allow task creation. Tasks start immediately by default, queued until this bot’s shared computer is free. Set startImmediately false to save a pending task.',{title:text,description:text,startImmediately:{type:'boolean'}},['title','description']),
  tool('load_skill','Load reusable task instructions. Skills do not grant permissions.',{name:{type:'string',enum:['github-development','workspace-apps']}},['name']),
  tool('github_connect','Connect GitHub to the Timber account, shared by all bots, without choosing a repository: call with {}. The user chooses accessible repositories in GitHub. Optionally supply repository and permission to verify access for a repository task; use write for push/PR and read for inspection. Never require a repository just to connect an account.',{repository:text,permission:{type:'string',enum:['read','write']}},[]),
  tool('github_list_repositories','List repositories visible through the Timber account’s shared GitHub integration. Connects the account inline if needed; no repository required. Returns up to 100 per page, with nextPage when more exist. Repository selection and permissions come from the GitHub installation and are shared by the owner’s bots.',{page:{type:'integer',minimum:1,maximum:10000}},[]),
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



