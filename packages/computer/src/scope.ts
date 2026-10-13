const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const TASK_COMPUTER_HEADER='x-timber-task-computer';
export function computerName(botId:string,taskId?:string):string {
  if(taskId&&!UUID.test(taskId))throw new Error('computer_invalid_request');
  return taskId?`task:${taskId}`:botId;
}
export function computerHeaders(botId:string,taskId?:string):Record<string,string> {
  return {'x-timber-bot-id':botId,...(taskId?{[TASK_COMPUTER_HEADER]:taskId}:{})};
}
export type ComputerScopeResolver=(botId:string)=>Promise<string|undefined>;
