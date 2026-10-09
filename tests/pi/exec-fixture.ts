import { TOOL_NAMESPACE } from "../../packages/runtime/src/chatgpt";

/** Model wire fixture; native Pi and BotDO execute the full session protocol. */
export function nativeExecFixture(input: Record<string, unknown>[]): Response | undefined {
  const userIndex = input.map(item => item.role === "user").lastIndexOf(true);
  const request = JSON.stringify(input[userIndex]);
  if (!request.includes("request-native-exec-session")) return;
  const results = input.slice(userIndex + 1).filter(item => item.type === "function_call_output");
  const latest = results.at(-1);
  const output = typeof latest?.output === "string" ? latest.output : JSON.stringify(latest?.output ?? "");
  const processId = /"processId"\s*:\s*"([^"\\]+)"/.exec(output)?.[1];
  const cancelled = request.includes("cancel-process");
  const done = results.length >= 2;
  const name = results.length ? cancelled ? "exec_cancel" : "exec_poll" : "exec";
  if (results.length && !done && !processId) throw new Error("Native exec did not return its processId to Pi");
  const args = results.length
    ? {processId, ...(cancelled ? {} : {yieldMs: 0})}
    : {command: "printf native-session-start; sleep 300; printf native-session-end", yieldMs: 0};
  const answer = cancelled ? "The process was cancelled." : "The process completed after polling.";
  const item = done
    ? {type: "message", id: "msg_exec_session", role: "assistant", status: "completed", content: [{type: "output_text", text: answer, annotations: []}]}
    : {type: "function_call", id: `fc_exec_session_${results.length}`, call_id: `call_exec_session_${results.length}`, namespace: TOOL_NAMESPACE, name, arguments: JSON.stringify(args), status: "completed"};
  const response = {id: `resp_exec_session_${results.length}`, object: "response", status: "completed", output: [item], usage: {input_tokens: 10, output_tokens: 8, total_tokens: 18}};
  const events = [
    {type: "response.created", response: {...response, status: "in_progress", output: []}},
    {type: "response.output_item.added", output_index: 0, item: {...item, ...(done ? {content: []} : {arguments: ""}), status: "in_progress"}},
    done ? {type: "response.output_text.delta", output_index: 0, content_index: 0, delta: answer} : {type: "response.function_call_arguments.delta", output_index: 0, delta: JSON.stringify(args)},
    {type: "response.output_item.done", output_index: 0, item},
    {type: "response.completed", response},
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {headers: {"content-type": "text/event-stream"}});
}
