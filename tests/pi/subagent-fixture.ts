import { TOOL_NAMESPACE } from "../../packages/runtime/src/chatgpt";

/** OpenAI wire responses only; production Pi owns spawning, execution and recovery. */
export function nativeSubagentFixture(input: Record<string, unknown>[]): Response | undefined {
  const userIndex = input.map(item => item.role === "user").lastIndexOf(true);
  const text = JSON.stringify(input[userIndex]);
  const isParent = text.includes("request-native-subagent"), isChild = text.includes("request-native-child-exec");
  if (!isParent && !isChild) return;
  const hasToolOutput = input.slice(userIndex + 1).some(item => item.type === "function_call_output");
  const tool = !hasToolOutput;
  const args = isParent ? {name: "Native researcher", task: "request-native-child-exec"} : {command: "printf native-child-command"};
  const answer = isParent ? "I delegated the command to Native researcher." : "The native child command completed.";
  const final = tool
    ? {type: "function_call", id: `fc_native_${isParent ? "spawn" : "exec"}`, call_id: `call_native_${isParent ? "spawn" : "exec"}`, namespace: TOOL_NAMESPACE, name: isParent ? "spawn_subagent" : "exec", arguments: JSON.stringify(args), status: "completed"}
    : {type: "message", id: "msg_native_parent_final", role: "assistant", status: "completed", content: [{type: "output_text", text: answer, annotations: []}]};
  const response = {id: "resp_native_subagent_fixture", object: "response", status: "completed", output: [final], usage: {input_tokens: 10, output_tokens: 8, total_tokens: 18}};
  const events = [
    {type: "response.created", response: {...response, status: "in_progress", output: []}},
    {type: "response.output_item.added", output_index: 0, item: {...final, ...(tool ? {arguments: ""} : {content: []}), status: "in_progress"}},
    tool ? {type: "response.function_call_arguments.delta", output_index: 0, delta: JSON.stringify(args)} : {type: "response.output_text.delta", output_index: 0, content_index: 0, delta: answer},
    {type: "response.output_item.done", output_index: 0, item: final},
    {type: "response.completed", response},
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(""), {headers: {"content-type": "text/event-stream"}});
}
