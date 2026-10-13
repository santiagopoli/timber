import {Type, type Message} from '@earendil-works/pi-ai';
import {defineTool, type EntryId, type Storage, type ToolExecutionApi} from '@earendil-works/pi-durable';

export const TOOL_OUTPUT_PREVIEW_CHARACTERS = 12_000;
const boundedTools = new Set(['exec', 'exec_poll', 'read_file']);

/** A provider view only: native entries and the public transcript stay intact. */
export function previewToolOutputs(messages: Message[]): Message[] {
  return messages.map(message => {
    if (message.role !== 'toolResult' || !boundedTools.has(message.toolName)) return message;
    return {...message, content: message.content.map(part => {
      if (part.type !== 'text') return part;
      let result: Record<string, unknown>;
      try {result = JSON.parse(part.text);} catch {return part;}
      if (!result || typeof result !== 'object' || typeof result.output !== 'string' || result.output.length <= TOOL_OUTPUT_PREVIEW_CHARACTERS) return part;
      const output = result.output;
      return {...part, text: JSON.stringify({...result,
        output: output.slice(0, 8_000) + '\n[Middle omitted from model preview; full output retained.]\n' + output.slice(-4_000),
        outputPreview: {totalCharacters: output.length, toolCallId: message.toolCallId, timestamp: message.timestamp,
          readMore: 'Use read_tool_output with this toolCallId, timestamp and an offset to read the retained output without rerunning the action.'},
      })};
    })};
  });
}

export function retainedOutputTool(host: {
  sql: DurableObjectStorage['sql'];
  storage(): Storage;
  authorize(api: ToolExecutionApi, context: Parameters<ToolExecutionApi['agent']>[0]): Promise<void>;
}) {
  return defineTool({name: 'read_tool_output', replay: 'safe',
    description: 'Read a bounded page of a retained exec, exec_poll or read_file result from your own conversation. Use the toolCallId and timestamp in outputPreview. This never reruns the command and works after compaction or recovery.',
    parameters: Type.Object({toolCallId: Type.String({minLength: 1, maxLength: 1024}), timestamp: Type.Integer({minimum: 0}),
      offset: Type.Optional(Type.Integer({minimum: 0})), limit: Type.Optional(Type.Integer({minimum: 1, maximum: TOOL_OUTPUT_PREVIEW_CHARACTERS}))}),
    execute: async (input, api, context) => {
      await host.authorize(api, context);
      const row = host.sql.exec<{id: number}>(`SELECT id FROM pi_entries WHERE conversation_id=?
        AND json_extract(record,'$.kind')='pi.tool-result'
        AND json_extract(record,'$.model[0].toolCallId')=? AND json_extract(record,'$.model[0].timestamp')=?
        ORDER BY id DESC LIMIT 1`, Number(api.conversationId), input.toolCallId, input.timestamp).toArray()[0];
      const entry = row ? await host.storage().entry(api.conversationId, row.id as EntryId, context) : undefined;
      const message = entry?.entry.model?.[0];
      let output: string | undefined;
      if (message?.role === 'toolResult' && boundedTools.has(message.toolName)) {
        for (const part of message.content) if (part.type === 'text') {
          try {const value = JSON.parse(part.text); if (typeof value?.output === 'string') {output = value.output; break;}} catch { /* Non-result diagnostics are not output. */ }
        }
      }
      if (output === undefined) return {isError: true, content: [{type: 'text', text: 'Retained output not found in this conversation. Do not rerun an action merely to retrieve its output.'}]};
      const offset = input.offset ?? 0, end = Math.min(output.length, offset + (input.limit ?? TOOL_OUTPUT_PREVIEW_CHARACTERS));
      return {content: [{type: 'text', text: JSON.stringify({toolCallId: input.toolCallId, timestamp: input.timestamp,
        totalCharacters: output.length, offset, output: output.slice(offset, end), nextOffset: end < output.length ? end : null})}]};
    },
  });
}
